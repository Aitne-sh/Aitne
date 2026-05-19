// P22 §4 — drift-signal recording, weight calculation, skill selection.
//
// Helpers around the `skill_curation_signals` table:
//   - `recordSignal()` — INSERT
//   - `unconsumedSignalsBySkill()` — fetch grouped
//   - `markSignalsConsumed(ids, proposalId)` — flip consumed_at
//   - `weightSignal(type, payload)` — per §4.2 weight table
//   - `selectSkillsForRun(snapshot)` — apply weight + cooldown rules
//
// Preview release ships only `structure_diff` as a signal source — the
// hourly walker watches the user's knowledge tree and writes one row per
// observed change. Search-miss / agent-feedback / owner-correction signal
// types were removed when the feature pivoted to "silent background
// optimization, no user feedback collection burden".
//
// Cooldowns (§4.2 last bullets) are computed by `selectSkillsForRun` from
// `skill_curation_proposals` history; nothing is pre-stored — weights are
// recomputed at fire time so changes to the table take effect immediately.

import type Database from "better-sqlite3";

export type SignalType = "structure_diff";

export interface SignalRow {
  id: number;
  skill_slug: string;
  section_id: string | null;
  signal_type: SignalType;
  payload_json: string;
  observed_at: number;
  consumed_at: number | null;
  consumed_by_proposal_id: number | null;
}

export interface RecordSignalInput {
  skill_slug: string;
  section_id?: string | null;
  signal_type: SignalType;
  payload: unknown;
  observed_at?: number;
}

export function recordSignal(db: Database.Database, input: RecordSignalInput): number {
  const observedAt = input.observed_at ?? Date.now();
  const stmt = db.prepare(`
    INSERT INTO skill_curation_signals
      (skill_slug, section_id, signal_type, payload_json, observed_at)
    VALUES
      (@skill_slug, @section_id, @signal_type, @payload_json, @observed_at)
  `);
  const r = stmt.run({
    skill_slug: input.skill_slug,
    section_id: input.section_id ?? null,
    signal_type: input.signal_type,
    payload_json: JSON.stringify(input.payload),
    observed_at: observedAt,
  });
  return Number(r.lastInsertRowid);
}

export function unconsumedSignalsForSkill(
  db: Database.Database,
  skill_slug: string,
): SignalRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM skill_curation_signals
       WHERE skill_slug = ? AND consumed_at IS NULL
       ORDER BY observed_at ASC`,
    )
    .all(skill_slug);
  return rows as SignalRow[];
}

export function unconsumedSignalsAll(db: Database.Database): SignalRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM skill_curation_signals
       WHERE consumed_at IS NULL
       ORDER BY skill_slug, observed_at ASC`,
    )
    .all();
  return rows as SignalRow[];
}

export function markSignalsConsumed(
  db: Database.Database,
  ids: number[],
  proposalId: number,
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const stmt = db.prepare(
    `UPDATE skill_curation_signals
     SET consumed_at = ?, consumed_by_proposal_id = ?
     WHERE id IN (${placeholders})`,
  );
  stmt.run(Date.now(), proposalId, ...ids);
}

// ── Weight + age table (P22 §4.2) ─────────────────────────────────────────

interface WeightRule {
  weight: number;
  minAgeMs: number;
}

export function weightFor(signal: SignalRow, now: number = Date.now()): number {
  const rule = ruleFor(signal);
  if (now - signal.observed_at < rule.minAgeMs) return 0;
  return rule.weight;
}

