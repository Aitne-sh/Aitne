import { RiskTier } from "../../safety/risk-classifier.js";
import type { McpRiskTier, McpServer } from "./types.js";

/**
 * B-003 Phase 3 — MCP tool risk helpers.
 *
 * A server carries an `McpRiskTier` (`read` / `approve`). That tier governs
 * how the agent should treat every tool the server exposes. The mapping to
 * the shared `RiskTier` enum is kept here (not in risk-classifier) because
 * it is *not* an HTTP endpoint classification — it feeds session
 * `disallowedTools` computation, not request routing.
 *
 * The legacy `notify` tier was abolished in DELEGATED-MODE-V2-DESIGN.md
 * Phase 1 along with `RiskTier.Notify`. Per `clean-reinstall-no-migrations`
 * policy, existing rows with `risk_tier='notify'` are not migrated — the
 * schema CHECK constraint is updated to the 2-tier set and the user
 * re-seeds via `pa stop && rm ~/.personal-agent/data.db && pa start`.
 *
 * Namespace convention per design: `mcp-tool:<serverId>:<toolName>`. The
 * Claude Code SDK itself exposes MCP tools as `mcp__<serverId>__<toolName>`;
 * we generate both forms (the namespace form for audit/log clarity, the
 * double-underscore form for `disallowedTools` which the SDK matches).
 */

/** Convert a server's tier to the shared RiskTier enum. */
export function classifyMcpServerTier(tier: McpRiskTier): RiskTier {
  switch (tier) {
    case "read":
      return RiskTier.ReadSensitive;
    case "approve":
      return RiskTier.Approve;
  }
}

/** Tool id as it appears in the Claude SDK `disallowedTools` list. */
export function claudeMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** Tool id as it appears in audit logs / risk reasoning. */
export function mcpToolNamespaceKey(serverId: string, toolName: string): string {
  return `mcp-tool:${serverId}:${toolName}`;
}

/**
 * Parse an MCP tool name. Two on-the-wire conventions are accepted:
 *
 *  1. `mcp__<serverId>__<toolName>` (double underscore) — emitted by
 *     Claude SDK tool_use blocks and Codex `item.name` for MCP invocations.
 *     The split is on the FIRST `__` after the `mcp__` prefix.
 *  2. `mcp_<serverId>_<toolName>` (single underscore) — emitted by Gemini
 *     CLI's `tool_name` field per the `MCP_TOOL_PREFIX = "mcp_"` constant
 *     baked into Gemini's MCP runtime. Server ids may contain hyphens
 *     (e.g. `google-workspace`) but never bare underscores, so the split
 *     is on the FIRST `_` after the `mcp_` prefix.
 *
 * Returns null for non-MCP names or malformed inputs. Server ids are
 * constrained by {@link McpServerIdSchema} to `[a-z0-9-]+`. Tool names
 * are upstream-defined and may contain underscores or dots; everything
 * after the chosen separator is treated as the tool name verbatim.
 */
export function parseMcpToolName(
  name: string,
): { serverId: string; toolName: string } | null {
  // Double-underscore form first — exact-prefix match prevents ambiguous
  // overlap with the single-underscore form (`mcp__` also starts with
  // `mcp_`).
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep <= 0 || sep >= rest.length - 2) return null;
    return {
      serverId: rest.slice(0, sep),
      toolName: rest.slice(sep + 2),
    };
  }
  // Single-underscore form (Gemini). Reject names that fall through to
  // here without `mcp_` so non-MCP tool names stay null.
  if (!name.startsWith("mcp_")) return null;
  const rest = name.slice("mcp_".length);
  const sep = rest.indexOf("_");
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return {
    serverId: rest.slice(0, sep),
    toolName: rest.slice(sep + 1),
  };
}

export interface BuildMcpDisallowedToolsInput {
  /** Enabled MCP servers targeting the session's backend. */
  servers: readonly McpServer[];
  /**
   * Whether the session is autonomous (routine, scheduled task). Autonomous
   * sessions cannot answer an `approve`-tier prompt, so every tool from an
   * approve-tier server is stripped. Reactive (DM / dashboard chat) sessions
   * keep the full palette — the owner is already in the loop.
   */
  autonomous: boolean;
}

/**
 * Compute the set of MCP tool names that must be added to `disallowedTools`
 * for this session. Two rules, independently applied (union):
 *
 *   1. `toolAllowlist` enforcement. When a server declares a non-null
 *      allowlist, every probe-discovered tool *not* in the allowlist is
 *      blocked — the agent must stay inside the curated subset.
 *   2. Autonomous approve-tier strip. On autonomous ProcessKeys, every
 *      probe-discovered tool from an `approve`-tier server is blocked so
 *      the session cannot drive high-stakes actions without the owner in
 *      the loop.
 *
 * Both rules use literal tool names from `lastProbeStatus.tools` — no
 * wildcards. The Claude SDK's `disallowedTools` matcher for MCP names is
 * literal, and a wildcard like `mcp__<id>__*` would also block legitimately
 * allowlisted tools. The known trade-off: a tool added to the server after
 * the last probe is NOT in this list, so the autonomous strip is weaker
 * than a wildcard would be. Operationally the user re-probes after
 * changing tools; the `policies/mcp.md` policy layer is the soft backstop.
 */
export function buildMcpDisallowedTools(
  input: BuildMcpDisallowedToolsInput,
): string[] {
  const out: string[] = [];
  for (const server of input.servers) {
    if (!server.enabled) continue;

    const stripAll = input.autonomous && server.riskTier === "approve";
    const allowlist = server.toolAllowlist;
    if (!stripAll && !allowlist) continue;

    const tools = server.lastProbeStatus?.tools ?? [];
    const allowed = allowlist ? new Set(allowlist) : null;
    for (const tool of tools) {
      if (stripAll) {
        out.push(claudeMcpToolName(server.id, tool.name));
        continue;
      }
      if (allowed && !allowed.has(tool.name)) {
        out.push(claudeMcpToolName(server.id, tool.name));
      }
    }
  }
  return out;
}
