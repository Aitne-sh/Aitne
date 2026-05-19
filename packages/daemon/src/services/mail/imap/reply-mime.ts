export interface ReplyQuoteSource {
  from?: { email: string; name?: string } | null;
  sentAt?: string | Date | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

export interface ReplyBodyInput {
  textBody?: string;
  htmlBody?: string;
  inReplyTo: string;
  references: string[];
  parent: ReplyQuoteSource;
}

export interface BuiltReplyBodies {
  textBody?: string;
  htmlBody?: string;
  references: string[];
}

export function buildReplyBodies(input: ReplyBodyInput): BuiltReplyBodies {
  const references = dedupeReferences([
    ...input.references,
    input.inReplyTo,
  ]);
  const textQuote = buildPlainQuote(input.parent);
  const htmlQuote = buildHtmlQuote(input.parent);

  return {
    textBody:
      input.textBody !== undefined || textQuote !== undefined
        ? `${input.textBody ?? ""}${input.textBody && textQuote ? "\n\n" : ""}${textQuote ?? ""}`.trim()
        : undefined,
    htmlBody:
      input.htmlBody !== undefined || htmlQuote !== undefined
        ? `${input.htmlBody ?? ""}${input.htmlBody && htmlQuote ? "<br><br>" : ""}${htmlQuote ?? ""}`.trim()
        : undefined,
    references,
  };
}

export function dedupeReferences(references: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of references) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function buildPlainQuote(parent: ReplyQuoteSource): string | undefined {
  const body = parent.textBody?.trim() ?? htmlToText(parent.htmlBody);
  if (!body) return undefined;
  return `${replyIntro(parent)}\n${body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")}`;
}

function buildHtmlQuote(parent: ReplyQuoteSource): string | undefined {
  const body = parent.htmlBody?.trim();
  if (body) {
    return `<p>${escapeHtml(replyIntro(parent))}</p><blockquote>${body}</blockquote>`;
  }
  const textBody = parent.textBody?.trim();
  if (!textBody) return undefined;
  return `<p>${escapeHtml(replyIntro(parent))}</p><blockquote><pre>${escapeHtml(textBody)}</pre></blockquote>`;
}

function replyIntro(parent: ReplyQuoteSource): string {
  const author = parent.from?.name || parent.from?.email || "the sender";
  const sentAt = formatReplyDate(parent.sentAt);
  return `On ${sentAt}, ${author} wrote:`;
}

function formatReplyDate(value: string | Date | null | undefined): string {
  if (!value) return "an earlier message";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "an earlier message";
  return date.toUTCString();
}

function htmlToText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

