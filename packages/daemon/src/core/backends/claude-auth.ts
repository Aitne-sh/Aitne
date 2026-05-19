/**
 * Claude-backend auth probe + error-introspection helpers — pure module split
 * out of `claude-code-core.ts` as part of the file-split plan (Tier 2, §8).
 *
 * Two responsibilities, both stateless:
 *
 *  1. **Error introspection** (pattern A in the split plan) — pure helpers
 *     over `error: unknown` used by the SDK error-mapping paths in
 *     `ClaudeCodeCore`. Each helper narrows the structural shape captured by
 *     `ErrorLike` in `claude-errors.ts`. No instance state.
 *
 *  2. **Auth probes** (pattern B) — `checkAuth` is the cheap presence check
 *     used by the reactive execute path; `checkAuthDetailed` is the deeper
 *     probe consumed by `AuthHealthMonitor` and the setup wizard. Both are
 *     standalone async functions taking a `ClaudeAuthDeps` record holding
 *     the small subset of state they need (`cliPath` + `AgentConfig`).
 *     The deps record is a deliberate seam so the functions can be unit
 *     tested without spinning up a `ClaudeCodeCore` instance.
 *
 * The thin `checkAuth` / `checkAuthDetailed` / `isAuthError` / `getError*`
 * methods on `ClaudeCodeCore` remain as transitional shims (file-split-plan
 * §15) — they forward to the functions here so that test files which call
 * `(core as any).isAuthError(...)` keep working without modification.
 */

import type { AuthCheckResult } from "../agent-core.js";
import { probeApiKeyServerSide } from "./api-key-probe.js";
import { readClaudeCredentials } from "./claude-credentials-store.js";
import { isPlausibleAnthropicApiKey } from "./cli-utils.js";
import { detectCloudProviderEnv } from "./claude-probe.js";
import type { ErrorLike } from "./claude-errors.js";

/**
 * Dependencies required to run the auth probes. The `cliPath` may be `null`
 * when the Claude Code CLI is not on PATH at boot — in that case the
 * detailed probe surfaces a `missing` result with the install command.
 *
 * The plan in `docs/design/appendices/file-split-plan.md` §8 originally
 * called for `{ cliPath, config }` as deps; the `config` field is left out
 * here because neither `checkAuth` nor `checkAuthDetailed` reads any field
 * of `AgentConfig` (only env vars + `cliPath`). Keeping the deps object
 * truthful is more useful than mirroring the plan literally — adding
 * `config` later is a single-line change if a probe ever needs it.
 */
export interface ClaudeAuthDeps {
  readonly cliPath: string | null;
}

// ---------- Pattern A: error introspection helpers ----------

export function getErrorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as ErrorLike).status
    : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as ErrorLike).code === "string"
    ? (error as ErrorLike).code
    : undefined;
}

export function getErrorType(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as ErrorLike).type === "string"
    ? (error as ErrorLike).type
    : undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Claude backend execution failed";
}

export function isAuthError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) {
    return true;
  }

  const code = getErrorCode(error)?.toLowerCase() ?? "";
  const type = getErrorType(error)?.toLowerCase() ?? "";
  if (
    code.includes("auth") ||
    code.includes("forbidden") ||
    code.includes("unauthorized") ||
    type.includes("auth") ||
    type.includes("forbidden") ||
    type.includes("unauthorized")
  ) {
    return true;
  }

  return /unauthorized|forbidden|authentication|invalid api key|login required/i.test(
    getErrorMessage(error),
  );
}

// ---------- Pattern B: auth probes ----------

/**
 * Cheap presence check used by the reactive execute path. Returns a
 * narrowed `method` so the dispatcher can include it in error telemetry,
 * but never makes a network call.
 */
export async function checkAuth(deps: ClaudeAuthDeps): Promise<
  | {
      ok: true;
      method:
        | "cli_login"
        | "api_key"
        | "oauth"
        | "vertex"
        | "bedrock"
        | "foundry";
    }
  | { ok: false; reason: string }
