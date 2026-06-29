import { Hono } from "hono";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { stream as honoStream } from "hono/streaming";
import Busboy from "busboy";
import type Database from "better-sqlite3";
import type { AgentConfig } from "../../config.js";
import {
  AttachmentStore,
  IngestRejectedError,
  type AttachmentProvenance,
} from "../../services/attachments/store.js";
import { requiresDownloadDisposition } from "../../services/attachments/sanitize.js";
import { createLogger } from "../../logging.js";
import type { IAuditLogger } from "../../core/dispatcher.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("attachments-route");

/** Per-file caps (bytes). Images capped at the Anthropic image input
 *  ceiling of 5 MB; everything else at 25 MB. The 100 MB/turn total is
 *  enforced separately at bind time in POST /api/chat/messages. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const NON_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const PER_TURN_MAX_BYTES = 100 * 1024 * 1024;

/** Cap on simultaneous in-flight uploads per authenticated principal. */
const CONCURRENT_UPLOADS_PER_KEY = 5;

/** Token-bucket style in-memory counter for concurrent inbound uploads.
 *  Keyed by bearer-principal (dashboard) — Phase 1 only serves the
 *  dashboard via Bearer auth, so keying on "bearer" is sufficient. */
const inFlightPerKey = new Map<string, number>();

function acquireInFlight(key: string): boolean {
  const cur = inFlightPerKey.get(key) ?? 0;
  if (cur >= CONCURRENT_UPLOADS_PER_KEY) return false;
  inFlightPerKey.set(key, cur + 1);
  return true;
}
function releaseInFlight(key: string): void {
  const cur = inFlightPerKey.get(key) ?? 0;
  if (cur <= 1) inFlightPerKey.delete(key);
  else inFlightPerKey.set(key, cur - 1);
}

export interface AttachmentRoutesDeps {
  db: Database.Database;
  config: AgentConfig;
  store: AttachmentStore;
  /**
   * Validate an `X-Turn-Token` header. Returns the `session_id` bound to
   * that token when the dispatcher issued it for a currently-running
   * turn, null otherwise. Injected by index.ts to avoid a runtime
   * dependency on the dispatcher module inside the route file.
   */
  validateTurnToken: (
    token: string,
  ) => { sessionId: number } | null;
  /**
   * Audit logger — every successful inbound/outbound upload is written to
   * `agent_actions` so the dashboard events/cost views surface attachment
   * activity (rows feed the on-demand retrospective per DELEGATED-MODE-V2
   * §4.5). Optional during tests that don't wire the dispatcher.
   */
  audit?: IAuditLogger;
}

interface ParsedUpload {
  buffer: Readable;
  filename: string;
  mimeType: string;
  caption: string | null;
}

/** Parse multipart with busboy, yielding the first `file` field as a
 *  Node Readable backed directly by the incoming HTTP body. Rejects if
 *  no file field appears before the request ends. */
async function parseSingleFileMultipart(
  request: Request,
  maxSizeBytes: number,
): Promise<ParsedUpload> {
  if (!request.body) throw new IngestRejectedError("empty", "Missing request body");
  const contentType = request.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().startsWith("multipart/")) {
    throw new IngestRejectedError(
      "disallowed_mime",
      "Content-Type must be multipart/form-data",
    );
  }

  return await new Promise<ParsedUpload>((resolve, reject) => {
    const bb = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 1,
        fileSize: maxSizeBytes + 1,
      },
    });
    let settled = false;
    let caption: string | null = null;

    bb.on("field", (name, value) => {
      if (name === "caption" && typeof value === "string") {
        caption = value.slice(0, 1024);
      }
    });

    bb.on("file", (name, fileStream, info) => {
      if (settled) {
        fileStream.resume();
        return;
      }
      settled = true;
      resolve({
        buffer: fileStream,
        filename: info.filename ?? "attachment.bin",
        mimeType: info.mimeType ?? "application/octet-stream",
        caption,
      });
    });

    bb.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    bb.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new IngestRejectedError("empty", "No file field in multipart body"));
      }
    });

    Readable.fromWeb(request.body as never).pipe(bb);
  });
}

function maxBytesForDeclaredType(declared: string): number {
  return declared.toLowerCase().startsWith("image/")
    ? IMAGE_MAX_BYTES
    : NON_IMAGE_MAX_BYTES;
}

function principalKeyFor(c: {
  req: { header: (n: string) => string | undefined };
}): string {
  // Phase 1 is dashboard-bearer only — key on the auth header so a
  // misbehaving client can't flood outside its own upload budget. We
  // intentionally don't key on content-of-token, just its presence bucket.
  const auth = c.req.header("authorization") ?? "";
  const turn = c.req.header("x-turn-token") ?? "";
  if (turn) return `turn:${turn}`;
  if (auth) return `bearer:${auth.slice(0, 32)}`;
  return "anonymous";
}

