import type Database from "better-sqlite3";
import { CHAT_SIDEBAR_SCOPES, isChatSidebarScope } from "@aitne/shared";
import { createLogger } from "../logging.js";
import { cleanupSessionWorkdir, getSessionWorkdirPath } from "./workdir.js";

const logger = createLogger("dashboard-session-cleanup");

export type DeleteSessionResult =
  | { ok: true; deleted: number }
  | { ok: false; status: 404 | 409 | 403; message: string };

/**
 * Delete every non-active chat-sidebar session in a single statement.
 *
 * Using `DELETE ... RETURNING id` collapses the original SELECT-then-DELETE
 * into one atomic operation, which closes two bugs in the previous
 * implementation:
 *   1. TOCTOU: a session could flip from `closed` → `active` between the
 *      SELECT (that captured its id) and the DELETE (that trusted the id
 *      blindly), causing the live session to be destroyed.
 *   2. Parameter limit: IN-list expansion of N ids hits
 *      SQLITE_MAX_VARIABLE_NUMBER (default 999 on older builds) once the
 *      history grows past that threshold.
 *
 * Order: messages first, then conversation_sessions. The messages FK has no
 * ON DELETE CASCADE, and with foreign_keys=ON the reverse order would error.
 * Both are wrapped in one tx so a mid-delete failure leaves the DB intact.
 */
export function deleteAllChatSidebarSessions(params: {
  db: Database.Database;
  dataDir: string;
}): { deleted: number } {
  const scopeList = CHAT_SIDEBAR_SCOPES;
  const placeholders = scopeList.map(() => "?").join(", ");

  let deletedIds: number[] = [];

  params.db.transaction(() => {
    params.db
      .prepare(
        `DELETE FROM messages
          WHERE session_id IN (
            SELECT id FROM conversation_sessions
             WHERE scope IN (${placeholders})
               AND status != 'active'
          )`,
      )
      .run(...scopeList);

    const returned = params.db
      .prepare(
        `DELETE FROM conversation_sessions
          WHERE scope IN (${placeholders})
            AND status != 'active'
          RETURNING id`,
      )
      .all(...scopeList) as Array<{ id: number }>;
    deletedIds = returned.map((row) => row.id);
  })();

  if (deletedIds.length === 0) return { deleted: 0 };

  // Workdir rm runs AFTER the tx commits — if the tx rolled back we would
  // otherwise delete files the DB still references.
  for (const id of deletedIds) {
    cleanupSessionWorkdir(getSessionWorkdirPath(params.dataDir, id));
  }

  // Cap the id sample — a 1500-session delete shouldn't dump 1500 ints
  // into a single log line. The count is the load-bearing signal; a
  // sample is enough to trace a specific complaint back to a delete.
  const idSample = deletedIds.slice(0, 20);
  logger.info(
    {
      deleted: deletedIds.length,
      sessionIdSample: idSample,
      truncated: deletedIds.length > idSample.length,
    },
    "Dashboard bulk-deleted chat sidebar sessions",
  );

  return { deleted: deletedIds.length };
}

/** Delete a single non-active sidebar session. */
export function deleteChatSession(params: {
  db: Database.Database;
  dataDir: string;
  sessionId: number;
}): DeleteSessionResult {
  const row = params.db
    .prepare(
      `SELECT id, scope, status FROM conversation_sessions WHERE id = ?`,
    )
    .get(params.sessionId) as
    | { id: number; scope: string; status: string }
    | undefined;

  if (!row) return { ok: false, status: 404, message: "Session not found" };
  if (!isChatSidebarScope(row.scope)) {
    return {
      ok: false,
      status: 403,
      message: "This session cannot be deleted from the dashboard",
    };
  }
  if (row.status === "active") {
    return {
      ok: false,
      status: 409,
      message: "Active sessions cannot be deleted — end the chat first",
    };
  }

  // Single-row delete is immune to TOCTOU on the scope set (scope is
  // immutable for a session), but we still re-check `status != 'active'`
  // inside the DELETE so a concurrent status flip can't slip past the
  // SELECT-time guard above.
  let deleted = 0;
  params.db.transaction(() => {
    params.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(row.id);
    const info = params.db
      .prepare(
        `DELETE FROM conversation_sessions
          WHERE id = ?
            AND status != 'active'`,
      )
      .run(row.id);
    deleted = info.changes;
  })();

  /* v8 ignore next 7 — concurrent status flip between SELECT guard and DELETE; unreachable in single-threaded tests */
  if (deleted === 0) {
    return {
      ok: false,
      status: 409,
      message: "Session became active during delete — try again",
    };
  }

  cleanupSessionWorkdir(getSessionWorkdirPath(params.dataDir, row.id));

  logger.info(
    { sessionId: row.id, scope: row.scope },
    "Dashboard deleted chat sidebar session",
  );

  return { ok: true, deleted };
}
