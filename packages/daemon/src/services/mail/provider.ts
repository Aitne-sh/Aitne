export type MailProviderKind = "gmail" | "outlook" | "yahoo" | "icloud";

export type AuthStatus = "healthy" | "requires_consent" | "degraded";

export type CanonicalFolder = "inbox" | "sent" | "drafts" | "trash" | "spam";

export interface MailAccount {
  id: string;
  kind: MailProviderKind;
  email: string;
  label?: string;
  authStatus: AuthStatus;
  idleEnabled: boolean;
  active: boolean;
  createdAt: string;
}

export interface MailAccountHealth {
  accountId: string;
  lastPollAtUtc: string | null;
  lastError: string | null;
  lastErrorAtUtc: string | null;
  consecutiveErrorCount: number;
  idleFallbackUntilUtc: string | null;
}

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MailMessageSummary {
  accountId: string;
  providerMsgId: string;
  /** RFC-2822 Message-Id header. `null` when the provider didn't surface it
   *  in list/summary mode (Gmail summary mode does when the To/Message-Id
   *  headers are requested; IMAP SEARCH doesn't). */
  rfc822MsgId: string | null;
  threadId: string | null;
  folder: string;
  receivedAtUtc: string;
  subject: string | null;
  from: MailAddress;
  /** Recipients visible at the summary layer. Empty array means "not returned
   *  by the list/summary call" — use {@link MailProvider.get} for an
   *  authoritative list. */
  to: MailAddress[];
  snippet: string | null;
  isRead: boolean;
  flags: string[];
  /** `undefined` means the provider could not determine this in summary mode
   *  (Gmail metadata doesn't expose it without a full fetch). Don't coerce
   *  to `false` — callers making filter decisions on "no attachments" must
   *  distinguish unknown from known-no. */
  hasAttachment?: boolean;
}

export interface MailMessage extends MailMessageSummary {
  body: { text?: string; html?: string };
  attachments: MailAttachmentMeta[];
}

export interface ListQuery {
  folder?: string;
  q?: string;
  limit?: number;
  since?: string;
  unreadOnly?: boolean;
}

export interface ReplyContext {
  inReplyToRfc822Id: string;
  references: string[];
  providerThreadId?: string;
  parentProviderMsgId?: string;
}

export interface SendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  reply?: ReplyContext;
  draftOnly?: boolean;
}

export interface SendResult {
  id: string;
  isDraft: boolean;
  warnings?: string[];
  /**
   * RFC-2822 Message-Id header of the sent/drafted message, when the
   * provider can surface it without a follow-up round trip. Used by
   * {@link AgentWriteTracker} as a second attribution key so the IMAP
   * SMTP+APPEND path — where the Sent-folder UID differs from the draft
   * UID — can still suppress observations of the agent's own writes.
   * Optional: providers that don't expose it natively leave it undefined.
   */
  rfc822MsgId?: string;
  /**
   * Provider thread id of the just-sent message, when the upstream API
   * surfaces it without a follow-up round trip (Gmail does; IMAP / Outlook
   * do not). Used by INTEGRATION-DRIFT-DETECTION-PLAN Phase 5 actor
   * attribution: Gmail reconcile keys snapshots by threadId, so the
   * `/api/mail/:account/send` write surface needs threadId — not just
   * messageId — for the next reconcile to resolve `actor='agent'`.
   * Optional: providers without thread semantics leave it undefined and
   * the route falls back to messageId-only marking.
   */
  threadId?: string;
}

export type PollCursor =
  | {
      kind: "gmail";
      lastEpoch: number;
      historyId?: string;
      processedIds?: string[];
      nextPageToken?: string;
      historyPageToken?: string;
    }
  | { kind: "graph"; deltaLink?: string; nextLink?: string }
  | {
      kind: "imap";
      folders: Record<string, { uidValidity: number; lastUid: number }>;
    };

export interface PollResult {
  messages: MailMessageSummary[];
  removedIds: string[];
  nextCursor: PollCursor;
  drained: boolean;
}

export interface FolderInfo {
  id: string;
  name: string;
  canonical?: CanonicalFolder;
  unread: number;
}

/** Response shape for `GET /mail/:id/tags` (§3.11 row 12). IMAP returns an
 *  empty `userDefined` on servers that don't advertise keywords in PERMANENTFLAGS. */
export interface TagCatalog {
  system: string[];
  userDefined: string[];
}

export interface DraftSummary {
  draftId: string;
  threadId?: string;
  subject: string | null;
  to: string | null;
  snippet: string;
}