> {
  const cloud = detectCloudProviderEnv();
  if (cloud) {
    if (cloud.missing.length > 0) {
      return {
        ok: false,
        reason: `${cloud.flagEnvVar}=1 but missing required env vars: ${cloud.missing.join(", ")}`,
      };
    }
    return { ok: true, method: cloud.method };
  }

  const rawApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (rawApiKey) {
    if (!isPlausibleAnthropicApiKey(rawApiKey)) {
      return {
        ok: false,
        reason: "ANTHROPIC_API_KEY is set but does not look like an Anthropic key (expected `sk-ant-…`).",
      };
    }
    return { ok: true, method: "api_key" };
  }
  if (!deps.cliPath) {
    return {
      ok: false,
      reason: "Claude Code CLI is not installed or not on PATH. Run `npm install -g @anthropic-ai/claude-code`.",
    };
  }
  return { ok: true, method: "cli_login" };
}

/**
 * Detailed auth probe used by AuthHealthMonitor and the dashboard setup
 * wizard. Two modes:
 *  - **API key** (`ANTHROPIC_API_KEY`): format check + server-side probe
 *    via `probeApiKeyServerSide("anthropic", ...)` (roadmap §9.1).
 *    Throws on network/timeout so `checkAll()` records `probe_network_error`.
 *  - **CLI login**: reads `~/.claude/credentials.json` for `refreshToken`.
 *    Never writes to the Keychain or credentials file — refresh is left
 *    to the CLI (Phase 0 confirmed rotating refresh_tokens; daemon-driven
 *    refresh would race and corrupt state).
 */
export async function checkAuthDetailed(
  deps: ClaudeAuthDeps,
): Promise<AuthCheckResult> {
  const cloud = detectCloudProviderEnv();
  if (cloud) {
    if (cloud.missing.length > 0) {
      return {
        ok: false,
        status: "missing",
        method: cloud.method,
        detail: `${cloud.flagEnvVar}=1 but missing: ${cloud.missing.join(", ")}`,
        recoveryCommand: `Set the missing env vars or unset ${cloud.flagEnvVar}`,
      };
    }
    // Real auth happens inside the SDK against AWS / GCP / Azure. The
    // daemon does not run a server-side probe for cloud providers — the
    // first execution will surface any credential failure. Mark the
    // status as `ok` here so the dashboard reports "Configured (cloud)";
    // AuthHealthMonitor still re-runs this check hourly so a malformed
    // env (env vars cleared after launch) flips the cache to `missing`.
    return {
      ok: true,
      status: "ok",
      method: cloud.method,
      detail: `Configured via ${cloud.label} — runtime auth verified by Claude Code SDK`,
    };
  }

  const rawApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (rawApiKey) {
    if (!isPlausibleAnthropicApiKey(rawApiKey)) {
      return {
        ok: false,
        status: "expired",
        method: "api_key",
        detail: "ANTHROPIC_API_KEY does not match Anthropic key format (expected `sk-ant-…`).",
        recoveryCommand: "Unset ANTHROPIC_API_KEY or replace it with a valid Anthropic API key",
      };
    }
    // Format is plausible — attempt a server-side probe to detect
    // revoked keys within 1 hourly cycle (roadmap §9.1). On network
    // failure, the probe throws and the caller (checkAll or check-auth
    // route) records `probe_network_error` without flipping DB cache.
    const probe = await probeApiKeyServerSide("anthropic", rawApiKey);
    return {
      ok: probe.ok,
      status: probe.ok ? "ok" : "expired",
      method: "api_key",
      detail: probe.detail,
      ...(!probe.ok && {
        recoveryCommand: "Unset ANTHROPIC_API_KEY or replace it with a valid Anthropic API key",
      }),
    };
  }

  if (!deps.cliPath) {
    return {
      ok: false,
      status: "missing",
      method: "cli_login",
      detail: "Claude Code CLI not found on PATH",
      recoveryCommand: "npm install -g @anthropic-ai/claude-code",
    };
  }

  const bundle = await readClaudeCredentials();
  if (!bundle) {
    return {
      ok: false,
      status: "expired",
      method: "cli_login",
      detail: "No Claude credentials found",
      recoveryCommand: "claude auth login",
    };
  }

  if (!bundle.refreshToken) {
    return {
      ok: false,
      status: "expired",
      method: "cli_login",
      detail: "Credentials lack refresh_token — run `claude auth login`",
      recoveryCommand: "claude auth login",
    };
  }

  return { ok: true, status: "ok", method: "oauth" };
}
