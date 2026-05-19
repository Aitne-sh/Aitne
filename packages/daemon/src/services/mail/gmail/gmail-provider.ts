import type {
  DraftDetail,
  DraftSummary,
  FolderInfo,
  ListQuery,
  MailAccount,
  MailAddress,
  MailMessage,
  MailMessageSummary,
  MailProvider,
  PollCursor,
  PollResult,
  SendInput,
  SendResult,
  TagCatalog,
  ThreadView,
  UpdateDraftInput,
  UpdateDraftResult,
} from "../provider.js";
import { MailNotFoundError } from "../provider.js";
import { htmlToPlainText } from "../html-to-plaintext.js";
import type {
  GmailDraft,
  GmailDraftSummary,
  GmailLabel,
  GmailMessage,
  GmailMessageSummary,
  GmailService,
} from "../../gmail.js";
import {
  normalizeGmailPollCursor,
  seedGmailPollCursor,
  trimGmailProcessedIds,
} from "./poll-cursor.js";

/**
 * Sentinel stored in `mail_accounts.secret_blob_name` for the primary Gmail
 * row backed by shared Google OAuth. The row exists so the unified `/mail/*`
 * surface has an account to bind against, but the credentials themselves
 * continue to live in `SecretBroker` (google credentials.json + oauth token).
 * The registry factory recognizes this sentinel and pulls from the broker
 * rather than from `FileEncryptedBlobStore`.
 */
export const LEGACY_GMAIL_BLOB_SENTINEL = "legacy-google-auth";

const SYSTEM_LABEL_CANONICAL: Record<string, FolderInfo["canonical"]> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  DRAFTS: "drafts",
  TRASH: "trash",
  SPAM: "spam",
};

export interface GmailProviderOptions {
  account: MailAccount;
  service: GmailService;
}

/**
 * Gmail adapter over the existing {@link GmailService}. The credentials still
 * live in SecretBroker / shared Google OAuth, but Gmail now participates in
 * the unified `/mail/:accountId/*` routes and `MailPoller`.
 */
