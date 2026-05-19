/**
 * Mail classifier — provider-agnostic adapter over {@link gmail-classifier}.
 *
 * The design (§10 Phase 7) calls this generalization "additive only": the
 * Gmail-specific pipeline keeps using `gmail-classifier` directly; this
 * module lets downstream code classify a {@link MailMessageSummary} from any
 * provider (Outlook, Yahoo, iCloud) without touching the original file.
 *
 * The adapter maps `MailMessageSummary` → the classifier's `EmailInput`:
 *   - `from` renders as a conventional `Name <addr>` or bare `addr` string,
 *     which is what `extractSenderDomain` expects.
 *   - `snippet` falls back to empty string when null (classifier invariant).
 *   - `body` is left null because `MailMessageSummary` does not carry it;
 *     callers who have fetched the full {@link MailMessage} can pass the
 *     body text explicitly via `classifyMailWithBody`.
 */

import {
  classifyEmail,
  extractTravel,
  processEmailBatch,
  type ClassifiedEmail,
  type EmailCategory,
  type EmailInput,
  type TravelExtraction,
} from "./gmail-classifier.js";
import type {
  MailAddress,
  MailMessage,
  MailMessageSummary,
} from "./mail/provider.js";
import { htmlToPlainText } from "./mail/html-to-plaintext.js";

export type { ClassifiedEmail, EmailCategory, TravelExtraction };

export function formatMailAddress(addr: MailAddress | null | undefined): string | null {
  if (!addr?.email) return null;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

export function toClassifierInput(
  msg: MailMessageSummary,
  body?: string | null,
): EmailInput {
  return {
    messageId: msg.providerMsgId,
    from: formatMailAddress(msg.from),
    subject: msg.subject,
    snippet: msg.snippet ?? "",
    date: msg.receivedAtUtc,
    body: body ?? null,
  };
}

export function classifyMailMessage(
  msg: MailMessageSummary,
  body?: string | null,
): ClassifiedEmail {
  return classifyEmail(toClassifierInput(msg, body));
}

export function extractMailTravel(
  msg: MailMessage,
): TravelExtraction | null {
  // When only HTML is present, feeding it raw to the classifier breaks
  // plaintext pattern matching (tags swallow fields like booking codes
  // and provider names). Strip tags + decode common entities so the
  // HTML-only branch actually classifies.
  const bodyText =
    msg.body.text ??
    (msg.body.html ? htmlToPlainText(msg.body.html) : null);
  const input = toClassifierInput(msg, bodyText);
  const classified = classifyEmail(input);
  return extractTravel(input, classified);
}

export function processMailBatch(
  messages: Iterable<MailMessageSummary>,
): ReturnType<typeof processEmailBatch> {
  const inputs = Array.from(messages, (m) => toClassifierInput(m));
  return processEmailBatch(inputs);
}
