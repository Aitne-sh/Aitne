import type {
  MailMessage,
  ThreadView,
} from "../../../services/mail/provider.js";
import {
  extractMailHtmlBody,
  renderExtractedMailHtmlBody,
  type ExtractedMailHtmlImage,
  type ExtractedMailHtmlLink,
} from "../../../services/mail/html-to-plaintext.js";

export const MAIL_BODY_CHUNK_DEFAULT_CHARS = 12_000;
export const MAIL_BODY_CHUNK_MAX_CHARS = 50_000;
export const MAIL_BODY_METADATA_DEFAULT_LIMIT = 100;
export const MAIL_BODY_METADATA_MAX_LIMIT = 500;

export type MailBodyFormat = "extracted" | "raw";
export type MailBodySource = "html" | "text" | "empty";
export type MailBodyMode = "full" | "none";

export function buildMailBodyResponse(input: {
  accountId: string;
  message: MailMessage;
  format: MailBodyFormat;
  chunk: number;
  maxChars: number;
  metadataOffset: number;
  metadataLimit: number;
}) {
  const { message, format, chunk, maxChars, metadataOffset, metadataLimit } =
    input;
  const resolved = resolveMailBody(message, format);
  const totalChars = resolved.content.length;
  const start = chunk * maxChars;
  const end = start + maxChars;
  const content = start < totalChars ? resolved.content.slice(start, end) : "";
  const hasMore = end < totalChars;
  const links = resolved.links.slice(metadataOffset, metadataOffset + metadataLimit);
  const images = resolved.images.slice(metadataOffset, metadataOffset + metadataLimit);
  const linksHasMore = metadataOffset + metadataLimit < resolved.links.length;
  const imagesHasMore = metadataOffset + metadataLimit < resolved.images.length;
  return {
    accountId: input.accountId,
    providerMsgId: message.providerMsgId,
    rfc822MsgId: message.rfc822MsgId,
    threadId: message.threadId,
    subject: message.subject,
    format,
    source: resolved.source,
    content,
    chunk,
    maxChars,
    totalChars,
    hasMore,
    nextChunk: hasMore ? chunk + 1 : null,
    rawHtmlAvailable:
      typeof message.body.html === "string" && message.body.html.length > 0,
    rawTextAvailable:
      typeof message.body.text === "string" && message.body.text.length > 0,
    metadataOffset,
    metadataLimit,
    links,
    images,
    linkCount: resolved.links.length,
    imageCount: resolved.images.length,
    linksHasMore,
    imagesHasMore,
    nextMetadataOffset:
      linksHasMore || imagesHasMore ? metadataOffset + metadataLimit : null,
  };
}

function resolveMailBody(
  message: MailMessage,
  format: MailBodyFormat,
): {
  content: string;
  source: MailBodySource;
  links: ExtractedMailHtmlLink[];
  images: ExtractedMailHtmlImage[];
} {
  const html = message.body.html;
  const text = message.body.text;
  if (format === "raw") {
    if (html) return { content: html, source: "html", links: [], images: [] };
    if (text) return { content: text, source: "text", links: [], images: [] };
    return { content: "", source: "empty", links: [], images: [] };
  }

  if (html) {
    const extracted = extractMailHtmlBody(html);
    return {
      content: renderExtractedMailHtmlBody(extracted),
      source: "html",
      links: extracted.links,
      images: extracted.images,
    };
  }
  if (text) return { content: text, source: "text", links: [], images: [] };
  return { content: "", source: "empty", links: [], images: [] };
}

export function parseBodyMode(
  raw: string | undefined,
):
  | { ok: true; value: MailBodyMode }
  | { ok: false; body: { error: string; message: string } } {
  if (raw === undefined || raw === "full") return { ok: true, value: "full" };
  if (raw === "none") return { ok: true, value: "none" };
  return {
    ok: false,
    body: { error: "invalid_query", message: "body must be full or none" },
  };
}

export function applyMailMessageBodyMode(
  message: MailMessage,
  mode: MailBodyMode,
): MailMessage {
  if (mode === "full") return message;
  return { ...message, body: {} };
}

export function applyThreadBodyMode(
  thread: ThreadView,
  mode: MailBodyMode,
): ThreadView {
  if (mode === "full") return thread;
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      applyMailMessageBodyMode(message, mode),
    ),
  };
}
