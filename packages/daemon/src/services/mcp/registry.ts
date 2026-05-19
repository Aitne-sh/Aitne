import type Database from "better-sqlite3";
import { BACKEND_IDS, type BackendId } from "@aitne/shared";
import {
  McpProbeResultSchema,
  mcpSecretBlobName,
  validateTransportShape,
  type McpProbeResult,
  type McpRiskTier,
  type McpServer,
  type McpTransport,
} from "./types.js";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";

/**
 * B-003 Phase 2 — MCP registry (DB + blob store helpers).
 *
 * This module owns the `mcp_servers` table. Callers should never hand-write
 * to that table; they go through these functions so the JSON columns and
 * transport invariants stay consistent. Per-server secret *values* live in
 * the encrypted blob store under `mcp:<serverId>:<keyName>` — `envKeys` and
 * `headerKeys` on the row are the list of key names the secret payload
 * exposes, not the secret values themselves.
 */

interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  cwd: string | null;
  url: string | null;
  env_keys: string;
  header_keys: string;
  backends: string;
  enabled: number;
  risk_tier: string;
  tool_allowlist: string | null;
  last_probe_at: number | null;
  last_probe_status: string | null;
  created_at: number;
  updated_at: number;
}

function parseStringArray(raw: string | null, fallback: string[] = []): string[] {
  // Callers (rowToServer) only invoke us with `string | null`; the null branch
  // is kept for defensive future reuse but every current path guards above.
  /* c8 ignore next */
  if (raw == null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return fallback;
  }
}

function parseBackends(raw: string): BackendId[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is BackendId =>
      typeof v === "string" && (BACKEND_IDS as readonly string[]).includes(v),
    );
  } catch {
    return [];
  }
}

