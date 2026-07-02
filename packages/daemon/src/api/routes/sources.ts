import { Hono } from "hono";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { stream as honoStream } from "hono/streaming";
import type { AttachmentStore } from "../../services/attachments/store.js";
import {
  SOURCE_STATUSES,
  type SourceLibrary,
  type SourceStatus,
} from "../../services/sources/store.js";
import { requiresDownloadDisposition } from "../../services/attachments/sanitize.js";
import { createLogger } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("sources-route");

/** Vault-relative card paths the PATCH verb accepts. Kept in lockstep with
 *  the `knowledge/sources/*` context-write whitelist — the card itself is
 *  written through `/api/context/*`, this only records the binding. */
const CARD_PATH_RE = /^knowledge\/sources\/[a-z0-9._/-]+\.md$/;

function isSafeCardPath(cardPath: string): boolean {
  if (!CARD_PATH_RE.test(cardPath)) return false;
  const segments = cardPath.split("/");
  // The character class admits dots, so reject traversal/empty segments
  // the regex alone would let through ("knowledge/sources/../x.md").
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

function isSourceStatus(value: string): value is SourceStatus {
  return (SOURCE_STATUSES as readonly string[]).includes(value);
}

/** True when `path` is a readable regular file whose bytes hash to
 *  `sha256`. Unreadable/missing paths are simply "no match" — the
 *  export falls back to copying. */
function fileMatchesSha256(path: string, sha256: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    return (
      createHash("sha256").update(readFileSync(path)).digest("hex") === sha256
    );
  } catch {
    return false;
  }
}

/** Structural slice of `ObsidianService` the export verb needs — kept as an
 *  interface so tests can stub it without the CLI machinery. */
export interface ObsidianExportService {
  readonly available: boolean;
  readonly absoluteVaultPath: string | null;
  isRunning(): Promise<boolean>;
  createNote(name: string, content: string): Promise<void>;
  resolveNotePath(noteName: string): string | null;
}

export interface SourceRoutesDeps {
  sourceLibrary: SourceLibrary;
  attachmentStore: AttachmentStore;
  /** Context-vault dir resolver — used to read a filed source's card body
   *  into the companion note on export. Optional in narrow tests. */
  getContextDir?: () => string;
  /** External Obsidian vault service — export target. Optional; when
   *  absent, `POST /:id/export {target:"obsidian"}` returns 409. */
  obsidianService?: ObsidianExportService | null;
  /** Marks the companion note as an agent write so the obsidian-watcher
   *  attributes it correctly (same contract as the obsidian routes). */
  writeTracker?: { markWriting(path: string): void } | null;
}

/**
 * `/api/sources` — the durable source-library surface
 * (SOURCE_LIBRARY_DESIGN.md). Agent-facing verbs are Autonomous
 * (loopback curl, no bearer); hard DELETE is Approve-tier via the
 * risk classifier so the middleware enforces Bearer auth on it.
 */
