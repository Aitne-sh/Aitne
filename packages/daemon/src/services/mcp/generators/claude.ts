import { z } from "zod";
import type { McpServer } from "../types.js";
import {
  buildEnvFromServers,
  scopedEnvVarName,
  serversForBackend,
  type GeneratedMcpConfig,
  type GeneratorOptions,
} from "./types.js";

/**
 * B-003 Phase 2 — Claude MCP config generator (.mcp.json).
 *
 * Claude Code / Agent SDK discovers MCP servers from `<workdir>/.mcp.json`.
 * The SDK also accepts the same shape as the `mcpServers` option to `query()`.
 *
 * Spec reference: https://docs.claude.com/en/docs/claude-code/mcp.json
 * — last reviewed 2026-04-18.
 *
 * Secrets are NOT inlined in the file. We emit `${MCP_<ID>_<KEY>}`
 * placeholders and carry the value in the spawned-process env; Claude's
 * config-file loader expands `${VAR}` references from that env at read time.
 */
export const SPEC_VERSION = "claude-2026-04-18";

const StdioServerSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const HttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const SseServerSchema = z.object({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpJsonSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.union([StdioServerSchema, HttpServerSchema, SseServerSchema]),
  ),
});

function envRefs(server: McpServer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of server.envKeys) {
    out[key] = `\${${scopedEnvVarName(server.id, key)}}`;
  }
  return out;
}

function headerRefs(server: McpServer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of server.headerKeys) {
    out[key] = `\${${scopedEnvVarName(server.id, key)}}`;
  }
  return out;
}

function allKeys(server: McpServer): readonly string[] {
  return [...server.envKeys, ...server.headerKeys];
}

export function generateClaudeConfig(
  allServers: readonly McpServer[],
  options: GeneratorOptions,
): GeneratedMcpConfig {
  const servers = serversForBackend(allServers, "claude");
  const mcpServers: Record<string, unknown> = {};

  for (const server of servers) {
    if (server.transport === "stdio") {
      if (!server.command) continue;
      const env = envRefs(server);
      mcpServers[server.id] = {
        type: "stdio",
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
      continue;
    }
    if (server.transport === "http" || server.transport === "sse") {
      if (!server.url) continue;
      const headers = headerRefs(server);
      mcpServers[server.id] = {
        type: server.transport,
        url: server.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
  }

  const body = { mcpServers };
  McpJsonSchema.parse(body);

  return {
    path: ".mcp.json",
    contents: `${JSON.stringify(body, null, 2)}\n`,
    env: buildEnvFromServers(servers, options, allKeys),
  };
}
