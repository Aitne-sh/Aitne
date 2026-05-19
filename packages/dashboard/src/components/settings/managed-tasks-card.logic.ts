/**
 * Pure helpers for ManagedTasksCard — split out so render-free
 * assertions (output-path round-trip, soft-warning threshold,
 * dirty-detection, error extraction) stay unit-testable without
 * mounting React.
 *
 * The card itself remains the orchestration shell; every transformation
 * the card performs ends up here so the test surface stays narrow.
 */

import type { ManagedTask } from "@aitne/shared";
import {
  DOMAINS,
  MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
  TYPE_PLURALS,
  pluralToType,
  type Domain,
  type EntityType,
} from "@aitne/shared";
import type { RecurrenceRule } from "@/lib/api-types";
import { ApiError } from "@/lib/api-client";
import { recurrenceRulesEqual } from "./recurrence-rule-editor.logic";

export interface OutputPathState {
  domain: Domain | "";
  type: EntityType | "";
}

/**
 * Round-trip a stored `output_path` string back into the structured
 * `(domain, type)` pair the modify sheet's selectors render. Returns
 * `("", "")` for `null` / unparseable values — the user must then re-
 * pick a valid pair before Save can fire (the daemon's CHECK rejects
 * malformed paths).
 *
 * Examples:
 *   "work/meetings/" → { domain: "work", type: "meeting" }
 *   "finance/receipts/" → { domain: "finance", type: "receipt" }
 *   null / "garbage/" → { domain: "", type: "" }
 */
export function parseOutputPath(path: string | null): OutputPathState {
  if (!path) return { domain: "", type: "" };
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.length !== 2) return { domain: "", type: "" };
  const [domainRaw, plural] = segments;
  const type = pluralToType(plural);
  if (!type) return { domain: "", type: "" };
  if (!(DOMAINS as readonly string[]).includes(domainRaw)) {
    return { domain: "", type: "" };
  }
  return { domain: domainRaw as Domain, type };
}

/**
 * Compose `(domain, type)` back into the §9.3 path form rendered into
 * `output_path`. Returns `null` when either selector is empty —
 * matching the daemon's nullable column semantics for "not yet
 * decided" rows (FR-16).
 */
export function composeOutputPath(state: OutputPathState): string | null {
  if (!state.domain || !state.type) return null;
  return `${state.domain}/${TYPE_PLURALS[state.type]}/`;
}

/**
 * Whether the active-tasks count crosses the §NFR-1a soft-warning
 * threshold. Surfaced as an amber count in the card header so the user
 * notices before the rendered §B section starts approaching the 32 KB
 * policy-files cap. Hard cap (`MANAGEMENT_ACTIVE_TASKS_HARD_CAP`) is
 * enforced server-side at registration; this is the dashboard's
 * earlier-warning surface.
 */
export function isOverSoftWarning(activeCount: number): boolean {
  return activeCount >= MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING;
}

/**
 * Extract a user-facing error string from a thrown value. Preserves
 * `ApiError.message` (which carries the daemon's structured message)
 * and falls back to "operation failed" for non-Error throws so the
 * Alert never renders `undefined`.
 */
export function extractError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "operation failed";
}

/**
 * Field-level dirty-detection for the modify sheet's Save gate.
 * Captures every field the sheet exposes — including the optional
 * `recurrenceRule` followups #1 added — so a single change anywhere
 * enables Save, and a no-op edit (re-typing the same value) does not.
 */
export interface ModifySheetDraft {
  intent: string;
  cadence: string;
  outputPath: string | null;
  /** `null` while the rule is loading or the daemon couldn't return one. */
  recurrenceRule: RecurrenceRule | null;
}

export function modifySheetDirty(
  draft: ModifySheetDraft,
  baseline: {
    task: ManagedTask;
    recurrenceRule: RecurrenceRule | null;
  },
): boolean {
  if (draft.intent.trim() !== baseline.task.intent) return true;
  if (draft.cadence.trim() !== baseline.task.cadence) return true;
  if (draft.outputPath !== baseline.task.output_path) return true;
  if (!recurrenceRulesEqual(draft.recurrenceRule, baseline.recurrenceRule)) {
    return true;
  }
  return false;
}
