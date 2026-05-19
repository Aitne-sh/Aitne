import type Database from "better-sqlite3";
import type { IMessageRecorder } from "./dispatcher.js";
import { createLogger } from "../logging.js";

const logger = createLogger("message-recorder");

/**
 * MessageRecorder — records conversation messages atomically with the
 * session's activity bookkeeping.
 *
 * One row in `messages` corresponds to one increment of the parent
 * session's `message_count` and a refresh of its `last_message_at`. The
 * INSERT and the UPDATE run in the same `db.transaction(...)` so the
 * counter cannot drift from the actual row count: if the INSERT rolls
 * back (FK break, disk full, corruption), the UPDATE rolls back too.
 * This replaces the older paired `recordMessage(...); touchSession(...)`
 * calling convention, which was the root cause of the v28 FK regression
 * leaving `message_count` counting phantom turns.
 *
 * Returns `true` on successful persistence, `false` on error (caller
 * decides whether to surface it — the dispatcher, for example, turns an
 * assistant-message failure into a dashboard `chat_error`).
 */
export class MessageRecorder implements IMessageRecorder {
  private readonly messageColumns: Set<string>;
  private readonly hasBackendMetadataColumns: boolean;
  private readonly hasNotificationDispatchColumn: boolean;

  constructor(private readonly db: Database.Database) {
    this.messageColumns = new Set(
      (this.db.pragma("table_info(messages)") as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    this.hasBackendMetadataColumns =
      this.messageColumns.has("backend") && this.messageColumns.has("model_id");
    this.hasNotificationDispatchColumn =
      this.messageColumns.has("notification_dispatch_id");
  }

  recordMessage(params: {
    sessionId: number;
    role: "user" | "assistant" | "system";
    content: string;
    platform: string;
    senderId?: string;
    backend?: string;
    modelId?: string;
    metadata?: Record<string, unknown>;
    notificationDispatchId?: string | null;
  }): boolean {
    const {
      sessionId,
      role,
      content,
      platform,
      senderId,
      backend,
      modelId,
      metadata,
      notificationDispatchId,
    } = params;
    const columns = [
      "session_id",
      "role",
      "content",
      "platform",
      "sender_id",
      "metadata",
    ];
    const values: unknown[] = [
      sessionId,
      role,
      content,
      platform,
      senderId ?? null,
      JSON.stringify(metadata ?? {}),
    ];
    if (this.hasBackendMetadataColumns) {
      columns.push("backend", "model_id");
      values.push(backend ?? null, modelId ?? null);
    }
    if (this.hasNotificationDispatchColumn) {
      columns.push("notification_dispatch_id");
      values.push(notificationDispatchId ?? null);
    }
    columns.push("timestamp");
    const placeholders = values.map(() => "?").join(", ");
    const insertSql = `INSERT INTO messages (
                         ${columns.join(", ")}
                       ) VALUES (
                         ${placeholders}, CURRENT_TIMESTAMP
                       )`;
    const touchSql = `UPDATE conversation_sessions
                         SET last_message_at = CURRENT_TIMESTAMP,
                             message_count = message_count + 1
                       WHERE id = ?`;

    try {
      const record = this.db.transaction(() => {
        // Order matters: INSERT must come before UPDATE. Any FK violation
        // on the insert rolls the transaction back including the counter
        // bump. If a future edit reverses this, message_count can advance
        // on a turn whose row never persisted.
        this.db.prepare(insertSql).run(...values);
        this.db.prepare(touchSql).run(sessionId);
      });
      record();
      return true;
    } catch (err) {
      logger.error({ err, sessionId, role }, "Failed to record message");
      return false;
    }
  }
}
