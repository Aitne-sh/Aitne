import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import type { ISessionManager } from "./dispatcher.js";
import { getSessionWorkdirPath } from "./workdir.js";
import { DASHBOARD_CHAT_SCOPE } from "../messaging/constants.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";

/**
 * runtime_state key holding the most recent loud prompt-context-change
 * timestamp (UTC ISO string). Written by `markContextChanged` for changes
 * that should invalidate active DM sessions and used here to decide whether
 * a resumed session's stored SDK session id is still reasoning over fresh
 * context.
 */
export const CONTEXT_CHANGED_AT_KEY = "dashboard_context_changed_at";

export type DashboardContinueResult =
  | { ok: true; sessionId: number }
  | { ok: false; status: 403 | 404 | 409 | 503; message: string };

/**
 * Persist "prompt context changed loudly" as a UTC ISO timestamp in
 * `runtime_state`. `continueDashboardSession` compares this against the target
 * session's `last_message_at` to decide whether the stored SDK session id has
 * gone stale and should be discarded before resume.
 *
 * Stored as an ISO string rather than a raw number so it compares correctly
 * (lexicographically) against SQLite's `CURRENT_TIMESTAMP` format.
 */
export function markContextChanged(db: Database.Database): void {
  writeRuntimeState(
    db,
    CONTEXT_CHANGED_AT_KEY,
    new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
  );
}

export async function endDashboardSession(params: {
  sessionManager: ISessionManager;
  channelId: string;
}): Promise<{ id: number } | null> {
  const active = await params.sessionManager.findActive({
    platform: "dashboard",
    channel: params.channelId,
    threadId: null,
    isDm: true,
  });
  if (!active) return null;
  params.sessionManager.closeSession(active.id);
  return active;
}

export function continueDashboardSession(params: {
  db: Database.Database;
  dataDir: string;
  sessionManager: ISessionManager;
  sessionId: number;
}): DashboardContinueResult {
  const sessionRow = params.db
    .prepare(
      `SELECT id, scope, scope_key, backend_session_id, last_message_at
         FROM conversation_sessions
        WHERE id = ?`,
    )
    .get(params.sessionId) as {
      id: number;
      scope: string;
      scope_key: string;
      backend_session_id: string | null;
      last_message_at: string;
    } | undefined;

  if (!sessionRow) {
    return { ok: false, status: 404, message: "Session not found" };
  }
  if (sessionRow.scope !== DASHBOARD_CHAT_SCOPE) {
    return {
      ok: false,
      status: 403,
      message: "Only dashboard chat sessions can be continued from dashboard history",
    };
  }
  // Intentionally NO `backend_session_id != null` precondition here.
  // This function itself writes NULL as a legal intermediate state when
  // `shouldInvalidateSdkSession` fires (context changed after the
  // session's last turn), and the dispatcher's fresh-execute path
  // handles NULL backend by injecting the prior transcript via
  // `buildCrossSessionConversationHistory`. Requiring non-null would
  // refuse the very state this function produces — leaving any
  // previously-continued session stuck read-only in the sidebar. The
  // real gate is the workdir: without the instruction files + skill
  // tree, fresh-execute has no context to boot from.
  if (!existsSync(getSessionWorkdirPath(params.dataDir, params.sessionId))) {
    return {
      ok: false,
      status: 409,
      message: "This session's local state has already been cleaned up",
    };
  }

  const sourcePlatforms = (
    params.db
      .prepare(
        `SELECT DISTINCT platform
           FROM messages
          WHERE session_id = ?`,
      )
      .all(params.sessionId) as Array<{ platform: string }>
  ).map((row) => row.platform);
  const browserOnly =
    sourcePlatforms.length > 0 &&
    sourcePlatforms.every((platform) => platform === "dashboard");
  if (!browserOnly) {
    return {
      ok: false,
      status: 403,
      message: "Only browser-only sessions can be continued from dashboard history",
    };
  }

  // If the operator's context (today/roadmap/user/etc.) was mutated after
  // this session's last turn, the stored SDK session is reasoning over
  // outdated context. Clear `backend_session_id` inside the same transaction
  // that re-activates the row so the next user message falls through to the
  // fresh-execute branch (which rebuilds context and injects history), while
  // leaving `messages` intact for UI continuity and `requiresHistoryInjection`.
  const contextChangedAt = readRuntimeState<string>(
    params.db,
    CONTEXT_CHANGED_AT_KEY,
  );
  // Compare against the most recent non-forwarded message — proactive
  // forwards (dm-channel-timeline.md §F.7) bump `last_message_at` from a
  // separate SDK session, so using it here would mask context changes
  // that landed before the forward but still go unread by the resumed
  // session.
  const lastConsumedRow = params.db
    .prepare(
      `SELECT timestamp
         FROM messages
        WHERE session_id = ?
          AND (
            role <> 'assistant'
            OR json_extract(metadata, '$.notificationType') IS NULL
            OR json_extract(metadata, '$.notificationType') NOT IN
               ('proactive_forward', 'proactive_forward_batched')
          )
        ORDER BY timestamp DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionRow.id) as { timestamp: string } | undefined;
  const lastConsumedAt = lastConsumedRow?.timestamp ?? sessionRow.last_message_at;
  const shouldInvalidateSdkSession =
    typeof contextChangedAt === "string"
    && contextChangedAt > lastConsumedAt;

  // Collect the non-transactional side effects produced by closing other
  // active sessions (workdir cleanup for non-dashboard scopes, staleSet
  // entry removal) and only run them AFTER this transaction commits. If
  // the transaction fails anywhere between here and the final UPDATE, the
  // DB is restored but we must not have already deleted files or mutated
  // in-memory flags.
  const effects = params.sessionManager.newEffectsBuffer();

  params.db.transaction(() => {
    const activeRows = params.db
      .prepare(
        `SELECT id
           FROM conversation_sessions
          WHERE scope = ?
            AND scope_key = ?
            AND status = 'active'
            AND id != ?`,
      )
      .all(sessionRow.scope, sessionRow.scope_key, sessionRow.id) as Array<{ id: number }>;

    for (const activeRow of activeRows) {
      params.sessionManager.closeSessionInTx(activeRow.id, effects);
    }

    if (shouldInvalidateSdkSession) {
      params.db
        .prepare(
          `UPDATE conversation_sessions
              SET backend_session_id = NULL
            WHERE id = ?`,
        )
        .run(sessionRow.id);
    }

    params.db
      .prepare(
        `UPDATE conversation_sessions
            SET status = 'active'
          WHERE id = ?`,
      )
      .run(sessionRow.id);

    // If the target session was flagged stale while it was active (e.g. a
    // context mutation ran in that window), clear the in-memory flag so
    // `getOrCreateDm` doesn't immediately reset-in-place on the very first
    // turn after Continue. The persistent `context_changed_at` check still
    // fires when truly needed — this only suppresses the duplicate signal.
    effects.staleFlagClears.push(sessionRow.id);
  })();

  // TX committed — safe to flush filesystem and in-memory side effects.
  params.sessionManager.flushEffects(effects);

  return { ok: true, sessionId: sessionRow.id };
}
