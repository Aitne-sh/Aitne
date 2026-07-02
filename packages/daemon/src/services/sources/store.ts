import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { hardLinkOrCopy } from "../attachments/hardlink.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("source-library");

export type SourceStatus = "unfiled" | "filed" | "archived";

export const SOURCE_STATUSES: readonly SourceStatus[] = [
  "unfiled",
  "filed",
  "archived",
];

export interface SourceDocumentRow {
  id: string;
  sha256: string;
  path: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: SourceStatus;
  cardPath: string | null;
  provenance: string;
  originAttachmentId: string | null;
  caption: string | null;
  receivedAt: string;
  lastReceivedAt: string;
  receiveCount: number;
  updatedAt: string;
}

interface SourceDocumentDbRow {
  id: string;
  sha256: string;
  path: string;
  original_filename: string;
  safe_filename: string;
  mime_type: string;
  size_bytes: number;
  status: SourceStatus;
  card_path: string | null;
  provenance: string;
  origin_attachment_id: string | null;
  caption: string | null;
  received_at: string;
  last_received_at: string;
  receive_count: number;
  updated_at: string;
}

function mapRow(row: SourceDocumentDbRow): SourceDocumentRow {
  return {
    id: row.id,
    sha256: row.sha256,
    path: row.path,
    originalFilename: row.original_filename,
    safeFilename: row.safe_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    cardPath: row.card_path,
    provenance: row.provenance,
    originAttachmentId: row.origin_attachment_id,
    caption: row.caption,
    receivedAt: row.received_at,
    lastReceivedAt: row.last_received_at,
    receiveCount: row.receive_count,
    updatedAt: row.updated_at,
  };
}

export interface CaptureFromFileParams {
  /** Absolute path to the already-verified bytes (an attachment-store file). */
  filePath: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  sizeBytes: number;
  /** Attachment provenance carried over verbatim (e.g. `user_telegram`). */
  provenance: string;
  caption?: string | null;
  originAttachmentId?: string | null;
}

export interface CaptureResult {
  id: string;
  /** True when the sha256 matched an existing source — no new file/row. */
  deduped: boolean;
}

export interface SourceListFilter {
  status?: SourceStatus;
  limit?: number;
  offset?: number;
}

export interface SourcePatch {
  status?: SourceStatus;
  cardPath?: string | null;
  caption?: string | null;
}

/**
 * SourceLibrary — durable on-disk store + SQLite ledger for user-sent
 * source documents (SOURCE_LIBRARY_DESIGN.md).
 *
 * Files live at `<dataDir>/sources/<id>/<safeFilename>`, hardlinked (or
 * copied) out of the attachment store at capture time so they share no
 * lifecycle with `chat_attachments`: no reaper touches this root and no
 * FK ties rows to the message graph. Deletion is status-driven
 * (`archived`); `hardDelete` exists only for the bearer-gated API verb.
 */
export class SourceLibrary {
  private readonly rootDir: string;

  constructor(
    private readonly db: Database.Database,
    dataDir: string,
  ) {
    this.rootDir = join(dataDir, "sources");
    mkdirSync(this.rootDir, { recursive: true });
  }

  /** Absolute path to the directory that contains this source's bytes. */
  dirFor(id: string): string {
    return join(this.rootDir, id);
  }

  /**
   * Capture verified bytes into the library. Dedup key is the file's
   * sha256: a repeat capture bumps `last_received_at`/`receive_count`
   * (and re-materializes the binary if it vanished) instead of storing
   * a second copy.
   */
  captureFromFile(params: CaptureFromFileParams): CaptureResult {
    const sha256 = createHash("sha256")
      .update(readFileSync(params.filePath))
      .digest("hex");

    const existing = this.db
      .prepare(`SELECT * FROM source_documents WHERE sha256 = ?`)
      .get(sha256) as SourceDocumentDbRow | undefined;

    if (existing) {
      if (!existsSync(existing.path)) {
        // Self-heal: the ledger row survived but the binary is gone
        // (external tampering) — re-materialize from the fresh copy.
        mkdirSync(this.dirFor(existing.id), { recursive: true });
        hardLinkOrCopy(params.filePath, existing.path);
        logger.warn(
          { id: existing.id, path: existing.path },
          "source binary was missing — re-materialized from re-received copy",
        );
      }
      this.db
        .prepare(
          `UPDATE source_documents
           SET last_received_at = datetime('now'),
               receive_count = receive_count + 1,
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(existing.id);
      return { id: existing.id, deduped: true };
    }

    const id = `src_${randomUUID()}`;
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true });
    const finalPath = join(dir, params.safeFilename);
    try {
      hardLinkOrCopy(params.filePath, finalPath);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }

    this.db
      .prepare(
        `INSERT INTO source_documents
         (id, sha256, path, original_filename, safe_filename, mime_type,
          size_bytes, provenance, origin_attachment_id, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sha256,
        finalPath,
        params.originalFilename,
        params.safeFilename,
        params.mimeType,
        params.sizeBytes,
        params.provenance,
        params.originAttachmentId ?? null,
        params.caption ?? null,
      );

    return { id, deduped: false };
  }

  get(id: string): SourceDocumentRow | null {
    const row = this.db
      .prepare(`SELECT * FROM source_documents WHERE id = ?`)
      .get(id) as SourceDocumentDbRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(filter: SourceListFilter = {}): SourceDocumentRow[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = filter.status
      ? (this.db
          .prepare(
            `SELECT * FROM source_documents WHERE status = ?
             ORDER BY received_at DESC, id LIMIT ? OFFSET ?`,
          )
          .all(filter.status, limit, offset) as SourceDocumentDbRow[])
      : (this.db
          .prepare(
            `SELECT * FROM source_documents
             ORDER BY received_at DESC, id LIMIT ? OFFSET ?`,
          )
          .all(limit, offset) as SourceDocumentDbRow[]);
    return rows.map(mapRow);
  }

  /**
   * Update lifecycle fields. Setting `cardPath` without an explicit
   * `status` implies `filed`; clearing it (null) without an explicit
   * status implies `unfiled`. Returns the updated row, or null when the
   * id is unknown.
   */
  patch(id: string, patch: SourcePatch): SourceDocumentRow | null {
    const current = this.get(id);
    if (!current) return null;

    let status = patch.status ?? current.status;
    if (patch.status === undefined && patch.cardPath !== undefined) {
      status = patch.cardPath === null ? "unfiled" : "filed";
    }
    const cardPath =
      patch.cardPath !== undefined ? patch.cardPath : current.cardPath;
    const caption =
      patch.caption !== undefined ? patch.caption : current.caption;

    this.db
      .prepare(
        `UPDATE source_documents
         SET status = ?, card_path = ?, caption = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(status, cardPath, caption, id);
    return this.get(id);
  }

  /** Remove the row and its on-disk dir. Bearer-gated at the API layer. */
  hardDelete(id: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    this.db.prepare(`DELETE FROM source_documents WHERE id = ?`).run(id);
    try {
      rmSync(this.dirFor(id), { recursive: true, force: true });
    } catch (err) {
      logger.warn({ id, err }, "source dir removal failed after row delete");
    }
    return true;
  }

  /** Resolve the source a chat attachment was captured into, via the
   *  `chat_attachments.source_id` breadcrumb set at ingest/promote time. */
  findByAttachmentId(attachmentId: string): SourceDocumentRow | null {
    const row = this.db
      .prepare(`SELECT source_id FROM chat_attachments WHERE id = ?`)
      .get(attachmentId) as { source_id: string | null } | undefined;
    if (!row?.source_id) return null;
    return this.get(row.source_id);
  }
}
