/**
 * Mirrors keychain-stored backend auth into `process.env` so the existing
 * Claude SDK / Codex CLI / Gemini CLI subprocesses pick it up without
 * per-spawn-site refactoring. Both direct API keys (Anthropic / OpenAI /
 * Google) and Claude's cloud-provider modes (Bedrock / Vertex / Foundry)
 * flow through this single chokepoint — see
 * `@aitne/shared/backend-api-key-config` for the typed config.
 *
 * **Precedence** (highest first):
 *   1. Keychain (set via the dashboard API)
 *   2. Original shell env captured at daemon startup
 *   3. CLI login / OAuth (the SDK/CLI's native auth, used when neither of
 *      the above is set)
 *
 * The "original shell env" snapshot is captured *before* the first sync
 * for the **superset** of env vars any provider could set, so a UI-driven
 * clear (DELETE /backends/:id/api-key) or a provider switch (e.g.
 * Anthropic → Bedrock) can restore the operator's shell-set values
 * byte-for-byte instead of blanket-deleting them. This keeps
 * `aitne start && export ANTHROPIC_API_KEY=...` workflows intact.
 */

import {
  BACKEND_IDS,
  getApiKeyEnvAssignments,
  getManagedApiKeyEnvVars,
  type ApiKeyProvider,
  type BackendApiKeyConfig,
  type BackendId,
} from "@aitne/shared";
import {
  clearCodexAzureConfig,
  materializeCodexAzureConfig,
} from "./codex-home-materializer.js";
import type { SecretBroker } from "./secret-broker.js";

/**
 * Env vars each backend's **direct API key** mode uses, exposed for
 * backwards-compatible tests / status helpers that want the legacy
 * "primary env var name" view. The full superset for env mirroring is
 * exposed via `getManagedApiKeyEnvVars` (in @aitne/shared).
 */
export const BACKEND_API_KEY_ENV_VARS: Record<BackendId, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  opencode: ["OPENCODE_SERVER_PASSWORD"],
};

/** The value source actually in effect after a sync call. */
export type ApiKeySource = "keychain" | "shell" | "none";

export interface BackendApiKeySyncResult {
  source: ApiKeySource;
  /** Active provider when source==='keychain'. Null otherwise. */
  provider: ApiKeyProvider | null;
  /** True when the sync changed `process.env` for this backend. */
  changed: boolean;
}

interface OriginalShellSnapshot {
  // Per env-var-name original value (or undefined when unset).
  [envVarName: string]: string | undefined;
}

/**
 * Per-backend snapshot of the original shell-set env values, captured
 * before any keychain mirroring. Used to restore the shell value on
 * UI-driven clear or provider switch.
 */
const originalShellEnvByBackend = new Map<BackendId, OriginalShellSnapshot>();

/**
 * Capture the current `process.env` values for every backend's full
 * managed env-var set (across all providers). MUST be called once at
 * daemon startup, *before* the first `syncBackendApiKeyToEnv` call, so
 * the snapshot reflects what the operator set in their shell rather than
 * what we mirrored from keychain.
 *
 * Idempotent — repeated calls overwrite the snapshot with the current
 * env. Tests rely on this to reset between cases.
 */
export function captureOriginalShellEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  originalShellEnvByBackend.clear();
  for (const backendId of BACKEND_IDS) {
    const snapshot: OriginalShellSnapshot = {};
    for (const envName of getManagedApiKeyEnvVars(backendId)) {
      snapshot[envName] = env[envName];
    }
    originalShellEnvByBackend.set(backendId, snapshot);
  }
}

/**
 * Whether the backend had any non-empty shell value when capture ran.
 * Used to label the resolved source as "shell" vs "none" without
 * collapsing the per-alias structure of the snapshot.
 * Caller must already hold a reference to the snapshot.
 */
function shellSnapshotHasValue(
  snapshot: OriginalShellSnapshot,
  backendId: BackendId,
): boolean {
  for (const envName of getManagedApiKeyEnvVars(backendId)) {
    if (snapshot[envName]?.trim()) return true;
  }
  return false;
}

/**
 * Set a single env var to `value`, or delete it when `value === undefined`.
 * Returns true when the env actually changed.
 */
function setOrDelete(
  envName: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const current = env[envName];
  if (value === undefined) {
    if (current === undefined) return false;
    delete env[envName];
    return true;
  }
  if (current === value) return false;
  env[envName] = value;
  return true;
}

/**
 * Resolve the effective auth config for a backend (keychain > shell >
 * none) and mirror it into `process.env`. Call this at startup once for
 * each backend, and again after every UI mutation (PUT/DELETE
 * /backends/:id/api-key).
 *
 * Per-env-var semantics (matters for cloud providers, where switching
 * Anthropic → Bedrock means clearing `ANTHROPIC_API_KEY` and setting
 * `CLAUDE_CODE_USE_BEDROCK=1` + AWS_*):
 *  - **Keychain set**: every env var the active provider needs is set
 *    to the stored value. Every other env var in the managed superset
 *    is restored to its captured shell value (or deleted when the
 *    operator never exported it). This isolates the active provider
 *    from stale env from a previous provider — the keychain is the
 *    single source of truth.
 *  - **Falling back to shell**: every env var in the managed superset
 *    is restored to *exactly* what the operator originally set
 *    (including `undefined` for vars they did not export). This avoids
 *    silently introducing env vars the user never set — preserving the
 *    pre-feature behaviour byte-for-byte.
 *  - **Nothing configured**: every env var in the managed superset is
 *    deleted (so the cores fall through to their CLI login / OAuth
 *    branch).
 *
 * Returns the resolved source so the caller can log without leaking the
 * value itself.
 */
