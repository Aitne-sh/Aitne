import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import { createLogger } from "../../logging.js";
import { listMcpServers, resolveMcpSecrets } from "./registry.js";
import { generateMcpConfig } from "./generators/index.js";
import { scopedEnvVarName } from "./generators/types.js";
import type { McpServer } from "./types.js";
import { buildMcpDisallowedTools } from "./risk.js";

/**
 * Byte cap for the rendered `## MCP tools available` section in an
 * instruction file. Mirrors the per-policy-file cap in policy-files.ts so a
 * single MCP server with many long-described tools can't inflate CLAUDE.md
 * past the prompt-cache-friendly range.
 */
export const MCP_SECTION_MAX_BYTES = 32 * 1024;

const logger = createLogger("mcp-session-materializer");

/**
 * Instruction file name per backend, matching `SkillsCompiler.materializeSession*`.
 */
const INSTRUCTION_FILES: Record<BackendId, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  gemini: "GEMINI.md",
  opencode: "AGENTS.md",
};

/**
 * Per-backend MCP config file path, relative to the session workdir. Must
 * match whatever each generator returns in its `path` field. When no MCP
 * servers target the backend, we delete the file here so the backend's own
 * loader (Claude SDK reading `.mcp.json` from cwd; Codex reading
 * `.codex/config.toml`; Gemini reading `.gemini/settings.json`) cannot pick
 * up a stale config from a prior materialize.
 */
const BACKEND_CONFIG_PATHS: Partial<Record<BackendId, string>> = {
  claude: ".mcp.json",
  codex: ".codex/config.toml",
  gemini: ".gemini/settings.json",
};

/**
 * Marker used to delimit the appendable MCP section in an instruction file
 * so repeat materialization replaces the block in-place instead of stacking
 * duplicates. The `<!-- -->` comment style survives every backend's
 * markdown renderer and is ignored by the agent when it reads the file.
 */
const MCP_SECTION_BEGIN = "<!-- pa:mcp-section:begin -->";
const MCP_SECTION_END = "<!-- pa:mcp-section:end -->";

export interface McpSessionMaterialization {
  /** Enabled servers targeting this backend, in DB order (for callers / logging). */
  servers: readonly McpServer[];
  /**
   * Env variables that must be exported into the spawned agent process.
   * Keys are `scopedEnvVarName(serverId, keyName)`; values are the resolved
   * secret. Missing secrets are simply omitted — the backend will fail at
   * call time rather than the daemon silently substituting an empty string.
   */
  env: Record<string, string>;
  /** Absolute path of the config file written into the session workdir, or null when no MCP targets this backend. */
  configPath: string | null;
  /**
   * Claude-only: the object-shape the SDK's `mcpServers` option accepts.
   * Null for Codex / Gemini (they only read the file). Generated from the
   * same JSON content so the file and the in-memory shape never drift.
   */
  claudeMcpServers: Record<string, unknown> | null;
  /** Tool names to append to the session's `disallowedTools`. */
  disallowedTools: string[];
}

export interface MaterializeMcpParams {
  db: Database.Database;
  blobStore: EncryptedBlobStore;
  sessionDir: string;
  backendId: BackendId;
  /**
   * Whether the session is autonomous (routine / scheduled task). Controls
   * the approve-tier strip in `buildMcpDisallowedTools`.
   */
  autonomous: boolean;
  /**
   * Resolved vault context dir (result of `getContextDir(config)`). Used
   * only to decide whether the agent-facing MCP section should mention
   * `policies/mcp.md`. Optional so tests and internal callers without a
   * config handle can still materialize; when omitted the reference is
   * silently dropped instead of pointing at a non-existent file.
   */
  contextDir?: string;
}

/**
 * B-003 Phase 3 — idempotent per-session MCP materialization.
 *
 * Called by every agent core before handing off to the backend. Resolves
 * secrets, runs the backend's config-file generator, writes the file
 * atomically, and replaces the `## MCP tools available` section in the
 * instruction file in-place.
 *
 * Returns everything the caller needs to:
 *   - extend spawn env (`env`)
 *   - pass `mcpServers` to Claude's `query()` (`claudeMcpServers`)
 *   - merge blocks into `disallowedTools` (`disallowedTools`)
 *
 * Safe to call when no MCP servers target this backend: the helper short-
 * circuits to an empty return rather than writing an empty config file,
 * which would let a misconfigured backend still attempt to load MCP.
 */
