import type {
  AuthenticationResult,
  PublicClientApplication,
} from "@azure/msal-node";
import type {
  DraftDetail,
  DraftSummary,
  FolderInfo,
  ListQuery,
  MailAccount,
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
import {
  GraphClient,
  GraphError,
  type GraphTokenProvider,
} from "./graph-client.js";
import { OutlookGraphCalendarClient } from "../../calendar/outlook/graph-calendar-client.js";
import {
  advanceCursor,
  buildInboxDeltaUrl,
  extractDeltaPage,
  isRemovedItem,
  resolveDeltaUrl,
  type GraphCursor,
} from "./delta-cursor.js";
import { OUTLOOK_SCOPES } from "./client-config.js";
import { translateQueryFilters } from "./query-translator.js";

const SUMMARY_SELECT_FIELDS: readonly string[] = [
  "id",
  "internetMessageId",
  "conversationId",
  "subject",
  "from",
  "toRecipients",
  "receivedDateTime",
  "isRead",
  "hasAttachments",
  "categories",
  "bodyPreview",
];

const FULL_SELECT_FIELDS: readonly string[] = [
  ...SUMMARY_SELECT_FIELDS,
  "body",
  "ccRecipients",
  "bccRecipients",
];

const CANONICAL_FOLDER_MAP: Record<string, FolderInfo["canonical"]> = {
  inbox: "inbox",
  sentitems: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  junkemail: "spam",
};

interface GraphMessageDto {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  bccRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  parentFolderId?: string;
}

interface GraphFolderDto {
  id: string;
  displayName?: string;
  unreadItemCount?: number;
  wellKnownName?: string;
}

interface GraphAttachmentDto {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
}

export interface OutlookProviderOptions {
  account: MailAccount;
  msalApp: PublicClientApplication;
  /**
   * Optional MSAL `homeAccountId`. Used as the primary lookup key into the
   * MSAL token cache when set. If omitted, the provider falls back to looking
   * up by `account.email` (`username`) — safe because each Outlook accountId
   * maps to a per-account encrypted blob containing exactly one MSAL account.
   */
  homeAccountId?: string;
  graphClient?: GraphClient;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  concurrency?: number;
  deltaPageSize?: number;
  /**
   * Account-level AbortSignal from `MailAccountRegistry.getAbortSignal`.
   * Plumbed into {@link GraphClient} so pending fetches are cancelled when
   * the account is removed or deactivated (§3.2). Caller-supplied `init.signal`
   * on individual requests still wins if present.
   */
  abortSignal?: AbortSignal;
}

/**
 * MailProvider implementation for Microsoft Graph (§3.1, §3.11).
 * Two send patterns (§3.1.2):
 *  - Reply: createReply → patch → send (3 calls)
 *  - New:   create → send (2 calls)
 * `draftOnly: true` stops at the create step in either path. NEVER /sendMail.
 */
export class OutlookGraphProvider implements MailProvider {
  readonly kind = "outlook" as const;
  readonly account: MailAccount;
  private readonly msalApp: PublicClientApplication;
  private readonly homeAccountId: string | null;
  private readonly graphClient: GraphClient;
  private readonly deltaPageSize: number;
  private cachedToken: { token: string; expiresOn: Date } | null = null;
  /**
   * Lazy singleton — the calendar surface shares the mail provider's
   * GraphClient (and therefore its concurrency limiter + abortSignal), so
   * repeated `createCalendarClient` calls must hand back the SAME wrapper
   * instead of allocating a fresh one each time. Cleared with the rest of
   * the per-account state when MSAL re-consent flips the token cache.
   */
  private cachedCalendarClient: OutlookGraphCalendarClient | null = null;

  constructor(opts: OutlookProviderOptions) {
    this.account = opts.account;
    this.msalApp = opts.msalApp;
    this.homeAccountId = opts.homeAccountId ?? null;
    this.deltaPageSize = opts.deltaPageSize ?? 50;

    const tokenProvider: GraphTokenProvider = {
      getAccessToken: async () => this.acquireAccessToken(),
      invalidateToken: () => {
        this.cachedToken = null;
      },
    };

    this.graphClient = opts.graphClient ?? new GraphClient({
      tokenProvider,
      concurrency: opts.concurrency,
      fetchImpl: opts.fetchImpl,
      defaultSignal: opts.abortSignal,
    });
  }

  private async acquireAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresOn.getTime() - Date.now() > 60_000) {
      return this.cachedToken.token;
    }
    const accounts = await this.msalApp.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      throw new Error(
        `MSAL cache has no account for ${this.account.email}; re-consent required.`,
      );
    }
    // Per-account blob should hold exactly one MSAL account (§EncryptedBlobCachePlugin).
    // Prefer strict matches by homeAccountId then username; if neither matches
    // but the cache has a single entry, use it (common when username casing drifts
    // across MSAL versions). Reject ambiguous multi-account caches to avoid
    // cross-mailbox misfires (§C6).
    const byHome = this.homeAccountId
      ? accounts.find((a) => a.homeAccountId === this.homeAccountId)
      : null;
    const byUsername = accounts.find((a) => a.username === this.account.email);
    let account = byHome ?? byUsername;
    if (!account) {
      if (accounts.length === 1) {
        account = accounts[0]!;
      } else {
        throw new Error(
          `MSAL cache has ${accounts.length} accounts but none match ${this.account.email} (homeAccountId=${this.homeAccountId ?? "null"}); re-consent required.`,
        );
      }
    }
    const result: AuthenticationResult = await this.msalApp.acquireTokenSilent({
      scopes: [...OUTLOOK_SCOPES],
      account,
    });
    if (!result.accessToken) {
      throw new Error("MSAL acquireTokenSilent returned no accessToken");
    }
    this.cachedToken = {
      token: result.accessToken,
      expiresOn: result.expiresOn ?? new Date(Date.now() + 30 * 60 * 1000),
    };
    return this.cachedToken.token;
  }

  /**
   * SETUP-FLOW-REDESIGN-PLAN §6.1 — share the same MSAL token cache + the
   * mail surface's `GraphClient` with the on-demand Outlook calendar
   * surface. The shared `GraphClient` carries:
   *   - one ConcurrencyLimiter, so mail + calendar combined honour Graph's
   *     4-concurrent / (app, tenant) cap (§3.8) instead of running a
   *     parallel limiter per surface;
   *   - the account-level `abortSignal` from `MailAccountRegistry`, so
   *     `removeAccount` / `setActive(false)` cancels in-flight calendar
   *     fetches the same way it cancels mail fetches.
   *
   * Cached so repeated route hits do not re-allocate the wrapper.
   */
  createCalendarClient(): OutlookGraphCalendarClient {
    if (this.cachedCalendarClient) return this.cachedCalendarClient;
    this.cachedCalendarClient = OutlookGraphCalendarClient.fromGraphClient(this.graphClient);
    return this.cachedCalendarClient;
  }

  async list(q: ListQuery): Promise<MailMessageSummary[]> {
    const folder = q.folder ?? "Inbox";
    const params = new URLSearchParams();
    params.set("$select", SUMMARY_SELECT_FIELDS.join(","));
    params.set("$top", String(Math.min(q.limit ?? 25, 100)));
    params.set("$orderby", "receivedDateTime DESC");

    const filters: string[] = [];
    if (q.unreadOnly) filters.push("isRead eq false");
    if (q.since) filters.push(`receivedDateTime ge ${q.since}`);
    const translated = translateQueryFilters(q.q ?? null);
    if (translated.filters.length > 0) filters.push(...translated.filters);
    if (filters.length > 0) params.set("$filter", filters.join(" and "));
    if (translated.search) params.set("$search", `"${translated.search}"`);

    const url = `/me/mailFolders/${encodeURIComponent(folder)}/messages?${params.toString()}`;
    const response = await this.graphClient.requestJson<{ value: GraphMessageDto[] }>({ url });
    return (response.value ?? []).map((m) => this.toSummary(m, folder));
  }

  async get(id: string): Promise<MailMessage> {
    const params = new URLSearchParams();
    params.set("$select", FULL_SELECT_FIELDS.join(","));
    const message = await this.graphClient.requestJson<GraphMessageDto>({
      url: `/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
    });
    const attachmentsResponse = message.hasAttachments
      ? await this.graphClient.requestJson<{ value: GraphAttachmentDto[] }>({
          url: `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size`,
        })
      : { value: [] };

    const summary = this.toSummary(message, message.parentFolderId ?? "");
    return {
      ...summary,
      body: {
        text: message.body?.contentType === "text" ? message.body.content : undefined,
        html: message.body?.contentType === "html" ? message.body.content : undefined,
      },
      attachments: (attachmentsResponse.value ?? []).map((a) => ({
        id: a.id,
        filename: a.name ?? "",
        mimeType: a.contentType ?? "application/octet-stream",
        sizeBytes: a.size ?? 0,
      })),
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.reply) {
      return this.sendReply(input);
    }
    return this.sendNew(input);
  }

  private async sendNew(input: SendInput): Promise<SendResult> {
    const draftBody = buildGraphMessageBody(input);
    const draft = await this.graphClient.requestJson<GraphMessageDto>({
      url: "/me/messages",
      method: "POST",
      body: draftBody,
    });
    if (input.draftOnly !== false) {
      return {
        id: draft.id,
        isDraft: true,
        rfc822MsgId: draft.internetMessageId ?? undefined,
      };
    }
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(draft.id)}/send`,
      method: "POST",
    });
    return {
      id: draft.id,
      isDraft: false,
      rfc822MsgId: draft.internetMessageId ?? undefined,
    };
  }

  private async sendReply(input: SendInput): Promise<SendResult> {
    const reply = input.reply!;
    const parentId = reply.parentProviderMsgId;
    if (!parentId) {
      throw new Error("Outlook send(reply): reply.parentProviderMsgId is required");
    }
    const draft = await this.graphClient.requestJson<GraphMessageDto>({
      url: `/me/messages/${encodeURIComponent(parentId)}/createReply`,
      method: "POST",
      body: {},
    });
    const patch = buildGraphMessageBody(input, { isReply: true });
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(draft.id)}`,
      method: "PATCH",
      body: patch,
    });
    const rfc822MsgId = draft.internetMessageId ?? undefined;
    if (input.draftOnly !== false) {
      return { id: draft.id, isDraft: true, rfc822MsgId };
    }
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(draft.id)}/send`,
      method: "POST",
    });
    return { id: draft.id, isDraft: false, rfc822MsgId };
  }

  async modifyTags(id: string, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    const message = await this.graphClient.requestJson<GraphMessageDto>({
      url: `/me/messages/${encodeURIComponent(id)}?$select=categories`,
    });
    const current = new Set(message.categories ?? []);
    for (const r of remove) current.delete(r);
    for (const a of add) current.add(a);
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(id)}`,
      method: "PATCH",
      body: { categories: Array.from(current) },
    });
  }

  async markRead(id: string, read: boolean): Promise<void> {
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(id)}`,
      method: "PATCH",
      body: { isRead: read },
    });
  }

  async trash(id: string): Promise<void> {
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(id)}/move`,
      method: "POST",
      body: { destinationId: "deletedItems" },
    });
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    // Graph returns FileAttachment.contentBytes as base64. For ItemAttachment
    // / ReferenceAttachment the shape differs and `contentBytes` is absent —
    // we surface those as "not downloadable" to the caller (null) rather
    // than returning an empty buffer silently.
    try {
      const resp = await this.graphClient.requestJson<{
        "@odata.type"?: string;
        contentBytes?: string;
        contentType?: string;
      }>({
        url: `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      });
      if (!resp.contentBytes) return null;
      return {
        data: Buffer.from(resp.contentBytes, "base64"),
        mimeType: resp.contentType ?? "application/octet-stream",
      };
    } catch (err) {
      if (err instanceof GraphError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    const response = await this.graphClient.requestJson<{ value: GraphFolderDto[] }>({
      url: "/me/mailFolders?$select=id,displayName,unreadItemCount,wellKnownName&$top=100",
    });
    return (response.value ?? []).map((folder) => ({
      id: folder.id,
      name: folder.displayName ?? folder.id,
      canonical: folder.wellKnownName
        ? CANONICAL_FOLDER_MAP[folder.wellKnownName.toLowerCase()]
        : undefined,
      unread: folder.unreadItemCount ?? 0,
    }));
  }

  async pollSince(cursor: PollCursor | null, limit: number): Promise<PollResult> {
    const graphCursor = cursor?.kind === "graph" ? (cursor as GraphCursor) : null;
    const initialUrl = buildInboxDeltaUrl({
      pageSize: Math.min(limit, this.deltaPageSize),
      selectFields: SUMMARY_SELECT_FIELDS,
    });
    const { url } = resolveDeltaUrl(graphCursor, initialUrl);

    const body = await this.graphClient.requestJson<{
      value: (GraphMessageDto & { "@removed"?: { reason?: string } })[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    }>({ url });
    const page = extractDeltaPage(body);

    const messages: MailMessageSummary[] = [];
    const removedIds: string[] = [];
    for (const item of page.value) {
      if (isRemovedItem(item)) {
        if (item.id) removedIds.push(item.id);
        continue;
      }
      messages.push(this.toSummary(item, "Inbox"));
    }

    const advance = advanceCursor(page);
    return {
      messages,
      removedIds,
      nextCursor: advance.cursor,
      drained: advance.drained,
    };
  }

  async revoke(): Promise<void> {
    const accounts = await this.msalApp.getTokenCache().getAllAccounts();
    for (const account of accounts) {
      if ((this.homeAccountId && account.homeAccountId === this.homeAccountId)
        || account.username === this.account.email) {
        await this.msalApp.getTokenCache().removeAccount(account);
      }
    }
    this.cachedToken = null;
  }

  // ── Optional MailProvider extensions (§3.11 parity) ──

  async untrash(id: string): Promise<void> {
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(id)}/move`,
      method: "POST",
      body: { destinationId: "inbox" },
    });
  }

  async archive(id: string): Promise<void> {
    // `archive` is the Graph well-known folder name for the Outlook archive.
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(id)}/move`,
      method: "POST",
      body: { destinationId: "archive" },
    });
  }

  async listTags(): Promise<TagCatalog> {
    // Outlook's category catalog is the set of master categories the user
    // has defined on the mailbox. System tags are a fixed small set (see
    // §3.11 row 12). Returning ids keeps round-trip consistency with
    // `modifyTags` which stores categories by name — for Graph,
    // `masterCategories.displayName` IS the identifier used by PATCH
    // categories[], so name and id coincide.
    const response = await this.graphClient.requestJson<{
      value: { id: string; displayName: string }[];
    }>({ url: "/me/outlook/masterCategories?$select=id,displayName" });
    const userDefined = (response.value ?? []).map((c) => c.displayName);
    return { system: [], userDefined };
  }

  async getThread(threadId: string, limit?: number): Promise<ThreadView> {
    const top = Math.min(limit ?? 25, 100);
    const params = new URLSearchParams();
    params.set("$select", FULL_SELECT_FIELDS.join(","));
    params.set("$filter", `conversationId eq '${escapeODataLiteral(threadId)}'`);
    params.set("$top", String(top));
    params.set("$orderby", "receivedDateTime ASC");
    const response = await this.graphClient.requestJson<{ value: GraphMessageDto[] }>(
      { url: `/me/messages?${params.toString()}` },
    );
    const messages = (response.value ?? []).map((m) => this.toFullMessage(m));
    // Graph returns authoritative conversations — no client-side walk,
    // `status` is always "full" for Outlook.
    return { threadId, messages, status: "full" };
  }

  async listDrafts(limit?: number): Promise<DraftSummary[]> {
    const top = Math.min(limit ?? 25, 100);
    const params = new URLSearchParams();
    params.set(
      "$select",
      [
        "id",
        "conversationId",
        "subject",
        "toRecipients",
        "bodyPreview",
      ].join(","),
    );
    params.set("$top", String(top));
    params.set("$orderby", "lastModifiedDateTime DESC");
    const response = await this.graphClient.requestJson<{ value: GraphMessageDto[] }>(
      {
        url: `/me/mailFolders/drafts/messages?${params.toString()}`,
      },
    );
    return (response.value ?? []).map((m) => ({
      draftId: m.id,
      threadId: m.conversationId ?? undefined,
      subject: m.subject ?? null,
      to: (m.toRecipients ?? [])
        .map((r) => r.emailAddress?.address)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(", ") || null,
      snippet: m.bodyPreview ?? "",
    }));
  }

  async getDraft(draftId: string): Promise<DraftDetail | null> {
    try {
      const params = new URLSearchParams();
      params.set("$select", FULL_SELECT_FIELDS.join(","));
      const message = await this.graphClient.requestJson<GraphMessageDto>({
        url: `/me/messages/${encodeURIComponent(draftId)}?${params.toString()}`,
      });
      const to = (message.toRecipients ?? [])
        .map((r) => r.emailAddress?.address)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(", ") || null;
      const cc = (message.ccRecipients ?? [])
        .map((r) => r.emailAddress?.address)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(", ") || null;
      const bcc = (message.bccRecipients ?? [])
        .map((r) => r.emailAddress?.address)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(", ") || null;
      return {
        draftId: message.id,
        threadId: message.conversationId ?? undefined,
        subject: message.subject ?? null,
        from: message.from?.emailAddress?.address ?? null,
        to,
        cc,
        bcc,
        snippet: message.bodyPreview ?? "",
        body: message.body?.content ?? null,
        rfc822MsgId: message.internetMessageId ?? null,
        references: null,
      };
    } catch (err) {
      if (err instanceof GraphError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  async createDraft(input: SendInput): Promise<{ id: string }> {
    if (input.reply) {
      // Mirror `sendReply`'s guard. Graph's `/createReply` endpoint is the
      // only way to get authoritative `In-Reply-To`/`References`/
      // `conversationId` on the draft — without the parent's provider id
      // we cannot thread it correctly. Falling through to the non-reply
      // `POST /me/messages` path would silently orphan the draft, and the
      // agent would have no signal that its `reply` field was ignored.
      if (!input.reply.parentProviderMsgId) {
        throw new Error(
          "Outlook createDraft(reply): reply.parentProviderMsgId is required — " +
            "fetch the parent thread (GET /mail/:id/threads/:threadId) and pass " +
            "the message's providerMsgId, not just its rfc822 Message-Id.",
        );
      }
      // Use /createReply so Graph populates References / In-Reply-To
      // and threads the draft correctly, then PATCH the body.
      const draft = await this.graphClient.requestJson<GraphMessageDto>({
        url: `/me/messages/${encodeURIComponent(input.reply.parentProviderMsgId)}/createReply`,
        method: "POST",
        body: {},
      });
      const patch = buildGraphMessageBody(input, { isReply: true });
      await this.graphClient.requestVoid({
        url: `/me/messages/${encodeURIComponent(draft.id)}`,
        method: "PATCH",
        body: patch,
      });
      return { id: draft.id };
    }
    const draft = await this.graphClient.requestJson<GraphMessageDto>({
      url: "/me/messages",
      method: "POST",
      body: buildGraphMessageBody(input),
    });
    return { id: draft.id };
  }

  async updateDraft(
    draftId: string,
    input: UpdateDraftInput,
  ): Promise<UpdateDraftResult> {
    const body: Record<string, unknown> = {};
    if (input.subject !== undefined) body.subject = input.subject;
    if (input.to !== undefined) body.toRecipients = input.to.map(toGraphRecipient);
    if (input.cc !== undefined) body.ccRecipients = input.cc.map(toGraphRecipient);
    if (input.bcc !== undefined) body.bccRecipients = input.bcc.map(toGraphRecipient);
    if (input.htmlBody !== undefined) {
      body.body = { contentType: "html", content: input.htmlBody };
    } else if (input.textBody !== undefined) {
      body.body = { contentType: "text", content: input.textBody };
    }
    // Graph PATCH ignores Reply threading fields on an existing draft —
    // In-Reply-To / References are set at createReply time and immutable.
    // Surface this as a warning so the agent knows the field didn't land;
    // if threading needs to change, create a fresh draft.
    const warnings: string[] = [];
    if (input.reply !== undefined) {
      warnings.push("reply_threading_immutable_after_create");
    }
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(draftId)}`,
      method: "PATCH",
      body,
    });
    return warnings.length > 0
      ? { id: draftId, warnings }
      : { id: draftId };
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(draftId)}`,
      method: "DELETE",
    });
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId?: string }> {
    // Re-fetch to capture the conversationId + internetMessageId before
    // /send runs — once sent, Graph may remove the Drafts folder membership
    // we'd rely on to reconstruct those for SendResult attribution (§C6).
    let rfc822MsgId: string | undefined;
    let threadId: string | undefined;
    try {
      const preview = await this.graphClient.requestJson<GraphMessageDto>({
        url: `/me/messages/${encodeURIComponent(draftId)}?$select=conversationId,internetMessageId`,
      });
      rfc822MsgId = preview.internetMessageId ?? undefined;
      threadId = preview.conversationId ?? undefined;
    } catch {
      // Attribution is best-effort; the send itself is what matters.
    }
    await this.graphClient.requestVoid({
      url: `/me/messages/${encodeURIComponent(draftId)}/send`,
      method: "POST",
    });
    const result: { id: string; threadId?: string; rfc822MsgId?: string } = {
      id: draftId,
      threadId,
      rfc822MsgId,
    };
    return result;
  }

  private toFullMessage(message: GraphMessageDto): MailMessage {
    const summary = this.toSummary(message, message.parentFolderId ?? "");
    return {
      ...summary,
      body: {
        text: message.body?.contentType === "text" ? message.body.content : undefined,
        html: message.body?.contentType === "html" ? message.body.content : undefined,
      },
      attachments: [], // full attachment fetch deferred — get(id) uses a separate Graph call
    };
  }

  private toSummary(message: GraphMessageDto, folder: string): MailMessageSummary {
    return {
      accountId: this.account.id,
      providerMsgId: message.id,
      rfc822MsgId: message.internetMessageId ?? null,
      threadId: message.conversationId ?? null,
      folder,
      receivedAtUtc: message.receivedDateTime ?? new Date().toISOString(),
      subject: message.subject ?? null,
      from: addressFromGraph(message.from?.emailAddress) ?? { email: "" },
      to: (message.toRecipients ?? [])
        .map((r) => addressFromGraph(r.emailAddress))
        .filter((a): a is { email: string; name?: string } => a !== null),
      snippet: message.bodyPreview ?? null,
      isRead: message.isRead ?? false,
      flags: message.categories ?? [],
      hasAttachment: message.hasAttachments ?? false,
    };
  }
}

