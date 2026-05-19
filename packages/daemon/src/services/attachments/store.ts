import {
  mkdirSync,
  renameSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  createWriteStream,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type Database from "better-sqlite3";
import { fileTypeFromBuffer } from "file-type";
import {
  deriveSafeFilename,
  isAllowedMime,
  normalizeMimeType,
} from "./sanitize.js";
import { hardLinkOrCopy } from "./hardlink.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("attachment-store");

/** First-N bytes read from the stream for magic-byte MIME verification.
 *  `file-type` recommends at least 4100 bytes; we use 8 KB for headroom. */
const MAGIC_BYTES_SNIFF_SIZE = 8192;

export type AttachmentDirection = "inbound" | "outbound";

export type AttachmentProvenance =
  | "user_dashboard"
  | "user_slack"
  | "user_telegram"
  | "user_discord"
  | "user_whatsapp"
  | "agent";

export interface StoreAttachmentRow {
  id: string;
  sessionId: number | null;
  messageId: number | null;
  direction: AttachmentDirection;
  provenance: AttachmentProvenance;
  path: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  sizeBytes: number;
  turnToken: string | null;
  caption: string | null;
  createdAt: string;
}

interface ChatAttachmentDbRow {
  id: string;
  session_id: number | null;
  message_id: number | null;
  direction: AttachmentDirection;
  provenance: AttachmentProvenance;
  path: string;
  original_filename: string;
  safe_filename: string;
  mime_type: string;
  size_bytes: number;
  turn_token: string | null;
  caption: string | null;
  created_at: string;
}

function mapRow(row: ChatAttachmentDbRow): StoreAttachmentRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    direction: row.direction,
    provenance: row.provenance,
    path: row.path,
    originalFilename: row.original_filename,
    safeFilename: row.safe_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    turnToken: row.turn_token,
    caption: row.caption,
    createdAt: row.created_at,
  };
}

export interface IngestStreamParams {
  stream: Readable;
  declaredMimeType: string | null;
  originalFilename: string;
  direction: AttachmentDirection;
  provenance: AttachmentProvenance;
  caption?: string;
  /** Outbound-only: per-turn token issued by the dispatcher. Required when
   *  `direction === "outbound"` and `provenance === "agent"`. */
  turnToken?: string;
  /** Per-file size cap in bytes. Enforced during streaming so an
   *  overflowing client upload is cut off before the disk fills up. */
  maxSizeBytes: number;
}

export interface IngestResult {
  id: string;
  path: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
}

export class IngestRejectedError extends Error {
  constructor(
    public readonly reason:
      | "too_large"
      | "empty"
      | "disallowed_mime"
      | "undetected_mime",
    message: string,
  ) {
    super(message);
    this.name = "IngestRejectedError";
  }
}

/**
 * AttachmentStore — canonical on-disk store + SQLite row manager for chat
 * file attachments.
 *
 * Files live at `<dataDir>/attachments/<id>/<safeFilename>`. Writes are
 * atomic (tmp file → rename) and append-only; rows are deleted together
 * with their on-disk dir at session end / orphan reap / outbound
 * collection failure.
 */
export class AttachmentStore {
  private readonly rootDir: string;

  constructor(
    private readonly db: Database.Database,
    dataDir: string,
  ) {
    this.rootDir = join(dataDir, "attachments");
    mkdirSync(this.rootDir, { recursive: true });
  }

  /** Absolute path to the directory that contains this attachment's bytes. */
  dirFor(id: string): string {
    return join(this.rootDir, id);
  }