export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;
  readonly account: MailAccount;
  private readonly service: GmailService;

  constructor(opts: GmailProviderOptions) {
    this.account = opts.account;
    this.service = opts.service;
  }

  async list(q: ListQuery): Promise<MailMessageSummary[]> {
    const query = buildGmailQuery(q);
    const summaries = await this.service.listMessages({
      query: query.length > 0 ? query : undefined,
      maxResults: q.limit ?? 20,
    });
    return summaries.map((s) => this.toSummary(s));
  }

  async get(id: string): Promise<MailMessage> {
    const msg = await this.service.getMessage(id);
    if (!msg) {
      throw new MailNotFoundError("gmail", "message", id);
    }
    const attachments = await this.service.listAllAttachments(id).catch(() => []);
    return this.toFull(msg, attachments);
  }

  async send(input: SendInput): Promise<SendResult> {
    const params = {
      to: input.to.join(", "),
      cc: input.cc?.join(", ") || undefined,
      bcc: input.bcc?.join(", ") || undefined,
      subject: input.subject,
      body: input.textBody ?? htmlToPlainText(input.htmlBody ?? ""),
      htmlBody: input.htmlBody,
      threadId: input.reply?.providerThreadId || undefined,
      inReplyTo: input.reply?.inReplyToRfc822Id || undefined,
      references: input.reply?.references.join(" ") || undefined,
    };
    if (input.draftOnly !== false) {
      const { draftId } = await this.service.createDraft(params);
      return { id: draftId, isDraft: true };
    }
    const { messageId, threadId } = await this.service.sendMessage(params);
    return {
      id: messageId,
      isDraft: false,
      threadId: threadId.length > 0 ? threadId : undefined,
    };
  }

  async modifyTags(id: string, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    await this.service.modifyLabels(id, add, remove);
  }

  async markRead(id: string, read: boolean): Promise<void> {
    if (read) {
      await this.service.modifyLabels(id, [], ["UNREAD"]);
    } else {
      await this.service.modifyLabels(id, ["UNREAD"], []);
    }
  }

  async trash(id: string): Promise<void> {
    await this.service.trashMessage(id);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const attachment = await this.service.getAttachment(messageId, attachmentId);
    if (!attachment) return null;
    // Gmail's attachments.get endpoint returns only bytes — MIME type lives
    // on the parent message's payload parts, separate from the attachment
    // response. Callers that need the authoritative mime_type (the receipts
    // route, notably) already persisted it at detection time and use the
    // DB value. We return a safe default here to avoid an extra listAll
    // round trip per download.
    return { data: attachment.data, mimeType: "application/octet-stream" };
  }

  async listFolders(): Promise<FolderInfo[]> {
    const labels = await this.service.listLabels();
    return labels
      .filter((l) => l.type === "system")
      .map((l) => toFolderInfo(l));
  }

  async pollSince(
    cursor: PollCursor | null,
    limit: number,
  ): Promise<PollResult> {
    if (!cursor) {
      const profile = await this.service.getMailboxProfile().catch(() => null);
      return {
        messages: [],
        removedIds: [],
        nextCursor: seedGmailPollCursor(new Date(), profile?.historyId),
        drained: true,
      };
    }

    const current = normalizeGmailPollCursor(cursor);
    let removedIds: string[] = [];
    let historyId = current.historyId;

    if (historyId) {
      const history = await this.service.listHistoryPage({
        startHistoryId: historyId,
        maxResults: limit,
        pageToken: current.historyPageToken,
      });
      removedIds = history.removedIds;
      if (history.nextPageToken) {
        return {
          messages: [],
          removedIds,
          nextCursor: {
            kind: "gmail",
            lastEpoch: current.lastEpoch,
            historyId,
            processedIds: current.processedIds ?? [],
            nextPageToken: current.nextPageToken,
            historyPageToken: history.nextPageToken,
          },
          drained: false,
        };
      }
      historyId = history.historyId ?? historyId;
    }

    const page = await this.service.searchMessagesPage({
      query: `after:${current.lastEpoch}`,
      maxResults: limit,
      pageToken: current.nextPageToken,
    });
    const processedIds = current.processedIds ?? [];
    const processedSet = new Set(processedIds);
    const fresh = page.messages.filter((message) => !processedSet.has(message.id));
    const nextProcessedIds = trimGmailProcessedIds([
      ...processedIds,
      ...fresh.map((message) => message.id),
    ]);
    const drained = page.nextPageToken == null;
    if (drained && !historyId) {
      const profile = await this.service.getMailboxProfile().catch(() => null);
      historyId = profile?.historyId ?? undefined;
    }
    const nextCursor: PollCursor = drained
      ? {
          kind: "gmail",
          lastEpoch: Math.floor(Date.now() / 1000),
          historyId,
          processedIds: nextProcessedIds,
        }
      : {
          kind: "gmail",
          lastEpoch: current.lastEpoch,
          historyId,
          processedIds: nextProcessedIds,
          nextPageToken: page.nextPageToken ?? undefined,
        };

    return {
      messages: fresh.map((message) => this.toSummary(message)),
      removedIds,
      nextCursor,
      drained,
    };
  }

  async revoke(): Promise<void> {
    // Legacy Gmail tokens live in SecretBroker, not FileEncryptedBlobStore.
    // Revocation is an out-of-band user action via the dashboard's existing
    // Google disconnect flow; the unified adapter does not own the credential
    // lifecycle for this row.
  }

  async untrash(id: string): Promise<void> {
    await this.service.untrashMessage(id);
  }

  async archive(id: string): Promise<void> {
    // Gmail: "archive" means removing the INBOX label. A trashed message
    // cannot be archived — the caller should untrash first if needed.
    await this.service.modifyLabels(id, [], ["INBOX"]);
  }

  async listTags(): Promise<TagCatalog> {
    // Gmail's `users.messages.modify` takes label IDs, not display names. For
    // system labels id == name (INBOX, UNREAD, STARRED, …) so either works,
    // but for user-defined labels the id is `Label_1234` and the name is the
    // user-chosen string. Returning names here would let the agent chain
    // `listTags → modifyTags` and silently no-op on user labels. Return ids
    // on both sides so the round-trip is correct.
    const labels = await this.service.listLabels();
    const system: string[] = [];
    const userDefined: string[] = [];
    for (const l of labels) {
      if (l.type === "system") system.push(l.id);
      else userDefined.push(l.id);
    }
    return { system, userDefined };
  }

  async getThread(threadId: string, limit?: number): Promise<ThreadView> {
    const thread = await this.service.getThread(threadId, {
      maxMessages: limit ?? 25,
    });
    if (!thread) {
      throw new MailNotFoundError("gmail", "thread", threadId);
    }
    return {
      threadId: thread.id,
      messages: thread.messages.map((m) => this.toFull(m)),
      status: "full",
    };
  }

  async listDrafts(limit?: number): Promise<DraftSummary[]> {
    const drafts = await this.service.listDrafts({ maxResults: limit });
    return drafts.map((d) => toDraftSummary(d));
  }

  async getDraft(draftId: string): Promise<DraftDetail | null> {
    const draft = await this.service.getDraft(draftId);
    if (!draft) return null;
    return toDraftDetail(draft);
  }

  async createDraft(input: SendInput): Promise<{ id: string }> {
    const params = {
      to: input.to.join(", "),
      cc: input.cc?.join(", ") || undefined,
      bcc: input.bcc?.join(", ") || undefined,
      subject: input.subject,
      body: input.textBody ?? htmlToPlainText(input.htmlBody ?? ""),
      htmlBody: input.htmlBody,
      threadId: input.reply?.providerThreadId || undefined,
      inReplyTo: input.reply?.inReplyToRfc822Id || undefined,
      references: input.reply?.references.join(" ") || undefined,
    };
    const { draftId } = await this.service.createDraft(params);
    return { id: draftId };
  }

  async updateDraft(
    draftId: string,
    input: UpdateDraftInput,
  ): Promise<UpdateDraftResult> {
    // `reply === null` clears threading; `undefined` leaves it intact. We
    // translate to GmailService.updateDraft's undefined|null|string
    // tri-state the same way.
    let inReplyTo: string | null | undefined;
    let references: string | null | undefined;
    let threadId: string | undefined;
    if (input.reply === null) {
      inReplyTo = null;
      references = null;
    } else if (input.reply !== undefined) {
      inReplyTo = input.reply.inReplyToRfc822Id;
      references = input.reply.references.join(" ");
      threadId = input.reply.providerThreadId;
    }

    const params = {
      to: input.to ? input.to.join(", ") : undefined,
      cc: input.cc ? input.cc.join(", ") : undefined,
      bcc: input.bcc ? input.bcc.join(", ") : undefined,
      subject: input.subject,
      body:
        input.textBody !== undefined
          ? input.textBody
          : input.htmlBody !== undefined
            ? htmlToPlainText(input.htmlBody)
            : undefined,
      inReplyTo,
      references,
      threadId,
    };
    const { draftId: updatedId } = await this.service.updateDraft(draftId, params);
    // Gmail update is atomic — the draft id is preserved. `previousId` is
    // only set on providers with non-atomic updates (IMAP).
    return { id: updatedId };
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.service.deleteDraft(draftId);
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId?: string }> {
    const { messageId, threadId } = await this.service.sendDraft(draftId);
    return { id: messageId, threadId: threadId || undefined };
  }

  getLegacyService(): GmailService {
    return this.service;
  }

  private toSummary(s: GmailMessageSummary): MailMessageSummary {
    return {
      accountId: this.account.id,
      providerMsgId: s.id,
      rfc822MsgId: s.messageIdHeader,
      threadId: s.threadId || null,
      folder: inferFolderFromLabels(s.labelIds),
      receivedAtUtc: normalizeDate(s.date),
      subject: s.subject,
      from: parseAddress(s.from),
      to: parseAddressList(s.to),
      snippet: s.snippet,
      isRead: !s.labelIds.includes("UNREAD"),
      flags: s.labelIds,
      // Gmail metadata-mode doesn't expose attachment structure; leaving
      // undefined is honest (`hasAttachment?: boolean` — undefined = unknown).
      // `get(id)` walks the payload parts when certainty is needed.
      hasAttachment: undefined,
    };
  }

  private toFull(
    m: GmailMessage,
    attachments: Array<{
      attachmentId: string;
      filename: string;
      mimeType: string;
      size: number;
    }> = [],
  ): MailMessage {
    const summary = this.toSummary({
      id: m.id,
      threadId: m.threadId,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      date: m.date,
      snippet: m.snippet,
      labelIds: m.labelIds,
      messageIdHeader: m.messageIdHeader,
    });
    return {
      ...summary,
      hasAttachment: m.hasAttachment,
      body: {
        text: m.body ?? undefined,
        html: m.html ?? undefined,
      },
      attachments: attachments.map((attachment) => ({
        id: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.size,
      })),
    };
  }
}

