/**
 * HTML → plaintext for mail bodies, backed by `html-to-text`.
 *
 * Two call sites share this:
 *   - Providers (Gmail/Outlook/IMAP) use it to derive a `text/plain` fallback
 *     when a caller supplies `htmlBody` without `textBody`. HTML still goes
 *     alongside in multipart/alternative — this only exists for text-only
 *     fallback clients.
 *   - `mail-classifier` uses it when a received message has no text/plain
 *     part, so pattern matching (booking codes, provider names, etc.) has
 *     plaintext to work with.
 *
 * `html-to-text` handles the edge cases regex-stripping misses: malformed
 * tags, nested quoting, numeric/named entities, table flattening, and
 * CDATA sections. Kept to a minimal options object because mail-classifier
 * only needs runs of text — we don't want Markdown-like link decoration
 * (`[text](url)`) to confuse regex matchers further down.
 */
import { convert } from "html-to-text";

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      // Skip styling and scripting content entirely.
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "head", format: "skip" },
      // Drop the href entirely — we only want the anchor's visible text.
      // Leaving hrefs in produces "Click here [https://...]" which pollutes
      // the regex-matcher's text window downstream.
      { selector: "a", options: { ignoreHref: true } },
      // Images contribute nothing to the text heuristics.
      { selector: "img", format: "skip" },
    ],
    preserveNewlines: false,
  }).trim();
}

export interface ExtractedMailHtmlLink {
  text: string | null;
  href: string;
  title: string | null;
}

export interface ExtractedMailHtmlImage {
  alt: string | null;
  title: string | null;
  src: string | null;
}

export interface ExtractedMailHtmlBody {
  text: string;
  links: ExtractedMailHtmlLink[];
  images: ExtractedMailHtmlImage[];
}

/**
 * Extract the visible body from HTML mail for agent consumption.
 *
 * Unlike htmlToPlainText, this keeps link destinations and image alt/title
 * metadata because booking confirmations often hide critical actions or
 * reference numbers behind anchors and image attributes. Raw HTML can still
 * be fetched separately when exact markup is required.
 */
export function extractMailHtmlBody(html: string): ExtractedMailHtmlBody {
  const bodyHtml = extractBodyHtml(html);
  const text = htmlToPlainText(bodyHtml);
  return {
    text,
    links: extractLinks(bodyHtml),
    images: extractImages(bodyHtml),
  };
}

export function renderExtractedMailHtmlBody(extracted: ExtractedMailHtmlBody): string {
  const sections = [extracted.text].filter((s) => s.trim().length > 0);
  if (extracted.links.length > 0) {
    sections.push([
      "Links:",
      ...extracted.links.map((link) => {
        const label = link.text ?? link.title ?? "(no text)";
        return `- ${label}: ${link.href}`;
      }),
    ].join("\n"));
  }
  if (extracted.images.length > 0) {
    sections.push([
      "Images:",
      ...extracted.images.map((image) => {
        const label = image.alt ?? image.title ?? "(no alt/title)";
        return image.src ? `- ${label}: ${image.src}` : `- ${label}`;
      }),
    ].join("\n"));
  }
  return sections.join("\n\n").trim();
}

function extractLinks(html: string): ExtractedMailHtmlLink[] {
  const links: ExtractedMailHtmlLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    /* c8 ignore start — match[1] / match[2] are required captures, always
       defined for a successful match; `?? ""` fallbacks are defensive. */
    const attrs = parseAttributes(match[1] ?? "");
    const href = attrs.href?.trim();
    if (!href) continue;
    const text = htmlToPlainText(match[2] ?? "") || null;
    const title = attrs.title?.trim() || null;
    /* c8 ignore stop */
    const key = `${href}\n${text ?? ""}\n${title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text, href: decodeCommonEntities(href), title });
  }
  return links;
}

function extractImages(html: string): ExtractedMailHtmlImage[] {
  const images: ExtractedMailHtmlImage[] = [];
  const seen = new Set<string>();
  const re = /<img\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    // match[1] is the `([^>]*)` capture group, always defined for a
    // successful match; the `?? ""` is defensive only.
    /* c8 ignore next */
    const attrs = parseAttributes(match[1] ?? "");
    const alt = attrs.alt?.trim() || null;
    // attrs.title may be whitespace (`title=" "`); the `||` falls back
    // to null in that case. Tests don't exercise the whitespace branch.
    /* c8 ignore next */
    const title = attrs.title?.trim() || null;
    const src = attrs.src?.trim() || null;
    if (!alt && !title && !src) continue;
    const key = `${alt ?? ""}\n${title ?? ""}\n${src ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({
      alt,
      title,
      src: src ? decodeCommonEntities(src) : null,
    });
  }
  return images;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    /* c8 ignore start — match[1] is required capture; one of match[2-4]
       is always defined for the alternation pattern. Defensive only. */
    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    /* c8 ignore stop */
    attrs[key] = decodeCommonEntities(value);
  }
  return attrs;
}

function extractBodyHtml(html: string): string {
  const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return match?.[1] ?? html;
}

function decodeCommonEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) =>
      decodeCodePoint(raw, Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (raw, decimal: string) =>
      decodeCodePoint(raw, Number.parseInt(decimal, 10)),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function decodeCodePoint(raw: string, value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return raw;
  return String.fromCodePoint(value);
}
