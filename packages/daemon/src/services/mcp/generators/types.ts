import type { BackendId } from "@aitne/shared";
import type { McpServer } from "../types.js";

/**
 * B-003 Phase 2 — MCP config generators.
 *
 * Each backend has its own config file format. A generator takes the list of
 * *enabled* servers targeting that backend and returns:
 *   - `path`: the relative path (inside the session workdir) to write.
 *   - `contents`: the serialized file.
 *   - `env`: the env vars the spawned backend process must export. Per open
 *     question #1 in the design doc, secrets are NOT written into the config
 *     file — they are exported into the child process env and the config
 *     file references them as placeholders (`${VAR}`, `$VAR`, or Codex's
 *     `bearer_token_env_var`).
 *
 * Generators are pure functions: `(servers, options) → GeneratedMcpConfig`.
 */
export interface GeneratedMcpConfig {
  path: string;
  contents: string;
  env: Record<string, string>;
}

export interface GeneratorOptions {
  /**
   * Secret values already resolved by the caller (via `resolveMcpSecrets`),
   * keyed by `<serverId>:<keyName>` so multiple servers can coexist without
   * env-var name collisions. The generator picks the subset it needs.
   */
  secrets: Record<string, string>;
}

/**
 * Scope every secret variable with the server id so two servers that both
 * declare `TOKEN` can't clobber each other in the spawned process env.
 * Claude's generator sends `${TOKEN_FOR_<server>}` to the SDK, Codex's
 * generator points `bearer_token_env_var` at the same scoped name, etc.
 */
export function scopedEnvVarName(serverId: string, keyName: string): string {
  const clean = keyName
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  const idPart = serverId
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return `MCP_${idPart}_${clean}`;
}

/**
 * Collect the `env` record for `servers`, routing each declared env/header
 * key through `scopedEnvVarName`. Missing secrets are skipped silently —
 * the generator still emits the placeholder so the user can see what is
 * expected, and the run fails at the backend level if the var is truly
 * required.
 */
export function buildEnvFromServers(
  servers: readonly McpServer[],
  options: GeneratorOptions,
  keySelector: (server: McpServer) => readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const server of servers) {
    for (const keyName of keySelector(server)) {
      const raw = options.secrets[`${server.id}:${keyName}`];
      if (raw === undefined) continue;
      env[scopedEnvVarName(server.id, keyName)] = raw;
    }
  }
  return env;
}

export function serversForBackend(
  servers: readonly McpServer[],
  backend: BackendId,
): McpServer[] {
  return servers.filter(
    (s) => s.enabled && s.backends.includes(backend),
  );
}
