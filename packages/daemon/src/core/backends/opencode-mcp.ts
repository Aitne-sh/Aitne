/**
 * docs/design/appendices/opencode-backend.md §5.1 / §5.6 / §6.x — render the daemon's
 * `McpServer` rows into `OpencodeRuntimeConfig.mcp`.
 *
 * Unlike Claude / Codex / Gemini which read on-disk MCP config files
 * (`.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`),
 * OpenCode receives MCP config inline via `OPENCODE_CONFIG_CONTENT`
 * consumed at server-spawn time (§5.1). The daemon therefore produces
 * the `Record<string, McpLocalConfig | McpRemoteConfig>` map directly
 * instead of writing a file under the session workdir.
 *
 * Pure function — DB / blob-store access happens upstream in
 * `materializeMcpForSession`'s sibling caller. The renderer takes the
 * already-filtered server list + resolved secrets and produces:
 *   - `mcp`: the runtime-config map.
 *   - `env`: env vars the spawned `opencode serve` process must export
 *     so the `environment` placeholders resolve at MCP-spawn time.
 *     OpenCode does NOT do `${VAR}` expansion on stdio env values
 *     (V7 fixture), so we inline concrete values into `environment` —
 *     `env` stays empty for stdio servers. For remote servers, header
 *     values are inlined directly into the `headers` map.
 *   - `warnings`: server-name lint failures (`_`-containing ids) and
 *     unsupported-transport notices. Surfaced via dashboard.
 *
 * Server-name lint (§5.6): the documented mangling rule
 *   `mcp__<server>__<tool>` → `<server>_<tool>`
 * is ambiguous when `<server>` contains `_`. Until the SDK exposes
 * MCP tool ids (V7 deferred), we reject `_`-containing server names at
 * config-build time so the daemon never produces a config whose
 * server→tool boundary cannot be reconstructed.
 */

import { createLogger } from "../../logging.js";
import type {
  OpencodeMcpLocalServerConfig,
  OpencodeMcpRemoteServerConfig,
  OpencodeMcpServerConfig,
} from "@aitne/shared";
import type { McpServer } from "../../services/mcp/types.js";

const logger = createLogger("opencode-mcp");

/**
 * Inputs to the renderer. `secrets` is keyed by `<serverId>:<keyName>`
 * (the same shape `materializeMcpForSession` already produces for the
 * other backends).
 */
export interface OpencodeMcpRenderInput {
  /** MCP servers, already filtered to enabled + targeting opencode. */
  servers: readonly McpServer[];
  /** Resolved secrets, keyed `<serverId>:<keyName>`. */
  secrets: Record<string, string>;
  /**
   * Default tools-listing timeout to apply when the server row carries
   * none. Omit to let opencode's 5000 ms default apply.
   */
  defaultTimeoutMs?: number;
}

export interface OpencodeMcpRenderResult {
  /** Ready to drop into `OpencodeRuntimeConfig.mcp`. */
  mcp: Record<string, OpencodeMcpServerConfig>;
  /**
   * Env vars the daemon must export when spawning `opencode serve` (or
   * when probing remote server headers that mention `${MCP_…}`). Empty
   * for inline-only configurations.
   */
  env: Record<string, string>;
  /**
   * Server-name lint failures + transport rejections. Surface via the
   * dashboard so operators can rename / fix the upstream `mcp_servers`
   * row before the next session bounces.
   */
  warnings: string[];
}

/**
 * V5/§5.6 server-name lint. Returns null when the id is acceptable,
 * otherwise a human-readable reason that explains why the server was
 * dropped. Mirrors Codex's stricter `lowercase + dash only` rule
 * extended with the opencode-specific `_` prohibition.
 */
