import nodemailer from "nodemailer";
import { simpleParser, type ParsedAttachment } from "mailparser";
import { ImapFlow } from "imapflow";
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
} from "../provider.js";
import {
  MailNotFoundError,
  MailOperationNotSupportedError,
} from "../provider.js";
import type { ImapAccountSecret, ImapAppPasswordKind } from "./app-password.js";
import { advanceImapCursor, formatImapProviderMsgId, parseImapProviderMsgId, planImapFolderSync } from "./cursor.js";
import { resolveImapFolders, deriveCanonicalFolder, type ImapListedFolder, type ResolvedImapFolders } from "./folder-resolver.js";
import { buildReplyBodies } from "./reply-mime.js";
import { translateImapQuery } from "./query-translator.js";
import { createImapFlowClient } from "./client.js";
import { probeCapabilities, type ImapCapabilitySet } from "./capabilities.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("mail-imap-base");

/**
 * Real-time deletion event surfaced by IDLE when QRESYNC is enabled.
 * `providerMsgId` is pre-formatted as `${uidValidity}:${uid}` so callers
 * can soft-delete from `mail_messages_index` without re-hashing.
 */
export interface ExpungeNotification {
  folder: string;
  uid: number;
  uidValidity: number;
  providerMsgId: string;
}

export interface IdleHandlers {
  /** Called on any IDLE signal (new message, expunge). Triggers a re-poll. */
  onDirty: () => void;
  /**
   * Called once per VANISHED response when QRESYNC is live on the server.
   * On non-QRESYNC servers EXPUNGE notifications only carry sequence
   * numbers and this is NOT invoked — callers should fall back to the
   * reconcile observer for deletion detection on those accounts.
   */
  onExpunge?: (event: ExpungeNotification) => void;
}

export interface IdleCapableMailProvider extends MailProvider {
  startIdle(handlers: IdleHandlers): Promise<void>;
  stopIdle(): Promise<void>;
}

/**
 * Surface a provider exposes to the deletion-reconciliation observer
 * (§3.1.1). Keeping this as a structural interface — rather than requiring
 * `instanceof ImapProviderBase` — lets future IMAP-over-something providers
 * participate without inheritance coupling.
 */
export interface ImapReconcileSource {
  readonly account: MailAccount;
  listExistingUids(
    folder: string,
    options: { sinceUid?: number },
  ): Promise<{ uidValidity: number; uids: number[] }>;
  getCapabilities(): ImapCapabilitySet | null;
}

export function isImapReconcileSource(
  provider: unknown,
): provider is ImapReconcileSource {
  if (!provider || typeof provider !== "object") return false;
  const p = provider as Record<string, unknown>;
  return (
    typeof p.listExistingUids === "function" &&
    typeof p.getCapabilities === "function" &&
    typeof p.account === "object" &&
    p.account !== null
  );
}

/**
 * Fired once per provider instance, on the first successful connect. Phase 4
 * uses this to persist the CAPABILITY probe result on the account row so
 * Phase 7 can branch on it without reprobing. Must be fire-and-forget — the
 * base class does not await the returned promise so a slow DB write cannot
 * stall IMAP traffic.
 */
export type OnCapabilitiesProbed = (
  accountId: string,
  capabilities: ImapCapabilitySet,
) => void | Promise<void>;

export interface ImapProviderBaseOptions {
  account: MailAccount;
  secret: ImapAccountSecret;
  now?: () => Date;
  onCapabilitiesProbed?: OnCapabilitiesProbed;
}

type ImapFlowLike = InstanceType<typeof ImapFlow>;
type SmtpTransportLike = ReturnType<typeof nodemailer.createTransport>;

