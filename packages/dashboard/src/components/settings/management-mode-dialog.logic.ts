/**
 * Pure-logic helpers for `ManagementModeDialog`.
 *
 * Splitting them out keeps the validation testable without mounting
 * the React tree. The real, authoritative validator lives on the
 * daemon (`validatePrimaryVaultPath` in `config.ts`); the checks here
 * are the cheap ones that can run before the debounced server-side
 * validator. Full path inspection (symlink resolution, fs.accessible,
 * overlap with dataDir) now happens in
 * `POST /api/setup/validate-vault-path`.
 */

import {
  hasPathTraversalSegment,
  isClientAbsolutePath,
} from "@/lib/path-client";

export type ClientPathIssueCode =
  | "empty"
  | "not_absolute"
  | "path_traversal";

export interface ClientPathIssue {
  code: ClientPathIssueCode;
  message: string;
}

/**
 * Returns `null` when the path passes the cheap client-side checks.
 * Returns a `ClientPathIssue` otherwise — the code is stable, the
 * message is human-readable.
 */
export function classifyClientPathError(
  path: string,
): ClientPathIssue | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return { code: "empty", message: "Path is required." };
  }
  if (!isClientAbsolutePath(trimmed)) {
    return {
      code: "not_absolute",
      message: "Path must be absolute (for example /Users/me/Vault, ~/Vault, C:\\Vault, or \\\\server\\share).",
    };
  }
  // Reject `..` segments. Split on both separators so Windows paths are
  // covered in the browser before the daemon performs the authoritative check.
  if (hasPathTraversalSegment(trimmed)) {
    return {
      code: "path_traversal",
      message: "Path may not contain `..` segments.",
    };
  }
  return null;
}

export type MigrationConflictPolicyCode =
  | "abort"
  | "merge"
  | "overwrite_agent_files";

export function canSubmitMigration(args: {
  submitting: boolean;
  samePath: boolean;
  mode: "plain" | "obsidian";
  path: string;
  pathIssue: ClientPathIssue | null;
  validationStatus: "idle" | "validating" | "valid" | "invalid";
  policy: MigrationConflictPolicyCode;
  allowedPolicies: MigrationConflictPolicyCode[];
}): boolean {
  if (args.submitting || args.samePath) return false;
  if (args.mode === "plain") return true;
  return (
    args.path.trim().length > 0
    && args.pathIssue === null
    && args.validationStatus === "valid"
    && args.allowedPolicies.includes(args.policy)
  );
}

export function getPrimaryActionLabel(
  errorCode: string | null | undefined,
  submitting: boolean,
): "Migrating…" | "Wait Then Retry" | "Retry" | "Confirm & Migrate" {
  if (submitting) return "Migrating…";
  if (
    errorCode === "sessions_active"
    || errorCode === "executions_active"
    || errorCode === "migration_in_progress"
  ) {
    return "Wait Then Retry";
  }
  if (errorCode) return "Retry";
  return "Confirm & Migrate";
}

/**
 * When the daemon rejects a migration with a target-side conflict, the
 * default `"abort"` policy is no longer in the set of options the user
 * can pick. Returns the policy to auto-select so the radio group
 * renders with a sensible default and the Retry button sends a distinct
 * policy from the first attempt.
 *
 * Returns `null` when no auto-select is needed (e.g. unrelated error
 * codes like `move_failed`, or no error at all).
 */
export function autoSelectPolicyFor(
  errorCode: string | null | undefined,
): MigrationConflictPolicyCode | null {
  switch (errorCode) {
    case "target_has_agent_file_conflicts":
      // Only one allowed option; enforce it so Retry can't re-send abort.
      return "overwrite_agent_files";
    case "target_has_unrelated_files":
      // `merge` is the less destructive of the two allowed options.
      return "merge";
    default:
      return null;
  }
}
