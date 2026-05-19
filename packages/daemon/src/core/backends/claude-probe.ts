/**
 * Claude probe surface — pure module split out of `claude-code-core.ts` as
 * part of the file-split plan (Tier 1, §8). Owns the registry-driven probe
 * prompt and prefix list, the delegated- and native-allowlist computations,
 * and the helpers that extract tool names from the SDK's stream messages.
 *
 * No instance state, no captured closures — all functions are pure over
 * their arguments and the module-level constants computed from
 * `INTEGRATION_DESCRIPTORS`. Consumed by `ClaudeCodeCore.probeTools` and by
 * `ClaudeCodeCore.{getDelegatedClaudeTools,getNativeClaudeTools}`.
 */

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";

/**
 * Detect which cloud-provider mode the Claude Code SDK is currently
 * configured for, based on the documented `CLAUDE_CODE_USE_*` env flags.
 * Returns null when running in the default direct-API-key / OAuth mode.
 *
 * Required-env spec follows the official Claude Code docs (verified
 * 2026-05):
 *  - **Bedrock** — only `AWS_REGION` is required by Claude Code itself
 *    (the docs explicitly call this out). AWS credentials flow through
 *    the SDK's default credential chain, which can come from any of
 *    AWS_ACCESS_KEY_ID/SECRET, AWS_BEARER_TOKEN_BEDROCK, AWS_PROFILE, or
 *    `~/.aws/`. Requiring access-key + secret here would falsely fail
 *    bearer-token / profile setups.
 *  - **Vertex** — `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION`.
 *    GCP credentials flow through ADC, which can be `gcloud auth
 *    application-default login` or a `GOOGLE_APPLICATION_CREDENTIALS`
 *    file path; we don't require either at this layer.
 *  - **Foundry** — `ANTHROPIC_FOUNDRY_RESOURCE` OR
 *    `ANTHROPIC_FOUNDRY_BASE_URL`. The API key is optional; without it,
 *    Claude Code uses the Azure DefaultAzureCredential chain.
 *
 * The SDK reads these flags itself; the daemon only inspects them so
 * the auth probes (`checkAuth` / `checkAuthDetailed`) can return the
 * right `method` and skip the Anthropic-API probe (which would 401
 * against a Bedrock / Vertex / Foundry deployment).
 *
 * @internal — exported for `claude-auth.ts`; not part of the
 * `claude-code-core.ts` public surface.
 */
export function detectCloudProviderEnv(): {
  method: "bedrock" | "vertex" | "foundry";
  flagEnvVar: string;
  label: string;
  missing: string[];
} | null {
  if (process.env.CLAUDE_CODE_USE_BEDROCK?.trim() === "1") {
    const missing: string[] = [];
    if (!process.env.AWS_REGION?.trim()) missing.push("AWS_REGION");
    return {
      method: "bedrock",
      flagEnvVar: "CLAUDE_CODE_USE_BEDROCK",
      label: "Amazon Bedrock",
      missing,
    };
  }
  if (process.env.CLAUDE_CODE_USE_VERTEX?.trim() === "1") {
    const required = [
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
    ] as const;
    return {
      method: "vertex",
      flagEnvVar: "CLAUDE_CODE_USE_VERTEX",
      label: "Google Vertex AI",
      missing: required.filter((name) => !process.env[name]?.trim()),
    };
  }
  if (process.env.CLAUDE_CODE_USE_FOUNDRY?.trim() === "1") {
    const hasResource = Boolean(
      process.env.ANTHROPIC_FOUNDRY_RESOURCE?.trim(),
    );
    const hasBaseUrl = Boolean(
      process.env.ANTHROPIC_FOUNDRY_BASE_URL?.trim(),
    );
    return {
      method: "foundry",
      flagEnvVar: "CLAUDE_CODE_USE_FOUNDRY",
      label: "Microsoft Foundry",
      missing:
        hasResource || hasBaseUrl
          ? []
          : ["ANTHROPIC_FOUNDRY_RESOURCE or ANTHROPIC_FOUNDRY_BASE_URL"],
    };
  }
  return null;
}