  /**
   * Stream incoming bytes to disk, verify MIME via magic bytes, and
   * persist a `chat_attachments` row. Throws `IngestRejectedError` on
   * size overflow, disallowed/undetected MIME, or empty body.
   */
  async ingestStream(params: IngestStreamParams): Promise<IngestResult> {
    const id = randomUUID();
    const safeFilename = deriveSafeFilename(params.originalFilename, id);
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.tmp-${randomUUID()}`);
    const finalPath = join(dir, safeFilename);

    const sniffBuffer: Buffer[] = [];
    let sniffedBytes = 0;
    let totalBytes = 0;
    let truncated = false;

    const out = createWriteStream(tmpPath, { flags: "wx" });
    const { stream } = params;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onData = (chunk: Buffer): void => {
          totalBytes += chunk.length;
          if (totalBytes > params.maxSizeBytes) {
            truncated = true;
            // Pass an Error to `destroy()` so the stream emits `'error'`
            // even when its implementation does not auto-fire `'end'`
            // after a bare `destroy()` — defensive, because busboy's
            // file-part Readable follows a different lifecycle than
            // `Readable.from()` used in unit tests.
            stream.destroy(new Error("attachment_stream_truncated"));
            return;
          }
          if (sniffedBytes < MAGIC_BYTES_SNIFF_SIZE) {
            const need = MAGIC_BYTES_SNIFF_SIZE - sniffedBytes;
            const slice = chunk.length > need ? chunk.subarray(0, need) : chunk;
            sniffBuffer.push(Buffer.from(slice));
            sniffedBytes += slice.length;
          }
          if (!out.write(chunk)) {
            stream.pause();
          }
        };
        const onDrain = (): void => {
          stream.resume();
        };
        const cleanupInput = (): void => {
          stream.off("data", onData);
          stream.off("end", onEnd);
          stream.off("error", onError);
          stream.off("close", onClose);
          out.off("drain", onDrain);
        };
        const cleanupAll = (): void => {
          cleanupInput();
          out.off("error", onError);
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanupAll();
          fn();
        };
        const onEnd = (): void => {
          cleanupInput();
          out.end(() => {
            settle(() =>
              truncated ? reject(new Error("stream_truncated")) : resolve(),
            );
          });
        };
        const onClose = (): void => {
          // Safety net for Readable implementations that emit only
          // `'close'` after `destroy()` without a preceding `'end'` or
          // `'error'`. Without this listener, a truncation on such a
          // stream would never resolve the promise — the request would
          // hang until the caller's timeout fired. See `attachments.test.ts`
          // "rejects oversize uploads promptly" for the regression check.
          settle(() => {
            out.destroy();
            reject(
              truncated
                ? new Error("stream_truncated")
                : new Error("attachment_stream_closed_prematurely"),
            );
          });
        };
        const onError = (err: Error): void => {
          settle(() => {
            out.destroy();
            reject(err);
          });
        };
        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("error", onError);
        stream.on("close", onClose);
        out.on("drain", onDrain);
        out.on("error", onError);
      });
    } catch (err) {
      await this.waitForWriteStreamSettled(out, { destroy: true });
      this.safeRmTree(dir);
      if (truncated) {
        throw new IngestRejectedError(
          "too_large",
          `Attachment exceeds per-file cap of ${params.maxSizeBytes} bytes`,
        );
      }
      throw err;
    }

    await this.waitForWriteStreamSettled(out);

    if (totalBytes === 0) {
      this.safeRmTree(dir);
      throw new IngestRejectedError("empty", "Attachment body is empty");
    }

    // Magic-byte MIME verification.
    const head = Buffer.concat(sniffBuffer);
    const detected = await fileTypeFromBuffer(head);
    const declaredMime = normalizeMimeType(params.declaredMimeType);
    let resolvedMime = normalizeMimeType(detected?.mime);
    if (!resolvedMime) {
      // Plain-text / CSV / JSON / Markdown etc. have no magic bytes.
      // Accept a narrow set of declared text MIME types when the body
      // is valid UTF-8 without embedded NULs in the sniff window.
      if (declaredMime?.startsWith("text/")) {
        resolvedMime = declaredMime;
      } else if (
        declaredMime === "application/json" ||
        declaredMime === "application/xml" ||
        declaredMime === "application/x-yaml"
      ) {
        resolvedMime = declaredMime;
      }
    }
    if (!resolvedMime) {
      this.safeRmTree(dir);
      throw new IngestRejectedError(
        "undetected_mime",
        "Could not determine a safe MIME type for the upload",
      );
    }
    if (!isAllowedMime(resolvedMime)) {
      this.safeRmTree(dir);
      throw new IngestRejectedError(
        "disallowed_mime",
        `MIME type "${resolvedMime}" is not allowed`,
      );
    }

    renameSync(tmpPath, finalPath);

    this.db
      .prepare(
        `INSERT INTO chat_attachments
         (id, session_id, message_id, direction, provenance, path, original_filename,
          safe_filename, mime_type, size_bytes, turn_token, caption)
         VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.direction,
        params.provenance,
        finalPath,
        params.originalFilename,
        safeFilename,
        resolvedMime,
        totalBytes,
        params.turnToken ?? null,
        params.caption ?? null,
      );

