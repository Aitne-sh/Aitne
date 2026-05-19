/**
 * docs/design/appendices/opencode-backend.md §5.6 — Claude `disallowedTools` /
 * `allowedToolsOverride` → OpenCode `permission` translator.
 *
 * V5 (Phase 0) confirmed OpenCode 1.14.50 only exposes triple-typed
 * (`"ask"|"allow"|"deny"`) permission keys for:
 *   - `edit`, `bash`, `webfetch`, `doom_loop`, `external_directory`
 *
 * There is **no** `read` permission key. `Read(<glob>)` entries cannot
 * be expressed as a permission map; the translator either:
 *   (a) routes the entry to `tools: { read: false }` (the all-or-nothing
 *       hard-disable on the `read` tool), AND
 *   (b) surfaces a warning so the dashboard can offer the operator the
 *       defense-in-depth bash-level deny (e.g. `Bash(cat ~/.ssh/*)` in
 *       `always-disallowed.ts`).
 *
 * `bash` is the only key that accepts a pattern-map (`Record<glob,
 * "allow"|"ask"|"deny">`). `edit` is a triple, NOT a pattern-map per V5
 * — `Edit(<glob>)` and `Write(<glob>)` collapse to a single
 * `edit: "deny"` triple regardless of the glob, with a warning recording
 * the pattern that was dropped. (Write collapses into edit per OpenCode
 * docs.)
 *
 * MCP entries (`mcp__<server>__<tool>`) cannot be denied per-tool in
 * opencode 1.14.50 — `client.tool.ids()` returns 14 names that omit every
 * connected MCP server's tools (V7 fixture). v1 strategy is server-level:
 * the translator emits one warning per affected MCP server so the
 * dashboard can prompt the operator to drop the server from the MCP
 * config; the actual omission happens in the config-builder's MCP path.
 *
 * Pure function — lands in the 100%-coverage subset.
 */

import type {
  OpencodeBashPermission,
  OpencodePermissionBuildInput,
  OpencodePermissionBuildResult,
  OpencodePermissionConfig,
  OpencodePermissionValue,
} from "./opencode-config.js";

interface ParsedToolEntry {
  /** Tool name, e.g. "Bash", "Edit", "Read", "WebFetch", or full MCP id. */
  name: string;
  /** Argument pattern within `Tool(...)`, or `null` for bare tool names. */
  pattern: string | null;
}

/**
 * Parse a Claude-shaped tool entry. Examples:
 *   - `"Bash"` → `{ name: "Bash", pattern: null }`
 *   - `"Bash(rm -rf *)"` → `{ name: "Bash", pattern: "rm -rf *" }`
 *   - `"WebFetch"` → `{ name: "WebFetch", pattern: null }`
 *   - `"mcp__finance__transfer"` → `{ name: "mcp__finance__transfer", pattern: null }`
 *
 * Returns `null` for malformed entries (no name before `(`, or
 * unterminated paren). The caller surfaces a warning rather than throwing
 * so a single bad entry can't poison the whole permission build.
 */
function parseToolEntry(entry: string): ParsedToolEntry | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;
  const paren = trimmed.indexOf("(");
  if (paren === -1) {
    return { name: trimmed, pattern: null };
  }
  const name = trimmed.slice(0, paren).trim();
  if (name.length === 0) return null;
  if (!trimmed.endsWith(")")) return null;
  const pattern = trimmed.slice(paren + 1, trimmed.length - 1).trim();
  return { name, pattern: pattern.length > 0 ? pattern : null };
}

/**
 * MCP server-id extractor. Opencode's documented (but unverified)
 * mangling rule is `mcp__<server>__<tool>` → `<server>_<tool>`. The lint
 * in `opencode-mcp.ts` rejects server names containing `_`, so the first
 * `_`-free run after `mcp__` is the server id.
 */
