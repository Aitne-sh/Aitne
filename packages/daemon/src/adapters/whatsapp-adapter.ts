import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventPriority, createEvent } from "@aitne/shared";
import type { AttachmentRef, Event } from "@aitne/shared";
import type {
  MessageAdapter,
  NotificationRuntimeStatus,
  OnMessageCallback,
  OutboundAttachmentRef,
  ProcessingIndicatorHandle,
} from "./types.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { createLogger } from "../logging.js";
import { filenameForMime, splitOutboundText } from "./outbound-text.js";

// Per-type WhatsApp inbound size caps (symmetric with server limits).
const WA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const WA_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const WA_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const WA_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
const WA_CAPTION_MAX_CHARS = 1024;

const logger = createLogger("whatsapp-adapter");

const OWNER_PHONE_RE = /^\+\d{8,15}$/;
const USER_JID_SUFFIX = "@s.whatsapp.net";
const LID_JID_SUFFIX = "@lid";
const HOSTED_LID_JID_SUFFIX = "@hosted.lid";
const QR_FILENAME = "qr.txt";
const QR_TTL_MS = 90_000;
const OUTBOUND_CHUNK_SIZE = 4000;
const PRESENCE_REFRESH_MS = 8_000;

/**
 * How long a successfully-resolved WhatsApp Web client version is cached
 * before we re-fetch from the upstream sources. WhatsApp updates web.whatsapp
 * .com on a roughly weekly cadence, so 12 hours is small enough to keep us
 * out of the "stale → 405" failure mode but large enough to avoid hammering
 * the CDN on every reconnect.
 */
const WA_VERSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Reconnect tunables. Initial 1 s, double per attempt, cap at 60 s, plus a
 * small jitter so multiple processes restarting simultaneously do not
 * thunder-herd WhatsApp's relay servers. After RECONNECT_MAX_ATTEMPTS
 * consecutive failures we surface an error state and stop retrying — hammering
 * a relay that keeps closing us is the fast path to an IP-level ban.
 */
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const RECONNECT_JITTER_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 10;

/**
 * Disconnect codes that mean the user must take action — re-pair, fix a
 * conflicting device, or contact WhatsApp. There is no point reconnecting on
 * any of these; we transition straight to "logged_out" and stop the loop.
 *
 *   401 — DisconnectReason.loggedOut
 *   403 — DisconnectReason.forbidden (account banned / IP blocked)
 *   411 — DisconnectReason.multideviceMismatch (linked-device conflict)
 */
const UNRECOVERABLE_STATUS_CODES: ReadonlySet<number> = new Set([401, 403, 411]);

/**
 * Disconnect codes that indicate WhatsApp rejected our **client version**
 * during the noise handshake. The fix is to re-fetch the latest WA Web
 * version from upstream and try again — but the symptom is identical to a
 * generic close, so we both invalidate the version cache here AND let the
 * reconnect backoff handle the retry.
 *
 *   405 — Method Not Allowed (Boom-wrapped from the noise frame decoder)
 *   515 — DisconnectReason.restartRequired (server asked us to restart)
 */
const VERSION_REJECTED_STATUS_CODES: ReadonlySet<number> = new Set([405, 515]);

/**
 * Maximum number of recently-sent WAMessage IDs we keep in memory for echo
 * deduplication. Each entry is ~40 chars; the cap is the sustained outbound
 * burst we tolerate before falling off the trailing edge of the FIFO ring.
 * 256 covers ~8 minutes of one-message-per-2-seconds activity, well beyond
 * normal pacing.
 */
const SENT_MESSAGE_ID_CAP = 256;

type RenderQrFn = (qr: string, options: { small: boolean }) => void;
type RenderQrToDataUrlFn = (
  text: string,
  options?: { width?: number; margin?: number; errorCorrectionLevel?: "L" | "M" | "Q" | "H" },
) => Promise<string>;
type FetchVersionFn = (
  options?: Record<string, unknown>,
) => Promise<{ version?: number[]; isLatest?: boolean; error?: unknown }>;

/**
 * Thrown by {@link WhatsAppAdapter.requestQR} when the adapter is in a
 * terminal `logged_out` state and cannot accept a fresh QR attempt without
 * a session reset (auth-dir deletion). Carries no recovery path inside the
 * adapter — callers (the dashboard's WhatsApp settings page, the setup
 * wizard) detect this error via `instanceof` and surface a "Reset session"
 * CTA so the operator can remove the auth bundle and re-pair from scratch.
 */
export class WhatsAppLoggedOutError extends Error {
  readonly code = "logged_out_requires_reset" as const;
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppLoggedOutError";
  }
}

export type WhatsAppConnectionState =
  | "disabled"
  | "connecting"
  | "awaiting_qr"
  | "ok"
  | "disconnected"
  | "logged_out";

export interface WhatsAppQrSnapshot {
  /** The raw payload Baileys produced — what the QR pixels actually encode. */
  payload: string;
  /** Pre-rendered scannable PNG, ready for `<img src=...>`. */
  dataUrl: string;
  /** ms since epoch when the snapshot was generated. */
  generatedAt: number;
  /** Best-effort ms-since-epoch when this QR will rotate (Baileys rotates ~20s). */
  expiresAt: number;
}

export interface WhatsAppAdapterOptions {
  ownerPhone: string;
  authDir: string;
  onMessage: OnMessageCallback;
  onLoggedOut?: () => Promise<void> | void;
  /** Phase 2: canonical attachment store for inbound media download/ingest
   *  and outbound file delivery. When absent, media is silently skipped. */
  attachmentStore?: AttachmentStore;
}

interface AuthStateBundle {
  state: unknown;
  saveCreds: () => Promise<void>;
}

export function toWhatsAppJid(phone: string): string {
  if (!OWNER_PHONE_RE.test(phone)) {
    throw new Error(
      `Invalid WhatsApp owner phone "${phone}". Expected E.164 format like +818012345678`,
    );
  }
  return `${phone.slice(1)}${USER_JID_SUFFIX}`;
}

function normalizeWhatsAppUserJid(jid: string | null | undefined): string | null {
  if (typeof jid !== "string") return null;
  const at = jid.indexOf("@");
  if (at <= 0) return null;
  const local = jid.slice(0, at);
  const server = jid.slice(at + 1);
  const user = local.split(":")[0]?.split("_")[0];
  if (!user || !server) return null;
  return `${user}@${server}`;
}

function isDirectUserJid(jid: string): boolean {
  const normalized = normalizeWhatsAppUserJid(jid);
  return normalized !== null
    && (
      normalized.endsWith(USER_JID_SUFFIX)
      || normalized.endsWith(LID_JID_SUFFIX)
      || normalized.endsWith(HOSTED_LID_JID_SUFFIX)
    );
}