// Probe data is derived from `INTEGRATION_DESCRIPTORS.backendConnectors.claude`
// at module init, so adding a new delegated integration only requires the
// registry update — the prompt, prefix list, and tool-name regex follow
// automatically. Before this was registry-driven, every new integration
// silently broke its own probe (`present` permanently false) until someone
// remembered to edit four constants in lockstep. See
// `docs/design/17-delegated-mode-v2.md` §7.1.
//
// Tool names span two character classes:
//   - Gmail / Calendar: `search_threads`, `list_events` (snake_case only)
//   - Notion:           `notion-search`, `notion-create-pages` (kebab-case)
// The trailing `[A-Za-z0-9_-]+` class covers both. Namespace strings are
// regex-escaped because Codex (`._`) and Gemini (`.`) namespaces contain
// metacharacters.
function buildClaudeProbeData(): {
  prompt: string;
  prefixes: readonly string[];
  regex: RegExp;
} {
  interface ConnectorMeta {
    displayName: string;
    toolNamespace: string;
    requiredCapabilities: readonly string[];
    capabilityToolNames: readonly string[];
  }
  const meta: ConnectorMeta[] = [];
  for (const key of INTEGRATION_KEYS) {
    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const connector = descriptor.backendConnectors.claude;
    if (!connector) continue;
    const seen = new Set<string>();
    for (const tools of Object.values(connector.capabilityTools)) {
      for (const t of tools) seen.add(t);
    }
    meta.push({
      displayName: descriptor.displayName,
      toolNamespace: connector.toolNamespace,
      requiredCapabilities: connector.requiredCapabilities,
      capabilityToolNames: Array.from(seen),
    });
  }

  const prefixes = meta.map((m) => m.toolNamespace);

  const lines: string[] = ["Use `ToolSearch` only."];
  for (const m of meta) {
    // Keyword query: display name + required capability words split on
    // `_` / `-`. Mirrors the pre-registry-driven prompts (Gmail used
    // `'Gmail search read draft label'`, Calendar used `'Google Calendar
    // list get create update delete event'`) — both are display name +
    // requiredCapabilities expanded into word tokens. Using the
    // capability set (semantic) rather than every capability tool name
    // (mechanical) keeps ToolSearch's token-overlap ranking sharp; a
    // bag-of-tool-name-fragments query dilutes the signal across
    // ~15-30 tokens per integration and demotes the actually-relevant
    // hits.
    const queryWords = [
      m.displayName,
      ...m.requiredCapabilities.flatMap((c) => c.split(/[-_]/)),
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    lines.push(
      `Search for ${m.displayName} connector tools with query '${queryWords}' and max_results 20.`,
    );
  }
  lines.push("Do not call any of the searched MCP tools.");
  lines.push(
    `After the searches, print every full tool name returned that starts with one of: ${prefixes
      .map((p) => `'${p}'`)
      .join(", ")}.`,
  );
  // Per-integration "must include" hints: ToolSearch caps results at
  // max_results, so lower-ranked tools (e.g. Gmail's label_* family) can
  // be missed by keyword search. Listing them explicitly nudges the agent
  // to print them when they do appear in any of the searches above.
  for (const m of meta) {
    if (m.capabilityToolNames.length === 0) continue;
    const fullNames = m.capabilityToolNames
      .map((n) => m.toolNamespace + n)
      .join(", ");
    lines.push(
      `Include these ${m.displayName} tools if present: ${fullNames}.`,
    );
  }
  lines.push(
    "One tool name per line. No markdown fences. No explanation. If no such tools are available, print NONE.",
  );

  // Defense: an empty prefix list would compile to `\b(?:)[A-Za-z0-9_-]+\b`,
  // which matches any word — every connector probe would falsely "succeed".
  // Realistically `INTEGRATION_DESCRIPTORS` is non-empty, but the guard
  // keeps a future registry rollback from corrupting probe semantics.
  const escapedPrefixes = prefixes.map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  // Defensive: `INTEGRATION_DESCRIPTORS` is statically non-empty, so the
  // empty-prefix fallback is only reachable via a hypothetical future
  // registry rollback (rationale above). c8-ignore covers the conditional
  // expression including the `=== 0` branch the runtime never takes.
  /* c8 ignore start */
  const regex =
    escapedPrefixes.length === 0
      ? /(?!)/g
      : new RegExp(
          `\\b(?:${escapedPrefixes.join("|")})[A-Za-z0-9_-]+\\b`,
          "g",
        );
  /* c8 ignore stop */

  return { prompt: lines.join(" "), prefixes, regex };
}

const CLAUDE_PROBE_DATA = buildClaudeProbeData();
export const CLAUDE_PROBE_TOOLS_PROMPT = CLAUDE_PROBE_DATA.prompt;
const CLAUDE_PROBE_TOOL_PREFIXES = CLAUDE_PROBE_DATA.prefixes;
const CLAUDE_CONNECTOR_TOOL_RE = CLAUDE_PROBE_DATA.regex;

/**
 * Registry-driven allowlist entries for integrations currently delegated to
 * Claude. Under `permissionMode: "dontAsk"`, any tool not in the SDK's
 * `allowedTools` is silently denied — so a delegated Gmail / Calendar
 * integration whose skill instructs the agent to call
 * `mcp__claude_ai_Gmail__search_threads` will fail with "permission denied"
 * unless that exact tool name is pre-authorized here.
 *
 * Pure over `(integrations)` — callers pass the record read from
 * `db/integrations-store.ts#readIntegrations`. The SDK's MCP tool matcher is
 * literal (`mcp__<server>__<tool>` — see `services/mcp/risk.ts`), so we
 * enumerate every capability tool the registry declares rather than using a
 * wildcard. This guarantees the allowlist only widens by what the registry
 * explicitly advertises; adding a new connector tool demands a registry
 * update first.
 *
 * Only integrations whose `delegatedBackend === "claude"` contribute — a
 * Codex-delegated Gmail integration must not widen Claude's surface.
 */
export function computeDelegatedClaudeTools(
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): readonly string[] {
  const out = new Set<string>();
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    if (!state || state.mode !== "delegated") continue;
    if (state.delegatedBackend !== "claude") continue;
    const connector = INTEGRATION_DESCRIPTORS[key].backendConnectors.claude;
    // Every integration with `supportedDelegatedBackends` including "claude"
    // is required to declare a `backendConnectors.claude` entry — see the
    // registry tests in `packages/shared/src/integrations.test.ts`. The
    // guard remains for type narrowing and a future registry rollback.
    /* c8 ignore next */
    if (!connector) continue;
    for (const toolNames of Object.values(connector.capabilityTools)) {
      for (const toolName of toolNames) {
        out.add(connector.toolNamespace + toolName);
      }
    }
  }
  return Array.from(out);
}

