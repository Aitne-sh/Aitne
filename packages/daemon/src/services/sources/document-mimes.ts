/**
 * Document-class MIME types that are auto-captured into the source library
 * at attachment-ingest time (SOURCE_LIBRARY_DESIGN.md §auto-capture).
 *
 * Every entry MUST also be on the sanitize allowlist
 * (`services/attachments/sanitize.ts`) — auto-capture runs after MIME
 * verification, so an entry missing there can never fire. Deliberately
 * excludes `text/*` (chat is full of throwaway text files) and
 * image/audio/video (agent-judged via `POST /api/sources/promote`).
 */
export const AUTO_CAPTURE_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
];

const AUTO_CAPTURE_SET = new Set(AUTO_CAPTURE_MIME_TYPES);

/** True when an inbound attachment of this (verified) MIME type should be
 *  captured into the source library automatically. */
export function isAutoCaptureMime(mimeType: string): boolean {
  return AUTO_CAPTURE_SET.has(mimeType.toLowerCase());
}