export function extractWhatsAppText(message: Record<string, unknown> | null | undefined): string | null {
  if (!message) return null;
  const direct = message.conversation;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }
  const extended = (message.extendedTextMessage as { text?: unknown } | undefined)?.text;
  if (typeof extended === "string" && extended.trim()) {
    return extended;
  }
  const nestedKeys = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
  ] as const;
  for (const key of nestedKeys) {
    const nested = message[key] as { message?: Record<string, unknown> } | undefined;
    const nestedText = extractWhatsAppText(nested?.message);
    if (nestedText) {
      return nestedText;
    }
  }
  return null;
}

function parseMediaLength(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function unwrapWhatsAppMessage(
  message: Record<string, unknown> | null,
): Record<string, unknown> | null {
  let current = message;
  for (let i = 0; i < 5; i += 1) {
    if (!current) return null;
    const wrapper =
      (current.ephemeralMessage as { message?: Record<string, unknown> } | undefined)
      ?? (current.viewOnceMessage as { message?: Record<string, unknown> } | undefined)
      ?? (current.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined)
      ?? (current.viewOnceMessageV2Extension as { message?: Record<string, unknown> } | undefined)
      ?? (current.documentWithCaptionMessage as { message?: Record<string, unknown> } | undefined);
    if (!wrapper?.message) return current;
    current = wrapper.message;
  }
  /* v8 ignore next 2 — only reached with > 5 wrapper levels (not seen in practice) */
  return current;
}

/**
 * WhatsAppAdapter — Baileys-based owner-only WhatsApp DM integration.
 *
 * Phase 1 accepts messages from exactly one configured owner JID.
 */
export class WhatsAppAdapter implements MessageAdapter {
  readonly platformName = "whatsapp";
  readonly primaryRecipient: string;

  private readonly authDir: string;
  private readonly onMessage: OnMessageCallback;
  private readonly onLoggedOut: (() => Promise<void> | void) | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sock: any = null;
  private authState: AuthStateBundle | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private makeWASocket: ((options: any) => any) | null = null;
  private renderQr: RenderQrFn | null = null;
  private renderQrToDataUrl: RenderQrToDataUrlFn | null = null;
  private fetchLatestWaWebVersion: FetchVersionFn | null = null;
  private fetchLatestBaileysVersion: FetchVersionFn | null = null;
  private generateMessageId: (() => string) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private downloadMediaMessage: ((msg: any, type: "buffer", opts?: any) => Promise<Buffer>) | null = null;
  private readonly attachmentStore: AttachmentStore | null;
  /**
   * WhatsApp now often addresses the owner's own account as an LID
   * (`<opaque>@lid`) instead of a phone-number JID. We learn that alias from
   * auth creds and treat it as equivalent to the configured owner phone.
   */
  private ownerLidRecipient: string | null = null;
  /**
   * IDs of WAMessages this adapter has sent on the current Baileys socket.
   * Used to filter Baileys' echo of our own outbound messages out of the
   * incoming `messages.upsert` stream — see {@link handleIncomingMessage}.
   * Bounded to {@link SENT_MESSAGE_ID_CAP} entries with FIFO eviction so a
   * runaway send loop can never grow this unbounded.
   */
  private readonly sentMessageIds = new Set<string>();
  private loggedOutCode: number | null = null;
  private connectionState: WhatsAppConnectionState = "disabled";
  private shuttingDown = false;
  /**
   * Set while we are intentionally tearing down the current Baileys socket
   * (closeSocket → sock.end() → synchronous `connection.update` re-entry).
   * Without this flag, the close handler would treat the close as a network
   * failure and schedule a reconnect, racing against the legitimate next
   * `connect()` call and ultimately causing WhatsApp to reject one of the
   * sessions with `stream:error type="replaced"` (conflict).
   */
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private qrExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Outstanding presence-refresh interval. Tracked at the adapter level
   * (rather than only inside the `beginProcessingIndicator` closure) so
   * `stop()` can cancel it. Without this, an adapter teardown that races
   * an in-flight processing indicator would leave `sendPresence("composing")`
   * firing every {@link PRESENCE_REFRESH_MS} against a torn-down socket —
   * one `Error: socket disconnected` per tick until GC reclaimed the
   * closure. Only one indicator can be live at a time (the dispatcher
   * begins one indicator per inbound message and awaits its stop before
   * the next), so a single field is enough.
   */
  private presenceInterval: ReturnType<typeof setInterval> | null = null;
  private latestQr: WhatsAppQrSnapshot | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private cachedWAVersion: number[] | null = null;
  private cachedWAVersionAt = 0;

  constructor(options: WhatsAppAdapterOptions) {
    this.primaryRecipient = toWhatsAppJid(options.ownerPhone);
    this.authDir = options.authDir;
    this.onMessage = options.onMessage;
    this.onLoggedOut = options.onLoggedOut ?? null;
    this.attachmentStore = options.attachmentStore ?? null;
  }

  getStatus(): WhatsAppConnectionState {
    return this.connectionState;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * User-visible error derived from the current connection state.
   *
   * `lastError` is the diagnostic record of the most recent failure and stays
   * set across recovery (it's only cleared on `connection === "open"` or via
   * the user-initiated {@link requestQR}). Surfacing it raw to the dashboard
   * means a transient version-rejection (e.g. WhatsApp returning 515 on the
   * first connect, then accepting the second) renders a persistent red alert
   * underneath the QR while pairing is actually proceeding normally.
   *
   * Rule: errors are only "real" when there's no recovery in flight.
   *   - `ok` / `connecting` / `awaiting_qr` / `disabled` → null (active or
   *     transitioning). `disabled` covers the pre-connect window during
   *     {@link start}'s awaits.
   *   - `logged_out` → terminal, surface the error.
   *   - `disconnected` → if a reconnect timer is pending, recovery is in
   *     flight; otherwise we've either hit `RECONNECT_MAX_ATTEMPTS` or the
   *     adapter is between attempts with no scheduled retry, both of which
   *     are real, user-actionable failures.
   */
  getStatusError(): string | null {
    switch (this.connectionState) {
      case "ok":
      case "connecting":
      case "awaiting_qr":
      case "disabled":
        return null;
      case "logged_out":
        return this.lastError ?? "WhatsApp logged out";
      case "disconnected":
        if (this.reconnectTimer !== null) return null;
        return this.lastError ?? "WhatsApp disconnected";
      /* v8 ignore next 2 — default branch unreachable with correctly typed connectionState */
      default:
        return this.lastError;
    }
  }

  getNotificationRuntimeStatus(): NotificationRuntimeStatus {
    const error = this.getStatusError();
    if (error !== null) {
      return { runtimeState: "error", error };
    }
    switch (this.connectionState) {
      case "ok":
        return { runtimeState: "ok", error: null };
      case "connecting":
      case "awaiting_qr":
      case "disabled":
        // `disabled` is the pre-connect window during {@link start}'s awaits
        // (loadDependencies / ensureAuthState). Mapping it to "error" briefly
        // rendered red on /health polled during that window.
        return { runtimeState: "connecting", error: null };
      case "disconnected":
        // getStatusError returned null → reconnect timer is pending, so this
        // is a transient gap, not a failure. Treat as connecting.
        return { runtimeState: "connecting", error: null };
      /* v8 ignore next 2 — default branch unreachable with correctly typed connectionState */
      default:
        return { runtimeState: "connecting", error: null };
    }
  }

  async requestQR(): Promise<void> {
    // P2-11: a fresh `connect()` from a `logged_out` state cannot succeed
    // — WhatsApp's relays reject the same auth bundle and the adapter
    // bounces straight back to `logged_out`. Worse, retrying repeatedly
    // is the fast path to an IP-level rate limit. Surface the terminal
    // state to the dashboard so it can show a "Reset session" CTA
    // instead of silently burning attempts. The user clears the auth
    // dir via the dashboard's reset flow (which deletes
    // {@link authDir}); a subsequent requestQR() then succeeds because
    // ensureAuthState() loads a fresh bundle.
    if (this.connectionState === "logged_out") {
      throw new WhatsAppLoggedOutError(
        this.lastError
          ?? "WhatsApp session is logged out — reset the session to re-pair",
      );
    }
    // User-initiated retry: clear any previous failure state and the
    // backoff counter so the dashboard's "Refresh QR" button always gets a
    // fresh attempt instead of inheriting the last reconnect's exhaustion.
    this.shuttingDown = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.loadDependencies();
      this.ensureAuthDir();
      await this.ensureAuthState();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    if (this.sock && this.connectionState === "ok") {
      return;
    }
    if (this.sock) {
      this.closeSocket();
    }
    try {
      await this.connect();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Trigger QR generation (if needed) and wait up to `timeoutMs` for a fresh
   * scannable QR. Returns the snapshot once available, or `null` on timeout /
   * if pairing completes without a QR (already logged in).
   */
  async waitForQr(timeoutMs = 10_000): Promise<WhatsAppQrSnapshot | null> {
    // connectionState may be mutated by async Baileys callbacks; treat the
    // field as a runtime value, not a TS-narrowed literal across awaits.
    if ((this.connectionState as WhatsAppConnectionState) === "ok") {
      return null;
    }
    if (this.latestQr && Date.now() - this.latestQr.generatedAt < QR_TTL_MS) {
      return this.latestQr;
    }

    await this.requestQR();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.connectionState as WhatsAppConnectionState;
      if (state === "ok") return null;
      if (state === "logged_out") return null;
      if (this.latestQr) return this.latestQr;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.latestQr;
  }

  /** Returns the rendered scannable QR data URL, or `null` if no QR is current. */
  getQrSnapshot(): WhatsAppQrSnapshot | null {
    if (!this.latestQr) return null;
    if (Date.now() - this.latestQr.generatedAt > QR_TTL_MS) {
      return null;
    }
    return this.latestQr;
  }


  async start(): Promise<void> {
    if (this.sock) return;
    this.shuttingDown = false;
    this.reconnectAttempts = 0;
    await this.loadDependencies();
    this.ensureAuthDir();
    await this.ensureAuthState();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // P2-09: cancel any presence-refresh interval still in flight so
    // sendPresence("composing") doesn't keep firing against the torn-down
    // socket. The closure inside beginProcessingIndicator owns its `stopped`
    // flag, so a subsequent stop() from the indicator's own caller is a
    // safe no-op after this.
    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }
    this.reconnectAttempts = 0;
    this.sentMessageIds.clear();
    this.clearQrSnapshot();
    this.clearQrFile();
    this.closeSocket();
    this.connectionState = "disabled";
    logger.info("WhatsApp adapter disconnected");
  }

  async sendMessage(params: {
    channel: string;
    text: string;
    threadId?: string;
    attachments?: OutboundAttachmentRef[];
  }): Promise<{ messageId?: string }> {
    if (!this.sock || this.connectionState !== "ok") {
      throw new Error("WhatsApp socket is not connected");
    }

    const { channel, text, attachments } = params;

    if (!attachments?.length) {
      // Text only — existing behaviour.
      return this.sendWhatsAppText(channel, text);
    }

    // Text + attachments. WhatsApp supports caption on image/document/video
    // calls, but audio/sticker have no caption field. Strategy:
    //   - if text ≤ 1024 chars: use text as caption on the first attachment
    //     (no separate text message)
    //   - otherwise: send text in chunks first, then attachments bare.
    // Baileys is one-media-per-send, so we always loop.
    const captionText = text.length <= WA_CAPTION_MAX_CHARS ? text : null;
    let lastMessageId: string | undefined;

    if (!captionText && text) {
      const result = await this.sendWhatsAppText(channel, text);
      lastMessageId = result.messageId;
    }

    let isFirst = true;
    for (const att of attachments) {
      const caption = isFirst && captionText ? captionText : undefined;
      isFirst = false;
      try {
        const { readFileSync: rfs } = await import("node:fs");
        const buf = rfs(att.path);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let mediaPayload: any;

        if (att.mimeType.startsWith("image/")) {
          mediaPayload = { image: buf, mimetype: att.mimeType, caption };
        } else {
          mediaPayload = {
            document: buf,
            mimetype: att.mimeType,
            fileName: att.originalFilename,
            caption,
          };
        }

        const preId = this.generateMessageId?.() ?? null;
        if (preId) this.rememberSentMessageId(preId);

        const result = await this.sock.sendMessage(
          channel,
          mediaPayload,
          preId ? { messageId: preId } : undefined,
        );

        const actualId = result?.key?.id;
        if (typeof actualId === "string" && actualId !== preId) {
          this.rememberSentMessageId(actualId);
        }
        lastMessageId = (typeof actualId === "string" ? actualId : preId) ?? lastMessageId;
      } catch (err) {
        logger.error(
          { err, channel, filename: att.originalFilename },
          "Failed to send WhatsApp attachment",
        );
      }
    }

    return { messageId: lastMessageId };
  }

  /**
   * Send a plain-text reply, splitting at {@link OUTBOUND_CHUNK_SIZE} so we
   * stay under WhatsApp's ~4096-char per-message ceiling. Splits are
   * fence-aware and surrogate-safe (see {@link splitOutboundText}). When the
   * payload is chunked we emit a `wa outbound chunked` debug line so ops
   * can reconcile a single agent reply that lands as multiple WhatsApp
   * messages — the previous silent chunking made it look like the agent
   * had repeated itself.
   */
  private async sendWhatsAppText(
    channel: string,
    text: string,
  ): Promise<{ messageId?: string }> {
    const chunks = splitOutboundText(text, OUTBOUND_CHUNK_SIZE);
    if (chunks.length > 1) {
      logger.debug(
        { chunks: chunks.length, totalChars: text.length },
        "wa outbound chunked",
      );
    }
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      // Pre-generate the WAMessage id so we can register it BEFORE Baileys
      // begins emitting `messages.upsert` for the outbound. Without this,
      // a self-DM reply could race past the dedup set and be re-ingested
      // as if the user had sent it, looping the agent on its own replies.
      const preId = this.generateMessageId?.() ?? null;
      if (preId) this.rememberSentMessageId(preId);

      const result = await this.sock.sendMessage(
        channel,
        { text: chunk },
        preId ? { messageId: preId } : undefined,
      );

      // If something between us and the test mock didn't honor our
      // pre-generated id, fall back to the id Baileys actually used and
      // record that one as well — better to over-dedup than under-dedup.
      const actualId = result?.key?.id;
      if (typeof actualId === "string" && actualId !== preId) {
        this.rememberSentMessageId(actualId);
      }

      lastMessageId = (typeof actualId === "string" ? actualId : preId) ?? lastMessageId;
    }
    return { messageId: lastMessageId };
  }

  async beginProcessingIndicator(params: {
    channel: string;
    threadId?: string;
  }): Promise<ProcessingIndicatorHandle> {
    let stopped = false;
    const sendPresence = async (state: "composing" | "paused"): Promise<void> => {
      if (!this.sock || this.connectionState !== "ok") {
        return;
      }
      if (typeof this.sock.sendPresenceUpdate !== "function") {
        return;
      }
      try {
        await this.sock.sendPresenceUpdate(state, params.channel);
      } catch (err) {
        logger.debug(
          {
            channel: params.channel,
            state,
            error: err instanceof Error ? err.message : String(err),
          },
          "Failed to update WhatsApp presence",
        );
      }
    };

    await sendPresence("composing");
    // P2-09: clear any previously-active interval before claiming the slot.
    // The dispatcher invariant is "one indicator at a time per channel",
    // so this branch only triggers if a prior indicator's stop() was
    // skipped (e.g. crashed callsite); cancelling defensively is cheap
    // and prevents stacking firing intervals.
    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
    }
    const interval = setInterval(() => {
      void sendPresence("composing");
    }, PRESENCE_REFRESH_MS);
    interval.unref?.();
    this.presenceInterval = interval;

    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        if (this.presenceInterval === interval) {
          this.presenceInterval = null;
        }
        await sendPresence("paused");
      },
    };
  }

  private async loadDependencies(): Promise<void> {
    if (
      this.makeWASocket
      && this.renderQr
      && this.renderQrToDataUrl
      && this.fetchLatestWaWebVersion
      && this.fetchLatestBaileysVersion
      && this.generateMessageId
      && this.downloadMediaMessage
    ) {
      return;
    }

    const installHint =
      "Run: pnpm --filter @aitne/daemon add @whiskeysockets/baileys qrcode-terminal qrcode";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let baileys: any;
    try {
      baileys = await import("@whiskeysockets/baileys" as string);
    /* v8 ignore next 4 — packages always installed in production; catch only reachable when package is absent */
    } catch (err) {
      logger.error({ err }, "Failed to load @whiskeysockets/baileys");
      throw new Error(`@whiskeysockets/baileys not installed. ${installHint}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let qrTermModule: any;
    try {
      qrTermModule = await import("qrcode-terminal" as string);
    /* v8 ignore next 4 — packages always installed in production; catch only reachable when package is absent */
    } catch (err) {
      logger.error({ err }, "Failed to load qrcode-terminal");
      throw new Error(`qrcode-terminal not installed. ${installHint}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let qrModule: any;
    try {
      qrModule = await import("qrcode" as string);
    /* v8 ignore next 4 — packages always installed in production; catch only reachable when package is absent */
    } catch (err) {
      logger.error({ err }, "Failed to load qrcode");
      throw new Error(`qrcode not installed. ${installHint}`);
    }

    const makeWASockFn = typeof baileys.default === "function" ? baileys.default : /* v8 ignore next */ baileys.makeWASocket;
    /* v8 ignore next 1 — makeWASockFn is always truthy when Baileys is correctly installed */
    this.makeWASocket = makeWASockFn ?? null;
    /* v8 ignore next 3 — unreachable when Baileys exposes the expected API */
    if (!this.makeWASocket || typeof baileys.useMultiFileAuthState !== "function") {
      throw new Error("Baileys module does not expose the expected API");
    }

    const qrTermLib = /* v8 ignore next */ qrTermModule.default ?? qrTermModule;
    /* v8 ignore next 3 — unreachable when qrcode-terminal exposes generate() */
    if (!qrTermLib || typeof qrTermLib.generate !== "function") {
      throw new Error("qrcode-terminal module does not expose generate()");
    }
    this.renderQr = qrTermLib.generate.bind(qrTermLib) as RenderQrFn;

    const qrLib = /* v8 ignore next */ qrModule.default ?? qrModule;
    /* v8 ignore next 3 — unreachable when qrcode exposes toDataURL() */
    if (!qrLib || typeof qrLib.toDataURL !== "function") {
      throw new Error("qrcode module does not expose toDataURL()");
    }
    this.renderQrToDataUrl = qrLib.toDataURL.bind(qrLib) as RenderQrToDataUrlFn;

    const loggedOutRaw = baileys.DisconnectReason?.loggedOut;
    this.loggedOutCode = typeof loggedOutRaw === "number" ? loggedOutRaw : /* v8 ignore next */ 401;

    // Resolvers for the live WhatsApp Web client version. We capture both:
    // `fetchLatestWaWebVersion` reads web.whatsapp.com's own sw.js (the most
    // authoritative source — it's literally what the desktop client downloads),
    // and `fetchLatestBaileysVersion` falls back to the Baileys master branch
    // when WhatsApp's CDN is unreachable. Both helpers internally fall back to
    // the bundled default if their network call fails, so we never throw.
    if (typeof baileys.fetchLatestWaWebVersion === "function") {
      this.fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion as FetchVersionFn;
    /* v8 ignore next 3 — null branch only reachable with a Baileys build that omits this helper */
    } else {
      this.fetchLatestWaWebVersion = null;
    }
    if (typeof baileys.fetchLatestBaileysVersion === "function") {
      this.fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion as FetchVersionFn;
    /* v8 ignore next 3 — null branch only reachable with a Baileys build that omits this helper */
    } else {
      this.fetchLatestBaileysVersion = null;
    }

    // Pre-generated WAMessage IDs let us register an outbound id BEFORE
    // calling sock.sendMessage, which closes the race window with the
    // `messages.upsert` Baileys emits via process.nextTick for our own
    // outbound (see Baileys' Socket/messages-send.js → emitOwnEvents).
    // Without this we'd risk treating our own reply as a fresh user message
    // and feedback-looping the daemon.
    if (typeof baileys.generateMessageID === "function") {
      this.generateMessageId = baileys.generateMessageID as () => string;
    /* v8 ignore next 4 — generateMessageIDV2 path for older Baileys versions */
    } else if (typeof baileys.generateMessageIDV2 === "function") {
      this.generateMessageId = () =>
        (baileys.generateMessageIDV2 as (userId?: string) => string)();
    }

    // Phase 2 inbound media download helper.
    if (typeof baileys.downloadMediaMessage === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.downloadMediaMessage = baileys.downloadMediaMessage as (msg: any, type: "buffer", opts?: any) => Promise<Buffer>;
    /* v8 ignore next 3 — null branch only reachable with a Baileys build that omits this helper */
    } else {
      this.downloadMediaMessage = null;
    }
  }

  private ensureAuthDir(): void {
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
  }

  private async ensureAuthState(): Promise<void> {
    if (this.authState) {
      return;
    /* v8 ignore next 9 — real Baileys auth state is always pre-injected in tests; this branch only runs in production */
    } else {
      const baileys = await import("@whiskeysockets/baileys" as string);
      const bundle = await baileys.useMultiFileAuthState(this.authDir);
      this.authState = {
        state: bundle.state,
        saveCreds: bundle.saveCreds,
      };
      this.syncOwnerIdentityFromAuthState();
    }
  }

  /**
   * Resolve the WhatsApp Web client version we should advertise during the
   * noise handshake. Cached for {@link WA_VERSION_TTL_MS}; on cache miss we
   * try the live sources in order, falling back to `undefined` (which lets
   * Baileys use its bundled default) if everything fails.
   *
   * Why: Baileys 7.0.0-rc.9 ships with a hard-coded `[2, 3000, 1027934701]`
   * which WhatsApp's relays began rejecting with status 405 (`Method Not
   * Allowed` from the noise frame decoder). Without this resolution every
   * `connect()` failed before a QR could be emitted, leaving the dashboard
   * stuck on "Pairing…".
   */
  private async resolveWAVersion(): Promise<number[] | undefined> {
    const now = Date.now();
    if (this.cachedWAVersion && now - this.cachedWAVersionAt < WA_VERSION_TTL_MS) {
      return this.cachedWAVersion;
    }

    const tryResolve = async (
      fn: FetchVersionFn | null,
      label: string,
    ): Promise<number[] | null> => {
      if (!fn) return null;
      try {
        const result = await fn();
        if (
          result?.isLatest
          && Array.isArray(result.version)
          && result.version.length === 3
          && result.version.every((n) => typeof n === "number" && Number.isFinite(n))
        ) {
          logger.info({ source: label, version: result.version }, "resolved WhatsApp Web version");
          return result.version;
        }
        logger.debug(
          { source: label, isLatest: result?.isLatest, error: result?.error },
          "WhatsApp Web version source returned no fresh version",
        );
        return null;
      } catch (err) {
        logger.warn({ err, source: label }, "WhatsApp Web version source threw");
        return null;
      }
    };

    // Authoritative source first; Baileys master branch as a backup.
    const version =
      (await tryResolve(this.fetchLatestWaWebVersion, "wa-web-sw"))
      ?? (await tryResolve(this.fetchLatestBaileysVersion, "baileys-master"));

    if (version) {
      this.cachedWAVersion = version;
      this.cachedWAVersionAt = now;
      return version;
    }

    logger.warn("falling back to Baileys bundled WhatsApp Web version");
    return undefined;
  }

  private invalidateWAVersionCache(): void {
    if (this.cachedWAVersion) {
      logger.info({ previous: this.cachedWAVersion }, "invalidating cached WhatsApp Web version");
    }
    this.cachedWAVersion = null;
    this.cachedWAVersionAt = 0;
  }

  /**
   * Record a WAMessage id we just generated for an outbound send so the
   * matching `messages.upsert` echo can be filtered out by
   * {@link handleIncomingMessage}.
   *
   * Bounded with FIFO eviction (Sets preserve insertion order in ES2015+).
   * Eviction loss is harmless: it just means a stale id we no longer care
   * about ages out, never that we drop a real user message.
   */
  private rememberSentMessageId(id: string): void {
    if (!id) return;
    if (this.sentMessageIds.has(id)) return;
    if (this.sentMessageIds.size >= SENT_MESSAGE_ID_CAP) {
      const oldest = this.sentMessageIds.values().next().value;
      if (oldest !== undefined) this.sentMessageIds.delete(oldest);
    }
    this.sentMessageIds.add(id);
  }

  /**
   * Returns true (and removes the id) iff the given id was previously
   * registered via {@link rememberSentMessageId}. Used as a one-shot
   * "is this our own echo?" check; consuming on hit keeps the set lean and
   * avoids re-matching if WhatsApp ever redelivers the same key.
   */
  private consumeSentMessageId(id: string | null | undefined): boolean {
    if (typeof id !== "string" || id.length === 0) return false;
    return this.sentMessageIds.delete(id);
  }

  private async connect(): Promise<void> {
    if (!this.makeWASocket || !this.authState) {
      throw new Error("WhatsApp adapter dependencies are not initialized");
    }

    this.connectionState = "connecting";
    logger.info("whatsapp connecting");

    const version = await this.resolveWAVersion();
    // shuttingDown may have flipped while we awaited the version resolver —
    // bail out cleanly so we don't leak a fresh socket the caller can't see.
    if (this.shuttingDown) {
      this.connectionState = "disabled";
      logger.info("whatsapp connect aborted: shutting down");
      return;
    }

    const sock = this.makeWASocket({
      auth: this.authState.state,
      printQRInTerminal: false,
      // `markOnlineOnConnect: true` registers our session as an *active*
      // device with WhatsApp's relays. WhatsApp routes new messages to
      // active devices first; if every linked device is `unavailable` the
      // message may simply not be pushed to us, which is exactly what
      // happens when this is left at `false` — incoming DMs (including
      // self-DMs) silently never arrive at the daemon. The cosmetic cost
      // is that the user's contacts see one more "online" device, which
      // for a personal agent is exactly what we want anyway.
      markOnlineOnConnect: true,
      // Skip Baileys' initial-history-sync window. With the default
      // (`syncFullHistory: true`), Baileys enters `AwaitingInitialSync`
      // for ~20 s after every connect, buffering all `messages.upsert`
      // events behind a "history sync" gate. We don't care about
      // historical messages — only new ones from this point forward —
      // so we turn the gate off entirely. `shouldSyncHistoryMessage` is
      // a defensive belt-and-braces in case some inner loop still
      // consults it during a partial sync.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      /* v8 ignore next 1 — both truthy and falsy version paths tested; V8 ternary branch merge artefact */
      ...(version ? { version } : {}),
    });
    this.sock = sock;
    // P2-10: clear the self-echo dedup set on every fresh socket. WAMessage
    // ids are unique per session, so any id left over from the previous
    // socket would mis-classify an incoming message as our own echo if (in
    // practice, never) WhatsApp redelivered it on the new socket. More
    // importantly, the set used to grow unboundedly across long-lived
    // adapters with frequent reconnects — only `stop()` reset it, and a
    // daemon that lives weeks between restarts accumulates the full
    // outbound history. Even with the FIFO cap, every reconnect deserves
    // a fresh window because previous-socket ids are no longer ours to
    // dedup.
    this.sentMessageIds.clear();

    sock.ev.on("creds.update", this.authState.saveCreds);
    sock.ev.on("creds.update", (update: unknown) => {
      this.captureOwnerIdentity(update);
    });
    sock.ev.on("messages.upsert", (payload: unknown) => {
      this.handleMessagesUpsert(payload);
    });
    sock.ev.on("connection.update", (update: unknown) => {
      void this.handleConnectionUpdate(update, sock);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleConnectionUpdate(update: any, sock: any): Promise<void> {
    if (sock !== this.sock) return;

    if (typeof update?.qr === "string") {
      this.connectionState = "awaiting_qr";
      try {
        if (this.renderQr) {
          this.renderQr(update.qr, { small: true });
        }
        await this.captureQr(update.qr);
      } catch (err) {
        logger.error({ err }, "Failed to render WhatsApp QR");
      }
    }

    if (update?.connection === "open") {
      this.syncOwnerIdentityFromAuthState();
      this.connectionState = "ok";
      this.lastError = null;
      this.reconnectAttempts = 0;
      this.clearQrSnapshot();
      this.clearQrFile();
      logger.info("whatsapp connected");
      return;
    }

    if (update?.connection !== "close") {
      return;
    }

    // Synchronous re-entry from our own closeSocket → sock.end() flow. Bail
    // out cleanly so we don't double-close (closeSocket is mid-execution
    // already) and don't classify the close as a network failure.
    if (this.intentionalClose) {
      return;
    }

    const statusCode =
      update?.lastDisconnect?.error?.output?.statusCode
      ?? update?.lastDisconnect?.error?.data?.statusCode
      ?? null;

    this.closeSocket();
    this.clearQrSnapshot();
    this.clearQrFile();

    // Logged out / banned / multidevice mismatch — re-pairing is required.
    // Reconnecting on these is not just useless, it's the fastest way to
    // earn an IP-level rate limit, so we stop the loop entirely.
    const isLoggedOut =
      statusCode === this.loggedOutCode
      || (typeof statusCode === "number" && UNRECOVERABLE_STATUS_CODES.has(statusCode));
    if (isLoggedOut) {
      this.connectionState = "logged_out";
      /* v8 ignore next 1 — statusCode is always a number when isLoggedOut=true */
      this.lastError = `WhatsApp logged out (status ${statusCode ?? "unknown"}) — re-pair required`;
      this.reconnectAttempts = 0;
      logger.error({ statusCode }, "whatsapp connection closed: logged out");
      if (this.onLoggedOut) {
        try {
          await this.onLoggedOut();
        } catch (err) {
          logger.error({ err }, "Failed to notify about WhatsApp logout");
        }
      }
      return;
    }

    if (this.shuttingDown) {
      this.connectionState = "disabled";
      this.reconnectAttempts = 0;
      return;
    }

    // Version-rejection codes mean WhatsApp doesn't accept the client version
    // we advertised. Drop the cache so the next connect re-fetches a fresh
    // version, then fall through to the normal backoff path.
    if (typeof statusCode === "number" && VERSION_REJECTED_STATUS_CODES.has(statusCode)) {
      logger.warn(
        { statusCode },
        "WhatsApp rejected our client version; refetching latest on next attempt",
      );
      this.invalidateWAVersionCache();
      this.lastError = `WhatsApp rejected client version (status ${statusCode})`;
    } else {
      this.lastError =
        statusCode != null
          ? `WhatsApp connection closed (status ${statusCode})`
          : "WhatsApp connection closed";
    }

    this.connectionState = "disconnected";
    logger.info(
      { statusCode, attempt: this.reconnectAttempts + 1 },
      "whatsapp connection closed; scheduling reconnect",
    );
    this.scheduleReconnect();
  }

  /**
   * Schedule the next reconnect attempt with full-jitter exponential backoff.
   *
   * - Delay: `min(initial * factor^attempt, max) + random(0, jitter)`
   * - Cap: after {@link RECONNECT_MAX_ATTEMPTS} consecutive failures the loop
   *   stops and the adapter sits in `disconnected` until something external
   *   (e.g. the dashboard's "Refresh QR" button → `requestQR()`) restarts it.
   *
   * Why a hard cap: when WhatsApp is blocking us (bad version, throttled IP,
   * regional outage) every retry burns CPU and risks escalating the block.
   * Better to surface the error and let the user decide whether to wait it
   * out or rotate IP / re-pair.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown) return;
    if (this.connectionState === "logged_out") return;

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      const previousError = this.lastError ?? "unknown error";
      this.lastError = `WhatsApp reconnect gave up after ${RECONNECT_MAX_ATTEMPTS} attempts (${previousError})`;
      logger.error(
        { attempts: this.reconnectAttempts, lastError: previousError },
        "whatsapp reconnect: max attempts exceeded",
      );
      return;
    }

    const exponential = Math.min(
      RECONNECT_INITIAL_DELAY_MS * RECONNECT_BACKOFF_FACTOR ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
    const delayMs = exponential + jitter;

    this.reconnectAttempts += 1;
    logger.info(
      { attempt: this.reconnectAttempts, delayMs },
      "whatsapp reconnect scheduled",
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown || this.connectionState === "logged_out") {
        return;
      }
      void this.connect().catch((err) => {
        // connect() throws synchronously on a misconfigured adapter; the
        // close-event path can't recover that, so we have to feed the loop
        // ourselves. Errors here are already counted in reconnectAttempts.
        logger.error({ err }, "whatsapp reconnect attempt threw");
        this.connectionState = "disconnected";
        this.lastError = err instanceof Error ? err.message : String(err);
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private handleMessagesUpsert(payload: unknown): void {
    const messages = Array.isArray((payload as { messages?: unknown[] } | null)?.messages)
      ? (payload as { messages: unknown[] }).messages
      : [];

    for (const message of messages) {
      void this.handleIncomingMessage(message).catch((err) => {
        logger.error({ err }, "whatsapp incoming message handler threw");
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleIncomingMessage(rawMessage: any): Promise<void> {
    const remoteJid: unknown = rawMessage?.key?.remoteJid;
    const messageId: unknown = rawMessage?.key?.id;
    const fromMe = rawMessage?.key?.fromMe === true;

    // `fromMe: true` covers two very different cases on a personal-agent
    // WhatsApp setup that uses the owner's own number:
    //
    //   1. The daemon's own outbound message echoing back through Baileys'
    //      `messages.upsert` (Baileys emits these via process.nextTick when
    //      `emitOwnEvents: true`, which is the default).
    //   2. The owner sending a self-DM from another linked device — this is
    //      the natural way the owner talks to their own agent without
    //      maintaining a second WhatsApp account.
    //
    // We want to drop case 1 and process case 2. The two are indistinguishable
    // by JID alone (both use the owner's JID as `remoteJid`), so we tell them
    // apart by message id: every id this adapter generates for an outbound
    // send is registered in `sentMessageIds`, and we consume-on-match here.
    if (fromMe) {
      if (this.consumeSentMessageId(typeof messageId === "string" ? messageId : null)) {
        // Our own echo — already accounted for. Nothing to do.
        return;
      }
      logger.debug(
        { remoteJid, messageId },
        "whatsapp ingesting fromMe message (self-DM from another linked device)",
      );
    }

    if (typeof remoteJid !== "string" || !isDirectUserJid(remoteJid)) {
      logger.debug({ remoteJid }, "whatsapp message dropped: non-dm jid");
      return;
    }

    // For both inbound (`fromMe:false`) DMs and self-DMs (`fromMe:true`),
    // `remoteJid` is the chat partner — which for owner-to-owner self-DMs is
    // the owner's own JID. The check below therefore correctly accepts
    // self-DMs and rejects DMs to/from any third party.
    if (!this.isAuthorizedOwnerJid(remoteJid)) {
      logger.debug({ remoteJid }, "whatsapp message dropped: unauthorized sender");
      return;
    }

    const text = extractWhatsAppText(rawMessage?.message) ?? "";

    // Only await media extraction when the store is ready — this preserves
    // synchronous execution for the no-store path so existing tests that call
    // handleMessagesUpsert() without awaiting still work correctly.
    let attachmentRefs: AttachmentRef[] = [];
    if (this.attachmentStore && this.downloadMediaMessage) {
      attachmentRefs = await this.extractAndIngestWhatsAppMedia(rawMessage);
    }

    // Drop messages that have neither text nor supported media.
    if (!text && attachmentRefs.length === 0) {
      return;
    }

    const event: Event = createEvent({
      type: "message.received",
      source: "whatsapp",
      priority: EventPriority.HIGH,
      data: {
        waMessageId: rawMessage?.key?.id ?? null,
      },
    });

    Object.assign(event, {
      sender: this.primaryRecipient,
      channel: this.primaryRecipient,
      content: text,
      platform: "whatsapp",
      threadId: null,
      isDm: true,
      isMention: false,
      ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
    });

    this.onMessage(event);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async extractAndIngestWhatsAppMedia(rawMessage: any): Promise<AttachmentRef[]> {
    /* v8 ignore next 1 — caller already checks attachmentStore && downloadMediaMessage */
    if (!this.attachmentStore || !this.downloadMediaMessage) return [];

    const msg = unwrapWhatsAppMessage(rawMessage?.message ?? null);
    if (!msg) return [];

    const refs: AttachmentRef[] = [];

    // Image
    const imgMsg = msg.imageMessage as Record<string, unknown> | undefined;
    if (imgMsg) {
      const mimeType = (imgMsg.mimetype as string | undefined) ?? "image/jpeg";
      const fileLength = parseMediaLength(imgMsg.fileLength);
      const caption = (imgMsg.caption as string | undefined);
      if (fileLength > WA_IMAGE_MAX_BYTES) {
        logger.warn({ fileLength }, "whatsapp image exceeds 5 MB cap, skipping");
      } else {
        const ref = await this.downloadAndIngestWhatsApp(
          rawMessage,
          mimeType,
          filenameForMime("image", mimeType, "jpg"),
          WA_IMAGE_MAX_BYTES,
          caption,
        );
        if (ref) refs.push(ref);
      }
      return refs; // each message has exactly one media type
    }

    // Document
    const docMsg = msg.documentMessage as Record<string, unknown> | undefined;
    if (docMsg) {
      const mimeType = (docMsg.mimetype as string | undefined) ?? "application/octet-stream";
      const fileLength = parseMediaLength(docMsg.fileLength);
      const fileName = (docMsg.fileName as string | undefined) ?? "document";
      const caption = (docMsg.caption as string | undefined);
      if (fileLength > WA_DOCUMENT_MAX_BYTES) {
        logger.warn({ fileLength }, "whatsapp document exceeds 100 MB cap, skipping");
      } else {
        const ref = await this.downloadAndIngestWhatsApp(
          rawMessage,
          mimeType,
          fileName,
          WA_DOCUMENT_MAX_BYTES,
          caption,
        );
        if (ref) refs.push(ref);
      }
      return refs;
    }

    const audioMsg = msg.audioMessage as Record<string, unknown> | undefined;
    if (audioMsg) {
      const mimeType = (audioMsg.mimetype as string | undefined) ?? "audio/ogg";
      const fileLength = parseMediaLength(audioMsg.fileLength);
      if (fileLength > WA_AUDIO_MAX_BYTES) {
        logger.warn({ fileLength }, "whatsapp audio exceeds 16 MB cap, skipping");
      } else {
        const ref = await this.downloadAndIngestWhatsApp(
          rawMessage,
          mimeType,
          filenameForMime("audio", mimeType, "ogg"),
          WA_AUDIO_MAX_BYTES,
        );
        if (ref) refs.push(ref);
      }
      return refs;
    }

    const videoMsg = msg.videoMessage as Record<string, unknown> | undefined;
    if (videoMsg) {
      const mimeType = (videoMsg.mimetype as string | undefined) ?? "video/mp4";
      const fileLength = parseMediaLength(videoMsg.fileLength);
      const caption = (videoMsg.caption as string | undefined);
      if (fileLength > WA_VIDEO_MAX_BYTES) {
        logger.warn({ fileLength }, "whatsapp video exceeds 16 MB cap, skipping");
      } else {
        const ref = await this.downloadAndIngestWhatsApp(
          rawMessage,
          mimeType,
          filenameForMime("video", mimeType, "mp4"),
          WA_VIDEO_MAX_BYTES,
          caption,
        );
        if (ref) refs.push(ref);
      }
      return refs;
    }

    if (msg.stickerMessage) {
      logger.debug("whatsapp sticker ignored");
    }

    return refs;
  }

  private async downloadAndIngestWhatsApp(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawMessage: any,
    mimeType: string,
    filename: string,
    maxBytes: number,
    caption?: string,
  ): Promise<AttachmentRef | null> {
    /* v8 ignore next 1 — caller (extractAndIngestWhatsAppMedia) already checks both are set */
    if (!this.downloadMediaMessage || !this.attachmentStore) return null;
    let buf: Buffer;
    try {
      buf = await this.downloadMediaMessage(rawMessage, "buffer");
    } catch (err) {
      logger.error({ err }, "whatsapp downloadMediaMessage failed");
      return null;
    }

    try {
      const stream = Readable.from([buf]);
      const result = await this.attachmentStore.ingestStream({
        stream,
        declaredMimeType: mimeType,
        originalFilename: filename,
        direction: "inbound",
        provenance: "user_whatsapp",
        caption,
        maxSizeBytes: maxBytes,
      });
      return {
        id: result.id,
        originalFilename: result.originalFilename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        caption,
      };
    } catch (err) {
      logger.error({ err }, "whatsapp file ingest failed");
      return null;
    }
  }

  private captureOwnerIdentity(update: unknown): void {
    const me = (update as { me?: { lid?: unknown } } | null)?.me;
    const lid = normalizeWhatsAppUserJid(
      typeof me?.lid === "string" ? me.lid : null,
    );
    if (lid) {
      this.ownerLidRecipient = lid;
    }
  }

  private syncOwnerIdentityFromAuthState(): void {
    const me = (
      this.authState?.state as { creds?: { me?: { lid?: unknown } } } | null
    )?.creds?.me;
    const lid = normalizeWhatsAppUserJid(
      typeof me?.lid === "string" ? me.lid : null,
    );
    if (lid) {
      this.ownerLidRecipient = lid;
    }
  }

  private isAuthorizedOwnerJid(jid: string): boolean {
    const normalized = normalizeWhatsAppUserJid(jid);
    /* v8 ignore next 1 — jid already passed isDirectUserJid check, so normalized is never null here */
    if (!normalized) return false;
    if (normalized === normalizeWhatsAppUserJid(this.primaryRecipient)) {
      return true;
    }
    this.syncOwnerIdentityFromAuthState();
    return normalized === this.ownerLidRecipient;
  }

  private async captureQr(payload: string): Promise<void> {
    if (!this.renderQrToDataUrl) {
      throw new Error("qrcode renderer not initialized");
    }
    const dataUrl = await this.renderQrToDataUrl(payload, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    const now = Date.now();
    this.latestQr = {
      payload,
      dataUrl,
      generatedAt: now,
      expiresAt: now + QR_TTL_MS,
    };
    this.writeQrFile(payload);
  }

  private writeQrFile(qr: string): void {
    try {
      const qrPath = join(this.authDir, QR_FILENAME);
      writeFileSync(qrPath, qr, { mode: 0o600 });
    } catch (err) {
      logger.warn({ err }, "Failed to persist WhatsApp QR file");
    }
    if (this.qrExpiryTimer) {
      clearTimeout(this.qrExpiryTimer);
    }
    this.qrExpiryTimer = setTimeout(() => {
      this.qrExpiryTimer = null;
      this.clearQrSnapshot();
      this.clearQrFile();
    }, QR_TTL_MS);
    this.qrExpiryTimer.unref?.();
  }

  private clearQrSnapshot(): void {
    this.latestQr = null;
    if (this.qrExpiryTimer) {
      clearTimeout(this.qrExpiryTimer);
      this.qrExpiryTimer = null;
    }
  }

  private clearQrFile(): void {
    const qrPath = join(this.authDir, QR_FILENAME);
    try {
      unlinkSync(qrPath);
    } catch {
      // Ignore missing-file errors.
    }
  }

  /**
   * Close and forget the current Baileys socket.
   *
   * IMPORTANT — ordering matters: Baileys' `sock.end(error)` emits
   * `connection.update` *synchronously* from inside the call (see
   * Baileys/Socket/socket.js, the `end()` closure that does
   * `ev.emit('connection.update', { connection: 'close', ... })`). That re-
   * enters our own `handleConnectionUpdate` while we are still in the
   * middle of `closeSocket()`. We defend against this with two layers:
   *
   *  1. **Null `this.sock` first.** The handler's `if (sock !== this.sock)`
   *     guard then trivially returns: the synchronous reentry sees a stale
   *     `sock` reference and a fresh-null `this.sock`.
   *  2. **`intentionalClose` flag.** Even if some other event type fires
   *     after the null-out (e.g. a delayed ws-close on a later tick), the
   *     close handler skips the reconnect classifier path entirely.
   *
   * Without these guards the synchronous reentry was scheduling a spurious
   * reconnect timer that fired ~1 s after our deliberate close, creating a
   * second concurrent socket. WhatsApp then rejected the older session with
   * `stream:error type="replaced"`, leaving the connection unstable.
   */
  private closeSocket(): void {
    const sock = this.sock;
    if (!sock) return;
    this.sock = null;
    this.intentionalClose = true;
    // Remove application-level ev listeners before end(). Baileys' end()
    // only clears WebSocket-level listeners (ws 'close'/'open'/'message')
    // but leaves ev listeners (creds.update, messages.upsert, etc.) intact.
    // Without this, repeated reconnection cycles accumulate stale listeners
    // on the old socket's EventEmitter until the socket is garbage collected.
    try {
      sock.ev?.removeAllListeners?.();
    } catch {
      // Ignore — ev may already be torn down.
    }
    try {
      sock.ws?.close?.();
    } catch {
      // Ignore socket shutdown errors.
    }
    try {
      sock.end?.(new Error("shutdown"));
    } catch {
      // Ignore socket shutdown errors.
    }
    this.intentionalClose = false;
  }
}
