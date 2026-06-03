import type Database from "better-sqlite3";

/**
 * `agent.firing_blocked` audit throttle (AGENT_DEFINITIONS_DESIGN.md §12.3).
 *
 * When a disabled built-in Agent's cron would have fired, the scheduler records
 * the suppressed firing — but a routine on a tight cadence (hourly_check) could
 * otherwise write dozens of identical audit rows a day. The throttle keeps **at
 * most one** `agent_actions(action_type='agent.firing_blocked')` row per
 * `(agent_id, agent-day)`; every subsequent suppression in the same agent-day
 * increments that row's `detail.suppressed_count` instead.
 *
 * `agent-day` is the caller-supplied `YYYY-MM-DD` boundary string (04:00-local
 * by default), matched against `detail.agent_day` — so the first block of each
 * agent-day opens a fresh row. The increment runs entirely in SQL (`json_set`
 * over `json_extract`) so there is no read-modify-write race between concurrent
 * cron ticks. Detail keys are snake_case per design §12.3 (`reason`,
 * `suppressed_count`, `agent_day`).
 */

export type AgentFiringBlockedOutcome = "inserted" | "incremented";

export interface RecordAgentFiringBlockedInput {
  /** Owning Agent slug (`agents.id`). */
  slug: string;
  /** Agent-day `YYYY-MM-DD` label the suppression belongs to. */
  agentDay: string;
  /** Why the firing was blocked (design §12.3 value: `"disabled"`). */
  reason: string;
}

export function recordAgentFiringBlocked(
  db: Database.Database,
  input: RecordAgentFiringBlockedInput,
): AgentFiringBlockedOutcome {
  const existing = db
    .prepare<[string, string], { id: number }>(
      `SELECT id FROM agent_actions
        WHERE action_type = 'agent.firing_blocked'
          AND agent_id = ?
          AND json_extract(detail, '$.agent_day') = ?
        LIMIT 1`,
    )
    .get(input.slug, input.agentDay);

  if (existing !== undefined) {
    db.prepare(
      `UPDATE agent_actions
          SET detail = json_set(
                detail,
                '$.suppressed_count',
                COALESCE(json_extract(detail, '$.suppressed_count'), 0) + 1
              )
        WHERE id = ?`,
    ).run(existing.id);
    return "incremented";
  }

  db.prepare(
    `INSERT INTO agent_actions
        (action_type, agent_id, trigger, result, detail, started_at, completed_at)
      VALUES ('agent.firing_blocked', ?, 'autonomous', 'skipped', json(?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(
    input.slug,
    JSON.stringify({
      agent_day: input.agentDay,
      reason: input.reason,
      suppressed_count: 0,
    }),
  );
  return "inserted";
}
