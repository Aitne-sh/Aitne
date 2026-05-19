import { randomUUID } from "node:crypto";
import { createLogger } from "../logging.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import {
  getGoogleOAuthClientConfig,
  mergeGoogleTokenPayload,
  parseGoogleCredentialsJson,
} from "./google-auth.js";

const logger = createLogger("gmail-service");

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  date: string | null;
  snippet: string;
  body: string | null;
  html: string | null;
  labelIds: string[];
  messageIdHeader: string | null;
  references: string | null;
  /** True when the payload tree contains a part with `body.attachmentId`,
   *  regardless of MIME type. Only meaningful on full-format responses; the
   *  metadata-mode summary path does not populate this. */
  hasAttachment: boolean;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  date: string | null;
  snippet: string;
  labelIds: string[];
  /** Set when the summary fetch requested the Message-ID header. Null when
   *  the call used the lean metadataHeaders list for cost reasons. */
  messageIdHeader: string | null;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
}

export interface SendMessageParams {
  to: string;
  subject: string;
  /** Plain-text body. When {@link htmlBody} is also set the message is
   *  encoded as multipart/alternative; otherwise text/plain-only. */
  body: string;
  /** Optional HTML body. When set, emitted alongside {@link body} in a
   *  multipart/alternative envelope so recipients see the rich version by
   *  default while fallback clients still get the plain part. */
  htmlBody?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export interface GmailDraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  subject: string | null;
  to: string | null;
  snippet: string;
}

export interface GmailDraft {
  draftId: string;
  messageId: string;
  threadId: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  date: string | null;
  snippet: string;
  body: string | null;
  messageIdHeader: string | null;
  references: string | null;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

export interface UpdateDraftParams {
  to?: string;
  subject?: string;
  body?: string;
  cc?: string | null;
  bcc?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  threadId?: string;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

interface RawMessageParams {
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}

/** Check if a googleapis error is a 404 Not Found. */
function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string | number }).code;
  const status = (err as { response?: { status?: number } }).response?.status;
  // GaxiosError: code can be string "404" or number 404
  return code == 404 || status === 404;
}

/** Build RFC 2822 raw message and return as base64url string.
 *  When `htmlBody` is present, emits multipart/alternative with plain-text
 *  and HTML parts so recipients see rich content while fallback clients
 *  still get the plain variant. */
function buildRawMessage(params: RawMessageParams): string {
  const baseHeaders = [
    `To: ${sanitizeHeader(params.to)}`,
    `Subject: ${sanitizeHeader(params.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (params.cc) baseHeaders.push(`Cc: ${sanitizeHeader(params.cc)}`);
  if (params.bcc) baseHeaders.push(`Bcc: ${sanitizeHeader(params.bcc)}`);
  if (params.inReplyTo)
    baseHeaders.push(`In-Reply-To: ${sanitizeHeader(params.inReplyTo)}`);
  if (params.references)
    baseHeaders.push(`References: ${sanitizeHeader(params.references)}`);

  const rawBody = params.htmlBody
    ? buildMultipartAlternative(params.body, params.htmlBody)
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${params.body}`;
  const raw = `${baseHeaders.join("\r\n")}\r\n${rawBody}`;
  return Buffer.from(raw).toString("base64url");
}

function buildMultipartAlternative(textBody: string, htmlBody: string): string {
  // 24-byte random boundary — RFC 2046 §5.1.1 requires uniqueness within
  // the message, which is trivially satisfied by crypto-random bytes. No
  // need to scan the body for collisions at this length.
  const boundary = `=_pa_${randomUUID().replace(/-/g, "")}`;
  const parts = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    textBody,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    `--${boundary}--`,
    "",
  ];
  return parts.join("\r\n");
}

export interface GmailAttachmentMetadata {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailAttachmentData {
  data: Buffer;
  size: number;
}

export interface GmailMessagePage {
  messages: GmailMessageSummary[];
  nextPageToken: string | null;
}

export interface GmailMailboxProfile {
  emailAddress: string | null;
  historyId: string | null;
}

export interface GmailHistoryPage {
  removedIds: string[];
  nextPageToken: string | null;
  historyId: string | null;
}

export class GmailService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private gmail: any = null;

  constructor(private readonly secretBroker: SecretBroker) {}

