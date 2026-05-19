// P22 §2.2 + §5.3 — proposal apply hot path + system-driven auto-revert.
//
// applyProposal — called inside the `POST /api/skill-curation/proposals`
// chokepoint after every validation gate (auth, declaration, schema, diff
// caps, render budget, smoke test) has passed. Inserts the row, writes
// the overlay JSON, snapshots the prior overlay to history, and emits an
// audit log entry. The proposal lands in `status='applied'` directly;
// there is no owner-approval gate. When the current overlay's hash
// differs from the proposal's `prev_payload` (the optimizer raced
// against another writer), the row is persisted with `status='conflict'`
// and no overlay is written.
//
// recordFailedProposal — called by the chokepoint when a validation gate
// (diff caps, byte budget, smoke test) rejects the payload. The row is
// kept for audit ("why did the optimizer give up on X?") but no overlay
// is written and signals stay unconsumed so a fresh attempt can retry.
//
// autoRevertProposal — called by the §5.3 sweep when a previously-applied
// proposal accumulates new signals after apply, indicating the change
// did not "settle" the drift. Restores the prior overlay from the
// history snapshot, flips the row to `status='auto_reverted'`, and
// audits as `decided_by='system'`. This is the only roll-back path —
// the on/off toggle is the operator's only manual handle (§5.2 / §6.2).

import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  type CurationPayloadValue,
  type OverlayEnvelopeValue,
  SKILL_CURATION_SCHEMA_VERSION,
  type SectionKind,
} from "@aitne/shared";
import { OverlayStore, payloadHash } from "./overlay-store.js";

// ── Shared row + audit shapes ───────────────────────────────────────────

export interface DiffSummary {
  additions: number;
  modifications: number;
  removals: number;
  kind: string;
}

export type ProposalStatus =
  | "applied"
  | "auto_reverted"
  | "conflict"
  | "smoke_failed"
  | "diff_caps"
  | "render_budget";

/** Common shape — every proposal row starts as one of these regardless
 *  of which status branch persists it. The chokepoint's gates fan out
 *  into apply/conflict/failure paths but the row schema is identical. */
interface ProposalCore {
  runId: string;
  skill_slug: string;
  section_id: string;
  section_kind: SectionKind;
  prev_payload: CurationPayloadValue;
  new_payload: CurationPayloadValue;
  rendered_md: string;
  rendererVersion: string;
  rationale: string;
  signal_ids: number[];
  diff: DiffSummary;
}

interface ProposalRowFields extends ProposalCore {
  status: ProposalStatus;
  smoke_passed: boolean;
  smoke_failures_json: string | null;
  applied_overlay_path: string | null;
  decided_by: "auto" | "system";
  now: number;
}

// ── apply path ──────────────────────────────────────────────────────────

export interface ApplyProposalInput extends ProposalCore {
  db: Database.Database;
  overlay: OverlayStore;
  /** SkillsCompiler cache invalidation hook — fired only on success. */
  onApplied?: (slug: string, sectionId: string) => void;
  now?: number;
}

export type ApplyOutcome =
  | { ok: true; proposalId: number; status: "applied"; overlayPath: string }
  | { ok: false; proposalId: number; status: "conflict"; message: string };

export function applyProposal(input: ApplyProposalInput): ApplyOutcome {
  const now = input.now ?? Date.now();
  const overlayPath = input.overlay.paths.overlayPath(
    input.skill_slug,
    input.section_id,
  );

  // First-ever overlay: there's no envelope to compare against, so the
  // optimizer's `prev_payload` (sourced from the seed at proposal time)
  // is itself the baseline.
  const current = input.overlay.readPayload(
    input.skill_slug,
    input.section_id,
    input.section_kind,
  );
  const compareTo = current ?? input.prev_payload;
  if (payloadHash(compareTo) !== payloadHash(input.prev_payload)) {
    // Conflict — persist for audit, do not write overlay. Signals stay
    // unconsumed (caller's responsibility) so the next run can re-attempt
    // with a fresh `prev_payload`.
    const proposalId = insertProposalRow(input.db, {
      ...input,
      status: "conflict",
      smoke_passed: true,
      smoke_failures_json: null,
      applied_overlay_path: null,
      decided_by: "auto",
      now,
    });
    insertAuditRow(input.db, "skill_curation_conflict", proposalId, input, now);
    return {
      ok: false,
      proposalId,
      status: "conflict",
      message: "current overlay differs from proposal's prev_payload",
    };
  }

  const proposalId = insertProposalRow(input.db, {
    ...input,
    status: "applied",
    smoke_passed: true,
    smoke_failures_json: null,
    applied_overlay_path: overlayPath,
    decided_by: "auto",
    now,
  });

  const envelope: OverlayEnvelopeValue = {
    schema_version: SKILL_CURATION_SCHEMA_VERSION,
    skill_slug: input.skill_slug,
    section_id: input.section_id,
    kind: input.section_kind,
    payload: input.new_payload,
    applied_proposal_id: proposalId,
    applied_at: now,
  };
  // OverlayStore.write also snapshots the prior envelope into history/<id>.json
  // — that snapshot is what auto-revert restores from.
  input.overlay.write(envelope, proposalId);

  insertAuditRow(input.db, "skill_curation_applied", proposalId, input, now);

  if (input.onApplied) input.onApplied(input.skill_slug, input.section_id);
  return { ok: true, proposalId, status: "applied", overlayPath };
}

// ── failed-proposal persistence (diff_caps / render_budget / smoke_failed) ──

export interface RecordFailedProposalInput extends ProposalCore {
  db: Database.Database;
  status: "smoke_failed" | "diff_caps" | "render_budget";
  failure_detail: unknown;
  now?: number;
}

