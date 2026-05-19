import type { Hono } from "hono";
import { existsSync } from "node:fs";
import type { ApiDependencies } from "../../server.js";
import { getSessionWorkdirPath } from "../../../core/workdir.js";
import { DASHBOARD_CHAT_SCOPE, DOCS_QA_SCOPE } from "../../../messaging/constants.js";
import {
  deleteAllChatSidebarSessions,
  deleteChatSession,
} from "../../../core/dashboard-session-cleanup.js";

export function registerConversationsRoutes(app: Hono, deps: ApiDependencies): void {
  const { db, config } = deps;

  // ── Events/Logs API ──

  /** GET /events — paginated event/action log */
  app.get("/events", (c) => {
    const page = Math.max(1, Number(c.req.query("page") ?? "1"));
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 100);
    const offset = (page - 1) * limit;
    const type = c.req.query("type");
    const result = c.req.query("result");
    const days = c.req.query("days"); // "1" (today), "7", "30"

    let whereClause = "WHERE 1=1";
    const params: unknown[] = [];

    if (type) {
      whereClause += " AND action_type = ?";
      params.push(type);
    }
    if (result) {
      whereClause += " AND result = ?";
      params.push(result);
    }
    if (days) {
      const d = Number(days);
      if (d > 0 && d <= 365) {
        // datetime(started_at) normalizes mixed ISO-8601 / SQL formats — the
        // delegated_proxy.invoke writer historically inserted ISO-with-T-and-Z
        // strings, which sort lexicographically above same-day SQL strings.
        whereClause += " AND datetime(started_at) > datetime('now', '-' || ? || ' days')";
        params.push(d);
      }
    }

    const total = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM agent_actions ${whereClause}`,
      )
      .get(...params) as { cnt: number };

    params.push(limit, offset);
    const rows = db
      .prepare(
        `SELECT id, event_id, action_type, trigger, model_used, model_usage_json, cost_usd,
                tokens_input, tokens_output,
                cache_creation_tokens, cache_read_tokens,
                duration_ms, num_turns,
                result, detail, started_at, completed_at, error
         FROM agent_actions ${whereClause}
         ORDER BY datetime(started_at) DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params);

    return c.json({
      events: rows,
      pagination: {
        page,
        limit,
        total: total.cnt,
        totalPages: Math.ceil(total.cnt / limit),
      },
    });
  });

  // ── Conversations API ──

  /** GET /conversations — paginated conversation sessions */
  app.get("/conversations", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const limit = Math.min(Number(c.req.query("limit") ?? "20"), 50);
    const offset = (page - 1) * limit;
    const platform = c.req.query("platform");
    const status = c.req.query("status");
    const scope = c.req.query("scope");
    const scopes = scope
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    let whereClause = "WHERE 1=1";
    const params: unknown[] = [];

    if (platform) {
      whereClause += " AND platform = ?";
      params.push(platform);
    }
    if (status) {
      whereClause += " AND status = ?";
      params.push(status);
    }
    if (scopes && scopes.length > 0) {
      if (scopes.length === 1) {
        whereClause += " AND scope = ?";
        params.push(scopes[0]);
      } else {
        whereClause += ` AND scope IN (${scopes.map(() => "?").join(", ")})`;
        params.push(...scopes);
      }
    } else {
      // Default view excludes docs_qa: QA transcripts are short lookups
      // and would drown out chat in /activity. Operators opt in with the
      // explicit `?scope=docs_qa` filter chip.
      whereClause += " AND scope != ?";
      params.push(DOCS_QA_SCOPE);
    }

    const total = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM conversation_sessions ${whereClause}`,
      )
      .get(...params) as { cnt: number };

    params.push(limit, offset);
    const rows = db
      .prepare(
        `SELECT id, platform, channel_id, thread_id, scope, model, status,
                message_count, started_at, last_message_at, is_dm, backend_session_id
         FROM conversation_sessions ${whereClause}
         ORDER BY last_message_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params) as Array<{
        id: number;
        platform: string;
        channel_id: string;
        thread_id: string | null;
        scope: string;
        model: string;
        status: string;
        message_count: number;
        started_at: string;
        last_message_at: string;
        is_dm: number;
        backend_session_id: string | null;
      }>;

    const sourcePlatformsStmt = db.prepare(
      `SELECT DISTINCT platform
         FROM messages
        WHERE session_id = ?
        ORDER BY CASE platform
          WHEN 'dashboard' THEN 0
          WHEN 'whatsapp' THEN 1
          WHEN 'telegram' THEN 2
          WHEN 'slack' THEN 3
          WHEN 'discord' THEN 4
          ELSE 99
        END, platform`,
    );

    const conversations = rows.map((row) => {
      const sourcePlatforms = (
        sourcePlatformsStmt.all(row.id) as Array<{ platform: string }>
      ).map((platformRow) => platformRow.platform);
      const normalizedSourcePlatforms =
        sourcePlatforms.length > 0
          ? sourcePlatforms
          : row.platform !== "owner"
            ? [row.platform]
            : [];
      const browserOnly =
        normalizedSourcePlatforms.length > 0
        && normalizedSourcePlatforms.every((platform) => platform === "dashboard");

      return {
        id: row.id,
        platform: row.platform,
        channel_id: row.channel_id,
        thread_id: row.thread_id,
        model: row.model,
        status: row.status,
        message_count: row.message_count,
        started_at: row.started_at,
        last_message_at: row.last_message_at,
        summary: null,
        source_platforms: normalizedSourcePlatforms,
        read_only_from_dashboard:
          normalizedSourcePlatforms.length === 0 ||
          normalizedSourcePlatforms.some((platform) => platform !== "dashboard"),
        // A session is continuable when the dispatcher can actually
        // execute against it — not when its stored SDK session id is
        // non-null. `continueDashboardSession` legitimately writes
        // `backend_session_id = NULL` on the `shouldInvalidateSdkSession`
        // path, and the dispatcher falls back to fresh-execute + history
        // injection for NULL backends. The real gates are: scope,
        // browser-only provenance, and the workdir surviving on disk.
        continue_available:
          row.scope === DASHBOARD_CHAT_SCOPE
          && browserOnly
          && existsSync(getSessionWorkdirPath(config.dataDir, row.id)),
      };
    });

    return c.json({
      conversations,
      pagination: {
        page,
        limit,
        total: total.cnt,
        totalPages: Math.ceil(total.cnt / limit),
      },
    });
  });

  /**
   * DELETE /conversations — bulk-delete every non-active sidebar session.
   * Scope is hard-coded to `dashboard_chat` + `owner_dm` (what the chat
   * sidebar shows); the live active session is filtered out so deleting
   * "all past sessions" never kills the current chat.
   */
  app.delete("/conversations", (c) => {
    const result = deleteAllChatSidebarSessions({ db, dataDir: config.dataDir });
    return c.json({ status: "deleted", deleted: result.deleted });
  });

  /** DELETE /conversations/:id — delete one non-active sidebar session. */
  app.delete("/conversations/:id", (c) => {
    const sessionId = Number(c.req.param("id"));
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return c.json({ error: "invalid_session_id" }, 400);
    }
    const result = deleteChatSession({
      db,
      dataDir: config.dataDir,
      sessionId,
    });
    if (!result.ok) {
      return c.json({ error: "delete_failed", message: result.message }, result.status);
    }
    return c.json({ status: "deleted", deleted: result.deleted });
  });

  /** GET /conversations/:id/messages — messages for a specific conversation */
  app.get("/conversations/:id/messages", (c) => {
    const sessionId = Number(c.req.param("id"));
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const before = c.req.query("before"); // cursor-based pagination

    let whereClause = "WHERE session_id = ?";
    const params: unknown[] = [sessionId];

    if (before) {
      whereClause += " AND id < ?";
      params.push(Number(before));
    }

    params.push(limit);
    const rows = db
      .prepare(
        `SELECT id, role, content, platform, sender_id, timestamp
         FROM messages ${whereClause}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
        id: number;
        role: string;
        content: string;
        platform: string;
        sender_id: string | null;
        timestamp: string;
      }>;

    // Chat-attachments Phase 1 — inline attachment refs per message so
    // the dashboard transcript can render thumbnails/download chips
    // alongside past messages without an extra round-trip per row.
    // Skipped when the chat_attachments table doesn't exist (older DB
    // snapshots / tests that don't run migrations).
    const hasAttachments = (() => {
      try {
        const row = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='chat_attachments'`,
          )
          .get();
        return row !== undefined;
      } catch {
        return false;
      }
    })();
    const attachmentsByMessage = new Map<
      number,
      Array<{
        id: string;
        direction: "inbound" | "outbound";
        originalFilename: string;
        mimeType: string;
        sizeBytes: number;
        caption: string | null;
      }>
    >();
    if (hasAttachments && rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const attachmentRows = db
        .prepare(
          `SELECT message_id, id, direction, original_filename, mime_type, size_bytes, caption
           FROM chat_attachments
           WHERE message_id IN (${placeholders})
           ORDER BY created_at ASC`,
        )
        .all(...ids) as Array<{
          message_id: number;
          id: string;
          direction: "inbound" | "outbound";
          original_filename: string;
          mime_type: string;
          size_bytes: number;
          caption: string | null;
        }>;
      for (const a of attachmentRows) {
        let bucket = attachmentsByMessage.get(a.message_id);
        if (!bucket) {
          bucket = [];
          attachmentsByMessage.set(a.message_id, bucket);
        }
        bucket.push({
          id: a.id,
          direction: a.direction,
          originalFilename: a.original_filename,
          mimeType: a.mime_type,
          sizeBytes: a.size_bytes,
          caption: a.caption,
        });
      }
    }

    const enriched = rows.map((row) => {
      const attachments = attachmentsByMessage.get(row.id);
      return attachments && attachments.length > 0
        ? { ...row, attachments }
        : row;
    });

    return c.json({
      messages: enriched.reverse(), // Return in chronological order
      hasMore: rows.length === limit,
    });
  });

  // ── Search API ──

  /** GET /search?q= — full-text search via FTS5 */
  app.get("/search", (c) => {
    const q = c.req.query("q");
    if (!q || q.length < 2) return c.json({ error: "query too short" }, 400);
    if (q.length > 200) return c.json({ error: "query too long" }, 400);
    const limit = Math.min(Number(c.req.query("limit") ?? "20"), 50);

    // Sanitize: wrap each word in double-quotes to disable FTS5 operators (NEAR, NOT, OR, etc.)
    const safeQuery = q
      .replace(/[^\w\s\u3000-\u9FFF\uF900-\uFAFF]/g, " ")  // strip punctuation except CJK
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(" ");
    if (!safeQuery) return c.json({ actions: [], messages: [] });

    let actions: unknown[] = [];
    let messages: unknown[] = [];

    try {
      actions = db
        .prepare(
          `SELECT a.id, a.action_type, a.started_at,
                  highlight(fts_actions, 1, '<mark>', '</mark>') as snippet
           FROM fts_actions JOIN agent_actions a ON a.id = fts_actions.rowid
           WHERE fts_actions MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(safeQuery, limit);
    } catch {
      // FTS table may not exist yet
    }

    try {
      messages = db
        .prepare(
          `SELECT m.id, m.role, m.timestamp, m.session_id,
                  highlight(fts_messages, 0, '<mark>', '</mark>') as snippet
           FROM fts_messages JOIN messages m ON m.id = fts_messages.rowid
           WHERE fts_messages MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(safeQuery, limit);
    } catch {
      // FTS table may not exist yet
    }

    return c.json({ actions, messages });
  });
}
