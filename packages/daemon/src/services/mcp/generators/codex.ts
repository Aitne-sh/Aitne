import { z } from "zod";
import { stringify as stringifyToml } from "@iarna/toml";
import type { McpServer } from "../types.js";
import {
  buildEnvFromServers,
  scopedEnvVarName,
  serversForBackend,
  type GeneratedMcpConfig,
  type GeneratorOptions,
} from "./types.js";

/**
 * B-003 Phase 2 — Codex MCP config generator (.codex/config.toml).
 *
 * Codex uses TOML and has no explicit `type` field — the transport is
 * inferred from which keys are present (`command` = stdio, `url` = http).
 * HTTP transport currently requires `features.experimental_use_rmcp_client`
 * to be set globally.
 *
 * For bearer-auth over HTTP, Codex expects the token to come from an
 * environment variable referenced by `bearer_token_env_var`. For stdio env
 * passthrough, Codex reads `env = { KEY = "value" }` directly — there is
 * no `${VAR}` expansion like Claude has, so we inline the concrete value
 * we receive from the blob store.
 *
 * Spec reference: Codex CLI docs, `mcp_servers` + `features.experimental_use_rmcp_client`
 * — last reviewed 2026-04-18.
 */
export const SPEC_VERSION = "codex-2026-04-18";

const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const HttpServerSchema = z.object({
  url: z.string().url(),
  bearer_token_env_var: z.string().min(1).optional(),
});

// Codex's schema is "one-of stdio | http" but TOML can't express unions;
// we validate each entry individually.
const CodexEntrySchema = z.union([StdioServerSchema, HttpServerSchema]);

export function generateCodexConfig(
  allServers: readonly McpServer[],
  options: GeneratorOptions,
): GeneratedMcpConfig {
  const servers = serversForBackend(allServers, "codex");

  const body: Record<string, unknown> = {};
  const mcpServers: Record<string, unknown> = {};
  let needsRmcp = false;

  for (const server of servers) {
    if (server.transport === "stdio") {
      if (!server.command) continue;
      const env: Record<string, string> = {};
      // Codex has no placeholder expansion — inline concrete values. We
      // pull them from `options.secrets` (already namespaced as
      // `<serverId>:<keyName>`) and surface them to Codex under the
      // caller-visible key name.
      for (const key of server.envKeys) {
        const raw = options.secrets[`${server.id}:${key}`];
        if (raw !== undefined) env[key] = raw;
      }
      const entry: Record<string, unknown> = {
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
      CodexEntrySchema.parse(entry);
      mcpServers[server.id] = entry;
      continue;
    }

    if (server.transport === "http" || server.transport === "sse") {
      // Codex only supports streamable HTTP for remote MCPs; SSE falls into
      // the same config shape since the rmcp client negotiates transport.
      if (!server.url) continue;
      needsRmcp = true;
      // Pick a single header to drive `bearer_token_env_var` — by convention,
      // we key off a header literally named "Authorization". Multi-header
      // support isn't in Codex's schema yet; if the user declares more than
      // one, we emit only the bearer env ref and let the probe flag it.
      const bearerKey = server.headerKeys.find(
        (k) => k.toLowerCase() === "authorization",
      );
      const entry: Record<string, unknown> = {
        url: server.url,
        ...(bearerKey
          ? { bearer_token_env_var: scopedEnvVarName(server.id, bearerKey) }
          : {}),
      };
      CodexEntrySchema.parse(entry);
      mcpServers[server.id] = entry;
    }
  }

  if (needsRmcp) {
    body.features = { experimental_use_rmcp_client: true };
  }
  if (Object.keys(mcpServers).length > 0) {
    body.mcp_servers = mcpServers;
  }

  // For http/sse, the bearer token still flows via child-process env —
  // bearer_token_env_var points Codex at the scoped env name. For stdio,
  // Codex uses the inlined env block so this env record stays empty for
  // stdio-only mixes.
  const env = buildEnvFromServers(servers, options, (server) =>
    server.transport === "stdio" ? [] : server.headerKeys,
  );

  return {
    path: ".codex/config.toml",
    contents: stringifyToml(body as Parameters<typeof stringifyToml>[0]),
    env,
  };
}