function extractMcpServerId(toolId: string): string | null {
  if (!toolId.startsWith("mcp__")) return null;
  const rest = toolId.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

/**
 * Apply `allowedToolsOverride` semantics. The override widens the
 * effective permission: if a Claude-shaped entry like `Bash(npm *)` is
 * present in the override list, the translator emits a matching `"allow"`
 * entry in the bash pattern-map so opencode permits `npm *` even when a
 * broader deny is also present.
 *
 * Triple-typed keys (`edit`, `webfetch`) can only be flipped wholesale
 * by a bare-name entry (`"Edit"`, `"WebFetch"`); a glob-shaped override
 * is treated as a wholesale flip with a warning recording the dropped
 * glob. `Read` overrides flip the `tools.read` hard-disable off.
 */
function applyAllowedOverride(
  parsed: ParsedToolEntry,
  state: PermissionAccumulator,
): void {
  switch (parsed.name) {
    case "Bash":
      if (parsed.pattern) {
        state.bashPatterns[parsed.pattern] = "allow";
      } else {
        state.bashWholeDeny = false;
      }
      return;
    case "Edit":
    case "Write":
      state.editDeny = false;
      if (parsed.pattern) {
        state.warnings.push(
          `opencode: allowedToolsOverride '${parsed.name}(${parsed.pattern})' — opencode's edit permission is whole-tool only; pattern dropped, edit allowed wholesale`,
        );
      }
      return;
    case "Read":
      state.readHardDisable = false;
      if (parsed.pattern) {
        state.warnings.push(
          `opencode: allowedToolsOverride '${parsed.name}(${parsed.pattern})' — opencode has no read pattern surface; tools.read hard-disable lifted wholesale`,
        );
      }
      return;
    case "WebFetch":
      state.webfetchDeny = false;
      return;
    default:
      // MCP allows are handled at the server-config level by `setMcpContext`;
      // unknown tool names are silently ignored (the allow list cannot
      // surface a non-existent tool).
      return;
  }
}

interface PermissionAccumulator {
  bashPatterns: Record<string, OpencodePermissionValue>;
  bashWholeDeny: boolean;
  editDeny: boolean;
  webfetchDeny: boolean;
  readHardDisable: boolean;
  warnings: string[];
  /** MCP server ids that surfaced at least one tool-level entry. Reported once. */
  mcpServersFlagged: Set<string>;
}

function flagMcpServer(
  state: PermissionAccumulator,
  serverId: string,
  origin: "disallowedTools" | "mcpDisallowed",
): void {
  if (state.mcpServersFlagged.has(serverId)) return;
  state.mcpServersFlagged.add(serverId);
  state.warnings.push(
    `opencode: per-tool MCP deny is not expressible in opencode 1.14.50 (server '${serverId}', via ${origin}). Drop the server from the MCP config to deny — the config builder will omit unlisted servers.`,
  );
}

function applyDisallowed(
  parsed: ParsedToolEntry,
  state: PermissionAccumulator,
): void {
  // MCP entries — server-level only, no per-tool deny key.
  if (parsed.name.startsWith("mcp__")) {
    const serverId = extractMcpServerId(parsed.name);
    if (serverId) {
      flagMcpServer(state, serverId, "disallowedTools");
    }
    return;
  }

  switch (parsed.name) {
    case "Bash":
      if (parsed.pattern) {
        // Pattern-map entries always win — preserve verbatim so the bash
        // glob matcher inside opencode does the per-command match.
        state.bashPatterns[parsed.pattern] = "deny";
      } else {
        state.bashWholeDeny = true;
      }
      return;
    case "Edit":
    case "Write":
      state.editDeny = true;
      if (parsed.pattern) {
        state.warnings.push(
          `opencode: '${parsed.name}(${parsed.pattern})' — opencode's edit permission is whole-tool only; pattern dropped, edit denied wholesale (V5).`,
        );
      }
      return;
    case "Read":
      state.readHardDisable = true;
      if (parsed.pattern) {
        state.warnings.push(
          `opencode: 'Read(${parsed.pattern})' — opencode has no read permission key; surfacing as tools.read=false (hard-disable). Add Bash glob denies (e.g. 'Bash(cat ${parsed.pattern})') for finer-grained coverage.`,
        );
      } else {
        state.warnings.push(
          `opencode: 'Read' — surfacing as tools.read=false (hard-disable, V5).`,
        );
      }
      return;
    case "WebFetch":
      state.webfetchDeny = true;
      return;
    default:
      state.warnings.push(
        `opencode: tool '${parsed.name}' has no opencode permission mapping; entry ignored.`,
      );
  }
}

/**
 * Build an `OpencodePermissionConfig` from Claude's `disallowedTools` /
 * `allowedToolsOverride` envelope.
 *
 * Mode semantics:
 *   - `strict` — emit every deny rule + every override. The config-builder
 *     merges the absolute-block layer on top so absolute denies always win.
 *   - `allow` — drop per-session denies (the operator opted in to "no
 *     daemon-side restrictions"). The absolute-block layer is **still**
 *     merged by the config-builder; only the user-configured denylist is
 *     skipped here.
 *
 * Returns three slots:
 *   - `permission` — fed into `OpencodeRuntimeConfig.permission`.
 *   - `toolsHardDisable` — fed into `OpencodeRuntimeConfig.tools` (and
 *     into the agent profile frontmatter's `tools:` block on
 *     `runDelegatedTask` — Phase 4).
 *   - `warnings` — surfaced via the dashboard so operators see when an
 *     entry was dropped because opencode can't express it.
 */
export function buildOpencodePermission(
  input: OpencodePermissionBuildInput,
): OpencodePermissionBuildResult {
  const state: PermissionAccumulator = {
    bashPatterns: {},
    bashWholeDeny: false,
    editDeny: false,
    webfetchDeny: false,
    readHardDisable: false,
    warnings: [],
    mcpServersFlagged: new Set<string>(),
  };

  if (input.mode === "strict") {
    for (const raw of input.disallowedTools) {
      const parsed = parseToolEntry(raw);
      if (!parsed) {
        state.warnings.push(
          `opencode: could not parse disallowedTools entry '${raw}'; ignored`,
        );
        continue;
      }
      applyDisallowed(parsed, state);
    }
  }

  // mcpDisallowed (result of `buildMcpDisallowedTools()`) is always
  // examined — even in allow mode — because the autonomous approve-tier
  // strip is a safety-net the daemon applies before opencode even sees
  // the request, and the server-level omission is what enforces it.
  for (const tool of input.mcpDisallowed) {
    const serverId = extractMcpServerId(tool);
    if (serverId) {
      flagMcpServer(state, serverId, "mcpDisallowed");
    }
  }

  // `allowedToolsOverride` is only meaningful in strict mode — allow mode
  // already runs without per-session denies, so an override is moot.
  if (input.mode === "strict" && input.allowedToolsOverride) {
    for (const raw of input.allowedToolsOverride) {
      const parsed = parseToolEntry(raw);
      if (!parsed) {
        state.warnings.push(
          `opencode: could not parse allowedToolsOverride entry '${raw}'; ignored`,
        );
        continue;
      }
      applyAllowedOverride(parsed, state);
    }
  }

  return assemble(state);
}

function assemble(state: PermissionAccumulator): OpencodePermissionBuildResult {
  const permission: OpencodePermissionConfig = {};

  // Bash: pattern-map wins when any pattern is present. When both a
  // pattern map and a wholesale deny are requested, emit the map plus a
  // `"*"` wildcard catch-all so any non-listed bash command falls through
  // to deny.
  if (Object.keys(state.bashPatterns).length > 0) {
    const bash: Record<string, OpencodePermissionValue> = {
      ...state.bashPatterns,
    };
    if (state.bashWholeDeny && bash["*"] === undefined) {
      bash["*"] = "deny";
    }
    permission.bash = bash as OpencodeBashPermission;
  } else if (state.bashWholeDeny) {
    permission.bash = "deny";
  }

  if (state.editDeny) permission.edit = "deny";
  if (state.webfetchDeny) permission.webfetch = "deny";

  const toolsHardDisable: Record<string, boolean> = {};
  if (state.readHardDisable) {
    toolsHardDisable.read = false;
  }

  return {
    permission,
    toolsHardDisable,
    warnings: state.warnings,
  };
}

/**
 * Test-only helper export so the property-matrix in
 * `opencode-permission.test.ts` can drive every entry shape through the
 * same parser the production path uses.
 *
 * `parseToolEntry` is intentionally NOT a public API — consumers should
 * go through `buildOpencodePermission` so the warnings list stays the
 * single audit surface.
 *
 * @internal
 */
export const __test = { parseToolEntry, extractMcpServerId };