export function createAttachmentRoutes(deps: AttachmentRoutesDeps): Hono {
  const app = new Hono();

  // ── Inbound single-file upload ──
  app.post("/chat/attachments", async (c) => {
    const key = principalKeyFor(c);
    if (!acquireInFlight(key)) {
      return respondWithAgentError(c, 429, [
        composeIssue("attachments.too_many_uploads", {
          field: "principal",
          received: key,
        }),
      ], { legacyFields: { message: "Too many concurrent uploads. Wait for in-flight uploads to finish." } });
    }
    try {
      // Max cap is computed from declared MIME as a hint; the store
      // re-verifies via magic bytes and can reject post-facto.
      const declaredCT = c.req.header("content-type") ?? "";
      const isMultipart = declaredCT.toLowerCase().startsWith("multipart/");
      if (!isMultipart) {
        return respondWithAgentError(c, 400, [
          composeIssue("attachments.invalid_content_type", {
            field: "Content-Type",
            received: declaredCT || "<missing>",
          }),
        ], { legacyFields: { message: "Content-Type must be multipart/form-data" } });
      }

      // We don't know the per-file MIME until the file part starts; use
      // the generous non-image cap and let the store trim further if the
      // detected type is an image.
      let parsed: ParsedUpload;
      try {
        parsed = await parseSingleFileMultipart(c.req.raw, NON_IMAGE_MAX_BYTES);
      } catch (err) {
        if (err instanceof IngestRejectedError) {
          return respondWithAgentError(c, 400, [
            composeIssue("attachments.ingest_rejected", {
              field: "file",
              received: err.message,
              hint: `Store rejected the upload (${err.reason}). See attachment limits and MIME rules.`,
            }),
          ], { legacyErrorCode: err.reason, legacyFields: { message: err.message } });
        }
        logger.warn({ err }, "Multipart parse failed");
        return respondWithAgentError(c, 400, [
          composeIssue("attachments.invalid_multipart", {
            field: "body",
            received: err instanceof Error ? err.message : String(err),
          }),
        ]);
      }

      const headerCaption = c.req.header("x-caption") ?? null;
      const caption = parsed.caption ?? (headerCaption ? headerCaption.slice(0, 1024) : null);

      try {
        const result = await deps.store.ingestStream({
          stream: parsed.buffer,
          declaredMimeType: parsed.mimeType,
          originalFilename: parsed.filename,
          direction: "inbound",
          provenance: "user_dashboard",
          caption: caption ?? undefined,
          maxSizeBytes: maxBytesForDeclaredType(parsed.mimeType),
        });
        deps.audit?.logAttachment({
          direction: "inbound",
          attachmentId: result.id,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          provenance: "user_dashboard",
          originalFilename: result.originalFilename,
        });
        return c.json({
          id: result.id,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          originalFilename: result.originalFilename,
        });
      } catch (err) {
        if (err instanceof IngestRejectedError) {
          return respondWithAgentError(c, 400, [
            composeIssue("attachments.ingest_rejected", {
              field: "file",
              received: err.message,
              hint: `Store rejected the upload (${err.reason}).`,
            }),
          ], { legacyErrorCode: err.reason, legacyFields: { message: err.message } });
        }
        logger.error({ err }, "Inbound attachment ingest failed");
        return respondWithAgentError(c, 500, [
          composeIssue("attachments.ingest_failed", {
            field: "store",
            received: "<internal_error>",
          }),
        ]);
      }
    } finally {
      releaseInFlight(key);
    }
  });

  // ── Outbound single-file upload (agent → daemon) ──
  app.post("/chat/outbound-attachments", async (c) => {
    const token = c.req.header("x-turn-token");
    if (!token) {
      return respondWithAgentError(c, 403, [
        composeIssue("attachments.missing_turn_token", {
          field: "X-Turn-Token",
          received: "<missing>",
        }),
      ]);
    }
    const binding = deps.validateTurnToken(token);
    if (!binding) {
      return respondWithAgentError(c, 403, [
        composeIssue("attachments.invalid_turn_token", {
          field: "X-Turn-Token",
          received: "<expired or stale>",
        }),
      ]);
    }
    const key = `turn:${token}`;
    if (!acquireInFlight(key)) {
      return respondWithAgentError(c, 429, [
        composeIssue("attachments.too_many_uploads", {
          field: "principal",
          received: key,
        }),
      ]);
    }
    try {
      const declaredCT = c.req.header("content-type") ?? "";
      if (!declaredCT.toLowerCase().startsWith("multipart/")) {
        return respondWithAgentError(c, 400, [
          composeIssue("attachments.invalid_content_type", {
            field: "Content-Type",
            received: declaredCT || "<missing>",
          }),
        ], { legacyFields: { message: "Content-Type must be multipart/form-data" } });
      }
      let parsed: ParsedUpload;
      try {
        parsed = await parseSingleFileMultipart(c.req.raw, NON_IMAGE_MAX_BYTES);
      } catch (err) {
        if (err instanceof IngestRejectedError) {
          return respondWithAgentError(c, 400, [
            composeIssue("attachments.ingest_rejected", {
              field: "file",
              received: err.message,
              hint: `Store rejected the upload (${err.reason}).`,
            }),
          ], { legacyErrorCode: err.reason, legacyFields: { message: err.message } });
        }
        return respondWithAgentError(c, 400, [
          composeIssue("attachments.invalid_multipart", {
            field: "body",
            received: err instanceof Error ? err.message : String(err),
          }),
        ]);
      }
      const headerFilename = c.req.header("x-filename");
      const originalFilename = headerFilename?.trim() || parsed.filename;
      const headerCaption = c.req.header("x-caption") ?? null;
      const caption = headerCaption ? headerCaption.slice(0, 1024) : parsed.caption;

      try {
        const result = await deps.store.ingestStream({
          stream: parsed.buffer,
          declaredMimeType: parsed.mimeType,
          originalFilename,
          direction: "outbound",
          provenance: "agent" as AttachmentProvenance,
          caption: caption ?? undefined,
          turnToken: token,
          maxSizeBytes: maxBytesForDeclaredType(parsed.mimeType),
        });
        deps.audit?.logAttachment({
          direction: "outbound",
          attachmentId: result.id,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          provenance: "agent",
          originalFilename: result.originalFilename,
        });
        return c.json({ id: result.id });
      } catch (err) {
        if (err instanceof IngestRejectedError) {
          return respondWithAgentError(c, 400, [
            composeIssue("attachments.ingest_rejected", {
              field: "file",
              received: err.message,
              hint: `Store rejected the upload (${err.reason}).`,
            }),
          ], { legacyErrorCode: err.reason, legacyFields: { message: err.message } });
        }
        logger.error({ err }, "Outbound attachment ingest failed");
        return respondWithAgentError(c, 500, [
          composeIssue("attachments.ingest_failed", {
            field: "store",
            received: "<internal_error>",
          }),
        ]);
      }
    } finally {
      releaseInFlight(key);
    }
  });

  // ── Serve attachment bytes back to the dashboard ──
  app.get("/chat/attachments/:id", (c) => {
    const row = deps.store.get(c.req.param("id"));
    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("attachments.not_found", {
          field: "attachmentId",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }
    try {
      statSync(row.path);
    } catch {
      return respondWithAgentError(c, 404, [
        composeIssue("attachments.not_found", {
          field: "attachmentId",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }

    const download = requiresDownloadDisposition(row.mimeType);
    // Quote the filename per RFC 6266 — escape backslash + quote.
    const safeDisplay = row.originalFilename.replace(/["\\]/g, "_");
    const disposition = download
      ? `attachment; filename="${safeDisplay}"`
      : `inline; filename="${safeDisplay}"`;

    c.header("Content-Type", row.mimeType);
    c.header("Content-Length", String(row.sizeBytes));
    c.header("Content-Disposition", disposition);
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

  // ── Delete an unbound attachment ──
  app.delete("/chat/attachments/:id", (c) => {
    const id = c.req.param("id");
    const row = deps.store.get(id);
    if (!row) {
      return respondWithAgentError(c, 404, [
        composeIssue("attachments.not_found", {
          field: "attachmentId",
          received: c.req.param("id") ?? "<unknown>",
        }),
      ]);
    }
    if (row.messageId !== null) {
      return respondWithAgentError(c, 409, [
        composeIssue("attachments.already_bound", {
          field: "attachmentId",
          received: id,
        }),
      ], { legacyFields: { message: "Attachment is already attached to a sent message" } });
    }
    const ok = deps.store.deleteIfUnbound(id);
    if (!ok) {
      return c.json({ error: "conflict" }, 409);
    }
    return c.json({ status: "deleted", id });
  });

  return app;
}

export const ATTACHMENT_LIMITS = {
  IMAGE_MAX_BYTES,
  NON_IMAGE_MAX_BYTES,
  PER_TURN_MAX_BYTES,
  CONCURRENT_UPLOADS_PER_KEY,
} as const;
