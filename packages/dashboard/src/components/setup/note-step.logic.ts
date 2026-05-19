/**
 * SETUP-FLOW-REDESIGN-PLAN §5.6 — Note step pure logic.
 *
 * The Note step writes to **two** systems:
 *   1. Notion — via `PATCH /api/integrations/notion`. Mode + (in direct
 *      mode) API key + DB mappings, all owned by the existing
 *      `IntegrationCard` + `NotionDirectSettingsBody` components.
 *   2. External Obsidian vault — `externalObsidianVaultPath` +
 *      `externalObsidianWatch` via `PATCH /api/config`. Validation:
 *      path must be absolute, must not overlap `dataDir`, must not
 *      overlap the primary vault. The daemon's `validateExternalObsidianVaultPath`
 *      is the source of truth; we mirror its prefix checks client-side
 *      so the user gets an immediate signal without a round-trip.
 */

import {
  isClientAbsolutePath,
  isClientPathInsideOrEqual,
} from "@/lib/path-client";

export interface NoteStepFields {
  externalObsidianVaultPath: string;
  externalObsidianWatch: boolean;
}

export const DEFAULT_NOTE_STEP_FIELDS: NoteStepFields = {
  externalObsidianVaultPath: "",
  externalObsidianWatch: true,
};

/**
 * Pre-flight client-side path check. Mirrors the prefix rules in
 * `daemon/src/config.ts:validateExternalObsidianVaultPath` — the
 * daemon re-runs the full validation server-side, so this is just an
 * immediate-feedback layer.
 */
export type NotePathIssue =
  | "empty"
  | "not_absolute"
  | "overlaps_data_dir"
  | "overlaps_primary_vault";

export interface ValidateExternalVaultPathInput {
  path: string;
  dataDir: string;
  primaryVaultPath: string | null;
}

export function validateExternalVaultPathClient(
  input: ValidateExternalVaultPathInput,
): NotePathIssue | null {
  const trimmed = input.path.trim();
  if (trimmed.length === 0) return "empty";
  if (!isClientAbsolutePath(trimmed)) {
    return "not_absolute";
  }
  // Prefix-match against the data-dir; do a normalised strip so trailing
  // slashes don't confuse the check. The daemon does a stat-based realpath
  // resolution; here we approximate with raw prefix match. False
  // positives (a sibling that *starts with* dataDir) are rare and the
  // server re-runs the real validation.
  if (
    input.dataDir.length > 0
    && isClientPathInsideOrEqual(input.dataDir, trimmed)
  ) {
    return "overlaps_data_dir";
  }
  if (
    input.primaryVaultPath
    && isClientPathInsideOrEqual(input.primaryVaultPath, trimmed)
  ) {
    return "overlaps_primary_vault";
  }
  return null;
}

/** Human-readable inline error messages keyed off `NotePathIssue`. */
export function notePathIssueMessage(issue: NotePathIssue): string {
  switch (issue) {
    case "empty":
      return "Pick a path or leave the field blank to skip.";
    case "not_absolute":
      return "Use an absolute path (for example `/Users/me/Vault`, `~/Vault`, or `C:\\Vault`).";
    case "overlaps_data_dir":
      return "Path overlaps the agent's data directory; choose a separate location.";
    case "overlaps_primary_vault":
      return "Path overlaps the agent's primary vault; choose a separate location.";
  }
}

/**
 * Continue-button enablement. Empty path is **allowed** — the user is
 * skipping the external-vault opt-in; in that case the field is just
 * not persisted. A non-empty path with a validation issue blocks.
 */
export function canContinue(input: {
  pathIssue: NotePathIssue | null;
  saving: boolean;
}): boolean {
  if (input.saving) return false;
  if (input.pathIssue === null) return true;
  // Empty is the implicit-skip path — allow.
  return input.pathIssue === "empty";
}

/**
 * Build the `PATCH /api/config` body for the Note step. Path is
 * trimmed; an empty path resolves to `null` so the daemon clears the
 * field (lets the user un-pair an Obsidian vault from the wizard).
 */
export interface NotePatchBody {
  externalObsidianVaultPath: string | null;
  externalObsidianWatch: boolean;
}

export function buildNotePatchBody(
  fields: NoteStepFields,
): NotePatchBody {
  const trimmed = fields.externalObsidianVaultPath.trim();
  return {
    externalObsidianVaultPath: trimmed.length === 0 ? null : trimmed,
    externalObsidianWatch: fields.externalObsidianWatch,
  };
}