function ruleFor(signal: SignalRow): WeightRule {
  // Only `structure_diff` ships in Preview. File add/remove signals weigh
  // more than heading-level changes because they mark coarser drift
  // (a whole new file is "the user reorganised", a new heading is "the
  // user added a sub-area"). All structure_diff signals require 24h of
  // age before they count — short-lived churn (created and immediately
  // reverted) shouldn't trigger a run.
  const payload = safeParse(signal.payload_json);
  const subKind = (payload && (payload as Record<string, unknown>).sub_kind) ?? "";
  if (subKind === "file_add" || subKind === "file_remove") {
    return { weight: 2, minAgeMs: 24 * 60 * 60 * 1000 };
  }
  return { weight: 1, minAgeMs: 24 * 60 * 60 * 1000 };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Skill selection (P22 §4.2 + §3.4 step 3) ─────────────────────────────

export interface SkillSelection {
  skill_slug: string;
  weight: number;
  signal_ids: number[];
  cooldown_blocked: boolean;
  high_priority: boolean;
}

export interface SelectionOptions {
  /** Skills with `weight ≥ this` enter the run. Default 3 per §4.2.
   *  Manual runs (P22 §6.4) pass `0` to bypass the threshold. */
  minWeight?: number;
  /** Skills with `weight ≥ this` get high priority. Default 6. */
  highWeight?: number;
  /** Cooldown after a proposal landed in `applied` (ms). Default 7d. */
  appliedCooldownMs?: number;
  /** Cooldown after `auto_reverted` / `conflict` (ms). Default 14d. */
  revertedCooldownMs?: number;
  /** Skills the operator excluded via /settings/self-learning. */
  excludedSlugs?: Set<string>;
  /** Manual runs (P22 §6.4) ignore cooldowns — owner asked explicitly. */
  ignoreCooldowns?: boolean;
  now?: number;
}

export function selectSkillsForRun(
  db: Database.Database,
  options: SelectionOptions = {},
): SkillSelection[] {
  const now = options.now ?? Date.now();
  const minWeight = options.minWeight ?? 3;
  const highWeight = options.highWeight ?? 6;
  const appliedCooldownMs = options.appliedCooldownMs ?? 7 * 24 * 60 * 60 * 1000;
  const revertedCooldownMs = options.revertedCooldownMs ?? 14 * 24 * 60 * 60 * 1000;
  const excluded = options.excludedSlugs ?? new Set<string>();
  const ignoreCooldowns = options.ignoreCooldowns ?? false;

  const grouped = new Map<string, { weight: number; signalIds: number[] }>();
  for (const sig of unconsumedSignalsAll(db)) {
    if (excluded.has(sig.skill_slug)) continue;
    const w = weightFor(sig, now);
    const cur = grouped.get(sig.skill_slug) ?? { weight: 0, signalIds: [] };
    cur.weight += w;
    if (w > 0) cur.signalIds.push(sig.id);
    grouped.set(sig.skill_slug, cur);
  }

  const selections: SkillSelection[] = [];
  for (const [slug, agg] of grouped) {
    if (agg.weight < minWeight) continue;
    const cooldownBlocked = ignoreCooldowns
      ? false
      : isOnCooldown(db, slug, now, appliedCooldownMs, revertedCooldownMs);
    selections.push({
      skill_slug: slug,
      weight: agg.weight,
      signal_ids: agg.signalIds,
      cooldown_blocked: cooldownBlocked,
      high_priority: agg.weight >= highWeight,
    });
  }
  selections.sort((a, b) => b.weight - a.weight);
  return selections;
}

function isOnCooldown(
  db: Database.Database,
  skillSlug: string,
  now: number,
  appliedCooldownMs: number,
  revertedCooldownMs: number,
): boolean {
  // Cooldown is measured from the moment a proposal *resolved* (decided_at)
  // — not when it was first proposed. A proposal proposed three weeks ago
  // but applied yesterday should still be "fresh" for the 7-day cooldown.
  // Per §4.2: "a section that had a proposal applied within the last
  // 7 days is excluded". COALESCE keeps legacy rows (decided_at never
  // written for old applied rows) from looking infinitely old.
  const appliedRow = db
    .prepare(
      `SELECT MAX(COALESCE(decided_at, proposed_at)) AS last
       FROM skill_curation_proposals
       WHERE skill_slug = ? AND status = 'applied'`,
    )
    .get(skillSlug) as { last: number | null };
  if (appliedRow.last !== null && now - appliedRow.last < appliedCooldownMs) return true;
  const revertedRow = db
    .prepare(
      `SELECT MAX(COALESCE(decided_at, proposed_at)) AS last
       FROM skill_curation_proposals
       WHERE skill_slug = ? AND status IN ('auto_reverted', 'conflict')`,
    )
    .get(skillSlug) as { last: number | null };
  if (revertedRow.last !== null && now - revertedRow.last < revertedCooldownMs) return true;
  return false;
}
