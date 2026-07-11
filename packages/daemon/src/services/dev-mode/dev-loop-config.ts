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
import type { DevFlowConfig, DevLoopConfig } from "./types.js";
import { DEV_BUDGET_CONFIG_KEYS } from "./types.js";

/** loop-kit fleet.config.sh defaults. maxParallel=3 was a product decision
 *  (2026-07-07): parallel throughput over cost, interview-overridable. */
export const DEV_FLOW_CONFIG_DEFAULTS: DevFlowConfig = {
  decompose: true,
  maxParallel: 3,
  maxTasks: 8,
  superviseCap: 2,
  replanCap: 6,
  planReview: true,
  planReviewCap: 4,
  integrationFixupCap: 1,
  splitNudgeAt: 50,
  splitCarryover: true,
  worktreeSetupCommand: null,
};

/** loop-kit load_config defaults. verifyCommands has NO default — an empty
 *  list is rejected at approval (fail-closed, never a vacuous pass). */
export const DEV_LOOP_CONFIG_DEFAULTS: DevLoopConfig = {
  verifyCommands: [],
  verifyRetries: 0,
  contractReview: true,
  deniedPaths: [".env*", "secrets/**", "credentials/**"],
  escalatePaths: [],
  maxIterations: 10,
  maxIterSeconds: 900,
  maxRunSeconds: null,
  maxCostPerSessionUsd: 1.0,
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
  flow: DEV_FLOW_CONFIG_DEFAULTS,
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

/** Coerce to a positive number, or the fallback when absent/non-positive. */
function positiveOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/**
 * The USD ceiling for one leg (`query()` call). Always at most the per-session
 * cap; when a per-process total is set, also clamped to the remaining process
 * budget so the last leg cannot overshoot the total (loop-kit's
 * `remaining_budget` mirror — floored at $0.01 so a call is never handed $0).
 */
export function perCallBudgetUsd(config: DevLoopConfig, spentUsd: number): number {
  const perSession = config.maxCostPerSessionUsd;
  if (config.maxCostUsd === null) return perSession;
  const remaining = Math.max(0.01, config.maxCostUsd - Math.max(0, spentUsd));
  return Math.min(perSession, remaining);
}

/**
 * Merge a partial flow section over the fleet defaults — same coercion
 * posture as the loop config (unknown shapes fall back, never throw).
 */
export function normalizeDevFlowConfig(
  partial: Partial<DevFlowConfig> | null | undefined,
): DevFlowConfig {
  const p = partial ?? {};
  const d = DEV_FLOW_CONFIG_DEFAULTS;
  const setupRaw = p.worktreeSetupCommand;
  const worktreeSetupCommand =
    typeof setupRaw === "string" && setupRaw.trim().length > 0
      ? setupRaw.trim()
      : null;
  return {
    decompose: typeof p.decompose === "boolean" ? p.decompose : d.decompose,
    maxParallel: Math.max(1, nonNegInt(p.maxParallel, d.maxParallel)),
    maxTasks: Math.max(1, nonNegInt(p.maxTasks, d.maxTasks)),
    superviseCap: nonNegInt(p.superviseCap, d.superviseCap),
    replanCap: nonNegInt(p.replanCap, d.replanCap),
    planReview: typeof p.planReview === "boolean" ? p.planReview : d.planReview,
    planReviewCap: nonNegInt(p.planReviewCap, d.planReviewCap),
    integrationFixupCap: nonNegInt(p.integrationFixupCap, d.integrationFixupCap),
    // A percentage — clamp into [0, 100] (0 = off).
    splitNudgeAt: Math.min(100, nonNegInt(p.splitNudgeAt, d.splitNudgeAt)),
    splitCarryover:
      typeof p.splitCarryover === "boolean" ? p.splitCarryover : d.splitCarryover,
    worktreeSetupCommand,
  };
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
    // Clamped to [0, 2] — endless reruns would mask genuinely-red gates.
    verifyRetries: Math.min(2, nonNegInt(p.verifyRetries, d.verifyRetries)),
    contractReview:
      typeof p.contractReview === "boolean" ? p.contractReview : d.contractReview,
    deniedPaths: cleanStringList(p.deniedPaths, d.deniedPaths),
    escalatePaths: cleanStringList(p.escalatePaths, d.escalatePaths),
    // maxIterations must be at least 1 (a run with 0 iterations is nonsense).
    maxIterations: Math.max(1, nonNegInt(p.maxIterations, d.maxIterations)),
    maxIterSeconds: Math.max(1, nonNegInt(p.maxIterSeconds, d.maxIterSeconds)),
    maxRunSeconds: p.maxRunSeconds === undefined
      ? d.maxRunSeconds
      : positiveOrNull(p.maxRunSeconds),
    // Always-on per-session cap: a non-positive/absent value falls back to the
    // default rather than disabling the guard.
    maxCostPerSessionUsd: positiveOr(p.maxCostPerSessionUsd, d.maxCostPerSessionUsd),
    // Toggleable per-process total: absent → default (off); an explicit
    // non-positive value also means off (null).
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
    flow: normalizeDevFlowConfig(p.flow),
  };
}

