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
 * B-003 Phase 2 — Gemini MCP config generator (.gemini/settings.json).
 *
 * Gemini CLI discovers MCP servers from `<workdir>/.gemini/settings.json`
 * under the top-level `mcpServers` key. Transport is keyed off which of
 * `httpUrl` / `url` / `command` is set (precedence: `httpUrl` > `url` >
 * `command`).
 *
 * Env expansion uses **`$VAR`** (no braces). Gemini also does NOT read
 * project `.env`, so we must carry every referenced var through the
 * spawned-process env ourselves.
 *
 * Spec reference: Gemini CLI docs, `settings.json#mcpServers`
 * — last reviewed 2026-04-18.
 */
export const SPEC_VERSION = "gemini-2026-04-18";

const HttpServerSchema = z.object({
  httpUrl: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const SseServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const GeminiSettingsSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.union([HttpServerSchema, SseServerSchema, StdioServerSchema]),
  ),
});

function envRefs(server: McpServer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of server.envKeys) {
    out[key] = `$${scopedEnvVarName(server.id, key)}`;
  }
  return out;
}

function headerRefs(server: McpServer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of server.headerKeys) {
    out[key] = `$${scopedEnvVarName(server.id, key)}`;
  }
  return out;
}

function allKeys(server: McpServer): readonly string[] {
  return [...server.envKeys, ...server.headerKeys];
}

export function generateGeminiConfig(
  allServers: readonly McpServer[],
  options: GeneratorOptions,
): GeneratedMcpConfig {
  const servers = serversForBackend(allServers, "gemini");
  const mcpServers: Record<string, unknown> = {};

  for (const server of servers) {
    if (server.transport === "http") {
      if (!server.url) continue;
      const headers = headerRefs(server);
      mcpServers[server.id] = {
        httpUrl: server.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      continue;
    }
    if (server.transport === "sse") {
      if (!server.url) continue;
      const headers = headerRefs(server);
      mcpServers[server.id] = {
        url: server.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
      continue;
    }
    if (server.transport === "stdio") {
      if (!server.command) continue;
      const env = envRefs(server);
      mcpServers[server.id] = {
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
    }
  }

  const body = { mcpServers };
  GeminiSettingsSchema.parse(body);

  return {
    path: ".gemini/settings.json",
    contents: `${JSON.stringify(body, null, 2)}\n`,
    env: buildEnvFromServers(servers, options, allKeys),
  };
}