export async function materializeMcpForSession(
  params: MaterializeMcpParams,
): Promise<McpSessionMaterialization> {
  const allServers = listMcpServers(params.db);
  const forBackend = allServers.filter(
    (s) => s.enabled && s.backends.includes(params.backendId),
  );

  if (forBackend.length === 0) {
    // Nothing to write. Still strip the instruction-file section in case a
    // previous session wrote one and the user has since disabled all MCPs
    // — otherwise the agent would see a stale tool menu.
    stripMcpSection(params.sessionDir, params.backendId);
    // Also remove the on-disk config file. Without this, the backend's own
    // loader (Claude SDK's `.mcp.json`, Codex's `.codex/config.toml`,
    // Gemini's `.gemini/settings.json`) would still find a stale config
    // from an earlier materialize and try to connect to disabled/removed
    // servers — with `${MCP_…}` env placeholders that are no longer set in
    // the spawn env, resulting in silent auth failures. For Codex stdio,
    // the stale file also contains inlined secret values, so deletion is
    // the defense-in-depth story too.
    const staleConfigPath = BACKEND_CONFIG_PATHS[params.backendId];
    if (staleConfigPath) {
      const stalePath = join(params.sessionDir, staleConfigPath);
      try {
        rmSync(stalePath, { force: true });
      } catch (err) {
        /* c8 ignore next — `force: true` swallows ENOENT and most other
           common failure modes; this guards against EACCES on a workdir the
           daemon owns, which shouldn't happen in practice. */
        logger.warn(
          { err, path: stalePath, backendId: params.backendId },
          "Failed to remove stale MCP config file",
        );
      }
    }
    return {
      servers: [],
      env: {},
      configPath: null,
      claudeMcpServers: null,
      disallowedTools: [],
    };
  }

  // Resolve secrets for every (enabled, backend-targeted) server.
  const scopedSecrets: Record<string, string> = {};
  for (const server of forBackend) {
    const raw = await resolveMcpSecrets(params.blobStore, server);
    for (const [keyName, value] of Object.entries(raw)) {
      if (value == null) continue;
      scopedSecrets[`${server.id}:${keyName}`] = value;
    }
  }

  const generated = generateMcpConfig(params.backendId, forBackend, {
    secrets: scopedSecrets,
  });

  const absConfigPath = join(params.sessionDir, generated.path);
  writeAtomic(absConfigPath, generated.contents);

  const rulesFileExists = params.contextDir
    ? existsSync(join(params.contextDir, "policies/mcp.md"))
    : false;

  appendMcpSection(params.sessionDir, params.backendId, forBackend, {
    backendId: params.backendId,
    autonomous: params.autonomous,
    rulesFileExists,
  });

  const disallowedTools = buildMcpDisallowedTools({
    servers: forBackend,
    autonomous: params.autonomous,
  });

  // For Claude, parse the generated JSON back into the `mcpServers` shape the
  // SDK accepts. Unlike the on-disk `.mcp.json` (which Claude Code's config
  // loader expands `${VAR}` references in), the in-memory object handed to
  // `query()` has no documented expansion step — the Agent SDK's
  // `McpHttpServerConfig.headers` type is just `Record<string, string>`.
  // If we pass literal `${MCP_…}` values, every request would ship that
  // string as the Authorization header and silently 401. So for the Claude
  // path specifically we substitute the placeholders with the resolved env
  // values here. The `.mcp.json` on disk keeps placeholders so a user who
  // inspects the file sees the intent, and so a CLI-invoked session (which
  // does expand) still works.
  let claudeMcpServers: Record<string, unknown> | null = null;
  if (params.backendId === "claude") {
    /* c8 ignore start — the Claude generator always emits `{ mcpServers:
       {...} }` as valid JSON, so both the ternary's falsy branch and the
       catch arm are unreachable under current code. Both are kept as
       defensive guards against a future generator regression or a file-
       system tamper that corrupts the already-written `.mcp.json`. The
       happy path is exercised by the test above. */
    try {
      const parsed = JSON.parse(generated.contents) as {
        mcpServers?: Record<string, unknown>;
      };
      claudeMcpServers = parsed.mcpServers
        ? resolvePlaceholdersDeep(parsed.mcpServers, generated.env)
        : null;
    } catch (err) {
      logger.warn(
        { err, path: generated.path },
        "Failed to re-parse generated Claude MCP config for SDK; falling back to file-only",
      );
    }
    /* c8 ignore stop */
  }

  logger.info(
    {
      sessionDir: params.sessionDir,
      backendId: params.backendId,
      servers: forBackend.map((s) => s.id),
      disallowedCount: disallowedTools.length,
      envKeys: Object.keys(generated.env).length,
    },
    "MCP materialized for session",
  );

  return {
    servers: forBackend,
    env: generated.env,
    configPath: absConfigPath,
    claudeMcpServers,
    disallowedTools,
  };
}