interface BuildBodyOptions {
  isReply?: boolean;
}

function buildGraphMessageBody(input: SendInput, options: BuildBodyOptions = {}): Record<string, unknown> {
  const message: Record<string, unknown> = {};

  if (!options.isReply) {
    message.subject = input.subject;
    message.toRecipients = input.to.map(toGraphRecipient);
    if (input.cc?.length) message.ccRecipients = input.cc.map(toGraphRecipient);
    if (input.bcc?.length) message.bccRecipients = input.bcc.map(toGraphRecipient);
  } else {
    if (input.to.length > 0) message.toRecipients = input.to.map(toGraphRecipient);
    if (input.cc?.length) message.ccRecipients = input.cc.map(toGraphRecipient);
    if (input.bcc?.length) message.bccRecipients = input.bcc.map(toGraphRecipient);
  }

  if (input.htmlBody) {
    message.body = { contentType: "html", content: input.htmlBody };
  } else if (input.textBody) {
    message.body = { contentType: "text", content: input.textBody };
  }
  return message;
}

function toGraphRecipient(email: string): { emailAddress: { address: string } } {
  return { emailAddress: { address: email } };
}

function addressFromGraph(
  raw: { address?: string; name?: string } | undefined,
): { email: string; name?: string } | null {
  if (!raw?.address) return null;
  const result: { email: string; name?: string } = { email: raw.address };
  if (raw.name) result.name = raw.name;
  return result;
}

/** Escape single quotes for embedding in an OData `$filter` string literal
 *  (RFC 3986 percent-encoding is applied by the URL builder; we handle the
 *  one OData-specific concern, which is quote doubling). */
function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