    return {
      id,
      path: finalPath,
      originalFilename: params.originalFilename,
      safeFilename,
      mimeType: resolvedMime,
      sizeBytes: totalBytes,
      caption: params.caption,
    };
  }

  get(id: string): StoreAttachmentRow | null {
    const row = this.db
      .prepare(`SELECT * FROM chat_attachments WHERE id = ?`)
      .get(id) as ChatAttachmentDbRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Delete a still-unbound attachment (no message_id). Used by the
   * DELETE endpoint and the orphan reaper. Safe no-op if the row is
   * already gone.
   */
  deleteIfUnbound(id: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.messageId !== null) return false;
    this.db.prepare(`DELETE FROM chat_attachments WHERE id = ?`).run(id);
    this.safeRmTree(this.dirFor(id));
    return true;
  }

  /**
   * Bind a batch of inbound attachment rows to a session + message
   * inside a single transaction. Rows that don't exist or are already
   * bound are skipped; the caller receives the list that was actually
   * bound.
   */
  bindInbound(params: {
    attachmentIds: string[];
    sessionId: number;
    messageId: number;
  }): StoreAttachmentRow[] {
    if (params.attachmentIds.length === 0) return [];

    const bind = this.db.transaction((ids: string[]) => {
      const out: StoreAttachmentRow[] = [];
      const select = this.db.prepare(
        `SELECT * FROM chat_attachments
         WHERE id = ? AND direction = 'inbound' AND message_id IS NULL`,
      );
      const update = this.db.prepare(
        `UPDATE chat_attachments
         SET session_id = ?, message_id = ?
         WHERE id = ? AND message_id IS NULL`,
      );
      for (const id of ids) {
        const row = select.get(id) as ChatAttachmentDbRow | undefined;
        if (!row) continue;
        update.run(params.sessionId, params.messageId, id);
        out.push(
          mapRow({ ...row, session_id: params.sessionId, message_id: params.messageId }),
        );
      }
      return out;
    });

    return bind(params.attachmentIds);
  }

  listInboundForMessage(messageId: number): StoreAttachmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_attachments
         WHERE message_id = ? AND direction = 'inbound'
         ORDER BY created_at ASC`,
      )
      .all(messageId) as ChatAttachmentDbRow[];
    return rows.map(mapRow);
  }

  listOutboundForMessage(messageId: number): StoreAttachmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_attachments
         WHERE message_id = ? AND direction = 'outbound'
         ORDER BY created_at ASC`,
      )
      .all(messageId) as ChatAttachmentDbRow[];
    return rows.map(mapRow);
  }

  listForMessage(messageId: number): StoreAttachmentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_attachments
         WHERE message_id = ? ORDER BY created_at ASC`,
      )
      .all(messageId) as ChatAttachmentDbRow[];
    return rows.map(mapRow);
  }

  /**
   * Collect outbound rows produced during the current turn and clear
   * the token so they can't leak into a later turn. Returns the rows
   * in creation order.
   */
  collectOutboundForTurn(params: {
    turnToken: string;
    sessionId: number;
  }): StoreAttachmentRow[] {
    return this.db.transaction((): StoreAttachmentRow[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM chat_attachments
           WHERE turn_token = ? AND direction = 'outbound' AND message_id IS NULL
           ORDER BY created_at ASC`,
        )
        .all(params.turnToken) as ChatAttachmentDbRow[];
      if (rows.length === 0) return [];
      const update = this.db.prepare(
        `UPDATE chat_attachments
         SET turn_token = NULL, session_id = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        update.run(params.sessionId, row.id);
      }
      return rows.map(mapRow);
    })();
  }

  /** Release a turn token without collecting — used on turn failure. Any
   *  attachments the agent posted get swept into the orphan reaper path. */
  releaseTurnToken(turnToken: string): void {
    this.db
      .prepare(`UPDATE chat_attachments SET turn_token = NULL WHERE turn_token = ?`)
      .run(turnToken);
  }

  /**
   * Bind a single outbound attachment to the assistant message row that
   * was just recorded for this turn. Called after the dispatcher records
   * the assistant message in `messages` and the adapter has delivered
   * the file to the user.
   */
  bindOutboundToMessage(attachmentId: string, messageId: number): void {
    this.db
      .prepare(
        `UPDATE chat_attachments
         SET message_id = ?
         WHERE id = ? AND direction = 'outbound'`,
      )
      .run(messageId, attachmentId);
  }

  /**
   * Delete inbound orphans (no message_id) older than `maxAgeHours`.
   * Run once on daemon startup. Outbound orphans are rarer (a turn
   * that crashed between generation and collection) and swept the same
   * way.
   */
  reapOrphans(maxAgeHours = 24): { inbound: number; outbound: number } {
    const rows = this.db
      .prepare(
        `SELECT id, direction FROM chat_attachments
         WHERE message_id IS NULL
           AND created_at < datetime('now', ?)
        `,
      )
      .all(`-${maxAgeHours} hours`) as { id: string; direction: AttachmentDirection }[];
    let inbound = 0;
    let outbound = 0;
    for (const row of rows) {
      this.db.prepare(`DELETE FROM chat_attachments WHERE id = ?`).run(row.id);
      this.safeRmTree(this.dirFor(row.id));
      if (row.direction === "inbound") inbound++;
      else outbound++;
    }
    if (inbound + outbound > 0) {
      logger.info({ inbound, outbound }, "Reaped orphan chat attachments");
    }
    return { inbound, outbound };
  }

  /**
   * Delete attachment rows whose bound message no longer exists, plus their
   * on-disk directories. In production the FK normally removes these rows when
   * messages are pruned, but this is the recovery path for older databases,
   * tests with FK disabled, or a failed cascade.
   */
  reapDanglingMessageRefs(): number {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM chat_attachments AS a
         WHERE a.message_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM messages AS m WHERE m.id = a.message_id
           )`,
      )
      .all() as { id: string }[];
    let removed = 0;
    for (const row of rows) {
      this.db.prepare(`DELETE FROM chat_attachments WHERE id = ?`).run(row.id);
      this.safeRmTree(this.dirFor(row.id));
      removed++;
    }
    if (removed > 0) {
      logger.info({ removed }, "Reaped dangling chat attachment message refs");
    }
    return removed;
  }

  /**
   * Remove physical attachment directories that no longer have a DB row. This
   * catches the normal retention path where `messages` deletion cascades the
   * `chat_attachments` row before the filesystem can be cleaned. Fresh
   * directories are skipped so an in-flight ingest cannot be mistaken for an
   * orphan before its row is inserted.
   */
  reapUntrackedDirs(options: { minAgeHours?: number } = {}): number {
    const minAgeMs = (options.minAgeHours ?? 1) * 60 * 60 * 1000;
    if (!existsSync(this.rootDir)) return 0;
    let entries: string[];
    try {
      entries = readdirSync(this.rootDir);
    } catch (err) {
      logger.warn({ err, rootDir: this.rootDir }, "Failed to list attachment root");
      return 0;
    }

    const exists = this.db.prepare(`SELECT 1 FROM chat_attachments WHERE id = ?`);
    let removed = 0;
    const now = Date.now();
    for (const entry of entries) {
      const dir = this.dirFor(entry);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs < minAgeMs) continue;
      if (exists.get(entry)) continue;
      this.safeRmTree(dir);
      removed++;
    }
    if (removed > 0) {
      logger.info({ removed }, "Reaped untracked chat attachment directories");
    }
    return removed;
  }

  /**
   * Hard-link (or copy across volumes) an attachment into the session's
   * `_attachments/` subdir. Idempotent; safe to call per dispatch.
   */
  stageIntoWorkdir(params: {
    row: StoreAttachmentRow;
    sessionDir: string;
  }): string {
    const stagedDir = join(params.sessionDir, "_attachments");
    mkdirSync(stagedDir, { recursive: true });
    const dst = join(stagedDir, params.row.safeFilename);
    if (!existsSync(params.row.path)) {
      throw new Error(
        `Attachment ${params.row.id} missing at ${params.row.path}`,
      );
    }
    hardLinkOrCopy(params.row.path, dst);
    return dst;
  }

  private safeRmTree(dir: string): void {
    try {
      if (existsSync(dir)) {
        const stat = statSync(dir);
        if (stat.isDirectory()) {
          rmSync(dir, { recursive: true, force: true });
        } else {
          unlinkSync(dir);
        }
      }
    } catch (err) {
      logger.warn({ err, dir }, "Failed to remove attachment dir");
    }
  }

  private async waitForWriteStreamSettled(
    stream: ReturnType<typeof createWriteStream>,
    options?: { destroy?: boolean },
  ): Promise<void> {
    if (stream.closed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        stream.off("close", finish);
        stream.off("error", finish);
        resolve();
      };
      stream.once("close", finish);
      stream.once("error", finish);
      if (options?.destroy && !stream.destroyed) {
        stream.destroy();
      }
    });
  }
}
