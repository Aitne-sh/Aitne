/**
 * Filename sanitization + MIME allowlist for chat attachments.
 *
 * Pure module — no I/O, trivially unit-testable.
 */

/**
 * Derive a safe on-disk filename from a user-provided one. Strips path
 * separators, null bytes, control chars, and `..` segments; NFC-normalizes;
 * trims to 255 chars; falls back to `attachment-<id>.<ext>` on empty.
 *
 * The resulting name is constrained to `[A-Za-z0-9._-]` — any other code
 * point becomes `_`. The original filename is kept in the DB for display
 * (`original_filename`); this function only produces the disk-safe mirror.
 */
export function deriveSafeFilename(original: string, id: string): string {
  // `?? ""` is defensive against HTTP callers that hand us a null filename
  // (multipart uploads where `info.filename` is undefined) even though the
  // declared type is `string`.
  const stripped = (original ?? "")
    .normalize("NFC")
    // Drop null + control characters.
    .replace(/[\x00-\x1f\x7f]/g, "")
    // Collapse path separators.
    .replace(/[\\/]+/g, "_")
    // `..` path traversal segments.
    .replace(/\.\.+/g, "_")
    // Leading dots (hidden files) — allow a single leading dot only.
    .replace(/^\.+(?=.)/, "_")
    .trim();

  const safeBody = stripped.replace(/[^A-Za-z0-9._-]/g, "_");

  if (!safeBody || safeBody === "_" || safeBody === ".") {
    // When sanitization erased every structural byte, the original can't
    // have survived with a usable extension either (every path that reaches
    // this branch either had no `.ext` to begin with, or the leading-dot
    // rule already rewrote it away). Always fall back to `.bin`.
    return `attachment-${id}.bin`;
  }

  return safeBody.length > 255 ? safeBody.slice(safeBody.length - 255) : safeBody;
}

/**
 * Chat attachment MIME allowlist. Executables and archives are rejected
 * outright (see §Security in the design doc). Audio/video are accepted as
 * opaque files: they are staged into the session workdir and named in the
 * prompt, but only image attachments get native multimodal argv treatment.
 */
const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  // images
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/svg+xml",
  // audio
  "audio/aac",
  "audio/amr",
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/vnd.wave",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
  // video
  "video/3gp",
  "video/3gpp",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  // generic media containers surfaced by some MIME detectors / clients
  "application/mp4",
  "application/ogg",
  // docs
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  // text + data
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "text/yaml",
  // common source-code types surfaced by file-type / standard tables
  "text/x-python",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++",
  "text/javascript",
  "application/javascript",
  "application/typescript",
]);

export function normalizeMimeType(mime: string | null | undefined): string | null {
  const normalized = mime?.split(";")[0]?.trim().toLowerCase();
  return normalized || null;
}

export function isAllowedMime(mime: string): boolean {
  const normalized = normalizeMimeType(mime);
  return normalized !== null && ALLOWED_MIME_TYPES.has(normalized);
}

/** SVG is served only as a download (Content-Disposition: attachment) — it
 *  can carry scripts, so it is never rendered inline in Phase 1. */
export function requiresDownloadDisposition(mime: string): boolean {
  const lower = normalizeMimeType(mime) ?? "";
  if (lower === "image/svg+xml") return true;
  if (lower.startsWith("image/")) return false;
  if (lower === "application/pdf") return false;
  return true;
}
