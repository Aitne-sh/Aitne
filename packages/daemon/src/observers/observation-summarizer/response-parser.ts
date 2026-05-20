/**
 * Tolerant parser for the summarizer's `{summary, novelty}` JSON output.
 *
 * The prompt asks for strict JSON, but lite-tier models (Haiku, gpt-5-mini,
 * Flash-Lite) occasionally wrap the response in markdown fences or add
 * a sentence of preamble. This parser tolerates those failure modes
 * while staying strict about the two required fields.
 */

export interface ParsedSummary {
  summary: string;
  novelty: 0 | 1 | 2 | 3;
}

export type ParseSummaryResult =
  | { ok: true; value: ParsedSummary }
  | { ok: false; reason: ParseFailureReason; rawSnippet: string };

export type ParseFailureReason =
  | "no_json_object"
  | "invalid_json"
  | "missing_summary"
  | "missing_novelty"
  | "invalid_novelty";

/**
 * Maximum stored summary length. Mirrors the design spec (≤ 120 chars).
 * Truncation falls within the parser so all callers see a bounded string.
 */
export const SUMMARY_MAX_CHARS = 120;

export function parseSummarizerResponse(raw: string): ParseSummaryResult {
  const slice = extractJsonObject(raw);
  if (slice === null) {
    return { ok: false, reason: "no_json_object", rawSnippet: snippet(raw) };
  }

  // `extractJsonObject` only returns a `{...}`-shaped slice (or `null`,
  // already handled above). A `JSON.parse` of that slice either throws
  // (handled by the catch) or evaluates to a non-null object — never a
  // falsy primitive or array — so a separate `!parsed || typeof !==
  // "object"` guard would be dead defensive code.
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "invalid_json", rawSnippet: snippet(slice) };
  }
  const summaryValue = obj["summary"];
  if (typeof summaryValue !== "string" || summaryValue.length === 0) {
    return { ok: false, reason: "missing_summary", rawSnippet: snippet(slice) };
  }

  const noveltyValue = obj["novelty"];
  if (noveltyValue === undefined || noveltyValue === null) {
    return { ok: false, reason: "missing_novelty", rawSnippet: snippet(slice) };
  }
  const novelty = coerceNovelty(noveltyValue);
  if (novelty === null) {
    return { ok: false, reason: "invalid_novelty", rawSnippet: snippet(slice) };
  }

  // Collapse newlines + trim — the design spec says one-line summary.
  const cleaned = summaryValue.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX_CHARS);
  return {
    ok: true,
    value: { summary: cleaned, novelty },
  };
}

/** Apply a novelty floor (e.g., VIP mail). The result clamps to 0..3. */
export function applyNoveltyFloor(
  parsed: ParsedSummary,
  floor: 0 | 1 | 2 | 3 | undefined,
): ParsedSummary {
  if (floor === undefined) return parsed;
  if (parsed.novelty >= floor) return parsed;
  return { ...parsed, novelty: floor };
}

// ── Internal ────────────────────────────────────────────────────────────

/** Extract the first balanced `{...}` block from a string. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function coerceNovelty(value: unknown): 0 | 1 | 2 | 3 | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) {
    return value as 0 | 1 | 2 | 3;
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 3) return n as 0 | 1 | 2 | 3;
  }
  return null;
}

function snippet(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}