export abstract class ImapProviderBase
implements IdleCapableMailProvider {
  abstract readonly kind: ImapAppPasswordKind;
  readonly account: MailAccount;
  protected readonly secret: ImapAccountSecret;
  protected readonly now: () => Date;

  private clientPromise: Promise<ImapFlowLike> | null = null;
  private smtpTransport: SmtpTransportLike | null = null;
  private resolvedFoldersPromise: Promise<ResolvedImapFolders> | null = null;
  private idleCallback: (() => void) | null = null;
  private idleExpungeCallback:
    | ((event: ExpungeNotification) => void)
    | null = null;
  private idleListenerClient: ImapFlowLike | null = null;
  private idleLoopClient: ImapFlowLike | null = null;
  private idleLoopPromise: Promise<void> | null = null;
  private readonly onCapabilitiesProbed: OnCapabilitiesProbed | null;
  private capabilities: ImapCapabilitySet | null = null;
  private capabilitiesProbed = false;
  /**
   * Snapshot of UIDVALIDITY per folder, refreshed on each `mailboxOpen`.
   * Expunge events need the UIDVALIDITY that was in effect when the message
   * was observed so we can build the local `provider_msg_id`. Per-client
   * state — cleared when the client closes so a post-reconnect mismatch
   * never fabricates stale ids.
   */
  private uidValidityByFolder = new Map<string, number>();

  constructor(options: ImapProviderBaseOptions) {
    this.account = options.account;
    this.secret = options.secret;
    this.now = options.now ?? (() => new Date());
    this.onCapabilitiesProbed = options.onCapabilitiesProbed ?? null;
  }

  /** Most-recently-probed capabilities, or null until first connect finishes. */
  getCapabilities(): ImapCapabilitySet | null {
    return this.capabilities;
  }

  async list(query: ListQuery): Promise<MailMessageSummary[]> {
    const folder = query.folder ?? "INBOX";
    const translation = translateImapQuery(query.q ?? null, { now: this.now });
    const client = await this.getClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const search = this.buildSearchObject(query, translation);
      const searchResult = await client.search(search, { uid: true });
      const uids = Array.isArray(searchResult) ? searchResult : [];
      const ordered = [...uids].sort((a, b) => b - a);
      const limited = ordered.slice(0, Math.min(query.limit ?? 25, 100));
      const fetched = limited.length
        ? await client.fetchAll(
            limited,
            {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              bodyStructure: true,
              ...(translation.requiresClientSideUnicodeFilter ? { source: true } : {}),
            },
            { uid: true },
          )
        : [];
      const uidValidity = toNumber(getMailboxObject(client.mailbox)?.uidValidity) ?? 0;
      let summaries = fetched.map((message) =>
        this.toSummary(message as unknown as Record<string, unknown>, folder, uidValidity),
      );
      if (translation.requiresClientSideUnicodeFilter) {
        summaries = await this.attachSourceSnippets(
          summaries,
          fetched as unknown as Array<Record<string, unknown>>,
        );
        summaries = summaries.filter((summary) => this.matchesClientSideQuery(summary, query.q ?? ""));
      }
      return summaries;
    } finally {
      lock.release();
    }
  }

  async get(id: string): Promise<MailMessage> {
    const located = await this.locateMessage(id, { includeSource: true });
    if (!located || !located.message?.source) {
      throw new Error(`IMAP message not found: ${id}`);
    }
    const parsed = await simpleParser(located.message.source as Buffer);
    const summary = this.toSummary(
      located.message,
      located.folder,
      located.uidValidity,
    );
    return {
      ...summary,
      body: {
        text: parsed.text ?? undefined,
        html: typeof parsed.html === "string" ? parsed.html : undefined,
      },
      attachments: parsed.attachments.map(
        (attachment, index) => toAttachmentMeta(attachment, index),
      ),
    };
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    // IMAP has no attachment-download endpoint analogous to Graph: the bytes
    // only exist inside the RFC-2822 source, so we re-fetch + re-parse and
    // match by the same id convention `get()` used at detection time.
    const located = await this.locateMessage(messageId, { includeSource: true });
    if (!located || !located.message?.source) return null;
    const parsed = await simpleParser(located.message.source as Buffer);
    for (let i = 0; i < parsed.attachments.length; i++) {
      const att = parsed.attachments[i];
      if (attachmentIdFor(att, i) !== attachmentId) continue;
      if (!att.content) return null;
      return {
        data: att.content as Buffer,
        mimeType: att.contentType ?? "application/octet-stream",
      };
    }
    return null;
  }

  async send(input: SendInput): Promise<SendResult> {
    const raw = await this.composeRawMessage(input);
    // §C6: the RFC-2822 Message-Id is stable across SMTP + APPEND-to-Sent
    // (we generate it once during MIME construction). Surface it in
    // SendResult so the route can mark `mail:<acct>:rfc822:<id>` as a
    // second agent-write attribution key; without this, the IMAP
    // SMTP+APPEND path leaks the agent's own send into the next poll.
    const rfc822MsgId = extractHeaderMessageId(raw) ?? undefined;
    const folders = await this.getResolvedFolders();
    if (input.draftOnly !== false) {
      const appended = await this.appendMessage(folders.drafts, raw, ["\\Draft"]);
      return { id: appended.id, isDraft: true, rfc822MsgId };
    }

    const transport = this.getSmtpTransport();
    const envelopeTo = [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ];
    await transport.sendMail({
      envelope: {
        from: this.account.email,
        to: envelopeTo,
      },
      raw,
    });

    try {
      const appended = await this.appendMessage(folders.sent, raw, ["\\Seen"]);
      return { id: appended.id, isDraft: false, rfc822MsgId };
    } catch (error) {
      return {
        id: rfc822MsgId ?? `smtp:${Date.now()}`,
        isDraft: false,
        rfc822MsgId,
        warnings: [
          `sent_append_failed:${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async modifyTags(id: string, add: string[], remove: string[]): Promise<void> {
    const located = await this.locateMessage(id);
    if (!located) throw new Error(`IMAP message not found: ${id}`);
    const client = await this.getClient();
    const lock = await client.getMailboxLock(located.folder, { readOnly: false });
    try {
      const permanentFlags = new Set(
        Array.from(getMailboxObject(client.mailbox)?.permanentFlags ?? []).map(String),
      );
      const allowKeywords = permanentFlags.has("\\*");
      const supported = (tags: string[]) =>
        tags.filter((tag) => isSystemFlag(tag) || allowKeywords || permanentFlags.has(tag));

      const toAdd = supported(add);
      const toRemove = supported(remove);
      if (toAdd.length > 0) {
        await client.messageFlagsAdd(located.uid, toAdd, { uid: true });
      }
      if (toRemove.length > 0) {
        await client.messageFlagsRemove(located.uid, toRemove, { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async markRead(id: string, read: boolean): Promise<void> {
    const located = await this.locateMessage(id);
    if (!located) throw new Error(`IMAP message not found: ${id}`);
    const client = await this.getClient();
    const lock = await client.getMailboxLock(located.folder, { readOnly: false });
    try {
      if (read) {
        await client.messageFlagsAdd(located.uid, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(located.uid, ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async trash(id: string): Promise<void> {
    const located = await this.locateMessage(id);
    if (!located) throw new Error(`IMAP message not found: ${id}`);
    const client = await this.getClient();
    const folders = await this.getResolvedFolders();
    const lock = await client.getMailboxLock(located.folder, { readOnly: false });
    try {
      await client.messageMove(located.uid, folders.trash, { uid: true });
    } finally {
      lock.release();
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    const client = await this.getClient();
    const listed = (await client.list()) as ImapListedFolder[];
    return Promise.all(
      listed.map(async (folder) => {
        const status = await client.status(folder.path, { unseen: true });
        return {
          id: folder.path,
          name: folder.path,
          canonical: deriveCanonicalFolder(folder),
          unread: toNumber(status.unseen) ?? 0,
        };
      }),
    );
  }

  async pollSince(cursor: PollCursor | null, limit: number): Promise<PollResult> {
    const folders = await this.getResolvedFolders();
    const inbox = folders.inbox;
    const client = await this.getClient();
    const lock = await client.getMailboxLock(inbox, { readOnly: true });
    try {
      const uidValidity = toNumber(getMailboxObject(client.mailbox)?.uidValidity) ?? 0;
      const plan = planImapFolderSync(cursor, inbox, uidValidity);

      const searchResult = await client.search(
        plan.mode === "resume"
          ? { uid: `${Math.max(plan.lastSeenUid + 1, 1)}:*` }
          : { all: true },
        { uid: true },
      );
      let uids = Array.isArray(searchResult) ? searchResult : [];
      uids = [...uids].sort((a, b) => a - b);

      if (plan.mode !== "resume") {
        const batch = uids.slice(0, limit);
        const fetched = batch.length
          ? await client.fetchAll(
              batch,
              { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
              { uid: true },
            )
          : [];
        const lastUid = batch.at(-1) ?? 0;
        return {
          messages: fetched.map((message) =>
            this.toSummary(message as unknown as Record<string, unknown>, inbox, uidValidity),
          ),
          removedIds: [],
          nextCursor: advanceImapCursor(cursor, inbox, uidValidity, lastUid),
          drained: uids.length <= limit,
        };
      }

      const batch = uids.slice(0, limit);
      const fetched = batch.length
        ? await client.fetchAll(
            batch,
            { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
            { uid: true },
          )
        : [];
      const lastUid = batch.at(-1) ?? plan.lastSeenUid;
      return {
        messages: fetched.map((message) =>
          this.toSummary(message as unknown as Record<string, unknown>, inbox, uidValidity),
        ),
        removedIds: [],
        nextCursor: advanceImapCursor(cursor, inbox, uidValidity, lastUid),
        drained: uids.length <= limit,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * List UIDs currently present on the server for `folder`. Used by the
   * reconcile observer (§3.1.1) to diff against the local index and flag
   * deletions. Returns the server's current UIDVALIDITY alongside so the
   * caller can skip reconciliation on an epoch mismatch — deletion
   * reconciliation does not cross UIDVALIDITY boundaries (the poll path's
   * resync branch owns that case).
   *
   * `sinceUid` bounds the walk: callers typically pass `lastUid - K` to cap
   * the SEARCH on very large folders. Pass `0` (or omit) to walk the folder.
   */
  async listExistingUids(
    folder: string,
    options: { sinceUid?: number } = {},
  ): Promise<{ uidValidity: number; uids: number[] }> {
    const client = await this.getClient();
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const uidValidity =
        toNumber(getMailboxObject(client.mailbox)?.uidValidity) ?? 0;
      const sinceUid = Math.max(options.sinceUid ?? 0, 0);
      const search =
        sinceUid > 0 ? { uid: `${sinceUid}:*` } : { all: true };
      const result = await client.search(search, { uid: true });
      // Per imapflow, `search` resolves to a number[] (possibly empty) on
      // success. A non-array return is a protocol failure or partial parse
      // — and silently treating that as "the folder is empty" is what the
      // reconcile planner would interpret as "soft-delete every local row
      // in the walked window". Throw instead so `reconcileFolder`'s
      // try/catch logs and skips the folder this tick rather than
      // declaring a mass deletion on bad evidence.
      if (!Array.isArray(result)) {
        throw new Error(
          "IMAP search returned non-array result; refusing to use as authoritative UID list",
        );
      }
      const uids = [...result].sort((a, b) => a - b);
      return { uidValidity, uids };
    } finally {
      lock.release();
    }
  }

  async startIdle(handlers: IdleHandlers): Promise<void> {
    this.idleCallback = handlers.onDirty;
    this.idleExpungeCallback = handlers.onExpunge ?? null;
    const client = await this.getClient();
    if (this.idleLoopPromise && this.idleLoopClient === client) {
      return;
    }
    if (this.idleListenerClient !== client) {
      client.on("exists", () => this.idleCallback?.());
      client.on("expunge", (event: unknown) =>
        this.handleExpungeEvent(event),
      );
      this.idleListenerClient = client;
    }
    await client.mailboxOpen((await this.getResolvedFolders()).inbox, {
      readOnly: true,
    });
    this.idleLoopClient = client;
    const idlePromise = this.runIdleLoop(client)
      .catch(() => undefined)
      .finally(() => {
        if (this.idleLoopClient === client) {
          this.idleLoopClient = null;
        }
        if (this.idleLoopPromise === idlePromise) {
          this.idleLoopPromise = null;
        }
      });
    this.idleLoopPromise = idlePromise;
  }

  async stopIdle(): Promise<void> {
    this.idleCallback = null;
    this.idleExpungeCallback = null;
    const client = this.clientPromise ? await this.clientPromise.catch(() => null) : null;
    if (client?.usable) {
      try {
        await client.noop();
      } catch {
        // Breaking a dead IDLE loop is best-effort only.
      }
    }
    await this.idleLoopPromise?.catch(() => undefined);
  }

  /**
   * Translate an ImapFlow `expunge` event into an {@link ExpungeNotification}
   * (if QRESYNC is live and the event carries a UID) plus a generic re-poll
   * trigger. Non-QRESYNC servers only surface sequence numbers; those are
   * not resolvable to a provider_msg_id here, so the reconcile observer
   * (§3.1.1) is the fallback for deletion detection on those accounts.
   */
  private handleExpungeEvent(event: unknown): void {
    this.idleCallback?.();
    const callback = this.idleExpungeCallback;
    if (!callback) return;
    if (!event || typeof event !== "object") return;
    const e = event as { path?: unknown; uid?: unknown; vanished?: unknown };
    if (e.vanished !== true) return;
    const uid = toNumber(e.uid);
    const folder = typeof e.path === "string" ? e.path : null;
    if (uid === null || uid <= 0 || !folder) return;
    const uidValidity = this.uidValidityByFolder.get(folder);
    if (!uidValidity) return;
    callback({
      folder,
      uid,
      uidValidity,
      providerMsgId: formatImapProviderMsgId(uidValidity, uid),
    });
  }

  async revoke(): Promise<void> {
    await this.stopIdle();
    if (this.smtpTransport && "close" in this.smtpTransport) {
      (this.smtpTransport as { close?: () => void }).close?.();
    }
    this.smtpTransport = null;

    const client = this.clientPromise ? await this.clientPromise.catch(() => null) : null;
    this.clientPromise = null;
    this.resolvedFoldersPromise = null;
    if (client?.usable) {
      await client.logout();
    }
  }

  // ── Optional MailProvider extensions (§3.11) ──

  async untrash(id: string): Promise<void> {
    const located = await this.locateMessage(id);
    if (!located) throw new Error(`IMAP message not found: ${id}`);
    const client = await this.getClient();
    const folders = await this.getResolvedFolders();
    const lock = await client.getMailboxLock(located.folder, { readOnly: false });
    try {
      await client.messageMove(located.uid, folders.inbox, { uid: true });
    } finally {
      lock.release();
    }
  }

  async archive(id: string): Promise<void> {
    const located = await this.locateMessage(id);
    if (!located) throw new Error(`IMAP message not found: ${id}`);
    const client = await this.getClient();
    const folders = await this.getResolvedFolders();
    const lock = await client.getMailboxLock(located.folder, { readOnly: false });
    try {
      await client.messageMove(located.uid, folders.archive, { uid: true });
    } finally {
      lock.release();
    }
  }

  async listTags(): Promise<TagCatalog> {
    // IMAP's tag catalog is the set of system flags (always available) plus
    // whatever PERMANENTFLAGS the server advertises per-folder. PERMANENTFLAGS
    // isn't captured on the account-level CAPABILITY probe — it's a SELECT
    // response. Read it against INBOX (the most user-visible folder).
    // modifyTags silently drops anything outside this set — the skill is
    // expected to read listTags before writing (§3.11 asymmetry 2).
    const system = ["\\Seen", "\\Flagged", "\\Answered", "\\Draft"];
    const client = await this.getClient();
    const folders = await this.getResolvedFolders();
    const lock = await client.getMailboxLock(folders.inbox, { readOnly: true });
    try {
      const mailbox = getMailboxObject(client.mailbox);
      const permanent = mailbox?.permanentFlags;
      const userDefined = Array.isArray(permanent)
        ? permanent
            .filter((f): f is string => typeof f === "string")
            .filter((f) => !f.startsWith("\\") && f !== "*")
        : [];
      return { system, userDefined };
    } finally {
      lock.release();
    }
  }

  async getThread(threadId: string, limit?: number): Promise<ThreadView> {
    // IMAP has no authoritative thread id (§3.6). The threadId accepted
    // here is a client-synthesized rfc822 Message-Id — this entry point
    // walks headers backwards through the local cache. Because the base
    // class doesn't have direct access to the SQLite cache, we delegate
    // the walk to whatever the provider subclass knows; in Phase 5 the
    // client-side walk is a best-effort via a single-folder header probe
    // plus a hint that full threading needs the local index.
    //
    // v1 behavior: return just the message matching `threadId` (single-
    // message thread) and signal status=partial so the caller knows the
    // chain wasn't walked. A richer walk lands in Phase 7 once the
    // mail_messages_index FTS read path is in.
    void limit;
    const located = await this.locateMessageByRfc822(threadId);
    if (!located) {
      // Match Gmail/Outlook semantics: thread-not-found is a 404 via
      // MailNotFoundError's httpStatus field, not an empty partial view.
      // Empty partial is indistinguishable from "found but ancestors
      // missing" and the route layer can't disambiguate.
      throw new MailNotFoundError(this.kind, "thread", threadId);
    }
    const summary = this.toSummary(
      located.message,
      located.folder,
      located.uidValidity,
    );
    const body = await this.readBodyFromLocated(located);
    const full: MailMessage = { ...summary, body, attachments: [] };
    return {
      threadId,
      messages: [full],
      status: "partial",
      missingAncestors: 0,
    };
  }

  async listDrafts(limit?: number): Promise<DraftSummary[]> {
    const client = await this.getClient();
    const folders = await this.getResolvedFolders();
    const cap = Math.min(limit ?? 25, 100);
    const lock = await client.getMailboxLock(folders.drafts, { readOnly: true });
    try {
      const uidValidity = toNumber(getMailboxObject(client.mailbox)?.uidValidity) ?? 0;
      const searchResult = (await client.search({ all: true }, { uid: true })) as
        | number[]
        | false;
      const uids = (Array.isArray(searchResult) ? searchResult : [])
        .sort((a, b) => b - a)
        .slice(0, cap);
      if (uids.length === 0) return [];
      const fetched = await client.fetchAll(
        uids,
        { uid: true, envelope: true, internalDate: true, bodyStructure: true },
        { uid: true },
      );
      return fetched.map((m) => {
        const summary = this.toSummary(
          m as unknown as Record<string, unknown>,
          folders.drafts,
          uidValidity,
        );
        return {
          draftId: summary.providerMsgId,
          threadId: summary.rfc822MsgId ?? undefined,
          subject: summary.subject,
          to: summary.to.map((a) => a.email).join(", ") || null,
          snippet: summary.snippet ?? "",
        };
      });
    } finally {
      lock.release();
    }
  }

  async getDraft(draftId: string): Promise<DraftDetail | null> {
    const located = await this.locateMessage(draftId, { includeSource: true });
    if (!located) return null;
    const summary = this.toSummary(
      located.message,
      located.folder,
      located.uidValidity,
    );
    const body = await this.readBodyFromLocated(located);
    return {
      draftId: summary.providerMsgId,
      threadId: summary.rfc822MsgId ?? undefined,
      subject: summary.subject,
      from: summary.from.email || null,
      to: summary.to.map((a) => a.email).join(", ") || null,
      cc: null,
      bcc: null,
      snippet: summary.snippet ?? "",
      body: body.text ?? null,
      rfc822MsgId: summary.rfc822MsgId,
      references: null,
    };
  }

  // Draft write operations are structurally possible over IMAP APPEND but
  // require MIME construction that duplicates `send()`'s reply-aware envelope
  // logic. Deferred to Phase 5-rev2 so we can reuse a shared MIME builder
  // instead of diverging. Surface a typed error so the route layer maps to
  // 501 without falling back to the generic 500 path.
  async createDraft(_input: SendInput): Promise<{ id: string }> {
    void _input;
    throw new MailOperationNotSupportedError(
      this.kind,
      "createDraft",
      "IMAP draft APPEND MIME construction is Phase 5-rev2 work. Use POST /mail/:acct/messages/send with draftOnly via the Gmail/Outlook surface until then.",
    );
  }
  async updateDraft(): Promise<never> {
    throw new MailOperationNotSupportedError(
      this.kind,
      "updateDraft",
      "IMAP draft updates are non-atomic (APPEND + EXPUNGE) and require MIME construction. Phase 5-rev2.",
    );
  }
  async deleteDraft(): Promise<void> {
    throw new MailOperationNotSupportedError(
      this.kind,
      "deleteDraft",
      "Deferred alongside createDraft/updateDraft. Phase 5-rev2.",
    );
  }
  async sendDraft(): Promise<never> {
    throw new MailOperationNotSupportedError(
      this.kind,
      "sendDraft",
      "Deferred alongside createDraft/updateDraft. Phase 5-rev2.",
    );
  }

  // Helpers for the thread/draft read path above. Kept here so subclasses
  // (Yahoo/iCloud) inherit them without override.
  protected async locateMessageByRfc822(rfc822MsgId: string): Promise<
    | {
        folder: string;
        uid: number;
        uidValidity: number;
        message: Record<string, unknown>;
      }
    | null
  > {
    const client = await this.getClient();
    const folders = (await this.listFolders()).map((f) => f.id);
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const uidValidity = toNumber(getMailboxObject(client.mailbox)?.uidValidity) ?? 0;
        const uids = (await client.search(
          { header: { "Message-ID": rfc822MsgId } },
          { uid: true },
        )) as number[] | false;
        if (Array.isArray(uids) && uids.length > 0) {
          const uid = uids[uids.length - 1]!;
          const message = await client.fetchOne(
            uid,
            {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              bodyStructure: true,
              source: true,
            },
            { uid: true },
          );
          if (message) {
            return {
              folder,
              uid,
              uidValidity,
              message: message as unknown as Record<string, unknown>,
            };
          }
        }
      } catch {
        // Folder not selectable or search rejected — try the next one.
      } finally {
        lock.release();
      }
    }
    return null;
  }

  protected async readBodyFromLocated(located: {
    message: Record<string, unknown>;
  }): Promise<{ text?: string; html?: string }> {
    const source = (located.message as { source?: Buffer | Uint8Array | string }).source;
    if (!source) return {};
    const buffer = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
    const parsed = await simpleParser(buffer);
    return {
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      html: typeof parsed.html === "string" ? parsed.html : undefined,
    };
  }

  protected async getResolvedFolders(): Promise<ResolvedImapFolders> {
    if (!this.resolvedFoldersPromise) {
      this.resolvedFoldersPromise = this.loadResolvedFolders();
    }
    return this.resolvedFoldersPromise;
  }

  private async loadResolvedFolders(): Promise<ResolvedImapFolders> {
    const client = await this.getClient();
    const listed = (await client.list()) as ImapListedFolder[];
    return resolveImapFolders(listed, this.secret.folderHints);
  }

  protected async getClient(): Promise<ImapFlowLike> {
    if (!this.clientPromise) {
      this.clientPromise = this.connectClient();
    }
    return this.clientPromise;
  }

  private async connectClient(): Promise<ImapFlowLike> {
    const client = createImapFlowClient(this.secret);
    client.on("close", () => {
      this.clientPromise = null;
      this.resolvedFoldersPromise = null;
      this.uidValidityByFolder.clear();
      if (this.idleListenerClient === client) {
        this.idleListenerClient = null;
      }
      if (this.idleLoopClient === client) {
        this.idleLoopClient = null;
        this.idleLoopPromise = null;
      }
    });
    // Cache UIDVALIDITY as mailboxes are opened so the `expunge` handler
    // can construct a local provider_msg_id without reopening the mailbox.
    client.on("mailboxOpen", (mailbox: unknown) => {
      const mb = getMailboxObject(mailbox);
      const path = typeof mb?.path === "string" ? mb.path : null;
      const uidValidity = toNumber(mb?.uidValidity);
      if (path && uidValidity !== null) {
        this.uidValidityByFolder.set(path, uidValidity);
      }
    });
    await client.connect();
    this.recordCapabilities(client);
    return client;
  }

  protected recordCapabilities(client: ImapFlowLike): void {
    // Probe once per provider instance. A reconnect within the same instance
    // keeps the first probe — capabilities are stable per server within a
    // session. A server-side upgrade that changes capabilities is surfaced
    // via the next provider rebuild: the registry evicts + re-creates the
    // provider on `onProviderSelectionChanged`, account removal, or explicit
    // `evictProvider`, each of which triggers a fresh probe on first connect.
    if (this.capabilitiesProbed) return;
    this.capabilitiesProbed = true;

    const raw = (client as unknown as { capabilities?: unknown }).capabilities;
    const caps = probeCapabilities(
      raw as Iterable<string> | Map<string, unknown> | null | undefined,
    );
    this.capabilities = caps;

    const callback = this.onCapabilitiesProbed;
    if (!callback) return;
    // Fire-and-forget: persistence latency must never stall the connect path.
    // Warn-log instead of swallowing — a silent DB write failure would leave
    // Phase 7's capability-driven branches running on stale/null state.
    const accountId = this.account.id;
    void Promise.resolve()
      .then(() => callback(accountId, caps))
      .catch((error: unknown) => {
        logger.warn(
          {
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          "onCapabilitiesProbed callback failed",
        );
      });
  }

  private getSmtpTransport(): SmtpTransportLike {
    if (!this.smtpTransport) {
      this.smtpTransport = nodemailer.createTransport({
        host: this.secret.smtp.host,
        port: this.secret.smtp.port,
        secure: this.secret.smtp.secure,
        requireTLS: this.secret.smtp.requireTls,
        auth: {
          user: this.secret.email,
          pass: this.secret.appPassword,
        },
      });
    }
    return this.smtpTransport;
  }

  private async locateMessage(
    id: string,
    options: { includeSource?: boolean } = {},
  ): Promise<
    | {
        folder: string;
        uid: number;
        uidValidity: number;
        message: Record<string, unknown>;
      }
    | null
  > {
    const parsed = parseImapProviderMsgId(id);
    if (!parsed) return null;

    const client = await this.getClient();
    const folders = await this.listFolders();
    const candidates = Array.from(
      new Set([
        ...(await this.getResolvedFoldersValues()),
        ...folders.map((folder) => folder.id),
      ]),
    );

    for (const folder of candidates) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const uidValidity = toNumber(getMailboxObject(client.mailbox)?.uidValidity) ?? 0;
        if (uidValidity !== parsed.uidValidity) continue;
        const message = await client.fetchOne(
          parsed.uid,
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            bodyStructure: true,
            ...(options.includeSource ? { source: true } : {}),
          },
          { uid: true },
        );
        if (message) {
          return {
            folder,
            uid: parsed.uid,
            uidValidity,
            message: message as unknown as Record<string, unknown>,
          };
        }
      } catch {
        // Try the next folder. IMAP UIDs are folder-scoped.
      } finally {
        lock.release();
      }
    }

    return null;
  }

  private async getResolvedFoldersValues(): Promise<string[]> {
    const folders = await this.getResolvedFolders();
    return Array.from(
      new Set([
        folders.inbox,
        folders.sent,
        folders.drafts,
        folders.trash,
        folders.archive,
      ]),
    );
  }

  private async appendMessage(
    folder: string,
    raw: Buffer,
    flags: string[],
  ): Promise<{ id: string }> {
    const client = await this.getClient();
    const appendResult = await client.append(folder, raw, flags, this.now());

    if (appendResult && appendResult.uid) {
      return {
        id: formatImapProviderMsgId(
          toNumber(appendResult.uidValidity) ?? 0,
          appendResult.uid,
        ),
      };
    }

    const status = await client.status(folder, { uidNext: true, uidValidity: true });
    const uidNext = toNumber(status.uidNext) ?? 1;
    const uidValidity = toNumber(status.uidValidity) ?? 0;
    return {
      id: formatImapProviderMsgId(uidValidity, Math.max(uidNext - 1, 1)),
    };
  }

  private async composeRawMessage(input: SendInput): Promise<Buffer> {
    let textBody = input.textBody;
    let htmlBody = input.htmlBody;
    let references = input.reply?.references ?? [];

    if (input.reply) {
      const parent = input.reply.parentProviderMsgId
        ? await this.get(input.reply.parentProviderMsgId)
        : null;
      const replyBodies = buildReplyBodies({
        textBody: input.textBody,
        htmlBody: input.htmlBody,
        inReplyTo: input.reply.inReplyToRfc822Id,
        references: input.reply.references,
        parent: {
          from: parent?.from,
          sentAt: parent?.receivedAtUtc,
          textBody: parent?.body.text,
          htmlBody: parent?.body.html,
        },
      });
      textBody = replyBodies.textBody;
      htmlBody = replyBodies.htmlBody;
      references = replyBodies.references;
    }

    const composer = await loadMailComposer();
    const mail = new composer({
      from: formatFromHeader(this.account),
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: textBody,
      html: htmlBody,
      inReplyTo: input.reply?.inReplyToRfc822Id,
      references,
      date: this.now(),
      disableFileAccess: true,
      disableUrlAccess: true,
      newline: "\r\n",
    });

    return new Promise<Buffer>((resolve, reject) => {
      mail.compile().build((error: Error | null, message: Buffer) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(message);
      });
    });
  }

  private toSummary(
    message: Record<string, unknown>,
    folder: string,
    uidValidity: number,
  ): MailMessageSummary {
    const envelope = getObject(message.envelope);
    const flags = getStringSet(message.flags);
    const from = addressFromEnvelope(envelope.from) ?? { email: "" };
    return {
      accountId: this.account.id,
      providerMsgId: formatImapProviderMsgId(
        uidValidity,
        toNumber(message.uid) ?? 0,
      ),
      rfc822MsgId: getString(envelope.messageId),
      threadId: null,
      folder,
      receivedAtUtc:
        (message.internalDate instanceof Date
          ? message.internalDate
          : this.now()
        ).toISOString(),
      subject: getString(envelope.subject),
      from,
      to: addressesFromEnvelope(envelope.to),
      snippet: null,
      isRead: flags.includes("\\Seen"),
      flags,
      hasAttachment: bodyStructureHasAttachment(message.bodyStructure),
    };
  }

  private buildSearchObject(
    query: ListQuery,
    translation: ReturnType<typeof translateImapQuery>,
  ): Record<string, unknown> {
    const search: Record<string, unknown> = { all: true };

    if (query.unreadOnly) search.seen = false;
    if (query.since) search.since = new Date(query.since);

    for (const term of translation.terms) {
      if (term.op === "FROM" && search.from === undefined) {
        search.from = term.value;
      } else if (term.op === "TO" && search.to === undefined) {
        search.to = term.value;
      } else if (term.op === "SUBJECT" && search.subject === undefined) {
        search.subject = term.value;
      } else if (term.op === "TEXT" && search.text === undefined) {
        search.text = term.value;
      } else if (term.op === "UNSEEN") {
        search.seen = false;
      } else if (term.op === "SINCE" && search.since === undefined && term.value) {
        search.since = new Date(term.value);
      } else if (term.op === "BEFORE" && search.before === undefined && term.value) {
        search.before = new Date(term.value);
      } else if (term.op === "LARGER" && search.larger === undefined && term.value) {
        search.larger = Number.parseInt(term.value, 10);
      }
    }

    return search;
  }

  private matchesClientSideQuery(
    summary: MailMessageSummary,
    query: string,
  ): boolean {
    const lowered = query.trim().toLowerCase();
    if (!lowered) return true;
    const haystack = [
      summary.subject,
      summary.from.email,
      summary.from.name,
      ...summary.to.flatMap((entry) => [entry.email, entry.name]),
      summary.snippet,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLowerCase();
    return haystack.includes(lowered.replaceAll('"', ""));
  }

  private async attachSourceSnippets(
    summaries: MailMessageSummary[],
    fetched: Array<Record<string, unknown>>,
  ): Promise<MailMessageSummary[]> {
    const snippets = await Promise.all(
      fetched.map(async (message) => {
        const snippet = await this.extractSnippetFromSource(message.source);
        return snippet ?? null;
      }),
    );
    return summaries.map((summary, index) => ({
      ...summary,
      snippet: snippets[index] ?? summary.snippet,
    }));
  }

  private async extractSnippetFromSource(source: unknown): Promise<string | null> {
    if (!(source instanceof Buffer)) return null;
    try {
      const parsed = await simpleParser(source);
      const text = parsed.text ?? "";
      const normalized = text.replace(/\s+/g, " ").trim();
      return normalized.length > 0 ? normalized.slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  private async runIdleLoop(client: ImapFlowLike): Promise<void> {
    while (this.idleCallback && this.clientPromise && this.idleLoopClient === client) {
      try {
        await client.idle();
      } catch (error) {
        if (!this.idleCallback) {
          return;
        }
        throw error;
      }
    }
  }
}

function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Derive a stable attachment id from a simpleParser-parsed attachment.
 * Kept in one place so `get()` and `getAttachment()` agree on the format —
 * a mismatch would silently break receipt downloads even though the rows
 * were inserted correctly.
 */
function attachmentIdFor(attachment: ParsedAttachment, index: number): string {
  return (
    (typeof attachment?.contentId === "string" && attachment.contentId) ||
    (typeof attachment?.cid === "string" && attachment.cid) ||
    `att-${index + 1}`
  );
}

function toAttachmentMeta(attachment: ParsedAttachment, index: number): {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
} {
  return {
    id: attachmentIdFor(attachment, index),
    filename: typeof attachment?.filename === "string" ? attachment.filename : "",
    mimeType:
      typeof attachment?.contentType === "string"
        ? attachment.contentType
        : "application/octet-stream",
    sizeBytes: typeof attachment?.size === "number" ? attachment.size : 0,
  };
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getStringSet(value: unknown): string[] {
  if (!(value instanceof Set)) return [];
  return Array.from(value).map(String);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function getMailboxObject(
  value: unknown,
): {
  uidValidity?: unknown;
  permanentFlags?: Iterable<unknown>;
  path?: unknown;
} | null {
  return value && typeof value === "object"
    ? (value as {
        uidValidity?: unknown;
        permanentFlags?: Iterable<unknown>;
        path?: unknown;
      })
    : null;
}

function addressFromEnvelope(value: unknown): MailAddress | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = getObject(value[0]);
  const address = getString(first.address);
  if (!address) return null;
  return {
    email: address,
    name: getString(first.name) ?? undefined,
  };
}

function addressesFromEnvelope(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => addressFromEnvelope([entry]))
    .filter((entry): entry is MailAddress => entry !== null);
}

function bodyStructureHasAttachment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as {
    disposition?: string;
    dispositionParameters?: Record<string, unknown>;
    childNodes?: unknown[];
  };
  if (
    typeof node.disposition === "string" &&
    node.disposition.toLowerCase() === "attachment"
  ) {
    return true;
  }
  if (node.dispositionParameters && "filename" in node.dispositionParameters) {
    return true;
  }
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some((child) => bodyStructureHasAttachment(child));
  }
  return false;
}

function isSystemFlag(tag: string): boolean {
  return ["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "\\Deleted"].includes(
    tag,
  );
}

function formatFromHeader(account: MailAccount): string {
  if (!account.label) return account.email;
  return `"${account.label}" <${account.email}>`;
}

function extractHeaderMessageId(raw: Buffer): string | null {
  const match = raw.toString("utf8").match(/^Message-ID:\s*(.+)$/im);
  return match ? match[1]!.trim() : null;
}

async function loadMailComposer(): Promise<
  new (options: Record<string, unknown>) => {
    compile(): {
      build(callback: (error: Error | null, message: Buffer) => void): void;
    };
  }
> {
  const module = await import("nodemailer/lib/mail-composer/index.js");
  return (module.default ?? module) as unknown as new (
    options: Record<string, unknown>,
  ) => {
    compile(): {
      build(callback: (error: Error | null, message: Buffer) => void): void;
    };
  };
}
