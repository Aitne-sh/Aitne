export class UrlExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlExtractError";
  }
}

export interface UrlExtractResult {
  urls: string[];
}

const URL_CANDIDATE_RE = /https?:\/\/[^\s<>"']+/gi;
// Includes `]` and `}` so wrapped forms `[https://x]` and `{https://x}` peel
// cleanly without breaking valid path characters (RFC 3986 reserves `]`/`}`
// outside literal IPv6 hosts, which the URL constructor handles separately).
const TRAILING_PUNCTUATION_RE = /[)\]},.;!?]+$/;

export function extractHttpUrls(input: string, limit = 10): UrlExtractResult {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(URL_CANDIDATE_RE)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION_RE, "");
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    // Defensive: the candidate regex only matches http(s) prefixes and
    // URL never normalises away from http/https. Preserved in case the
    // regex is ever widened — kept out of the coverage gate via v8-ignore.
    /* v8 ignore start */
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    /* v8 ignore stop */
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    urls.push(normalized);
    seen.add(normalized);
    if (urls.length > limit) {
      throw new UrlExtractError(`At most ${limit} URLs can be queued at once.`);
    }
  }

  if (urls.length === 0) {
    throw new UrlExtractError("Provide at least one http:// or https:// URL.");
  }

  return { urls };
}