export function recordFailedProposal(input: RecordFailedProposalInput): number {
  const now = input.now ?? Date.now();
  return insertProposalRow(input.db, {
    ...input,
    smoke_passed: false,
    smoke_failures_json: JSON.stringify(input.failure_detail),
    applied_overlay_path: null,
    decided_by: "auto",
    now,
  });
}

// ── auto-revert path (§5.3 — system-only) ──────────────────────────────

export interface AutoRevertInput {
  db: Database.Database;
  overlay: OverlayStore;
  proposalId: number;
  /** Same SkillsCompiler cache hook as applyProposal — fires on success. */
  onApplied?: (slug: string, sectionId: string) => void;
  now?: number;
}

export type AutoRevertOutcome =
  | { ok: true; proposalId: number }
  | { ok: false; status: "missing" | "wrong_state"; message: string };

interface AutoRevertRow {
  id: number;
  run_id: string;
  skill_slug: string;
  section_id: string;
  section_kind: SectionKind;
  status: string;
  diff_kind: string;
}

export function autoRevertProposal(input: AutoRevertInput): AutoRevertOutcome {
  const now = input.now ?? Date.now();
  const row = input.db
    .prepare(
      `SELECT id, run_id, skill_slug, section_id, section_kind, status, diff_kind
       FROM skill_curation_proposals WHERE id = ?`,
    )
    .get(input.proposalId) as AutoRevertRow | undefined;
  if (!row) {
    return { ok: false, status: "missing", message: `proposal ${input.proposalId} not found` };
  }
  // Only `applied` proposals own an overlay write that can be undone.
  // auto_reverted rows are already rolled back; conflict / smoke_failed /
  // diff_caps / render_budget never wrote an overlay.
  if (row.status !== "applied") {
    return {
      ok: false,
      status: "wrong_state",
      message: `proposal status=${row.status} cannot be auto-reverted`,
    };
  }

  const histPath = input.overlay.paths.historyPath(row.skill_slug, input.proposalId);
  if (existsSync(histPath)) {
    input.overlay.restoreFromHistory(row.skill_slug, row.section_id, input.proposalId);
  } else {
    // First-ever overlay for this section — no prior snapshot. Revert
    // means deleting the overlay so the seed renders again.
    input.overlay.delete(row.skill_slug, row.section_id);
  }

  input.db
    .prepare(
      `UPDATE skill_curation_proposals
       SET status = 'auto_reverted', decided_at = ?, decided_by = 'system'
       WHERE id = ?`,
    )
    .run(now, input.proposalId);

  insertAuditRow(input.db, "skill_curation_auto_reverted", input.proposalId, {
    runId: row.run_id,
    skill_slug: row.skill_slug,
    section_id: row.section_id,
    section_kind: row.section_kind,
    diff_kind: row.diff_kind,
  }, now);

  if (input.onApplied) input.onApplied(row.skill_slug, row.section_id);
  return { ok: true, proposalId: input.proposalId };
}

// ── private helpers ─────────────────────────────────────────────────────

function insertProposalRow(
  db: Database.Database,
  fields: ProposalRowFields,
): number {
  const r = db
    .prepare(
      `INSERT INTO skill_curation_proposals
        (run_id, skill_slug, section_id, section_kind, schema_version,
         renderer_version_at_proposal, prev_payload_json, new_payload_json,
         rendered_md, diff_additions, diff_modifications, diff_removals,
         diff_kind, rationale, signals_json, smoke_passed_at,
         smoke_failures_json, status, proposed_at, decided_at, decided_by,
         applied_overlay_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.runId,
      fields.skill_slug,
      fields.section_id,
      fields.section_kind,
      SKILL_CURATION_SCHEMA_VERSION,
      fields.rendererVersion,
      JSON.stringify(fields.prev_payload),
      JSON.stringify(fields.new_payload),
      fields.rendered_md,
      fields.diff.additions,
      fields.diff.modifications,
      fields.diff.removals,
      fields.diff.kind,
      fields.rationale,
      JSON.stringify(fields.signal_ids),
      fields.smoke_passed ? fields.now : null,
      fields.smoke_failures_json,
      fields.status,
      fields.now,
      fields.now,
      fields.decided_by,
      fields.applied_overlay_path,
    );
  return Number(r.lastInsertRowid);
}

interface AuditDetail {
  runId: string;
  skill_slug: string;
  section_id: string;
  section_kind: SectionKind;
  diff_kind: string;
}

/** Audit detail accepts either an `ApplyProposalInput` (where diff is a
 *  full `DiffSummary`) or an explicit `AuditDetail` (autoRevert has only
 *  the row's diff_kind, no live diff). The body is the same JSON shape. */
function insertAuditRow(
  db: Database.Database,
  action_type: string,
  proposalId: number,
  source: ApplyProposalInput | AuditDetail,
  now: number,
): void {
  const detail: AuditDetail =
    "diff" in source
      ? {
          runId: source.runId,
          skill_slug: source.skill_slug,
          section_id: source.section_id,
          section_kind: source.section_kind,
          diff_kind: source.diff.kind,
        }
      : source;
  const ts = Math.floor(now / 1000);
  db.prepare(
    `INSERT INTO agent_actions (action_type, result, started_at, completed_at, detail)
     VALUES (?, 'success', datetime(?, 'unixepoch'), datetime(?, 'unixepoch'), ?)`,
  ).run(
    action_type,
    ts,
    ts,
    JSON.stringify({
      proposal_id: proposalId,
      skill_slug: detail.skill_slug,
      section_id: detail.section_id,
      kind: detail.section_kind,
      diff_kind: detail.diff_kind,
      run_id: detail.runId,
    }),
  );
}
