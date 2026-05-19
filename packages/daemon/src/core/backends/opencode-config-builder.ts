/**
 * docs/design/appendices/opencode-backend.md §5.1 / §5.8 / Phase 3 — assemble the
 * complete `OpencodeRuntimeConfig` envelope a session needs.
 *
 * Inputs (already normalised by caller):
 *   - `modelId`: provider/model composite from the BackendRouter.
 *   - `executionMode`: per-backend Safe/Allow posture.
 *   - `disallowedTools`: per-session denylist (Claude-shaped).
 *   - `allowedToolsOverride`: dashboard widen list (Claude-shaped) or null.
 *   - `mcpRender`: result of `renderOpencodeMcp` — the per-session `mcp`
 *     map plus warnings the dashboard surfaces.
 *
 * Outputs:
 *   - `config`: the envelope to pass through to `serverManager.ensureConfig()`
 *     (which hashes it and bounces the server if it differs from the
 *     running hash). Per §5.1 the daemon ALWAYS emits a full self-contained
 *     JSON — no field is left to the merge layer.
 *   - `warnings`: collected from both translators so the dashboard can
 *     show the operator which entries opencode can't express verbatim.
 *
 * Self-contained invariant: every field on `OpencodeRuntimeConfig` is
 * explicit (or deliberately omitted) so the daemon's behaviour does not
 * depend on the merge-vs-replace semantics of `OPENCODE_CONFIG_CONTENT`
 * (§10 D1, deferred). This means a same-envelope second turn produces a
 * bit-identical config and skips the bounce (§5.1 cost model).
 *
 * Pure function — no I/O, no DB reads. Wired into `OpencodeCore.execute()`
 * after `materializeMcpForSession` resolves the per-backend MCP list.
 */

import {
  buildOpencodePermission,
  type ExecutionPermissionMode,
  type OpencodeBashPermission,
  type OpencodeMcpServerConfig,
  type OpencodePermissionConfig,
  type OpencodePermissionValue,
  type OpencodeRuntimeConfig,
} from "@aitne/shared";
import { buildOpencodeAbsoluteBlockPermission } from "../../safety/always-disallowed.js";

export interface OpencodeConfigBuilderInput {
  modelId: string;
  executionMode: ExecutionPermissionMode;
  disallowedTools: readonly string[];
  allowedToolsOverride: readonly string[] | null;
  mcpDisallowed: readonly string[];
  /**
   * Per-session MCP map (already filtered to enabled + opencode-targeted
   * + name-linted by `renderOpencodeMcp`). Empty when no MCP targets the
   * session.
   */
  mcp: Record<string, OpencodeMcpServerConfig>;
  /**
   * V1+V2 — `AGENTS.md` and `.claude/skills/<name>/SKILL.md` are
   * auto-discovered from the session cwd. The default is therefore an
   * EMPTY instructions array; the daemon explicitly omits the field.
   * Operators set `PA_OPENCODE_DEFENSIVE_INSTRUCTIONS=1` to force-emit
   * the defensive glob list.
   */
  defensiveInstructions?: boolean;
  /**
   * Extra hard-disable tool entries (e.g. `read: false` when a session
   * must have zero read capability). Composed with the V8 subagent
   * suppression (`task: false`) the builder always emits.
   */
  extraHardDisable?: Record<string, boolean>;
}

export interface OpencodeConfigBuilderResult {
  config: OpencodeRuntimeConfig;
  /**
   * Operator-facing notices from the permission translator and the MCP
   * renderer. Dashboard surfaces these inline on the runtime-config
   * preview tile.
   */
  warnings: string[];
}

/**
 * Defensive `instructions` glob list (V12 — only useful when the
 * session cwd is symlinked or chrooted in a way that defeats
 * auto-discovery). Skills are intentionally NOT listed here — including
 * `.claude/skills/**\/SKILL.md` would inflate the system prompt with
 * every skill body. Skills auto-discover separately via opencode's
 * `skill` tool (§5.5).
 */
const DEFENSIVE_INSTRUCTIONS = [
  "AGENTS.md",
  ".opencode/agent/*.md",
] as const;

/**
 * Merge two `OpencodePermissionConfig` blocks. The second argument
 * **wins** for whole-key collisions — absolute-block entries override
 * any user-configured allow/deny. For the `bash` pattern-map, the merge
 * is per-pattern with `b` winning.
 *
 * Why per-pattern merge: a Phase-3 acceptance gate requires that an
 * operator who explicitly allows `Bash(npm *)` does not have their
 * allow erased by the absolute-block layer (which has no `npm *` deny).
 * Same-pattern collisions deny-wins because the absolute-block layer
 * is non-negotiable.
 */
