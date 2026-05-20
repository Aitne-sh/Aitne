export interface AmazonExtractInput {
  scheme: string;
  host: string;
  path: string;
  url: string;
}

export interface AmazonProductReference {
  asin: string;
  locale: string;
}

const AMAZON_HOST_REGEX =
  /^(?:www\.|smile\.)?amazon\.(com|co\.uk|co\.jp|ca|de|fr|it|es|in|com\.au|com\.br|com\.mx|nl|sg|ae|pl|se)$/i;

const ASIN_PATH_REGEX = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
const ASIN_QUERY_REGEX = /^[A-Z0-9]{10}$/i;
const AWS_CONSOLE_REGEX = /(^|\.)console\.aws\.amazon\.com$/i;

export function extractAmazonReference(
  input: AmazonExtractInput,
): AmazonProductReference | null {
  if (input.scheme !== "https:") return null;
  const host = (input.host || "").toLowerCase();
  if (AWS_CONSOLE_REGEX.test(host)) return null;
  const hostMatch = AMAZON_HOST_REGEX.exec(host);
  if (!hostMatch) return null;
  const locale = hostMatch[1].toLowerCase();
  const pathMatch = ASIN_PATH_REGEX.exec(input.path);
  if (pathMatch) {
    return { asin: pathMatch[1].toUpperCase(), locale };
  }
  // Some Amazon search-result links and Kindle redirects carry the
  // ASIN as a query parameter. Parse defensively so we never throw on
  // a malformed URL.
  try {
    const url = new URL(input.url);
    const candidate = url.searchParams.get("asin");
    if (candidate && ASIN_QUERY_REGEX.test(candidate)) {
      return { asin: candidate.toUpperCase(), locale };
    }
  } catch {
    // ignore — caller already stripped malformed URLs via redactor
  }
  return null;
}