  get available(): boolean {
    return this.gmail !== null;
  }

  async init(): Promise<void> {
    const credentialsRaw = await this.secretBroker.getGoogleCredentialsJson();
    if (!credentialsRaw) {
      logger.warn("Gmail credentials not configured");
      return;
    }

    const credentials = parseGoogleCredentialsJson(credentialsRaw);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let google: any;
    try {
      const mod = await import("googleapis" as string);
      google = mod.google;
    } catch {
      throw new Error(
        "googleapis package not installed. Run: pnpm --filter @aitne/daemon add googleapis",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let auth: any;

    if (credentials.type === "service_account") {
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      });
    } else {
      const tokenRaw = await this.secretBroker.getGoogleTokenJson();
      if (!tokenRaw) {
        throw new Error("OAuth2 credentials require authorization. Click 'Authorize' in the dashboard.");
      }
      const token = JSON.parse(tokenRaw) as Record<string, unknown>;
      const clientConfig = getGoogleOAuthClientConfig(credentials);
      if (!clientConfig) throw new Error("Invalid Google credentials format");

      auth = new google.auth.OAuth2(
        clientConfig.client_id,
        clientConfig.client_secret,
        clientConfig.redirect_uris?.[0],
      );
      auth.setCredentials(token);
      auth.on("tokens", async (tokens: Record<string, unknown>) => {
        try {
          const existingRaw = await this.secretBroker.getGoogleTokenJson();
          const merged = mergeGoogleTokenPayload(existingRaw, tokens);
          await this.secretBroker.saveGoogleTokenJson(merged);
        } catch (error) {
          logger.error({ err: error }, "Failed to persist refreshed Gmail token");
        }
      });
    }

    this.gmail = google.gmail({ version: "v1", auth });
    logger.info("Gmail service initialized");
  }

  async listMessages(options: {
    query?: string;
    maxResults?: number;
    labelIds?: string[];
  } = {}): Promise<GmailMessageSummary[]> {
    const page = await this.searchMessagesPage(options);
    return page.messages;
  }

  async searchMessagesPage(options: {
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  } = {}): Promise<GmailMessagePage> {
    if (!this.gmail) {
      return { messages: [], nextPageToken: null };
    }

    const params: Record<string, unknown> = {
      userId: "me",
      maxResults: options.maxResults ?? 20,
    };
    if (options.query) params.q = options.query;
    if (options.labelIds?.length) params.labelIds = options.labelIds;
    if (options.pageToken) params.pageToken = options.pageToken;

    const listRes = await this.gmail.users.messages.list(params);
    const messageRefs = listRes.data.messages ?? [];

    const messages = await Promise.all(
      messageRefs.slice(0, params.maxResults as number).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (ref: any) => {
          const msg = await this.gmail.users.messages.get({
            userId: "me",
            id: ref.id,
            format: "metadata",
            metadataHeaders: [
              "Subject",
              "From",
              "To",
              "Cc",
              "Date",
              "Message-ID",
            ],
          });
          return this.parseMessageSummary(msg.data);
        },
      ),
    );

