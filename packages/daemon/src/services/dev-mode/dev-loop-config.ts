/**
 * Development-mode loop config — defaults, normalization, validation, and the
 * approval-hash serialization. Pure (deterministic; no fs/db/network), so it
 * stays IN the coverage gate at 100%.
 *
 * Every default mirrors loop-kit's `load_config` (loop.config.sh). The
 * approval hash is sha256(canonical(contract) + canonical(config)) — the
 * immutability anchor. A resume tolerates a BUDGET-ONLY change (maxIterations
 * / maxCostUsd / maxRunSeconds) via the config-sans-budget hash, exactly like
 * loop-kit's `config_hash_sans_budget`.
 */

import { createHash } from "node:crypto";
import type { DevLoopConfig } from "./types.js";
import { DEV_BUDGET_CONFIG_KEYS } from "./types.js";

/** loop-kit load_config defaults. verifyCommands has NO default — an empty
 *  list is rejected at approval (fail-closed, never a vacuous pass). */
export const DEV_LOOP_CONFIG_DEFAULTS: DevLoopConfig = {
  verifyCommands: [],
  deniedPaths: [".env*", "secrets/**", "credentials/**"],
  escalatePaths: [],
  maxIterations: 10,
  maxIterSeconds: 900,
  maxRunSeconds: null,
  maxCostUsd: null,
  stagnationN: 2,
  repeatFailN: 3,
  futileN: 2,
  metForceN: 2,
  maxRevisions: 3,
  reviewMode: "always",
  holisticEveryN: 3,
  holisticTriggerLines: 400,
  stopEval: true,
  permissionMode: "acceptEdits",
  maxResumes: 10,
};

function cleanStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Coerce to a non-negative integer, or the fallback when not a finite number. */
function nonNegInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/** Coerce to a positive number, or null when absent/non-positive. */
function positiveOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Merge a partial (from the interview) over the defaults, coercing every
 * field to a sane shape. Unknown enum values fall back to the default.
 */
export function normalizeDevLoopConfig(
  partial: Partial<DevLoopConfig> | null | undefined,
): DevLoopConfig {
  const p = partial ?? {};
  const d = DEV_LOOP_CONFIG_DEFAULTS;
  const reviewMode =
    p.reviewMode === "always" || p.reviewMode === "candidate" || p.reviewMode === "off"
      ? p.reviewMode
      : d.reviewMode;
  const permissionMode =
    p.permissionMode === "acceptEdits"
      || p.permissionMode === "auto"
      || p.permissionMode === "bypassPermissions"
      ? p.permissionMode
      : d.permissionMode;
  return {
    verifyCommands: cleanStringList(p.verifyCommands, d.verifyCommands),
    deniedPaths: cleanStringList(p.deniedPaths, d.deniedPaths),
    escalatePaths: cleanStringList(p.escalatePaths, d.escalatePaths),
    // maxIterations must be at least 1 (a run with 0 iterations is nonsense).
    maxIterations: Math.max(1, nonNegInt(p.maxIterations, d.maxIterations)),
    maxIterSeconds: Math.max(1, nonNegInt(p.maxIterSeconds, d.maxIterSeconds)),
    maxRunSeconds: p.maxRunSeconds === undefined
      ? d.maxRunSeconds
      : positiveOrNull(p.maxRunSeconds),
    maxCostUsd: p.maxCostUsd === undefined
      ? d.maxCostUsd
      : positiveOrNull(p.maxCostUsd),
    stagnationN: nonNegInt(p.stagnationN, d.stagnationN),
    repeatFailN: nonNegInt(p.repeatFailN, d.repeatFailN),
    futileN: nonNegInt(p.futileN, d.futileN),
    metForceN: nonNegInt(p.metForceN, d.metForceN),
    maxRevisions: Math.max(1, nonNegInt(p.maxRevisions, d.maxRevisions)),
    reviewMode,
    holisticEveryN: nonNegInt(p.holisticEveryN, d.holisticEveryN),
    holisticTriggerLines: nonNegInt(p.holisticTriggerLines, d.holisticTriggerLines),
    stopEval: typeof p.stopEval === "boolean" ? p.stopEval : d.stopEval,
    permissionMode,
    maxResumes: Math.max(1, nonNegInt(p.maxResumes, d.maxResumes)),
  };
}

export interface DevConfigValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Approval-gate validation. The one hard rule loop-kit enforces at `cmd_run`:
 * VERIFY_COMMANDS must be non-empty (the only path to SUCCESS). The rest is
 * defensive shape-checking that `normalizeDevLoopConfig` already guarantees,
 * surfaced as human-readable reasons for the loop summary.
 */
export function validateDevLoopConfig(config: DevLoopConfig): DevConfigValidation {
  const errors: string[] = [];
  if (config.verifyCommands.length === 0) {
    errors.push(
      "verifyCommands is empty — at least one deterministic check is required "
        + "(it is the only path to SUCCESS).",
    );
  }
  if (config.maxIterations < 1) {
    errors.push("maxIterations must be at least 1.");
  }
  return { ok: errors.length === 0, errors };
}

// ── Approval-hash serialization (deterministic) ─────────────────────────

/** Deterministic JSON with sorted object keys — a stable hash input. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The immutability anchor — sha256 over the RAW contract markdown bytes plus
 * the canonical config. Hashing the file text (loop-kit hashes file bytes,
 * not a parsed structure) makes the evaluate re-check robust: it re-reads the
 * on-disk `.aitne-dev/docs/product-contract.md` verbatim, with no fragile
 * parse round-trip. The engine passes this in-memory value to the
 * deterministic evaluator (never a repo file), so an injected instruction
 * that edits the contract cannot forge a re-approval.
 */
export function computeApprovalHash(
  contractMarkdown: string,
  config: DevLoopConfig,
): string {
  return sha256(`${contractMarkdown}\n${canonicalize(config)}`);
}

/** Strip the budget-only keys, then hash — the resume tolerance for a raised
 *  cap (loop-kit config_hash_sans_budget). */
export function computeConfigHashSansBudget(config: DevLoopConfig): string {
  const rest: Record<string, unknown> = { ...config };
  for (const key of DEV_BUDGET_CONFIG_KEYS) delete rest[key];
  return sha256(canonicalize(rest));
}