export interface SyncBackendApiKeyOptions {
  /**
   * Daemon data directory. Required when the Codex backend uses the
   * `azure-openai` provider — the daemon writes a managed `config.toml`
   * to `<dataDir>/codex-home/` and points `CODEX_HOME` there. Pass
   * `null` (the default) when the caller hasn't wired it through; in
   * that case Azure config materialization is skipped and a warning is
   * logged so the operator can correct the wiring without crashing.
   */
  dataDir?: string | null;
}

export async function syncBackendApiKeyToEnv(
  broker: SecretBroker,
  backendId: BackendId,
  env: NodeJS.ProcessEnv = process.env,
  opts: SyncBackendApiKeyOptions = {},
): Promise<BackendApiKeySyncResult> {
  const config = await broker.getBackendApiKeyConfig(backendId);
  const managed = getManagedApiKeyEnvVars(backendId);
  let changed = false;

  if (config) {
    const assignments = getApiKeyEnvAssignments(config);
    const snapshot = originalShellEnvByBackend.get(backendId);

    // Codex Azure OpenAI requires a managed config.toml file in addition
    // to env vars. Write it now so CODEX_HOME points at a directory
    // codex CLI can read from, leaving the operator's `~/.codex/`
    // untouched. When `dataDir` isn't wired through, skip silently with
    // a warning — the env var alone (without config.toml) won't make
    // codex switch to Azure, but we still set AZURE_OPENAI_API_KEY in
    // case a future codex version reads it directly.
    if (config.provider === "azure-openai" && opts.dataDir) {
      const home = materializeCodexAzureConfig(opts.dataDir, config);
      assignments.CODEX_HOME = home;
    } else if (backendId === "codex" && config.provider !== "azure-openai") {
      // Switching off Azure → tear down the managed config so an
      // accidentally-set CODEX_HOME from a previous session never
      // points at a stale config.toml.
      if (opts.dataDir) clearCodexAzureConfig(opts.dataDir);
    }

    for (const name of managed) {
      const next =
        name in assignments ? assignments[name] : snapshot?.[name];
      changed = setOrDelete(name, next, env) || changed;
    }
    return { source: "keychain", provider: config.provider, changed };
  }

  // No keychain config — if this is the codex backend, also tear down
  // any stale managed config.toml from a previous Azure session.
  if (backendId === "codex" && opts.dataDir) {
    clearCodexAzureConfig(opts.dataDir);
  }

  const snapshot = originalShellEnvByBackend.get(backendId);
  if (snapshot) {
    // Restore each env var to its original value — preserves "user
    // exported only ANTHROPIC_API_KEY" exactly as it was before the
    // daemon launched. Byte-for-byte backwards compat for shell-set
    // operators.
    for (const name of managed) {
      const original = snapshot[name];
      changed = setOrDelete(name, original, env) || changed;
    }
    return {
      source: shellSnapshotHasValue(snapshot, backendId) ? "shell" : "none",
      provider: null,
      changed,
    };
  }

  // No snapshot at all (e.g. captureOriginalShellEnv was never called —
  // can only happen in malformed test harnesses). Defensive clear.
  for (const name of managed) {
    changed = setOrDelete(name, undefined, env) || changed;
  }
  return { source: "none", provider: null, changed };
}

/**
 * Resolve which env vars are "active" for the current configured state —
 * either the keys the active provider populates (when keychain wins), or
 * the legacy primary names (when shell or nothing is configured). Used
 * by the GET /backends/:id/api-key route so the dashboard can render
 * "Sets `ANTHROPIC_API_KEY`" / "Sets `CLAUDE_CODE_USE_BEDROCK` + AWS_*"
 * without having to re-derive the assignments.
 */
function resolveActiveEnvVarNames(
  backendId: BackendId,
  config: BackendApiKeyConfig,
): readonly string[] {
  return Object.keys(getApiKeyEnvAssignments(config));
}

/**
 * Read-only inspector — reports whether a value is currently effective in
 * `process.env`, which source it came from, the active provider (when
 * keychain), and the env var names the source populates. Used by the
 * GET /backends/:id/api-key route so the dashboard can render
 * "configured (keychain, bedrock)" / "configured (shell)" / "not
 * configured" without ever returning the secret value itself.
 */
export async function describeBackendApiKey(
  broker: SecretBroker,
  backendId: BackendId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  configured: boolean;
  source: ApiKeySource;
  provider: ApiKeyProvider | null;
  envVarNames: readonly string[];
}> {
  const config = await broker.getBackendApiKeyConfig(backendId);
  if (config) {
    return {
      configured: true,
      source: "keychain",
      provider: config.provider,
      envVarNames: resolveActiveEnvVarNames(backendId, config),
    };
  }
  const legacyEnvVarNames = BACKEND_API_KEY_ENV_VARS[backendId];
  for (const name of legacyEnvVarNames) {
    if (env[name]?.trim()) {
      return {
        configured: true,
        source: "shell",
        provider: null,
        envVarNames: legacyEnvVarNames,
      };
    }
  }
  return {
    configured: false,
    source: "none",
    provider: null,
    envVarNames: legacyEnvVarNames,
  };
}
