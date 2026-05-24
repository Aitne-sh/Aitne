// P22 §5.3 — auto-revert + 2-cycle freeze.
//
// Each cadence cycle, before spawning a new optimizer run, the daemon
// re-evaluates recently-applied proposals: if the section has accumulated
// MORE signals (post-apply) than were present at apply time, the apply
// did not "settle" the drift and is rolled back automatically. The section
// is then marked `frozen` for two cadence cycles to prevent thrashing.
//
// This is the ONLY roll-back path. There is no owner-driven approve /
// reject / revert API — the operator's only manual handle is the on/off
// toggle (which stops new runs and tells SkillsCompiler to render seeds
// only).
//
// Detection heuristic (deterministic, no LLM):
//   - Walk every `applied` proposal whose `decided_at` falls within the
//     regression window (default 21 days — covers 2 weekly cycles plus a
//     slack day so revert fires before the cooldown lifts).
//   - Compute total weighted signal weight observed for `(skill_slug,
//     section_id)` AFTER `decided_at`. Use the same weight table as
//     selectSkillsForRun (so the threshold is consistent).
//   - If post-apply weight ≥ `regressionThresholdWeight` (default 3),
//     auto-revert via `autoRevertProposal()` and add
//     `<slug>:<section_id>` to `runtime_state.skill_curation.frozen[]`
//     with a 2-cycle countdown.
//
// Cycle countdown:
//   - On every successful auto-revert, the entry's `cycles_remaining` is
//     set to 2.
//   - On every cadence fire (call to `tickFrozenCycles()`), every entry's
//     counter decrements. Entries reaching 0 are removed.
//   - The smoke-test gate `frozen_sections_unchanged` consults this set
//     via `readFrozenSet()`.

import type Database from "better-sqlite3";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../../db/runtime-state.js";
import { autoRevertProposal } from "./apply-proposal.js";
import type { OverlayStore } from "./overlay-store.js";
import { weightFor, type SignalRow } from "./signals.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("skill-curation-auto-revert");

const FROZEN_KEY = "skill_curation.frozen";
const DEFAULT_REGRESSION_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
const DEFAULT_REGRESSION_THRESHOLD = 3;
const DEFAULT_FREEZE_CYCLES = 2;

interface FrozenEntry {
  /** `<slug>:<section_id>` */
  key: string;
  cycles_remaining: number;
  frozen_at: number;
  reason: string;
  proposal_id?: number;
}

interface FrozenState {
  entries: FrozenEntry[];
}

export interface AutoRevertSweepOptions {
  now?: number;
  regressionWindowMs?: number;
  regressionThresholdWeight?: number;
  freezeCycles?: number;
  /** Test seam — defaults to live autoRevertProposal. */
  revertProposalImpl?: typeof autoRevertProposal;
}

export interface AutoRevertOutcome {
  reverted: number;
  proposals_inspected: number;
  newly_frozen: { slug: string; section_id: string }[];
}

interface CandidateRow {
  id: number;
  skill_slug: string;
  section_id: string;
  status: string;
  decided_at: number | null;
  proposed_at: number;
}

/** Read the current frozen entries set as a flat `<slug>:<section_id>` set,
 *  the form expected by the smoke-test `frozen_sections_unchanged` check. */
export function readFrozenSet(db: Database.Database): Set<string> {
  const state = readRuntimeState<FrozenState>(db, FROZEN_KEY);
  if (!state) return new Set();
  return new Set(state.entries.map((e) => e.key));
}

/** Decrement every entry's `cycles_remaining`, drop entries reaching 0.
 *  Call once per cadence cycle BEFORE spawning the optimizer (so a section
 *  that was frozen 2 cycles ago becomes eligible again on the third). */
export function tickFrozenCycles(db: Database.Database): {
  unfrozen: { slug: string; section_id: string }[];
} {
  const state = readRuntimeState<FrozenState>(db, FROZEN_KEY);
  if (!state || state.entries.length === 0) return { unfrozen: [] };
  const unfrozen: { slug: string; section_id: string }[] = [];
  const next: FrozenEntry[] = [];
  for (const entry of state.entries) {
    const remaining = entry.cycles_remaining - 1;
    if (remaining <= 0) {
      const [slug, section_id] = entry.key.split(":");
      unfrozen.push({ slug, section_id });
    } else {
      next.push({ ...entry, cycles_remaining: remaining });
    }
  }
  writeRuntimeState(db, FROZEN_KEY, { entries: next });
  return { unfrozen };
}