/**
 * Registry-driven allowlist entries for integrations currently in `native`
 * mode bound to Claude. Mirror of `computeDelegatedClaudeTools`; the only
 * difference is the predicate — native binds via `nativeBackend` instead
 * of `delegatedBackend`. Required for the same reason as the delegated
 * counterpart: under `permissionMode: "dontAsk"` the SDK silently denies
 * any tool not in `allowedTools`, so a native Gmail integration whose
 * `SKILL.native.claude.md` body instructs the agent to call
 * `mcp__claude_ai_Gmail__search_threads` would fail with "permission
 * denied" unless that exact tool name is pre-authorized here.
 *
 * Pure over `(integrations)` — callers pass the record read from
 * `db/integrations-store.ts#readIntegrations`. The SDK's MCP tool matcher is
 * literal, so we enumerate every capability tool the registry declares
 * rather than using a wildcard. Destructive tools are included because the
 * confirmation contract is enforced at the prompt + `deniedTools` layer
 * (orthogonal to the SDK allowlist); excluding them here would bypass the
 * skill-level destructive-confirm flow without surfacing as a user-visible
 * decision point.
 *
 * Only integrations whose `nativeBackend === "claude"` contribute — a
 * native binding to Codex / Gemini must not widen Claude's surface, mirroring
 * the cross-backend isolation in `computeDelegatedClaudeTools`.
 *
 * `INTEGRATION_NATIVE_MODE_DESIGN.md` §11 (DM execution path).
 */