function buildGmailQuery(q: ListQuery): string {
  const parts: string[] = [];
  if (q.q && q.q.trim().length > 0) parts.push(q.q.trim());
  if (q.unreadOnly) parts.push("is:unread");
  if (q.since) {
    const ts = Math.floor(new Date(q.since).getTime() / 1000);
    if (Number.isFinite(ts) && ts > 0) parts.push(`after:${ts}`);
  }
  const folder = q.folder?.toLowerCase();
  if (folder && folder !== "inbox") {
    parts.push(`in:${folder}`);
  } else if (!folder) {
    parts.push("in:inbox");
  } else {
    parts.push("in:inbox");
  }
  return parts.join(" ");
}

function toFolderInfo(label: GmailLabel): FolderInfo {
  return {
    id: label.id,
    name: label.name,
    canonical: SYSTEM_LABEL_CANONICAL[label.id.toUpperCase()],
    unread: 0,
  };
}

function inferFolderFromLabels(labelIds: string[]): string {
  for (const l of labelIds) {
    const canonical = SYSTEM_LABEL_CANONICAL[l.toUpperCase()];
    if (canonical) return l;
  }
  return "INBOX";
}

function normalizeDate(raw: string | null): string {
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function parseAddress(raw: string | null): MailAddress {
  if (!raw) return { email: "" };
  const match = raw.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { email: raw.trim() };
}

function parseAddressList(raw: string | null): MailAddress[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => parseAddress(p))
    .filter((a) => a.email.length > 0);
}

function toDraftSummary(d: GmailDraftSummary): DraftSummary {
  return {
    draftId: d.draftId,
    threadId: d.threadId || undefined,
    subject: d.subject,
    to: d.to,
    snippet: d.snippet,
  };
}

function toDraftDetail(d: GmailDraft): DraftDetail {
  return {
    draftId: d.draftId,
    threadId: d.threadId || undefined,
    subject: d.subject,
    from: d.from,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    snippet: d.snippet,
    body: d.body,
    rfc822MsgId: d.messageIdHeader,
    references: d.references,
  };
}