export function createSourceRoutes(deps: SourceRoutesDeps): Hono {
  const app = new Hono();

  // ── List (metadata only) ──
  app.get("/sources", (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !isSourceStatus(status)) {
      return respondWithAgentError(c, 400, [
        composeIssue("sources.invalid_status", {
          field: "status",
          received: status,
          validValues: [...SOURCE_STATUSES],
        }),
      ]);
    }
    const limit = c.req.query("limit");
    const offset = c.req.query("offset");
    const rows = deps.sourceLibrary.list({
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit: Number.parseInt(limit, 10) || undefined } : {}),
      ...(offset !== undefined ? { offset: Number.parseInt(offset, 10) || 0 } : {}),
    });
    return c.json({ sources: rows.map(toWire) });
  });

  // ── Metadata ──
  app.get("/sources/:id", (c) => {
    const row = deps.sourceLibrary.get(c.req.param("id"));
    if (!row) return notFound(c, c.req.param("id"));
    return c.json(toWire(row));
  });

  // ── Bytes ──
  app.get("/sources/:id/file", (c) => {
    const row = deps.sourceLibrary.get(c.req.param("id"));
    if (!row) return notFound(c, c.req.param("id"));
    let sizeBytes: number;
    try {
      sizeBytes = statSync(row.path).size;
    } catch {
      return respondWithAgentError(c, 410, [
        composeIssue("sources.file_missing", {
          field: "sourceId",
          received: row.id,
          hint: "The ledger row exists but the binary is gone from disk.",
        }),
      ]);
    }

    const download = requiresDownloadDisposition(row.mimeType);
    const safeDisplay = row.originalFilename.replace(/["\\]/g, "_");
    c.header("Content-Type", row.mimeType);
    c.header("Content-Length", String(sizeBytes));
    c.header(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename="${safeDisplay}"`,
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, max-age=0, must-revalidate");

    return honoStream(c, async (s) => {
      const fileStream = createReadStream(row.path);
      try {
        await s.pipe(Readable.toWeb(fileStream) as ReadableStream<Uint8Array>);
      } finally {
        fileStream.destroy();
      }
    });
  });

  // ── Promote a chat attachment (any allowed MIME — images, audio…) ──
  app.post("/sources/promote", async (c) => {
    const parsed = await readJsonBody(c, { maxBytes: 64 * 1024 });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { attachmentId?: unknown; caption?: unknown };
    if (typeof body?.attachmentId !== "string" || !body.attachmentId) {
      return respondWithAgentError(c, 400, [
        composeIssue("sources.missing_attachment_id", {
          field: "attachmentId",
          received: String(body?.attachmentId ?? "<missing>"),
        }),
      ]);
    }
    const caption =
      typeof body.caption === "string" ? body.caption.slice(0, 1024) : null;

    const attachment = deps.attachmentStore.get(body.attachmentId);
    if (!attachment) {
      return respondWithAgentError(c, 404, [
        composeIssue("attachments.not_found", {
          field: "attachmentId",
          received: body.attachmentId,
        }),
      ]);
    }
    try {
      statSync(attachment.path);
    } catch {
      return respondWithAgentError(c, 410, [
        composeIssue("attachments.file_missing", {
          field: "attachmentId",
          received: body.attachmentId,
          hint: "The attachment bytes were already reaped — ask the user to resend.",
        }),
      ]);
    }

    try {
      const result = deps.sourceLibrary.captureFromFile({
        filePath: attachment.path,
        originalFilename: attachment.originalFilename,
        safeFilename: attachment.safeFilename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        provenance: attachment.provenance,
        caption: caption ?? attachment.caption,
        originAttachmentId: attachment.id,
      });
      deps.attachmentStore.setSourceId(attachment.id, result.id);
      const row = deps.sourceLibrary.get(result.id);
      return c.json({
        ...(row ? toWire(row) : { id: result.id }),
        deduped: result.deduped,
      });
    } catch (err) {
      logger.error({ err, attachmentId: body.attachmentId }, "Promote failed");
      return respondWithAgentError(c, 500, [
        composeIssue("sources.capture_failed", {
          field: "attachmentId",
          received: body.attachmentId,
        }),
      ]);
    }
  });

  // ── Lifecycle patch (filing / archiving) ──
  app.patch("/sources/:id", async (c) => {
    const parsed = await readJsonBody(c, { maxBytes: 64 * 1024 });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      status?: unknown;
      cardPath?: unknown;
      caption?: unknown;
    };

    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !isSourceStatus(body.status)) {
        return respondWithAgentError(c, 400, [
          composeIssue("sources.invalid_status", {
            field: "status",
            received: String(body.status),
            validValues: [...SOURCE_STATUSES],
          }),
        ]);
      }
    }
    if (body.cardPath !== undefined && body.cardPath !== null) {
      if (typeof body.cardPath !== "string" || !isSafeCardPath(body.cardPath)) {
        return respondWithAgentError(c, 400, [
          composeIssue("sources.invalid_card_path", {
            field: "cardPath",
            received: String(body.cardPath),
            hint: "Must match knowledge/sources/<collection>/<slug>.md (lowercase, no traversal).",
          }),
        ]);
      }
    }
    if (
      body.caption !== undefined
      && body.caption !== null
      && typeof body.caption !== "string"
    ) {
      return respondWithAgentError(c, 400, [
        composeIssue("sources.invalid_caption", {
          field: "caption",
          received: typeof body.caption,
        }),
      ]);
    }

    const row = deps.sourceLibrary.patch(c.req.param("id"), {
      ...(body.status !== undefined ? { status: body.status as SourceStatus } : {}),
      ...(body.cardPath !== undefined
        ? { cardPath: body.cardPath as string | null }
        : {}),
      ...(body.caption !== undefined
        ? { caption: (body.caption as string | null)?.slice(0, 1024) ?? null }
        : {}),
    });
    if (!row) return notFound(c, c.req.param("id"));
    return c.json(toWire(row));
  });

  // ── Export the original binary into the external Obsidian vault ──
  // The one reuse path the agent cannot reach otherwise: the Obsidian
  // routes are markdown-only, so binaries need this fs copy. Notion is
  // deliberately NOT a target here — the card markdown already flows
  // through the existing `POST /api/notion/pages` surface, and a second
  // Notion write path would just duplicate its parent-resolution logic.
  app.post("/sources/:id/export", async (c) => {
    const row = deps.sourceLibrary.get(c.req.param("id"));
    if (!row) return notFound(c, c.req.param("id"));

    const parsed = await readJsonBody(c, { maxBytes: 16 * 1024 });
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { target?: unknown; note?: unknown };

    if (body.target !== "obsidian") {
      return respondWithAgentError(c, 400, [
        composeIssue("sources.unsupported_export_target", {
          field: "target",
          received: String(body.target ?? "<missing>"),
          validValues: ["obsidian"],
          hint: "For Notion, create a page from the source card markdown via POST /api/notion/pages.",
        }),
      ]);
    }

    const vault = deps.obsidianService;
    const vaultPath = vault?.available ? vault.absoluteVaultPath : null;
    if (!vault || !vaultPath) {
      return respondWithAgentError(c, 409, [
        composeIssue("sources.export_unavailable", {
          field: "externalObsidianVaultPath",
          received: "<unset>",
          hint: "Configure the external Obsidian vault in settings first.",
        }),
      ]);
    }

    if (!existsSync(row.path)) {
      return respondWithAgentError(c, 410, [
        composeIssue("sources.file_missing", {
          field: "sourceId",
          received: row.id,
        }),
      ]);
    }

    try {
      const destDir = join(vaultPath, "sources");
      mkdirSync(destDir, { recursive: true });
      // Idempotent re-export: a vault file already holding these exact
      // bytes (sha256 match) is reused instead of piling up prefixed
      // copies. Only a genuinely different file keeps the plain name for
      // itself; ours then takes the id-prefixed form, which is unique per
      // source and therefore safe to overwrite.
      let destName = row.safeFilename;
      if (
        existsSync(join(destDir, destName))
        && !fileMatchesSha256(join(destDir, destName), row.sha256)
      ) {
        destName = `${row.id}-${row.safeFilename}`;
      }
      const dest = join(destDir, destName);
      if (!fileMatchesSha256(dest, row.sha256)) {
        copyFileSync(row.path, dest);
      }

      // Companion note (default on): card body when the source is filed,
      // else a minimal stub — plus the `![[…]]` embed Obsidian renders.
      let noteCreated = false;
      let noteName: string | null = null;
      let noteSkippedReason: string | null = null;
      if (body.note !== false) {
        if (!(await vault.isRunning())) {
          noteSkippedReason = "obsidian_not_running";
        } else {
          let cardBody: string | null = null;
          if (row.cardPath && deps.getContextDir) {
            try {
              cardBody = readFileSync(
                join(deps.getContextDir(), row.cardPath),
                "utf-8",
              );
            } catch {
              cardBody = null;
            }
          }
          const stem = destName.replace(/\.[A-Za-z0-9]+$/, "");
          noteName = `sources/${stem}`;
          const content = [
            cardBody?.trim() ?? `# ${row.originalFilename}`,
            "",
            `![[${destName}]]`,
            "",
          ].join("\n");
          try {
            const absolute = vault.resolveNotePath(noteName);
            if (absolute) deps.writeTracker?.markWriting(absolute);
            await vault.createNote(noteName, content);
            noteCreated = true;
          } catch (err) {
            // Note creation is best-effort — the binary copy is the
            // durable part. Typical cause: the note already exists from
            // a previous export.
            noteSkippedReason = "note_create_failed";
            logger.warn({ err, noteName }, "Companion note creation failed");
          }
        }
      } else {
        noteSkippedReason = "disabled_by_request";
      }

      return c.json({
        status: "exported",
        target: "obsidian",
        file: `sources/${destName}`,
        noteCreated,
        ...(noteName ? { noteName } : {}),
        ...(noteSkippedReason ? { noteSkippedReason } : {}),
      });
    } catch (err) {
      logger.error({ err, sourceId: row.id }, "Obsidian export failed");
      return respondWithAgentError(c, 500, [
        composeIssue("sources.export_failed", {
          field: "sourceId",
          received: row.id,
        }),
      ]);
    }
  });

  // ── Hard delete (Approve tier — Bearer enforced by middleware) ──
  app.delete("/sources/:id", (c) => {
    const id = c.req.param("id");
    const row = deps.sourceLibrary.get(id);
    if (!row) return notFound(c, id);
    const force = c.req.query("force") === "true";
    if (row.status !== "archived" && !force) {
      return respondWithAgentError(c, 409, [
        composeIssue("sources.not_archived", {
          field: "sourceId",
          received: id,
          hint: "Archive the source first (PATCH status:'archived'), or pass ?force=true.",
        }),
      ]);
    }
    deps.sourceLibrary.hardDelete(id);
    return c.json({ status: "deleted", id });
  });

  return app;

  function notFound(
    c: Parameters<typeof respondWithAgentError>[0],
    id: string | undefined,
  ): Response {
    return respondWithAgentError(c, 404, [
      composeIssue("sources.not_found", {
        field: "sourceId",
        received: id ?? "<unknown>",
      }),
    ]);
  }
}

function toWire(row: {
  id: string;
  sha256: string;
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
}): Record<string, unknown> {
  // Deliberately omits the absolute on-disk `path` — agents fetch bytes
  // through GET /sources/:id/file, and leaking dataDir layout into agent
  // prompts invites hallucinated direct-fs access.
  return {
    id: row.id,
    sha256: row.sha256,
    originalFilename: row.originalFilename,
    safeFilename: row.safeFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    cardPath: row.cardPath,
    provenance: row.provenance,
    originAttachmentId: row.originAttachmentId,
    caption: row.caption,
    receivedAt: row.receivedAt,
    lastReceivedAt: row.lastReceivedAt,
    receiveCount: row.receiveCount,
    updatedAt: row.updatedAt,
  };
}
