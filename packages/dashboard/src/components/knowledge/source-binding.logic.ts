/**
 * Pure helpers for detecting a source-library binding in a vault file's
 * frontmatter. Source cards (`knowledge/sources/<collection>/<slug>.md`)
 * carry `type: source` + `source_id: src_<uuid>` (+ `mime:`), and the
 * daemon serves the original binary at `GET /api/sources/:id/file`.
 */

import type { ParsedFrontmatter } from "@/lib/frontmatter";

export interface SourceBinding {
  sourceId: string;
  mime: string | null;
}

export function sourceBinding(
  fields: ParsedFrontmatter["fields"],
): SourceBinding | null {
  const byKey = new Map(fields.map((f) => [f.key, f.value]));
  if (byKey.get("type") !== "source") return null;
  const sourceId = byKey.get("source_id");
  if (typeof sourceId !== "string" || !sourceId.startsWith("src_")) {
    return null;
  }
  const mime = byKey.get("mime");
  return {
    sourceId,
    mime: typeof mime === "string" && mime.length > 0 ? mime : null,
  };
}

/** Daemon binary route, reachable through the dashboard's /api proxy. */
export function sourceFileHref(sourceId: string): string {
  return `/api/sources/${encodeURIComponent(sourceId)}/file`;
}

const MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PPTX",
  "application/vnd.oasis.opendocument.text": "ODT",
};

export function mimeShortLabel(mime: string | null): string | null {
  if (!mime) return null;
  const known = MIME_LABELS[mime];
  if (known) return known;
  const subtype = mime.split("/")[1];
  return subtype ? subtype.toUpperCase() : null;
}