export interface DraftDetail extends DraftSummary {
  from: string | null;
  cc: string | null;
  bcc: string | null;
  body: string | null;
  rfc822MsgId: string | null;
  references: string | null;
}

export interface ThreadView {
  threadId: string;
  messages: MailMessage[];
  /** Set on IMAP when local index is missing earlier ancestors (§3.11 asymmetry 3). */
  missingAncestors?: number;
  /** `full` = every referenced message was resolved; `partial` = truncated. */
  status: "full" | "partial";
}

export interface UpdateDraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  /**
   * Reshape the draft's reply threading. `null` clears the header.
   * `undefined` leaves the existing value intact. A provider may reject
   * partial updates if doing so would violate the RFC-2822 chain — in
   * that case the caller should supply the full `reply` block.
   */
  reply?: ReplyContext | null;
}

/**
 * IMAP PATCH-draft returns a NEW id (§3.11 asymmetry 1). The response carries
 * both so the caller can re-target. Providers with atomic update (Gmail,
 * Graph) leave `previousId` unset.
 */
export interface UpdateDraftResult {
  id: string;
  previousId?: string;
  /** Provider-specific caveats the caller should see. Example: Outlook's
   *  reply headers are immutable after createDraft — updateDraft silently
   *  accepts a `reply` field but cannot apply it. Callers that need
   *  reshaped threading should create a new draft. */
  warnings?: string[];
}

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly account: MailAccount;

  list(q: ListQuery): Promise<MailMessageSummary[]>;
  get(id: string): Promise<MailMessage>;
  send(input: SendInput): Promise<SendResult>;
  modifyTags(id: string, add: string[], remove: string[]): Promise<void>;
  markRead(id: string, read: boolean): Promise<void>;
  trash(id: string): Promise<void>;
  listFolders(): Promise<FolderInfo[]>;

  pollSince(
    cursor: PollCursor | null,
    limit: number,
  ): Promise<PollResult>;

  revoke(): Promise<void>;

  /**
   * Optional extensions below — providers declare only what their backend
   * supports. The unified route layer returns 501 Not Implemented when a
   * method is missing. This lets new providers ship without a full parity
   * rewrite; Phase 5 commits to eventual parity across all four providers.
   */
  untrash?(id: string): Promise<void>;
  archive?(id: string): Promise<void>;
  listTags?(): Promise<TagCatalog>;

  /**
   * Download a single attachment's bytes. Optional — providers that haven't
   * implemented attachment fetch yet (Outlook / IMAP as of this writing)
   * leave it undefined and the unified receipts route returns 501 for
   * those rows. GmailProvider wraps the existing {@link GmailService}.
   */
  getAttachment?(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; mimeType: string } | null>;

  getThread?(threadId: string, limit?: number): Promise<ThreadView>;

  listDrafts?(limit?: number): Promise<DraftSummary[]>;
  getDraft?(draftId: string): Promise<DraftDetail | null>;
  createDraft?(input: SendInput): Promise<{ id: string }>;
  updateDraft?(
    draftId: string,
    input: UpdateDraftInput,
  ): Promise<UpdateDraftResult>;
  deleteDraft?(draftId: string): Promise<void>;
  sendDraft?(draftId: string): Promise<{ id: string; threadId?: string }>;
}

export function mailAccountBlobName(
  kind: MailProviderKind,
  accountId: string,
): string {
  return `mail:${kind}:${accountId}`;
}

/**
 * Thrown by provider methods when the referenced entity (message, draft,
 * thread) does not exist. Carries `httpStatus=404` so the unified route
 * layer's generic error classifier maps it to a 404 response consistently
 * across providers — matching Outlook's `GraphError.httpStatus` semantics.
 */
export class MailNotFoundError extends Error {
  readonly httpStatus = 404;
  readonly code = "not_found";
  constructor(kind: MailProviderKind, entity: string, id: string) {
    super(`${kind} ${entity} not found: ${id}`);
    this.name = "MailNotFoundError";
  }
}

/**
 * Thrown by provider methods when an operation is structurally unsupported
 * on this kind (e.g. IMAP draft mutations in Phase 5 where MIME construction
 * is deferred). Distinct from missing-method-on-interface — this is thrown
 * *inside* an implemented method when a sub-case is out of scope.
 */
export class MailOperationNotSupportedError extends Error {
  readonly httpStatus = 501;
  readonly code = "not_implemented";
  constructor(kind: MailProviderKind, operation: string, reason?: string) {
    super(
      reason
        ? `${kind}: ${operation} not supported — ${reason}`
        : `${kind}: ${operation} not supported`,
    );
    this.name = "MailOperationNotSupportedError";
  }
}