/** Add (or refresh) a freeze entry. Idempotent; if the same key already
 *  exists, its countdown is reset to `freezeCycles`. */
export function freezeSection(
  db: Database.Database,
  slug: string,
  section_id: string,
  reason: string,
  options?: { freezeCycles?: number; now?: number; proposal_id?: number },
): void {
  const cycles = options?.freezeCycles ?? DEFAULT_FREEZE_CYCLES;
  const now = options?.now ?? Date.now();
  const key = `${slug}:${section_id}`;
  const state = readRuntimeState<FrozenState>(db, FROZEN_KEY) ?? { entries: [] };
  const without = state.entries.filter((e) => e.key !== key);
  const entry: FrozenEntry = {
    key,
    cycles_remaining: cycles,
    frozen_at: now,
    reason,
    ...(options?.proposal_id !== undefined ? { proposal_id: options.proposal_id } : {}),
  };
  writeRuntimeState(db, FROZEN_KEY, { entries: [...without, entry] });
}

/** Detect regressed proposals + auto-revert + freeze. Idempotent — every
 *  proposal that has already been reverted is skipped on subsequent calls
 *  because its status flips to `reverted`. */
export function autoRevertSweep(
  db: Database.Database,
  overlay: OverlayStore,
  options: AutoRevertSweepOptions = {},
): AutoRevertOutcome {
  const now = options.now ?? Date.now();
  const windowMs = options.regressionWindowMs ?? DEFAULT_REGRESSION_WINDOW_MS;
  const thresholdWeight = options.regressionThresholdWeight ?? DEFAULT_REGRESSION_THRESHOLD;
  const freezeCycles = options.freezeCycles ?? DEFAULT_FREEZE_CYCLES;
  const revertImpl = options.revertProposalImpl ?? autoRevertProposal;

  const cutoff = now - windowMs;
  const candidates = db
    .prepare(
      `SELECT id, skill_slug, section_id, status, decided_at, proposed_at
       FROM skill_curation_proposals
       WHERE status = 'applied'
         AND COALESCE(decided_at, proposed_at) >= ?
       ORDER BY COALESCE(decided_at, proposed_at) ASC`,
    )
    .all(cutoff) as CandidateRow[];

  const newlyFrozen: { slug: string; section_id: string }[] = [];
  let reverted = 0;

  for (const c of candidates) {
    const appliedAt = c.decided_at ?? c.proposed_at;
    const postApplyWeight = computeWeightSince(db, c.skill_slug, c.section_id, appliedAt, now);
    if (postApplyWeight < thresholdWeight) continue;

    const r = revertImpl({ db, overlay, proposalId: c.id, now });
    if (!r.ok) {
      logger.warn(
        { proposal_id: c.id, status: r.status, message: r.message },
        "auto-revert failed",
      );
      continue;
    }
    reverted++;
    freezeSection(db, c.skill_slug, c.section_id, "regression", {
      freezeCycles,
      now,
      proposal_id: c.id,
    });
    newlyFrozen.push({ slug: c.skill_slug, section_id: c.section_id });
    logger.info(
      {
        proposal_id: c.id,
        slug: c.skill_slug,
        section_id: c.section_id,
        post_apply_weight: postApplyWeight,
      },
      "auto-revert + freeze",
    );
  }

  return {
    reverted,
    proposals_inspected: candidates.length,
    newly_frozen: newlyFrozen,
  };
}

/** Sum signal weights for `(slug, section_id)` whose `observed_at >= since`.
 *  `section_id IS NULL` whole-skill signals don't count toward a single
 *  section's regression — they're tracked separately. */
function computeWeightSince(
  db: Database.Database,
  slug: string,
  section_id: string,
  since: number,
  now: number,
): number {
  const rows = db
    .prepare(
      `SELECT id, skill_slug, section_id, signal_type, payload_json, observed_at,
              consumed_at, consumed_by_proposal_id
       FROM skill_curation_signals
       WHERE skill_slug = ?
         AND section_id = ?
         AND observed_at > ?`,
    )
    .all(slug, section_id, since) as SignalRow[];
  let weight = 0;
  for (const row of rows) weight += weightFor(row, now);
  return weight;
}