/**
 * Atomic write: stage to `<path>.tmp-<rand>` then rename. Prevents a reader
 * from seeing a half-written config if the agent spawns concurrently with
 * materialization (unlikely but cheap to guarantee).
 */
function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmpPath, contents, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, path);
}

function appendMcpSection(
  sessionDir: string,
  backendId: BackendId,
  servers: readonly McpServer[],
  options: RenderMcpSectionOptions,
): void {
  const instructionFile = join(sessionDir, INSTRUCTION_FILES[backendId]);
  const body = renderMcpSection(servers, options);
  replaceOrAppendSection(instructionFile, body);
}

function stripMcpSection(sessionDir: string, backendId: BackendId): void {
  const instructionFile = join(sessionDir, INSTRUCTION_FILES[backendId]);
  replaceOrAppendSection(instructionFile, null);
}

export interface RenderMcpSectionOptions {
  /**
   * Backend this section is being rendered for. The servers list is already
   * filtered to this backend by the caller; the id is surfaced in the
   * agent-facing text so a routine triaging multi-backend MCP coverage
   * doesn't assume it sees every server every session.
   */
  backendId?: BackendId;
  /**
   * Autonomous sessions strip every `approve`-tier server's tools via
   * `buildMcpDisallowedTools`. When true, we also replace the per-server
   * tool list with a one-line explanation so the model doesn't waste turns
   * trying to invoke blocked tools.
   */
  autonomous?: boolean;
  /**
   * Whether `<contextDir>/policies/mcp.md` exists. When false, the agent-facing
   * section no longer tells the model to consult a file that doesn't exist —
   * prevents spurious `curl` hunts in DMs and routines.
   */
  rulesFileExists?: boolean;
  /** Hard cap on the rendered section size. Defaults to `MCP_SECTION_MAX_BYTES`. */
  maxBytes?: number;
}

/**
 * Render the agent-facing `## MCP tools available` block.
 *
 * Size-bounded: emits `MCP_SECTION_END` unconditionally and truncates per-
 * server tool lists (and the server list itself) rather than blow past the
 * caller's byte budget. Allowlist-aware: probe tools outside the allowlist
 * are hidden, matching the SDK's `disallowedTools` enforcement so the model
 * never sees a tool it can't actually call. Autonomous-aware: approve-tier
 * servers render the block with a "blocked this turn" note in place of the
 * tool enumeration.
 */
