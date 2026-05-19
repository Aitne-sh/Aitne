import type Database from "better-sqlite3";

/**
 * B-003 Phase 4.4 — per-server MCP tool call audit log.
 *
 * Two-phase write pattern:
 *   1. `logMcpToolCall`  — called when the agent stream emits a `tool_use`
 *      block for an MCP tool. Returns the inserted row ID so the caller can
 *      wire it to the matching result.
 *   2. `updateMcpToolCallResult` — called when the stream later delivers the
 *      corresponding `tool_result` (Claude SDK only; Codex and Gemini CLI do
 *      not emit per-tool result events). Sets `ok`, `error`, and `duration_ms`.
 *
 * For Codex and Gemini, `ok`/`error`/`duration_ms` remain NULL, which the
 * dashboard renders as "invocation recorded" (the neutral "·" indicator).
 *
 * Note: the design doc (B-003 §Safety integration) originally targeted
 * `agent_actions` rows with `kind='mcp.tool_call'`. A dedicated table is used
 * instead because MCP tool calls are per-tool-use events inside a session, not
 * per-session events; most `agent_actions` columns would be NULL, and the
 * AuditLogger's dynamic-column insert machinery is awkward to extend.
 */

interface RawMcpToolCallRow {
  id: number;
  server_id: string;
  tool_name: string;
  event_type: string | null;
  session_id: string | null;
  ok: number | null;
  error: string | null;
  called_at: number;
  duration_ms: number | null;
}

export interface McpToolCallRow {
  id: number;
  serverId: string;
  toolName: string;
  eventType: string | null;
  sessionId: string | null;
  /** null = result not yet received (Codex/Gemini) or pending (Claude mid-session). */
  ok: boolean | null;
  error: string | null;
  calledAt: number;
  /**
   * Wall-clock ms from the SDK's `tool_use` message delivery to the matching
   * `tool_result` message. Includes SDK internal dispatch latency between the
   * two events. Only populated for the Claude backend; Codex and Gemini do not
   * emit per-tool result events.
   */
  durationMs: number | null;
}

function mapRow(row: RawMcpToolCallRow): McpToolCallRow {
  return {
    id: row.id,
    serverId: row.server_id,
    toolName: row.tool_name,
    eventType: row.event_type,
    sessionId: row.session_id,
    ok: row.ok === null ? null : row.ok === 1,
    error: row.error,
    calledAt: row.called_at,
    durationMs: row.duration_ms,
  };
}

/**
 * Record a single MCP tool invocation. Best-effort — callers must wrap in
 * try/catch so a logging failure never interrupts the core execution path.
 *
 * Returns the DB row ID so the caller can later backfill the result via
 * `updateMcpToolCallResult`. Throws on insert failure.
 */
export function logMcpToolCall(
  db: Database.Database,
  params: {
    serverId: string;
    toolName: string;
    eventType?: string;
    sessionId?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO mcp_tool_calls (server_id, tool_name, event_type, session_id, called_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      params.serverId,
      params.toolName,
      params.eventType ?? null,
      params.sessionId ?? null,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/**
 * Backfill the result of a tool invocation once the tool_result block arrives.
 * No-op if `rowId` does not match any existing row (graceful against missed
 * inserts or unexpected stream ordering).
 */
export function updateMcpToolCallResult(
  db: Database.Database,
  rowId: number,
  ok: boolean,
  error: string | null,
  durationMs?: number,
): void {
  db.prepare(
    `UPDATE mcp_tool_calls SET ok = ?, error = ?, duration_ms = ? WHERE id = ?`,
  ).run(ok ? 1 : 0, error, durationMs ?? null, rowId);
}

/**
 * List the most-recent tool calls for a given MCP server, newest first.
 * Returns an empty array if the table does not exist (pre-migration DB).
 */
export function listMcpToolCalls(
  db: Database.Database,
  serverId: string,
  limit = 20,
): McpToolCallRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, server_id, tool_name, event_type, session_id, ok, error, called_at, duration_ms
         FROM mcp_tool_calls
         WHERE server_id = ?
         ORDER BY called_at DESC
         LIMIT ?`,
      )
      .all(serverId, limit) as RawMcpToolCallRow[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/**
 * Delete audit rows older than `days` days. Returns the number of rows deleted.
 * Returns 0 silently if the table does not exist (pre-migration DB).
 *
 * Called by `runRetentionCleanup` as part of the daily retention sweep.
 * Note: `called_at` is stored as epoch milliseconds (not a SQLite datetime
 * string), so comparison uses integer arithmetic rather than datetime().
 */
export function pruneOldMcpToolCalls(db: Database.Database, days: number): number {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    return db
      .prepare(`DELETE FROM mcp_tool_calls WHERE called_at < ?`)
      .run(cutoffMs).changes;
  } catch {
    return 0;
  }
}