    return {
      messages,
      nextPageToken:
        typeof listRes.data.nextPageToken === "string"
          ? listRes.data.nextPageToken
          : null,
    };
  }

  async listHistoryPage(options: {
    startHistoryId: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<GmailHistoryPage> {
    if (!this.gmail) {
      return { removedIds: [], nextPageToken: null, historyId: null };
    }

    const params: Record<string, unknown> = {
      userId: "me",
      startHistoryId: options.startHistoryId,
      maxResults: options.maxResults ?? 20,
      historyTypes: ["messageDeleted"],
    };
    if (options.pageToken) params.pageToken = options.pageToken;

    try {
      const res = await this.gmail.users.history.list(params);
      const removedIds = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const history = (res.data.history ?? []) as any[];
      for (const item of history) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const deleted = (item?.messagesDeleted ?? []) as any[];
        for (const entry of deleted) {
          const id = entry?.message?.id;
          if (typeof id === "string" && id.length > 0) {
            removedIds.add(id);
          }
        }
      }
      return {
        removedIds: [...removedIds],
        nextPageToken:
          typeof res.data.nextPageToken === "string"
            ? res.data.nextPageToken
            : null,
        historyId:
          typeof res.data.historyId === "string" ? res.data.historyId : null,
      };
    } catch (err: unknown) {
      if (!isNotFoundError(err)) throw err;
      const profile = await this.getMailboxProfile();
      return {
        removedIds: [],
        nextPageToken: null,
        historyId: profile?.historyId ?? null,
      };
    }
  }

  async getMessage(messageId: string): Promise<GmailMessage | null> {
    if (!this.gmail) return null;

    let res;
    try {
      res = await this.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }

    return this.parseFullMessage(res.data);
  }

  async sendMessage(params: SendMessageParams): Promise<{ messageId: string; threadId: string }> {
    if (!this.gmail) throw new Error("Gmail service not initialized");

    const raw = buildRawMessage(params);

    const sendParams: Record<string, unknown> = {
      userId: "me",
      requestBody: { raw },
    };
    if (params.threadId) {
      (sendParams.requestBody as Record<string, unknown>).threadId = params.threadId;
    }

    const res = await this.gmail.users.messages.send(sendParams);
    return {
      messageId: res.data.id ?? "",
      threadId: res.data.threadId ?? "",
    };
  }

  async createDraft(params: SendMessageParams): Promise<{ draftId: string }> {
    if (!this.gmail) throw new Error("Gmail service not initialized");

    const raw = buildRawMessage(params);

    const draftParams: Record<string, unknown> = {
      userId: "me",
      requestBody: {
        message: { raw },
      },
    };
    if (params.threadId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (draftParams.requestBody as any).message.threadId = params.threadId;
    }

    const res = await this.gmail.users.drafts.create(draftParams);
    return { draftId: res.data.id ?? "" };
  }

  // ── Draft CRUD ──

  async listDrafts(options: { maxResults?: number } = {}): Promise<GmailDraftSummary[]> {
    if (!this.gmail) return [];
    const max = options.maxResults ?? 20;

    const res = await this.gmail.users.drafts.list({
      userId: "me",
      maxResults: max,
    });
    const drafts = res.data.drafts ?? [];

    const summaries = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      drafts.slice(0, max).map(async (d: any) => {
        try {
          const detail = await this.gmail.users.drafts.get({
            userId: "me",
            id: d.id,
            format: "metadata",
            metadataHeaders: ["Subject", "To"],
          });
          const msg = detail.data.message;
          const headers = msg?.payload?.headers ?? [];
          return {
            draftId: d.id ?? "",
            messageId: msg?.id ?? "",
            threadId: msg?.threadId ?? "",
            subject: this.getHeader(headers, "Subject"),
            to: this.getHeader(headers, "To"),
            snippet: msg?.snippet ?? "",
          };
        } catch {
          return {
            draftId: d.id ?? "",
            messageId: d.message?.id ?? "",
            threadId: d.message?.threadId ?? "",
            subject: null,
            to: null,
            snippet: "",
          };
        }
      }),
    );

    return summaries;
  }

  async getDraft(draftId: string): Promise<GmailDraft | null> {
    if (!this.gmail) return null;

    let res;
    try {
      res = await this.gmail.users.drafts.get({
        userId: "me",
        id: draftId,
        format: "full",
      });
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
    const msg = res.data.message;
    if (!msg) return null;
    const headers = msg.payload?.headers ?? [];
    return {
      draftId: res.data.id ?? "",
      messageId: msg.id ?? "",
      threadId: msg.threadId ?? "",
      subject: this.getHeader(headers, "Subject"),
      from: this.getHeader(headers, "From"),
      to: this.getHeader(headers, "To"),
      cc: this.getHeader(headers, "Cc"),
      bcc: this.getHeader(headers, "Bcc"),
      date: this.getHeader(headers, "Date"),
      snippet: msg.snippet ?? "",
      body: this.extractBody(msg.payload),
      messageIdHeader: this.getHeader(headers, "Message-ID"),
      references: this.getHeader(headers, "References"),
    };
  }

  async updateDraft(draftId: string, params: UpdateDraftParams): Promise<{ draftId: string }> {
    if (!this.gmail) throw new Error("Gmail service not initialized");

    const existing = await this.getDraft(draftId);
    if (!existing) throw new Error(`Draft ${draftId} not found`);

    // undefined = keep existing, null = clear, string = new value
    const resolve = <T>(incoming: T | null | undefined, current: T | null): T | undefined => {
      if (incoming === undefined) return current ?? undefined;
      if (incoming === null) return undefined;
      return incoming;
    };

    const merged = {
      to: params.to ?? existing.to ?? "",
      subject: params.subject ?? existing.subject ?? "",
      body: params.body ?? existing.body ?? "",
      cc: resolve(params.cc, existing.cc),
      bcc: resolve(params.bcc, existing.bcc),
      inReplyTo: resolve(params.inReplyTo, existing.messageIdHeader),
      references: resolve(params.references, existing.references),
      threadId: params.threadId ?? existing.threadId ?? undefined,
    };

    const raw = buildRawMessage(merged);

    const updateReq: Record<string, unknown> = {
      userId: "me",
      id: draftId,
      requestBody: { message: { raw } },
    };
    if (merged.threadId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (updateReq.requestBody as any).message.threadId = merged.threadId;
    }

    const res = await this.gmail.users.drafts.update(updateReq);
    return { draftId: res.data.id ?? "" };
  }

  async deleteDraft(draftId: string): Promise<void> {
    if (!this.gmail) throw new Error("Gmail service not initialized");
    await this.gmail.users.drafts.delete({ userId: "me", id: draftId });
  }

  async sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }> {
    if (!this.gmail) throw new Error("Gmail service not initialized");
    const res = await this.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });
    return {
      messageId: res.data.id ?? "",
      threadId: res.data.threadId ?? "",
    };
  }

  // ── Threads ──

  async getThread(
    threadId: string,
    options: { maxMessages?: number; format?: "full" | "metadata" } = {},
  ): Promise<GmailThread | null> {
    if (!this.gmail) return null;
    const format = options.format ?? "full";

    let res;
    try {
      res = await this.gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format,
      });
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messages = (res.data.messages ?? []).map((m: any) => this.parseFullMessage(m));

    const max = options.maxMessages;
    if (max && messages.length > max) {
      messages = messages.slice(-max);
    }

    return { id: res.data.id ?? "", messages };
  }

  // ── Attachment operations (Phase B — F-04 receipt organization) ──

  /**
   * List attachment metadata for a message without downloading content.
   * Returns only attachments with recognized receipt MIME types (PDF, images).
   */
  async listAttachments(messageId: string): Promise<GmailAttachmentMetadata[]> {
    return this.listAttachmentMetadata(messageId, {
      allowedMimeTypes: new Set([
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
      ]),
    });
  }

  async listAllAttachments(messageId: string): Promise<GmailAttachmentMetadata[]> {
    return this.listAttachmentMetadata(messageId);
  }

  private async listAttachmentMetadata(
    messageId: string,
    options?: { allowedMimeTypes?: ReadonlySet<string> },
  ): Promise<GmailAttachmentMetadata[]> {
    if (!this.gmail) return [];

    let res;
    try {
      res = await this.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
        // Only fetch payload structure, not body content
        fields: "payload",
      });
    } catch (err: unknown) {
      if (isNotFoundError(err)) return [];
      throw err;
    }

    return this.extractAttachmentMetadata(
      res.data.payload,
      options?.allowedMimeTypes,
    );
  }

  /**
   * Download a specific attachment by message ID and attachment ID.
   * Returns the raw binary data.
   */
  async getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachmentData | null> {
    if (!this.gmail) return null;

    try {
      const res = await this.gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });

      const data = res.data.data;
      if (!data) return null;

      // Gmail returns base64url-encoded data
      const buffer = Buffer.from(data, "base64url");
      return { data: buffer, size: res.data.size ?? buffer.length };
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  private extractAttachmentMetadata(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any,
    allowedMimeTypes?: ReadonlySet<string>,
  ): GmailAttachmentMetadata[] {
    const attachments: GmailAttachmentMetadata[] = [];
    if (!payload) return attachments;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (parts: any[]): void => {
      for (const part of parts) {
        if (
          part.body?.attachmentId &&
          part.filename &&
          (!allowedMimeTypes || allowedMimeTypes.has(part.mimeType))
        ) {
          attachments.push({
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size ?? 0,
          });
        }
        if (part.parts) walk(part.parts);
      }
    };

    if (payload.parts) walk(payload.parts);
    return attachments;
  }

  // ── Label operations (Phase 2) ──

  async modifyLabels(
    messageId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    if (!this.gmail) throw new Error("Gmail service not initialized");
    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
  }

  async trashMessage(messageId: string): Promise<void> {
    if (!this.gmail) throw new Error("Gmail service not initialized");
    await this.gmail.users.messages.trash({ userId: "me", id: messageId });
  }

  async untrashMessage(messageId: string): Promise<void> {
    if (!this.gmail) throw new Error("Gmail service not initialized");
    await this.gmail.users.messages.untrash({ userId: "me", id: messageId });
  }

  // ── Reply helpers ──

  private buildReplyHeaders(lastMessage: GmailMessage): { inReplyTo: string; references: string } | null {
    const msgId = lastMessage.messageIdHeader;
    if (!msgId) return null;

    const existingRefs = lastMessage.references;
    const references = existingRefs
      ? `${existingRefs} ${msgId}`
      : msgId;

    return { inReplyTo: msgId, references };
  }

  /**
   * Return the authenticated mailbox email address. Used to populate the
   * shared-Google-OAuth Gmail row in `mail_accounts`.
   */
  async getEmailAddress(): Promise<string | null> {
    const profile = await this.getMailboxProfile();
    return profile?.emailAddress ?? null;
  }

  async getMailboxProfile(): Promise<GmailMailboxProfile | null> {
    if (!this.gmail) return null;
    const res = await this.gmail.users.getProfile({ userId: "me" });
    return {
      emailAddress:
        (res.data.emailAddress as string | undefined) ?? null,
      historyId: typeof res.data.historyId === "string" ? res.data.historyId : null,
    };
  }

  async listLabels(): Promise<GmailLabel[]> {
    if (!this.gmail) return [];
    const res = await this.gmail.users.labels.list({ userId: "me" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (res.data.labels ?? []).map((l: any) => ({
      id: l.id ?? "",
      name: l.name ?? "",
      type: l.type ?? "",
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseMessageSummary(data: any): GmailMessageSummary {
    const headers = data.payload?.headers ?? [];
    return {
      id: data.id ?? "",
      threadId: data.threadId ?? "",
      subject: this.getHeader(headers, "Subject"),
      from: this.getHeader(headers, "From"),
      to: this.getHeader(headers, "To"),
      cc: this.getHeader(headers, "Cc"),
      date: this.getHeader(headers, "Date"),
      snippet: data.snippet ?? "",
      labelIds: data.labelIds ?? [],
      messageIdHeader: this.getHeader(headers, "Message-ID"),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseFullMessage(data: any): GmailMessage {
    const headers = data.payload?.headers ?? [];
    return {
      id: data.id ?? "",
      threadId: data.threadId ?? "",
      subject: this.getHeader(headers, "Subject"),
      from: this.getHeader(headers, "From"),
      to: this.getHeader(headers, "To"),
      cc: this.getHeader(headers, "Cc"),
      date: this.getHeader(headers, "Date"),
      snippet: data.snippet ?? "",
      body: this.extractBody(data.payload),
      html: this.extractHtmlBody(data.payload),
      labelIds: data.labelIds ?? [],
      messageIdHeader: this.getHeader(headers, "Message-ID"),
      references: this.getHeader(headers, "References"),
      hasAttachment: hasAnyAttachment(data.payload),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getHeader(headers: any[], name: string): string | null {
    const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
    return header?.value ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractBody(payload: any): string | null {
    if (!payload) return null;
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractHtmlBody(payload: any): string | null {
    if (!payload) return null;
    if (payload.mimeType === "text/html" && payload.body?.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf-8");
    }
    const stack: unknown[] = payload.parts ? [...payload.parts] : [];
    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const part = stack.shift() as any;
      if (part?.mimeType === "text/html" && part?.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part?.parts) stack.push(...part.parts);
    }
    return null;
  }
}

/**
 * Walk the Gmail payload tree returning true if any descendant carries an
 * `attachmentId` — which identifies a binary attachment in Gmail's model,
 * regardless of MIME type. Used by full-format parse so callers get accurate
 * `hasAttachment` on MailMessage. Metadata-mode lists don't exercise this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasAnyAttachment(payload: any): boolean {
  if (!payload) return false;
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = stack.shift() as any;
    if (node?.body?.attachmentId) return true;
    if (node?.parts) stack.push(...node.parts);
  }
  return false;
}