export function isAcceptableOpencodeServerName(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

function joinCommand(server: McpServer): string[] {
  const cmd = server.command?.trim();
  if (!cmd) return [];
  const argv = server.args ? server.args.filter((a): a is string => typeof a === "string") : [];
  return [cmd, ...argv];
}

/**
 * Render the stdio-transport variant: opencode treats every entry in
 * `command` as one argv element (it does not run through a shell). We
 * pass `environment` inline because opencode's stdio launcher does NOT
 * expand `${VAR}` references at runtime (V7).
 */
function renderLocal(
  server: McpServer,
  secrets: Record<string, string>,
  defaultTimeoutMs?: number,
): OpencodeMcpLocalServerConfig | null {
  const command = joinCommand(server);
  if (command.length === 0) return null;
  const environment: Record<string, string> = {};
  for (const key of server.envKeys) {
    const raw = secrets[`${server.id}:${key}`];
    if (raw !== undefined) environment[key] = raw;
  }
  const local: OpencodeMcpLocalServerConfig = {
    type: "local",
    command,
    enabled: true,
  };
  if (Object.keys(environment).length > 0) local.environment = environment;
  if (typeof defaultTimeoutMs === "number" && defaultTimeoutMs > 0) {
    local.timeout = defaultTimeoutMs;
  }
  return local;
}

/**
 * Render http / sse transport. The SDK's `McpRemoteConfig` does not
 * distinguish — both flow through the same shape; opencode's remote
 * dispatcher negotiates transport. Header values are inlined.
 */
function renderRemote(
  server: McpServer,
  secrets: Record<string, string>,
  defaultTimeoutMs?: number,
): OpencodeMcpRemoteServerConfig | null {
  if (!server.url) return null;
  const headers: Record<string, string> = {};
  for (const key of server.headerKeys) {
    const raw = secrets[`${server.id}:${key}`];
    if (raw !== undefined) headers[key] = raw;
  }
  const remote: OpencodeMcpRemoteServerConfig = {
    type: "remote",
    url: server.url,
    enabled: true,
  };
  if (Object.keys(headers).length > 0) remote.headers = headers;
  if (typeof defaultTimeoutMs === "number" && defaultTimeoutMs > 0) {
    remote.timeout = defaultTimeoutMs;
  }
  return remote;
}

/**
 * Main entry point. Pure — no I/O, deterministic given the same input.
 *
 * Servers whose name fails the lint OR whose required transport field
 * is missing (stdio without command, http/sse without url) are dropped
 * with a warning. The daemon then proceeds without that server — same
 * fail-soft posture as the Claude / Codex / Gemini generators.
 */
export function renderOpencodeMcp(
  input: OpencodeMcpRenderInput,
): OpencodeMcpRenderResult {
  const mcp: Record<string, OpencodeMcpServerConfig> = {};
  const warnings: string[] = [];

  for (const server of input.servers) {
    if (!server.enabled) continue;
    if (!isAcceptableOpencodeServerName(server.id)) {
      warnings.push(
        `opencode-mcp: server '${server.id}' rejected — opencode-mangled tool ids (mcp__<server>__<tool> → <server>_<tool>) become ambiguous when the server id contains '_'. Rename to lowercase kebab-case.`,
      );
      continue;
    }
    if (server.transport === "stdio") {
      const local = renderLocal(server, input.secrets, input.defaultTimeoutMs);
      if (!local) {
        warnings.push(
          `opencode-mcp: stdio server '${server.id}' has no 'command'; skipped`,
        );
        continue;
      }
      mcp[server.id] = local;
      continue;
    }
    /* c8 ignore start — McpTransport is closed-set; the http/sse branch
       always covers the remaining transports after the stdio early-return
       above, so the false-branch + unknown fallthrough below are
       unreachable unless a future transport ships without updating the
       renderer. */
    if (server.transport === "http" || server.transport === "sse") {
      /* c8 ignore stop */
      const remote = renderRemote(server, input.secrets, input.defaultTimeoutMs);
      if (!remote) {
        warnings.push(
          `opencode-mcp: ${server.transport} server '${server.id}' has no 'url'; skipped`,
        );
        continue;
      }
      mcp[server.id] = remote;
      continue;
    }
    /* c8 ignore start — see note above. */
    const unknown: never = server.transport;
    warnings.push(
      `opencode-mcp: unsupported transport '${String(unknown)}' for server '${server.id}'`,
    );
  }
  /* c8 ignore stop */

  if (Object.keys(mcp).length > 0) {
    logger.debug(
      { serverIds: Object.keys(mcp), warningCount: warnings.length },
      "rendered opencode mcp map",
    );
  }

  return {
    mcp,
    // OpenCode's `environment` map already carries inlined values for
    // stdio servers, and `headers` for remote servers, so no separate
    // env vector needs to flow into the spawn env. Reserved here so a
    // future opencode version that supports `${VAR}` expansion can fill
    // this in without a signature change.
    env: {},
    warnings,
  };
}