export interface DevConfigValidation {
  ok: boolean;
  errors: string[];
}

/**
 * DEFENSE-IN-DEPTH prescreen for clearly-dangerous verify / setup shells. These
 * run as a REAL `/bin/sh -c` subprocess with the daemon's privileges (D4,
 * unsandboxed), AND each verify command becomes a `Bash(<cmd>:*)` allowlist
 * prefix for the implement leg. This is a FAIL-CLOSED prescreen over structural
 * danger categories — NOT a complete sandbox and NOT the sole D6 guard. The
 * layered controls are: (1) the owner sees every verify + setup command in the
 * `!approve` summary and must explicitly approve; (2) this prescreen rejects
 * unambiguous categories (push, remote-code-exec, privilege escalation,
 * disk/tree destruction) before the owner even sees them; (3) the eventual
 * root-cause fix is to sandbox / drop-privileges on the verify runner itself
 * (tracked separately — a denylist is inherently incompletable for shell). The
 * regexes are lenient about flag placement (e.g. `git -c x push`) but a
 * determined obfuscation (write-then-exec, aliases) can still slip through —
 * hence "defense in depth", not a boundary. Returns a reason when refused.
 */
export function screenDangerousCommand(command: string): string | null {
  const lower = command.trim().toLowerCase();
  const rules: { re: RegExp; why: string }[] = [
    // git ... push — tolerate flags/values between (git -c x push, --git-dir=. push).
    { re: /\bgit\b[^;|&\n]*\bpush\b/, why: "runs `git push` (dev mode never pushes — D6)" },
    { re: /\|\s*(sudo\s+)?(sh|bash|zsh|dash|python[0-9.]*|perl|ruby|node)\b/, why: "pipes into a shell/interpreter (remote-code-execution vector)" },
    { re: /\bsudo\b/, why: "uses sudo (privilege escalation)" },
    // rm with any recursive flag (−r/−R/−rf/−fr/−−recursive), flags in any order.
    { re: /\brm\b[^|;&]*\s(-\S*r\S*|--recursive)\b/, why: "runs a recursive `rm` (destructive)" },
    { re: /\bdd\s+if=/, why: "runs `dd` (raw disk write)" },
    { re: /\bmkfs\b/, why: "runs mkfs (formats a filesystem)" },
    { re: />\s*\/dev\/(sd|nvme|disk|hd)/, why: "writes to a raw disk device" },
    // netcat -e reverse shell, flag anywhere after nc.
    { re: /\b(nc|ncat|netcat)\b[^|;&]*\s-[a-z]*e\b/, why: "opens a netcat reverse shell" },
  ];
  for (const { re, why } of rules) {
    if (re.test(lower)) return why;
  }
  return null;
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
  if (!(config.maxCostPerSessionUsd > 0)) {
    errors.push("maxCostPerSessionUsd must be a positive dollar amount (the per-session cost cap).");
  }
  if (config.maxCostUsd !== null && config.maxCostUsd < config.maxCostPerSessionUsd) {
    errors.push(
      `maxCostUsd ($${config.maxCostUsd}) must be at least maxCostPerSessionUsd `
        + `($${config.maxCostPerSessionUsd}) — a process total below one session's cap would stop before the first leg finishes.`,
    );
  }
  // Reject clearly-dangerous verify / setup shells (they run unsandboxed and
  // become the implement leg's Bash allowlist).
  for (const cmd of config.verifyCommands) {
    const why = screenDangerousCommand(cmd);
    if (why) errors.push(`verify command "${cmd}" is refused — it ${why}.`);
  }
  if (config.flow.worktreeSetupCommand) {
    const why = screenDangerousCommand(config.flow.worktreeSetupCommand);
    if (why) errors.push(`worktree setup command "${config.flow.worktreeSetupCommand}" is refused — it ${why}.`);
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