export function renderMcpSection(
  servers: readonly McpServer[],
  options: RenderMcpSectionOptions = {},
): string {
  const {
    backendId,
    autonomous = false,
    rulesFileExists = false,
    maxBytes = MCP_SECTION_MAX_BYTES,
  } = options;

  const lines: string[] = [];
  let bytes = 0;
  const endLine = MCP_SECTION_END;
  const endReserve = Buffer.byteLength(endLine, "utf-8") + 2;

  const push = (line: string): void => {
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline join
  };
  const wouldFit = (line: string): boolean =>
    bytes + Buffer.byteLength(line, "utf-8") + 1 + endReserve <= maxBytes;

  push(MCP_SECTION_BEGIN);
  push("");
  push("## MCP tools available");
  push("");
  push(
    backendId
      ? `The following MCP servers are enabled for this session (backend: \`${backendId}\`).`
      : "The following MCP servers are enabled.",
  );
  if (rulesFileExists) {
    push("Consult `policies/mcp.md` for per-server usage rules.");
  }
  push("");

  let truncatedServers = 0;

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const headerLine = `### ${server.name} (\`${server.id}\`)`;
    if (!wouldFit(headerLine)) {
      truncatedServers = servers.length - i;
      break;
    }
    push(headerLine);
    push("");
    push(`Risk tier: \`${server.riskTier}\``);

    const autonomouslyBlocked =
      autonomous && server.riskTier === "approve";
    if (autonomouslyBlocked) {
      push("");
      push(
        "_Tools from this approve-tier server are blocked in the current autonomous session. Surface an observation if the owner needs to intervene._",
      );
    }

    const allowlist = server.toolAllowlist;
    const probeTools = server.lastProbeStatus?.tools ?? [];
    // Filter probe results by allowlist so the agent-visible tool list is
    // exactly the set the SDK will actually let through. `disallowedTools`
    // still enforces this server-side; hiding non-allowlisted tools here
    // avoids repeated "tool not available" retries from the model.
    const visibleTools =
      allowlist && allowlist.length > 0
        ? probeTools.filter((t) => allowlist.includes(t.name))
        : probeTools;

    if (allowlist && allowlist.length > 0) {
      push(`Allowed tools: ${allowlist.map((t) => `\`${t}\``).join(", ")}`);
    }

    if (!autonomouslyBlocked) {
      push("");
      if (probeTools.length === 0) {
        push("_No probe results recorded. Run a probe to enumerate tools._");
      } else if (visibleTools.length === 0) {
        push("_No probed tools match the allowlist._");
      } else {
        let emitted = 0;
        let truncated = false;
        for (const tool of visibleTools) {
          const desc = tool.description ? ` — ${tool.description}` : "";
          const line = `- \`${tool.name}\`${desc}`;
          if (!wouldFit(line)) {
            truncated = true;
            break;
          }
          push(line);
          emitted++;
        }
        if (truncated) {
          push(
            `_…${visibleTools.length - emitted} more tools truncated (section size cap reached)._`,
          );
        }
      }
    }
    push("");
  }

  if (truncatedServers > 0) {
    // These pushes deliberately bypass `wouldFit`: we held back `endReserve`
    // bytes exactly so the truncation notice + end marker always land.
    lines.push(
      `_…${truncatedServers} more server(s) truncated (section size cap reached)._`,
    );
    lines.push("");
  }
  lines.push(endLine);
  return lines.join("\n");
}

/**
 * Replace the marker-delimited block in `path` with `body`. When `body` is
 * null the block is removed entirely. When no marker exists and `body` is
 * non-null the block is appended. Missing instruction files are left alone
 * — the skills compiler writes them first; if the file is absent something
 * upstream has gone wrong and we don't want to paper over it here.
 */
function replaceOrAppendSection(path: string, body: string | null): void {
  let current: string;
  try {
    current = readFileSync(path, "utf-8");
  } catch {
    logger.debug({ path }, "instruction file missing; skipping MCP section write");
    return;
  }
  const beginIdx = current.indexOf(MCP_SECTION_BEGIN);
  const endIdx = current.indexOf(MCP_SECTION_END);
  let next: string;
  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = current.slice(0, beginIdx).trimEnd();
    const after = current.slice(endIdx + MCP_SECTION_END.length).trimStart();
    if (body === null) {
      next = `${before}\n${after ? after + "\n" : ""}`;
    } else {
      next = `${before}\n\n${body}\n${after ? "\n" + after : ""}`.trimEnd() + "\n";
    }
  } else {
    if (body === null) return; // nothing to do
    next = `${current.trimEnd()}\n\n${body}\n`;
  }
  if (next !== current) {
    writeFileSync(path, next, { encoding: "utf-8", mode: 0o600 });
  }
}

// Re-export for convenient use from agent cores that want to mint env var
// names without depending on generators/types directly.
export { scopedEnvVarName };

/**
 * Recursively substitute `${VAR}` placeholders in string values using
 * `env` as the lookup table. Designed for the Claude in-memory
 * `mcpServers` object where the SDK accepts nested `Record<string, string>`
 * for headers / env but does not perform its own env-var expansion.
 *
 * Missing variables are left as the literal placeholder — the same
 * behavior as failing the request, so the agent sees a visible
 * `${MCP_FOO_BAR}` auth string rather than an empty header that would
 * produce a 401 with no obvious clue.
 *
 * Exported for the test; kept here (rather than in `./risk.ts`) because
 * it is tightly coupled to the generator's placeholder format.
 */
export function resolvePlaceholdersDeep<T>(
  value: T,
  env: Record<string, string>,
): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
      const resolved = env[name];
      return resolved === undefined ? match : resolved;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolvePlaceholdersDeep(v, env)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolvePlaceholdersDeep(v, env);
    }
    return out as unknown as T;
  }
  return value;
}
