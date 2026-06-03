import { existsSync, readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import type { SuccessCriterion } from "@aitne/shared";

import { safePath } from "../../api/routes/context/path-resolve.js";

/**
 * Success-criteria evaluator (AGENT_DEFINITIONS_DESIGN.md §8.3).
 *
 * A **pure** post-execution check over an Agent's `success_criteria` array. It
 * takes the already-resolved `contextDir` (rather than resolving it from daemon
 * config) so the module is unit-testable against a temp vault and has no config
 * coupling — the same shape `evening-review-verify.ts` uses.
 *
 * Best-effort semantics: every criterion is evaluated inside its own try/catch,
 * so a filesystem error or DB hiccup on one criterion records `false` + a
 * structured warning and the *others* still evaluate. A throw never flips the
 * execution's `result` field (that reflects the LLM-level outcome; criteria are
 * the orthogonal semantic layer the dashboard multiplies in). Warnings are
 * returned rather than logged in-module so the evaluator stays logger-free and
 * pure; the dispatcher-result-processor (Phase 7) logs them with execution
 * context.
 *
 * Timestamp domains (§5.1 note): `agent_executions.started_at` is epoch-ms while
 * `notification_log.created_at` / `agent_actions.started_at` are SQLite
 * `CURRENT_TIMESTAMP` UTC strings. The two DB-backed criteria bind the epoch-ms
 * anchor through `datetime(?/1000.0, 'unixepoch')` so the comparison is
 * string-vs-string in the same `YYYY-MM-DD HH:MM:SS` UTC format.
 *
 * Delivery semantics: the `notification_log` criterion counts only rows whose
 * `status` reflects the owner actually receiving the notification — see
 * `NOTIFICATION_DELIVERED_STATUSES` below.
 */

/** Everything a criterion needs, resolved once per execution by the recorder. */
export interface CriteriaEvalContext {
  db: Database.Database;
  /** Resolved context-vault root (`getContextDir`). */
  contextDir: string;
  /** `agents.id` (slug) — scopes the `agent_action_count` criterion. */
  agentId: string;
  /** Epoch-ms execution start — anchors both time-window criteria. */
  startedAt: number;
  /** Agent-day `YYYY-MM-DD` label, substituted into every `{date}` placeholder. */
  dateStr: string;
}

/** Structured per-criterion warning the caller logs (best-effort failures). */
export interface CriterionWarning {
  id: string;
  kind: SuccessCriterion["kind"];
  message: string;
}

export interface SuccessCriteriaResult {
  /** `criterion.id → met?`; written verbatim to `success_criteria_json`. */
  hits: Record<string, boolean>;
  /** Non-fatal evaluation problems (unresolvable path, DB error, …). */
  warnings: CriterionWarning[];
}

/** Internal per-criterion outcome before it is folded into the result maps. */
interface CriterionOutcome {
  hit: boolean;
  /** Set when the criterion could not be assessed (records `false` + warns). */
  warning?: string;
}

/** Replace every `{date}` occurrence in a target path with the agent-day label. */
function substituteDate(target: string, dateStr: string): string {
  return target.split("{date}").join(dateStr);
}

/**
 * Count ATX markdown headings whose hash-run length is *exactly* `level` — a
 * `###` does NOT count toward a `##`/level-2 floor. Lines inside fenced code
 * blocks (``` ``` ``` or `~~~`, up to 3 leading spaces) are skipped so a `## x`
 * in an example block never inflates the count. A heading allows 0–3 leading
 * spaces (4+ is an indented code block in CommonMark) and is terminated by a
 * space, a tab, or end-of-line (an empty `##` heading still counts).
 */
function countHeadings(markdown: string, level: 1 | 2 | 3): number {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceChar = "";
  let count = 0;
  for (const line of lines) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^ {0,3}(#{1,6})(?: |\t|$)/);
    if (heading && heading[1].length === level) count += 1;
  }
  return count;
}

function evalFileExists(
  criterion: Extract<SuccessCriterion, { kind: "file_exists" }>,
  ctx: CriteriaEvalContext,
): CriterionOutcome {
  const target = substituteDate(criterion.target, ctx.dateStr);
  const abs = safePath(ctx.contextDir, target);
  if (abs === null) {
    return { hit: false, warning: `unresolvable or out-of-vault target "${target}"` };
  }
  return { hit: existsSync(abs) };
}

function evalFileSectionCount(
  criterion: Extract<SuccessCriterion, { kind: "file_section_count" }>,
  ctx: CriteriaEvalContext,
): CriterionOutcome {
  const target = substituteDate(criterion.target, ctx.dateStr);
  const abs = safePath(ctx.contextDir, target);
  if (abs === null) {
    return { hit: false, warning: `unresolvable or out-of-vault target "${target}"` };
  }
  // An absent file is a legitimate criterion miss (the output was not produced),
  // not an error — return false without a warning. A present-but-unreadable file
  // (e.g. a directory at the path → EISDIR) throws out to the loop's catch.
  if (!existsSync(abs)) {
    return { hit: false };
  }
  const body = readFileSync(abs, "utf-8");
  return { hit: countHeadings(body, criterion.heading_level) >= criterion.min };
}

// A notification only counts as *delivered* (the criterion is named
// `delivered_within_minutes`) when it actually reached the owner. The two
// terminal statuses that mean "the owner never received it" are excluded:
//   - 'failed'     — delivery errored (notification-manager.ts:387/551).
//   - 'suppressed' — deliberately withheld: quiet hours, dedup, or a batch
//     window that expired without flushing (notification-manager.ts:436+).
// 'delivered' (sent now) and 'batched' (folded into a digest the owner does
// receive) both count. Matching every row regardless of status — as the bare
// §8.3 prose literal did — would let a *failed* digest satisfy a
// `dm_digest_delivered` check, reporting success for a notification the owner
// never saw. (The column is window-bounded on `created_at` because
// `delivered_at` is nullable; status is the always-populated delivery verdict.)
const NOTIFICATION_DELIVERED_STATUSES = "('delivered', 'batched')";

function evalNotificationLog(
  criterion: Extract<SuccessCriterion, { kind: "notification_log" }>,
  ctx: CriteriaEvalContext,
): CriterionOutcome {
  const upperMs = ctx.startedAt + criterion.delivered_within_minutes * 60_000;
  const row = ctx.db
    .prepare<[string, number, number], { present: number }>(
      `SELECT 1 AS present FROM notification_log
        WHERE notification_type = ?
          AND status IN ${NOTIFICATION_DELIVERED_STATUSES}
          AND created_at >= datetime(?/1000.0, 'unixepoch')
          AND created_at <= datetime(?/1000.0, 'unixepoch')
        LIMIT 1`,
    )
    .get(criterion.notification_type, ctx.startedAt, upperMs);
  return { hit: row !== undefined };
}

function evalAgentActionCount(
  criterion: Extract<SuccessCriterion, { kind: "agent_action_count" }>,
  ctx: CriteriaEvalContext,
): CriterionOutcome {
  const row = ctx.db
    .prepare<[string, string, number], { n: number }>(
      `SELECT COUNT(*) AS n FROM agent_actions
        WHERE agent_id = ?
          AND action_type = ?
          AND started_at >= datetime(?/1000.0, 'unixepoch')`,
    )
    .get(ctx.agentId, criterion.action_type, ctx.startedAt);
  // COUNT(*) always returns exactly one row, so `row` is defined.
  return { hit: row!.n >= criterion.min };
}

function evaluateOne(
  criterion: SuccessCriterion,
  ctx: CriteriaEvalContext,
): CriterionOutcome {
  switch (criterion.kind) {
    case "file_exists":
      return evalFileExists(criterion, ctx);
    case "file_section_count":
      return evalFileSectionCount(criterion, ctx);
    case "notification_log":
      return evalNotificationLog(criterion, ctx);
    case "agent_action_count":
      return evalAgentActionCount(criterion, ctx);
  }
}

/**
 * Evaluate every criterion best-effort and return the `{ hits, warnings }`
 * rollup. `hits` is written verbatim to `agent_executions.success_criteria_json`
 * (keyed by `criterion.id` — the shared schema enforces id uniqueness, so no
 * sibling can be silently overwritten).
 */
export function evaluateSuccessCriteria(
  criteria: readonly SuccessCriterion[],
  ctx: CriteriaEvalContext,
): SuccessCriteriaResult {
  const hits: Record<string, boolean> = {};
  const warnings: CriterionWarning[] = [];
  for (const criterion of criteria) {
    try {
      const outcome = evaluateOne(criterion, ctx);
      hits[criterion.id] = outcome.hit;
      if (outcome.warning !== undefined) {
        warnings.push({ id: criterion.id, kind: criterion.kind, message: outcome.warning });
      }
    } catch (err) {
      hits[criterion.id] = false;
      warnings.push({
        id: criterion.id,
        kind: criterion.kind,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { hits, warnings };
}
