/**
 * Shared resolver: turn a browser-task screenshot key
 * (`/api/browser-task/<id>/screenshots/<file>`, the `apiPathForTraceFile`
 * form the runner records) into a platform-appropriate outbound attachment.
 *
 * Three callers — the MCP notifier (`ask_user` / `finish`), the lite
 * final-confirm sender, and the B-4 purchase sender — all need the SAME
 * "deliver the screenshot as actual bytes, never a loopback URL" behaviour:
 *
 *   - `dashboard`: ingest the trace file into the chat `AttachmentStore` so
 *     the dashboard fetches it by id through the authenticated same-origin
 *     `/api/chat/attachments/:id` proxy and renders it inline. A raw `<img>`
 *     pointed at the loopback trace URL would 401 — the bearer token is never
 *     attached to an `<img>` request.
 *   - messaging adapters (WhatsApp / Telegram / Slack / Discord): hand the
 *     trace file straight to the adapter's native upload API. A loopback URL
 *     is unreachable from a phone.
 *
 * Returns null when the key shape is unrecognised, paDataDir / the ingest
 * hook is unwired, the extension is not a known image type, or the file is
 * missing on disk (e.g. §14.7 retention dropped it). Callers degrade to a
 * brief "unavailable" note or simply omit the image — never an unreachable
 * link.
 */

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createLogger } from "../logging.js";
import type { OutboundAttachmentRef } from "../adapters/types.js";
import { resolveTraceFilePath } from "../services/browser-history/automation/trace-store-paths.js";

const logger = createLogger("browser-task-screenshot-attachment");

/** Matches the `apiPathForTraceFile` form. Tolerates a trailing query / hash
 *  (none today, but keeps the parse robust if the URL shape ever grows one). */
export const SCREENSHOT_KEY_PATTERN =
  /^\/api\/browser-task\/([a-f0-9-]{36})\/screenshots\/([^/?#]+)$/i;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Extract a log-safe message from an unknown thrown value. */
function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ingest a resolved trace screenshot into the chat `AttachmentStore`,
 *  minting a fetchable id. Supplied by the daemon bootstrap (closure over the
 *  store); returns null on ingest failure. */
export type IngestOutboundImage = (input: {
  absPath: string;
  mimeType: string;
  originalFilename: string;
}) => Promise<OutboundAttachmentRef | null>;

/** Resolve a screenshot key to its on-disk trace location + image MIME, or
 *  null when paDataDir is absent, the key shape is unrecognised, the path
 *  normaliser rejects the inputs (defence against escapes), or the extension
 *  is not a known image type. Pure — `resolveTraceFilePath` is path math. */
export function resolveTraceImage(
  paDataDir: string | null,
  key: string,
): { absPath: string; fileName: string; mimeType: string } | null {
  if (!paDataDir) return null;
  const match = SCREENSHOT_KEY_PATTERN.exec(key);
  if (!match) return null;
  const taskId = match[1]!;
  const fileName = match[2]!;
  const absPath = resolveTraceFilePath(paDataDir, taskId, fileName);
  if (absPath === null) return null;
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (mimeType === undefined) return null;
  return { absPath, fileName: basename(fileName), mimeType };
}

/** Messaging path: hand the trace file directly to the adapter's native
 *  upload API. Null when the file is missing on disk (the caller emits an
 *  "unavailable" note rather than a loopback URL a phone cannot reach). */
export async function buildTraceAttachment(
  paDataDir: string | null,
  key: string,
): Promise<OutboundAttachmentRef | null> {
  const resolved = resolveTraceImage(paDataDir, key);
  if (resolved === null) return null;
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(resolved.absPath)).size;
  } catch (err) {
    logger.warn(
      { key, err: toErrMsg(err) },
      "browser-task screenshot: trace file missing — omitted",
    );
    return null;
  }
  return {
    id: key,
    path: resolved.absPath,
    originalFilename: resolved.fileName,
    mimeType: resolved.mimeType,
    sizeBytes,
  };
}

/** Dashboard path: ingest the trace file into the `AttachmentStore` so the
 *  dashboard can fetch it inline by id. Null when paDataDir / the ingest hook
 *  is unwired or ingest fails. */
export async function buildStoreAttachment(
  paDataDir: string | null,
  ingestOutboundImage: IngestOutboundImage | undefined,
  key: string,
): Promise<OutboundAttachmentRef | null> {
  const resolved = resolveTraceImage(paDataDir, key);
  if (resolved === null) return null;
  if (!ingestOutboundImage) return null;
  try {
    return await ingestOutboundImage({
      absPath: resolved.absPath,
      mimeType: resolved.mimeType,
      originalFilename: resolved.fileName,
    });
  } catch (err) {
    logger.warn(
      { key, err: toErrMsg(err) },
      "browser-task screenshot: dashboard ingest failed",
    );
    return null;
  }
}

/** Resolve a single screenshot key to a platform-appropriate outbound
 *  attachment: ingested store attachment for `dashboard`, native trace-file
 *  attachment for every messaging adapter. */
export async function resolveScreenshotAttachment(params: {
  platform: string;
  key: string;
  paDataDir: string | null;
  ingestOutboundImage?: IngestOutboundImage;
}): Promise<OutboundAttachmentRef | null> {
  return params.platform === "dashboard"
    ? buildStoreAttachment(
        params.paDataDir,
        params.ingestOutboundImage,
        params.key,
      )
    : buildTraceAttachment(params.paDataDir, params.key);
}
