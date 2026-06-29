/**
 * SETUP-FLOW-REDESIGN-PLAN §5.2 — vault step pure logic.
 *
 * Replaces the language-aware logic that used to live here. The Basics
 * step now owns language; this module owns the vault-mode + primary-path
 * decisions. The component is a thin shell around these helpers.
 *
 * Validation against the daemon's `validatePrimaryVaultPath` is the
 * server-side source of truth (see `daemon/src/config.ts`); this module
 * keeps a slim client-side mirror so the user gets immediate feedback
 * before the round-trip.
 */

import {
  isClientAbsolutePath,
  isClientPathInsideOrEqual,
} from "@/lib/path-client";

export type VaultMode = "plain" | "obsidian";

export type VaultPathIssue =
  | "empty"
  | "not_absolute"
  | "overlaps_data_dir";

export interface ValidatePrimaryVaultPathInput {
  path: string;
  dataDir: string;
}

/**
 * Pre-flight client-side path check. Mirrors the prefix rules in
 * `daemon/src/config.ts:validatePrimaryVaultPath` — the daemon
 * re-runs the full validation server-side, so this is just an
 * immediate-feedback layer (no system-path denials, no parent-existence
 * check; those need fs access).
 */
export function validatePrimaryVaultPathClient(
  input: ValidatePrimaryVaultPathInput,
): VaultPathIssue | null {
  const trimmed = input.path.trim();
  if (trimmed.length === 0) return "empty";
  if (!isClientAbsolutePath(trimmed)) {
    return "not_absolute";
  }
  if (input.dataDir.length > 0) {
    if (isClientPathInsideOrEqual(input.dataDir, trimmed)) {
      return "overlaps_data_dir";
    }
  }
  return null;
}

export function vaultPathIssueMessage(issue: VaultPathIssue): string {
  switch (issue) {
    case "empty":
      return "Pick a directory for the agent's primary vault.";
    case "not_absolute":
      return "Use an absolute path (for example `/Users/me/Vault`, `~/Vault`, or `C:\\Vault`).";
    case "overlaps_data_dir":
      return "Path overlaps the agent's data directory; choose a separate location.";
  }
}

/**
 * Continue-button enablement. Plain mode never blocks on path; obsidian
 * mode requires a valid (or at least non-empty) path. `saving` blocks
 * both branches.
 */
export function canContinue(input: {
  vaultMode: VaultMode;
  pathIssue: VaultPathIssue | null;
  saving: boolean;
}): boolean {
  if (input.saving) return false;
  if (input.vaultMode === "plain") return true;
  return input.pathIssue === null;
}

/**
 * Build the `POST /api/setup/migrate-context` body. Plain mode does not
 * carry a path; obsidian mode trims the user input.
 */
export type VaultMigrationBody =
  | { targetVaultMode: "plain"; conflictPolicy: "abort" }
  | {
      targetVaultMode: "obsidian";
      targetVaultPath: string;
      conflictPolicy: "abort";
    };

export function buildVaultMigrationBody(input: {
  vaultMode: VaultMode;
  primaryVaultPath: string;
}): VaultMigrationBody {
  if (input.vaultMode === "plain") {
    return { targetVaultMode: "plain", conflictPolicy: "abort" };
  }
  return {
    targetVaultMode: "obsidian",
    targetVaultPath: input.primaryVaultPath.trim(),
    conflictPolicy: "abort",
  };
}

/**
 * Inputs to the deferred-migration decision used by `ConversationStep`.
 * `currentMode` / `currentPath` come from `/api/config`; `pendingMode` /
 * `pendingPath` come from wizard state populated on the Vault step.
 */
export interface VaultMigrationDecisionInput {
  pendingMode: VaultMode;
  pendingPath: string;
  currentMode: VaultMode;
  currentPath: string | null;
}

export type VaultMigrationDecision =
  | { kind: "no_migration_needed" }
  | { kind: "migrate"; mode: VaultMode; path: string };

/**
 * Decide whether the deferred vault migration should run on entry to the
 * Customize Rules step, given the user's pending picks and the daemon's
 * current config. Pure — exists so the test suite can pin down the
 * branches that previously lived inside an `IIFE` in a `useEffect`.
 *
 * Rules:
 *   - plain & current plain     → no-op.
 *   - plain & current obsidian  → migrate (rollback to plain).
 *   - obsidian & empty path     → no-op (defensive; Vault step blocks this).
 *   - obsidian & current plain  → migrate.
 *   - obsidian & path differs   → migrate (re-target).
 *   - obsidian & path matches   → no-op.
 *
 * Path comparison is by exact string after trimming the pending value;
 * the daemon's `validateMigrationTargetPath` resolves `~`/relatives, so
 * we never compare against an unresolved server path.
 */
export function decideVaultMigration(
  input: VaultMigrationDecisionInput,
): VaultMigrationDecision {
  if (input.pendingMode === "plain") {
    if (input.currentMode === "obsidian") {
      return { kind: "migrate", mode: "plain", path: "" };
    }
    return { kind: "no_migration_needed" };
  }
  const pendingPathTrimmed = input.pendingPath.trim();
  if (pendingPathTrimmed.length === 0) {
    return { kind: "no_migration_needed" };
  }
  if (input.currentMode !== "obsidian") {
    return { kind: "migrate", mode: "obsidian", path: pendingPathTrimmed };
  }
  if (input.currentPath !== pendingPathTrimmed) {
    return { kind: "migrate", mode: "obsidian", path: pendingPathTrimmed };
  }
  return { kind: "no_migration_needed" };
}