export function computeNativeClaudeTools(
  integrations: Partial<Record<IntegrationKey, IntegrationState>>,
): readonly string[] {
  const out = new Set<string>();
  for (const key of INTEGRATION_KEYS) {
    const state = integrations[key];
    if (!state || state.mode !== "native") continue;
    if (state.nativeBackend !== "claude") continue;
    const connector = INTEGRATION_DESCRIPTORS[key].backendConnectors.claude;
    // User-managed native (descriptor lacks `backendConnectors.claude`,
    // e.g. `outlook_mail` flipped to native on Claude) reaches this branch.
    // The daemon has no authoritative tool list for those — the operator
    // widens via `allowedToolsOverride` or runs Allow mode, per
    // `docs/design/appendices/native-integration-mode.md` "User-managed
    // native" section. Mirrors the c8-ignore on the delegated counterpart
    // (line ~250): the descriptor schema currently guarantees a
    // `backendConnectors.claude` entry for every integration whose
    // `supportedModes` includes `"native"`, but the guard remains as
    // registry-drift insurance.
    /* c8 ignore next */
    if (!connector) continue;
    for (const toolNames of Object.values(connector.capabilityTools)) {
      for (const toolName of toolNames) {
        out.add(connector.toolNamespace + toolName);
      }
    }
  }
  return Array.from(out);
}

/** @internal — exported for `claude-code-core.ts:probeTools`; not part of
 *  the module's public surface. */
export function extractClaudeProbeTools(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const out: string[] = [];
  const record = message as {
    type?: string;
    subtype?: string;
    tools?: unknown;
    message?: unknown;
    result?: unknown;
  };

  if (record.type === "system" && record.subtype === "init" && Array.isArray(record.tools)) {
    addClaudeProbeTools(record.tools, out);
  }
  if (record.type === "assistant" || record.type === "user") {
    addClaudeProbeTools(record.message, out);
  }
  if (record.type === "result") {
    addClaudeProbeTools(record.result, out);
  }

  return out;
}

function addClaudeProbeTools(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(CLAUDE_CONNECTOR_TOOL_RE)) {
      out.push(match[0]);
    }
    if (isClaudeProbeToolName(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addClaudeProbeTools(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as {
    content?: unknown;
    message?: unknown;
    result?: unknown;
    text?: unknown;
    tool_name?: unknown;
    tools?: unknown;
  };
  addClaudeProbeTools(record.tool_name, out, depth + 1);
  addClaudeProbeTools(record.text, out, depth + 1);
  addClaudeProbeTools(record.content, out, depth + 1);
  addClaudeProbeTools(record.message, out, depth + 1);
  addClaudeProbeTools(record.result, out, depth + 1);
  addClaudeProbeTools(record.tools, out, depth + 1);
}

function isClaudeProbeToolName(value: string): boolean {
  return CLAUDE_PROBE_TOOL_PREFIXES.some((prefix) => {
    if (!value.startsWith(prefix)) return false;
    // Hyphen is part of the alphabet for kebab-case connectors (Notion's
    // `notion-search` etc.). Snake-case connectors keep working because
    // `_` is still in the class.
    return /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length));
  });
}

/** @internal — exported for `claude-code-core.ts:probeTools`; not part of
 *  the module's public surface. */
export function describeClaudeProbeResultError(result: SDKResultMessage): string {
  if ("result" in result && typeof result.result === "string" && result.result.trim()) {
    return result.result.trim();
  }
  if ("errors" in result && Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.join("; ");
  }
  return result.subtype;
}