function mergePermissions(
  base: OpencodePermissionConfig,
  override: OpencodePermissionConfig,
): OpencodePermissionConfig {
  const out: OpencodePermissionConfig = { ...base };

  // bash — pattern-map vs triple merge
  if (override.bash !== undefined) {
    out.bash = mergeBash(base.bash, override.bash);
  }
  // triple-only keys — override wins (absolute-block layer never emits
  // these today, but kept future-proof).
  if (override.edit !== undefined) out.edit = override.edit;
  if (override.webfetch !== undefined) out.webfetch = override.webfetch;
  if (override.doom_loop !== undefined) out.doom_loop = override.doom_loop;
  if (override.external_directory !== undefined) {
    out.external_directory = override.external_directory;
  }

  return out;
}

function mergeBash(
  base: OpencodeBashPermission | undefined,
  override: OpencodeBashPermission,
): OpencodeBashPermission {
  // Override is a triple: it is by definition the strongest expression on
  // this key, so it wins wholesale.
  if (typeof override === "string") return override;
  if (base === undefined) {
    return { ...override };
  }
  if (typeof base === "string") {
    // Base is a wholesale triple ("deny" / "ask" / "allow" — only "deny"
    // is reachable today via bare `Bash` in disallowedTools, but the
    // future-proof branches stay so a per-session translator gaining
    // bash:"ask"/"allow" emission later does not silently regress).
    //
    // The override is a pattern map of absolute-block denies. We MUST
    // preserve base's wholesale semantic, otherwise a user who said
    // "deny all bash" (bare `Bash`) would see their policy silently
    // widened to "deny only the absolute-block patterns" once those
    // patterns merge in. Encode the wholesale semantic as a `"*"`
    // catch-all on the merged pattern map — opencode's pattern matcher
    // prefers specific patterns over `*`, so the absolute-block entries
    // remain enforceable AND the catch-all carries the base value for
    // every unlisted command.
    const merged: Record<string, OpencodePermissionValue> = { ...override };
    if (merged["*"] === undefined) {
      merged["*"] = base;
    }
    return merged;
  }
  // Both are pattern-maps. Merge — override wins per-key.
  const merged: Record<string, OpencodePermissionValue> = { ...base };
  for (const [pat, value] of Object.entries(override)) {
    merged[pat] = value;
  }
  return merged;
}

/**
 * Build the complete `OpencodeRuntimeConfig` for a session.
 *
 * Ordering invariants (locked by `opencode-config-builder.test.ts`):
 *   1. The per-session translator's output is built FIRST (so warnings
 *      reflect what the operator configured).
 *   2. The absolute-block layer is merged on top — its denies always win
 *      over any per-session allow.
 *   3. `tools` is composed as `{ task: false, …caller-extras, …read-hard-
 *      disable }` — the order matches the JSON serialisation order and
 *      keeps the hash stable across same-envelope turns.
 */
export function buildOpencodeRuntimeConfig(
  input: OpencodeConfigBuilderInput,
): OpencodeConfigBuilderResult {
  const warnings: string[] = [];

  const perSession = buildOpencodePermission({
    disallowedTools: input.disallowedTools,
    allowedToolsOverride: input.allowedToolsOverride ?? null,
    mcpDisallowed: input.mcpDisallowed,
    mode: input.executionMode,
  });
  warnings.push(...perSession.warnings);

  const absolute = buildOpencodeAbsoluteBlockPermission();
  warnings.push(...absolute.warnings);

  // mergePermissions: per-session is the base, absolute-block is the
  // override. This produces "absolute wins" semantics for any same-key
  // collision in the bash pattern map.
  const permission = mergePermissions(
    perSession.permission,
    absolute.permission as OpencodePermissionConfig,
  );

  const tools: Record<string, boolean> = {
    // V8 — subagent suppression. opencode's `task` tool spawns subagents
    // outside the daemon's audit/stream surface; we always disable it.
    task: false,
    ...(input.extraHardDisable ?? {}),
    ...perSession.toolsHardDisable,
  };

  const config: OpencodeRuntimeConfig = {
    tools,
    permission,
  };

  // Only emit `model` when the composite parses as provider/model. The
  // server falls back to its own configured default when the field is
  // omitted; this keeps the bounce-hash stable when callers (tests)
  // pass an ad-hoc model id.
  if (input.modelId.includes("/")) {
    config.model = input.modelId;
  }

  if (Object.keys(input.mcp).length > 0) {
    config.mcp = input.mcp;
  }

  if (input.defensiveInstructions) {
    config.instructions = [...DEFENSIVE_INSTRUCTIONS];
  }

  return { config, warnings };
}

/**
 * `PA_OPENCODE_DEFENSIVE_INSTRUCTIONS=1` opts in to the defensive
 * `instructions` glob list. Centralised here so callers don't repeat
 * the env-var-name string.
 */
export function defensiveInstructionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PA_OPENCODE_DEFENSIVE_INSTRUCTIONS === "1";
}