function parseProbeStatus(raw: string | null): McpProbeResult | null {
  if (!raw) return null;
  try {
    return McpProbeResultSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function rowToServer(row: McpServerRow): McpServer {
  const toolAllowlist = row.tool_allowlist == null
    ? null
    : parseStringArray(row.tool_allowlist, []);
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command,
    args: row.args == null ? null : parseStringArray(row.args, []),
    cwd: row.cwd,
    url: row.url,
    envKeys: parseStringArray(row.env_keys, []),
    headerKeys: parseStringArray(row.header_keys, []),
    backends: parseBackends(row.backends),
    enabled: row.enabled === 1,
    riskTier: row.risk_tier as McpRiskTier,
    toolAllowlist,
    lastProbeAt: row.last_probe_at,
    lastProbeStatus: parseProbeStatus(row.last_probe_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface McpServerInput {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  envKeys?: string[];
  headerKeys?: string[];
  backends: BackendId[];
  enabled?: boolean;
  riskTier?: McpRiskTier;
  toolAllowlist?: string[] | null;
}

export class DuplicateMcpServerError extends Error {
  readonly code = "duplicate_mcp_server";
  constructor(id: string) {
    super(`MCP server already exists: ${id}`);
    this.name = "DuplicateMcpServerError";
  }
}

export class McpServerNotFoundError extends Error {
  readonly code = "mcp_server_not_found";
  constructor(id: string) {
    super(`MCP server not found: ${id}`);
    this.name = "McpServerNotFoundError";
  }
}

export class InvalidMcpServerError extends Error {
  readonly code = "invalid_mcp_server";
  constructor(message: string) {
    super(message);
    this.name = "InvalidMcpServerError";
  }
}

export function listMcpServers(db: Database.Database): McpServer[] {
  const rows = db
    .prepare(`SELECT * FROM mcp_servers ORDER BY created_at ASC`)
    .all() as McpServerRow[];
  return rows.map(rowToServer);
}

export function getMcpServer(
  db: Database.Database,
  id: string,
): McpServer | null {
  const row = db
    .prepare(`SELECT * FROM mcp_servers WHERE id = ?`)
    .get(id) as McpServerRow | undefined;
  return row ? rowToServer(row) : null;
}

export function anyMcpServerEnabled(db: Database.Database): boolean {
  // Tolerant to a missing `mcp_servers` table — unit tests construct minimal
  // in-memory DBs that may omit it, and production migrations run before any
  // caller reaches here, so a `no such table` surfacing here is always "no
  // enabled servers" in practice.
  try {
    const row = db
      .prepare(`SELECT 1 AS v FROM mcp_servers WHERE enabled = 1 LIMIT 1`)
      .get() as { v: number } | undefined;
    return row?.v === 1;
  } catch {
    return false;
  }
}

function normalizeBackends(backends: BackendId[]): BackendId[] {
  const seen = new Set<BackendId>();
  for (const b of backends) {
    if ((BACKEND_IDS as readonly string[]).includes(b)) {
      seen.add(b);
    }
  }
  return Array.from(seen);
}

/**
 * Per-backend constraint: Codex's HTTP MCP schema only knows how to pass a
 * bearer token through `bearer_token_env_var`, so any http/sse server
 * targeting Codex can declare at most one header key, and it must be
 * `Authorization` (case-insensitive). If we silently accepted
 * `X-API-Key`-style headers here the generator would drop them at
 * materialization time and the user would see opaque auth failures.
 */
function validateBackendCapabilities(input: {
  transport: McpTransport;
  backends: BackendId[];
  headerKeys?: string[];
}): { ok: true } | { ok: false; message: string } {
  if (
    (input.transport === "http" || input.transport === "sse") &&
    input.backends.includes("codex")
  ) {
    const headers = input.headerKeys ?? [];
    const nonBearer = headers.filter((h) => h.toLowerCase() !== "authorization");
    if (nonBearer.length > 0) {
      return {
        ok: false,
        message:
          "Codex HTTP transport supports only a single `Authorization` header. " +
          `Remove ${nonBearer.join(", ")} or drop Codex from the backends list.`,
      };
    }
  }
  return { ok: true };
}

export function insertMcpServer(
  db: Database.Database,
  input: McpServerInput,
): McpServer {
  const shape = validateTransportShape({
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ?? null,
    url: input.url ?? null,
  });
  if (!shape.ok) {
    throw new InvalidMcpServerError(shape.message);
  }

  const backends = normalizeBackends(input.backends);
  if (backends.length === 0) {
    throw new InvalidMcpServerError("backends must include at least one backend id");
  }

  const backendCheck = validateBackendCapabilities({
    transport: input.transport,
    backends,
    headerKeys: input.headerKeys,
  });
  if (!backendCheck.ok) {
    throw new InvalidMcpServerError(backendCheck.message);
  }

  const existing = getMcpServer(db, input.id);
  if (existing) {
    throw new DuplicateMcpServerError(input.id);
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO mcp_servers (
       id, name, transport, command, args, cwd, url,
       env_keys, header_keys, backends, enabled, risk_tier,
       tool_allowlist, last_probe_at, last_probe_status,
       created_at, updated_at
     ) VALUES (
       @id, @name, @transport, @command, @args, @cwd, @url,
       @env_keys, @header_keys, @backends, @enabled, @risk_tier,
       @tool_allowlist, NULL, NULL,
       @created_at, @updated_at
     )`,
  ).run({
    id: input.id,
    name: input.name,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    cwd: input.cwd ?? null,
    url: input.url ?? null,
    env_keys: JSON.stringify(input.envKeys ?? []),
    header_keys: JSON.stringify(input.headerKeys ?? []),
    backends: JSON.stringify(backends),
    enabled: input.enabled ? 1 : 0,
    risk_tier: input.riskTier ?? "approve",
    tool_allowlist: input.toolAllowlist ? JSON.stringify(input.toolAllowlist) : null,
    created_at: now,
    updated_at: now,
  });

  const saved = getMcpServer(db, input.id);
  /* c8 ignore start — transactional insert just succeeded; the row must
     exist. Defensive so a future caller that bypasses the insert path still
     surfaces a loud error instead of returning `undefined`. */
  if (!saved) {
    throw new Error(`Failed to read back inserted mcp_server: ${input.id}`);
  }
  /* c8 ignore stop */
  return saved;
}

export interface McpServerPatch {
  name?: string;
  transport?: McpTransport;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  envKeys?: string[];
  headerKeys?: string[];
  backends?: BackendId[];
  riskTier?: McpRiskTier;
  toolAllowlist?: string[] | null;
}

export function updateMcpServer(
  db: Database.Database,
  id: string,
  patch: McpServerPatch,
): McpServer {
  const current = getMcpServer(db, id);
  if (!current) throw new McpServerNotFoundError(id);

  const next: McpServer = {
    ...current,
    ...patch,
    envKeys: patch.envKeys ?? current.envKeys,
    headerKeys: patch.headerKeys ?? current.headerKeys,
    backends: patch.backends
      ? normalizeBackends(patch.backends)
      : current.backends,
    toolAllowlist:
      patch.toolAllowlist === undefined
        ? current.toolAllowlist ?? null
        : patch.toolAllowlist,
    updatedAt: Date.now(),
  };

  const shape = validateTransportShape({
    transport: next.transport,
    command: next.command ?? null,
    args: next.args ?? null,
    url: next.url ?? null,
  });
  if (!shape.ok) {
    throw new InvalidMcpServerError(shape.message);
  }
  if (next.backends.length === 0) {
    throw new InvalidMcpServerError("backends must include at least one backend id");
  }
  const backendCheck = validateBackendCapabilities({
    transport: next.transport,
    backends: next.backends,
    headerKeys: next.headerKeys,
  });
  if (!backendCheck.ok) {
    throw new InvalidMcpServerError(backendCheck.message);
  }

  // If the wire-shape of the server changed (transport/command/args/url/cwd),
  // the cached probe result no longer describes what will be reached on the
  // next connect, so the dashboard would render stale tools. Clear it and
  // require a fresh probe.
  const shapeChanged =
    current.transport !== next.transport ||
    current.command !== next.command ||
    current.url !== next.url ||
    current.cwd !== next.cwd ||
    !stringArraysEqual(current.args ?? [], next.args ?? []);

  db.prepare(
    `UPDATE mcp_servers SET
       name = @name,
       transport = @transport,
       command = @command,
       args = @args,
       cwd = @cwd,
       url = @url,
       env_keys = @env_keys,
       header_keys = @header_keys,
       backends = @backends,
       risk_tier = @risk_tier,
       tool_allowlist = @tool_allowlist,
       last_probe_at = CASE WHEN @invalidate_probe = 1 THEN NULL ELSE last_probe_at END,
       last_probe_status = CASE WHEN @invalidate_probe = 1 THEN NULL ELSE last_probe_status END,
       updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id,
    name: next.name,
    transport: next.transport,
    command: next.command ?? null,
    args: next.args ? JSON.stringify(next.args) : null,
    cwd: next.cwd ?? null,
    url: next.url ?? null,
    env_keys: JSON.stringify(next.envKeys),
    header_keys: JSON.stringify(next.headerKeys),
    backends: JSON.stringify(next.backends),
    risk_tier: next.riskTier,
    tool_allowlist:
      next.toolAllowlist == null ? null : JSON.stringify(next.toolAllowlist),
    invalidate_probe: shapeChanged ? 1 : 0,
    updated_at: next.updatedAt,
  });

  /* c8 ignore next 2 — UPDATE just succeeded; unreachable. */
  const saved = getMcpServer(db, id);
  if (!saved) throw new McpServerNotFoundError(id);
  return saved;
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function setMcpServerEnabled(
  db: Database.Database,
  id: string,
  enabled: boolean,
): McpServer {
  const existing = getMcpServer(db, id);
  if (!existing) throw new McpServerNotFoundError(id);
  db.prepare(
    `UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, Date.now(), id);
  /* c8 ignore next 2 — UPDATE just succeeded; unreachable. */
  const saved = getMcpServer(db, id);
  if (!saved) throw new McpServerNotFoundError(id);
  return saved;
}

export function deleteMcpServer(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
  return result.changes > 0;
}

/**
 * Kill switch — flip every `enabled=1` row to `enabled=0` in a single
 * statement. Returns the count of rows actually changed so the caller
 * (dashboard) can render a "disabled N servers" confirmation. Rows that
 * were already disabled are not touched (SQL `WHERE enabled = 1`), so
 * `updated_at` stays meaningful as "last user-driven state change".
 */
export function disableAllMcpServers(db: Database.Database): number {
  const result = db
    .prepare(`UPDATE mcp_servers SET enabled = 0, updated_at = ? WHERE enabled = 1`)
    .run(Date.now());
  return result.changes;
}

export function saveMcpProbeResult(
  db: Database.Database,
  id: string,
  result: McpProbeResult,
): McpServer {
  const existing = getMcpServer(db, id);
  if (!existing) throw new McpServerNotFoundError(id);
  db.prepare(
    `UPDATE mcp_servers SET
       last_probe_at = ?,
       last_probe_status = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), JSON.stringify(result), Date.now(), id);
  /* c8 ignore next 2 — UPDATE just succeeded; unreachable. */
  const saved = getMcpServer(db, id);
  if (!saved) throw new McpServerNotFoundError(id);
  return saved;
}

/* ------------------------------------------------------------------ *
 * Per-server secret helpers (blob store)
 * ------------------------------------------------------------------ */

export async function getMcpSecret(
  blobStore: EncryptedBlobStore,
  serverId: string,
  keyName: string,
): Promise<string | null> {
  return blobStore.readUtf8(mcpSecretBlobName(serverId, keyName));
}

export async function setMcpSecret(
  blobStore: EncryptedBlobStore,
  serverId: string,
  keyName: string,
  value: string,
): Promise<void> {
  await blobStore.writeUtf8(mcpSecretBlobName(serverId, keyName), value);
}

export async function deleteMcpSecret(
  blobStore: EncryptedBlobStore,
  serverId: string,
  keyName: string,
): Promise<void> {
  await blobStore.remove(mcpSecretBlobName(serverId, keyName));
}

/**
 * Delete every stored secret for this server — called after DELETE /api/mcp/servers/:id
 * so orphaned blobs don't linger on disk. Callers iterate over `envKeys +
 * headerKeys` captured *before* the DB row is deleted; this helper only takes
 * the list of names so the registry never has to reason about transport.
 */
export async function deleteAllMcpSecrets(
  blobStore: EncryptedBlobStore,
  serverId: string,
  keyNames: readonly string[],
): Promise<void> {
  await Promise.all(
    keyNames.map((keyName) => deleteMcpSecret(blobStore, serverId, keyName)),
  );
}

/**
 * Resolve every secret this server declares, returning a flat record keyed
 * by the variable/header name (`{ HA_TOKEN: "..." }`). Missing secrets are
 * returned as `null`.
 *
 * NOTE — shape mismatch with generators: the config generators in
 * `./generators/` expect `{ "<serverId>:<keyName>": value }` so secrets for
 * multiple servers can coexist without env-var name collisions. When the
 * Phase 3 session-workdir materializer calls the generators, it must build
 * that scoped map explicitly. The unscoped shape returned here is designed
 * for probe consumption, which only ever sees one server at a time.
 */
export async function resolveMcpSecrets(
  blobStore: EncryptedBlobStore,
  server: Pick<McpServer, "id" | "envKeys" | "headerKeys">,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const allKeys = [
    ...(server.envKeys ?? []),
    ...(server.headerKeys ?? []),
  ];
  await Promise.all(
    allKeys.map(async (keyName) => {
      out[keyName] = await getMcpSecret(blobStore, server.id, keyName);
    }),
  );
  return out;
}
