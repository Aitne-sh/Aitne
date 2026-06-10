import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import type { App } from "@slack/bolt";
import { EventPriority, createEvent } from "@aitne/shared";
import type { AttachmentRef, Event } from "@aitne/shared";
import type {
  AdapterConnectionState,
  MessageAdapter,
  OnMessageCallback,
  OutboundAttachmentRef,
} from "./types.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { createLogger } from "../logging.js";
import { splitOutboundText } from "./outbound-text.js";

type SlackApp = App;
type SlackBoltModule = typeof import("@slack/bolt");

/**
 * Wide subset of a Slack message event we read in handleMessage. Bolt models
 * `message` as a discriminated union of ~30 subtypes; we use a permissive
 * shape for the fields we actually touch and let the runtime payload carry
 * the rest verbatim.
 */
interface SlackInboundMessage {
  ts?: string;
  team?: string;
  channel?: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  files?: SlackInboundFile[];
}

interface SlackInboundFile {
  id?: string;
  name?: string;
  size?: number;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  file_access?: string;
}

const SLACK_INBOUND_MAX_BYTES = 25 * 1024 * 1024; // practical cap: 25 MB

// Slack's chat.postMessage rejects payloads above 40,000 characters
// (`msg_too_long`); split outbound text into 40k-char chunks. Keep a
// small safety margin so format markers ("*bold*", etc.) added by Slack
// rendering don't push us over.
const SLACK_OUTBOUND_MAX_CHARS = 39_000;

// All outbound Slack file-IO operations (auth.test, upload PUT, download
// GET) need a hard wall-clock cap. Without it a hung CDN / proxy stalls
// the adapter's message handler indefinitely. 30s is generous enough for
// 25 MB attachments over slow links while still bounded.
const SLACK_HTTP_TIMEOUT_MS = 30_000;

const logger = createLogger("slack-adapter");

export interface SlackBotInfo {
  botUserId: string | null;
  botName: string | null;
  team: string | null;
  url: string | null;
}

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
  ownerUserId: string | null;
  onMessage: OnMessageCallback;
  /** Called when a matching pairing challenge captures a new owner user ID. */
  onOwnerDetected?: (userId: string) => void | Promise<void>;
  /** Canonical attachment store for inbound media download/ingest and
   *  outbound file delivery. When absent, media is silently skipped. */
  attachmentStore?: AttachmentStore;
}

/**
 * Pairing challenge — a one-shot matcher the daemon registers via
 * `startPairing()`. Only inbound DMs whose text passes the matcher promote
 * their sender to owner. Used to implement magic-phrase pairing without
 * the "first DM wins" race that plagued the previous discovery design.
 */
export interface SlackPairingChallenge {
  match: (text: string) => boolean;
  expiresAt: number;
  /**
   * Optional reply hint for the case where the inbound DM did NOT match
   * the matcher but is recoverable with a small operator nudge
   * (e.g. the magic-phrase substring is present but wrapped in extra
   * prose). The adapter calls this AFTER the match check fails; a
   * non-null return becomes a DM reply on the sender's channel so the
   * legitimate user can correct their input instead of getting silence.
   * Leaks no secret — see `isPhraseWrappedInExtraText` for the reasoning.
   */
  hintReply?: (text: string) => string | null;
}

/**
 * SlackAdapter — @slack/bolt Socket Mode integration.
 *
 * Listens for DMs and @mentions via Slack's Socket Mode (WebSocket).
 * Converts Slack events to MessageEvents and pushes them into the EventBus.
 *
 * Pairing is challenge-based: an inbound DM only promotes its sender to
 * owner if the daemon has registered a {@link SlackPairingChallenge}
 * AND the message text satisfies the matcher. Otherwise the strict
 * owner-id filter applies and the message is dropped.
 */
export class SlackAdapter implements MessageAdapter {
  readonly platformName = "slack";

  private readonly botToken: string;
  private readonly appToken: string;
  private mutableOwnerId: string | null;
  private readonly onMessage: OnMessageCallback;
  private readonly onOwnerDetected:
    | ((userId: string) => void | Promise<void>)
    | null;
  private app: SlackApp | null = null;
  /**
   * True once `app.start()` has resolved (cleared in `stop()`). Gates the
   * watchdog probe: before the first successful start there is no socket
   * to assess, and reporting "down" then would trigger pointless restarts.
   */
  private startCompleted = false;
  private botUserId: string | null = null;
  private botInfo: SlackBotInfo | null = null;
  private pairingChallenge: SlackPairingChallenge | null = null;
  private readonly attachmentStore: AttachmentStore | null;

  constructor(opts: SlackAdapterOptions) {
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    this.mutableOwnerId = opts.ownerUserId;
    this.onMessage = opts.onMessage;
    this.onOwnerDetected = opts.onOwnerDetected ?? null;
    this.attachmentStore = opts.attachmentStore ?? null;
  }

  // ── Live config knobs ───────────────────────────────────────────────────

  setOwnerUserId(userId: string | null): void {
    this.mutableOwnerId = userId;
  }

  getOwnerUserId(): string | null {
    return this.mutableOwnerId;
  }

  startPairing(challenge: SlackPairingChallenge): void {
    this.pairingChallenge = challenge;
    logger.info(
      { ttlMs: challenge.expiresAt - Date.now() },
      "slack pairing challenge registered",
    );
    // Schedule the matcher closure for active cleanup at TTL. The
    // matcher itself short-circuits past the TTL via `isPairingActive`
    // (security intact), but without this timer the closure (and any
    // captured magic-phrase normalization buffer) sticks around in memory
    // forever when the pairing window simply expires with no inbound DM.
    // `.unref()` so the timer never blocks daemon shutdown; the
    // `pairingChallenge === challenge` guard means a successful pairing
    // (which nulls the field) or an explicit `cancelPairing()` between
    // now and TTL leaves the slot alone.
    const ttlMs = Math.max(0, challenge.expiresAt - Date.now());
    const sweep = setTimeout(() => {
      if (this.pairingChallenge === challenge) {
        this.pairingChallenge = null;
        logger.debug("slack pairing challenge expired (TTL sweep)");
      }
    }, ttlMs);
    if (typeof sweep.unref === "function") sweep.unref();
  }

  cancelPairing(): void {
    this.pairingChallenge = null;
  }

  isPairingActive(): boolean {
    return (
      this.pairingChallenge !== null
      && Date.now() < this.pairingChallenge.expiresAt
    );
  }

  getBotInfo(): SlackBotInfo | null {
    return this.botInfo;
  }

  /**
   * Token validation — calls Slack's `auth.test` directly so the dashboard
   * can verify a token before the adapter is even started. Equivalent to a
   * `curl -H "Authorization: Bearer xoxb-..." auth.test`.
   */
  static async fetchBotInfo(botToken: string): Promise<SlackBotInfo> {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Slack auth.test HTTP error: ${res.status}`);
    }
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      user_id?: string;
      user?: string;
      team?: string;
      url?: string;
    };
    if (!body.ok) {
      throw new Error(`Slack auth.test failed: ${body.error ?? "unknown"}`);
    }
    return {
      botUserId: body.user_id ?? null,
      botName: body.user ?? null,
      team: body.team ?? null,
      url: body.url ?? null,
    };
  }

  async start(): Promise<void> {
    // Dynamic import — @slack/bolt is an optional dependency
    let bolt: SlackBoltModule;
    try {
      bolt = (await import("@slack/bolt" as string)) as SlackBoltModule;
    } catch {
      throw new Error(
        "@slack/bolt not installed. Run: pnpm --filter @aitne/daemon add @slack/bolt",
      );
    }

    this.app = new bolt.App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    // Get bot user ID for mention detection + cache full info for the dashboard.
    try {
      this.botInfo = await SlackAdapter.fetchBotInfo(this.botToken);
      this.botUserId = this.botInfo.botUserId;
    } catch (err) {
      logger.warn({ err }, "slack auth.test failed during start");
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = authResult.user_id ?? null;
    }

    // Listen for all messages (filter in handler). `handleMessage` is
    // async because the pairing branch must await `onOwnerDetected` so the
    // env/DB write completes before we acknowledge the pairing — see
    // captureOwner. Bolt's `app.message` handler accepts async callbacks
    // and surfaces unhandled rejections; awaiting here also lets Bolt's
    // own error middleware see exceptions thrown downstream.
    this.app.message(async ({ message }) => {
      await this.handleMessage(message as SlackInboundMessage);
    });

    await this.app.start();
    this.startCompleted = true;
    logger.info({ botUserId: this.botUserId }, "Slack adapter connected (Socket Mode)");
  }

  async stop(): Promise<void> {
    this.startCompleted = false;
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    logger.info("Slack adapter disconnected");
  }

  /**
   * Live Socket Mode liveness for the adapter watchdog.
   *
   * Bolt's `App` keeps its `SocketModeReceiver` private, but the receiver's
   * `client` (a `@slack/socket-mode` `SocketModeClient`) and the client's
   * `websocket` (a `SlackWebSocket` with a public `isActive()`) are public
   * fields — only the first hop needs a cast. `@slack/socket-mode` v2
   * reconnects on `close` with an UNBOUNDED linear backoff, but a reconnect
   * chain can still die permanently (`UnrecoverableSocketModeStartError`,
   * or an exception escaping the recursive retry), and after machine sleep
   * the ping-pong watchdog may take minutes to notice a dead socket. The
   * adapter watchdog uses this probe to force a full stop→start cycle when
   * the socket stays dead.
   *
   * Returns "unknown" (watchdog: no action) when the receiver shape is not
   * what we expect — a Bolt upgrade must degrade to "no watchdog" rather
   * than to restart loops.
   */
  getConnectionState(): AdapterConnectionState {
    if (!this.app || !this.startCompleted) return "unknown";
    const receiver = (
      this.app as unknown as {
        receiver?: { client?: { websocket?: { isActive?: () => boolean } } };
      }
    ).receiver;
    const websocket = receiver?.client?.websocket;
    if (!websocket || typeof websocket.isActive !== "function") {
      return "unknown";
    }
    try {
      return websocket.isActive() ? "ok" : "down";
    } catch {
      return "unknown";
    }
  }

  async resolveUserChannel(): Promise<string | null> {
    if (!this.app || !this.mutableOwnerId) return null;

    const result = await this.app.client.conversations.open({
      token: this.botToken,
      users: this.mutableOwnerId,
    });
    return result.channel?.id ?? null;
  }

  async sendMessage(params: {
    channel: string;
    text: string;
    threadId?: string;
    attachments?: OutboundAttachmentRef[];
  }): Promise<{ messageId?: string }> {
    if (!this.app) {
      throw new Error("Slack app not started");
    }

    if (!params.attachments?.length) {
      // Text only — split into 40k-char chunks so Slack doesn't reject the
      // payload with `msg_too_long`. The vast majority of replies fit in
      // a single chunk; the loop is a no-op then.
      const chunks = splitOutboundText(params.text, SLACK_OUTBOUND_MAX_CHARS);
      let lastTs: string | undefined;
      try {
        for (const chunk of chunks) {
          const result = await this.app.client.chat.postMessage({
            token: this.botToken,
            channel: params.channel,
            text: chunk,
            thread_ts: params.threadId ?? undefined,
          });
          lastTs = (result.ts as string | undefined) ?? lastTs;
        }
        return { messageId: lastTs };
      } catch (err) {
        logger.error({ err, channel: params.channel }, "Failed to send Slack message");
        throw err;
      }
    }

    // Text + attachments: upload each file via the 3-step Slack upload API.
    // The text is sent as initial_comment on the first file, subsequent
    // files have no comment. This avoids a separate chat.postMessage
    // call while keeping the full text visible above the first file.
    let lastTs: string | undefined;
    let isFirst = true;
    for (const att of params.attachments) {
      try {
        const buf = readFileSync(att.path);
        // Step 1: Get upload URL
        const urlResp = await this.app.client.files.getUploadURLExternal({
          token: this.botToken,
          filename: att.originalFilename,
          length: buf.length,
        });
        const uploadUrl = urlResp?.upload_url as string | undefined;
        const fileId = urlResp?.file_id as string | undefined;
        if (!uploadUrl || !fileId) {
          logger.warn({ filename: att.originalFilename }, "slack getUploadURLExternal returned no url");
          continue;
        }
        // Step 2: PUT bytes
        await fetch(uploadUrl, {
          method: "PUT",
          body: buf,
          headers: { "Content-Type": att.mimeType },
          signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
        });
        // Step 3: Complete (send to channel)
        const completeResp = await this.app.client.files.completeUploadExternal({
          token: this.botToken,
          channel_id: params.channel,
          thread_ts: params.threadId ?? undefined,
          files: [{ id: fileId, title: att.originalFilename }],
          initial_comment: isFirst ? params.text : undefined,
        });
        isFirst = false;
        // completeUploadExternal returns { ok, files: [{id, permalink}] }
        // There's no ts; use the file id as a best-effort message id.
        lastTs = (completeResp?.files?.[0]?.id as string | undefined) ?? lastTs;
      } catch (err) {
        logger.error({ err, channel: params.channel, filename: att.originalFilename }, "Failed to upload Slack attachment");
      }
    }
    return { messageId: lastTs };
  }

  private async handleMessage(message: SlackInboundMessage): Promise<void> {
    // Ignore bot messages and message_changed/deleted subtypes
    if (message.bot_id || message.subtype) return;

    // Reject multi-person IMs (mpim) outright — CLAUDE.md single-owner
    // invariant: group chats and multi-user channels are out of scope by
    // design. The earlier `isDm` check passed only "im", but a bot
    // @-mention inside an "mpim" would have leaked through the
    // `isMention` branch and emitted agent replies into a channel
    // visible to non-owners. `channel_type` for mpim is "mpim"; private
    // channels are "group"; public channels are "channel" — none of
    // which are a single-owner DM. Only "im" is.
    if (message.channel_type === "mpim") {
      logger.debug(
        { channel: message.channel },
        "slack message dropped: multi-person IM rejected",
      );
      return;
    }

    const isDm = message.channel_type === "im";
    const isMention =
      !isDm &&
      this.botUserId !== null &&
      typeof message.text === "string" &&
      message.text.includes(`<@${this.botUserId}>`);
    if (!isDm && !isMention) return;

    const senderId: string = message.user ?? "unknown";
    const text: string = typeof message.text === "string" ? message.text : "";

    // Pairing-challenge check: only DMs (not channel mentions) can capture
    // ownership, and only if the text satisfies the registered matcher.
    // No "first DM wins" fallback — without an active challenge, an
    // unrecognised sender is dropped.
    if (isDm && this.isPairingActive()) {
      const challenge = this.pairingChallenge!;
      if (challenge.match(text)) {
        logger.info({ senderId }, "slack pairing challenge matched");
        // Await `captureOwner` so the env/DB write inside
        // `onOwnerDetected` completes before we acknowledge pairing.
        // `cancelPairing()` only fires on success — if the callback
        // throws (e.g. .env unwritable), the matcher stays armed so the
        // user can retry by resending the phrase.
        const ok = await this.captureOwner(senderId);
        if (ok) {
          this.cancelPairing();
        }
        // Do NOT fall through — the captured payload IS the magic phrase,
        // not a real user message. recordDetectedOwner sends the welcome
        // DM; emitting this to the EventBus would burn an agent inference
        // on the phrase itself.
        return;
      }
      // Matcher rejected but the input may be a wrapped magic
      // phrase. Send a hint so the legitimate user can correct rather
      // than getting silence indistinguishable from an attacker's wrong
      // guess. Best-effort: a send failure is logged but never bubbles.
      const hint = challenge.hintReply?.(text);
      if (hint) {
        try {
          // `this.app` is guaranteed non-null here: Bolt only fires the
          // message handler after `await this.app.start()` returns. The `!`
          // preserves the original throw-and-log behaviour if invariants
          // ever change, rather than silently dropping the hint reply.
          await this.app!.client.chat.postMessage({
            token: this.botToken,
            channel: message.channel ?? "",
            text: hint,
          });
        } catch (err) {
          logger.warn({ err, channel: message.channel }, "slack pairing hint reply failed");
        }
        return;
      }
    }

    if (!this.mutableOwnerId || senderId !== this.mutableOwnerId) {
      logger.debug({ senderId, channel: message.channel }, "slack message dropped: unauthorized sender");
      return;
    }

    // Inbound file attachments — download and ingest asynchronously, then
    // emit the event. For messages with no files (common case) this path
    // is synchronous and returns immediately.
    const files: SlackInboundFile[] = Array.isArray(message.files) ? message.files : [];
    if (files.length > 0 && this.attachmentStore) {
      void this.downloadAndEmitSlackMessage(
        message,
        senderId,
        text,
        isDm,
        isMention,
        files,
      ).catch((err) => logger.error({ err }, "slack attachment handler threw"));
      return;
    }

    this.emitSlackEvent(message, senderId, text, isDm, isMention, []);
  }

  private async downloadAndEmitSlackMessage(
    message: SlackInboundMessage,
    senderId: string,
    text: string,
    isDm: boolean,
    isMention: boolean,
    files: SlackInboundFile[],
  ): Promise<void> {
    const attachmentRefs: AttachmentRef[] = [];

    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      let resolvedFile: SlackInboundFile = file;
      if (
        file.file_access === "check_file_info"
        && typeof file.id === "string"
        && this.app?.client?.files?.info
      ) {
        try {
          const info = await this.app.client.files.info({
            token: this.botToken,
            file: file.id,
          });
          if (info?.file && typeof info.file === "object") {
            resolvedFile = info.file as SlackInboundFile;
          }
        } catch (err) {
          logger.warn({ err, fileId: file.id }, "slack files.info lookup failed");
        }
      }

      const fileSize = resolvedFile.size ?? 0;
      const mimetype = resolvedFile.mimetype ?? null;

      if (fileSize > SLACK_INBOUND_MAX_BYTES) {
        logger.warn({ fileSize, filename: file.name }, "slack file exceeds inbound cap, skipping");
        continue;
      }

      // Prefer url_private_download (includes Content-Disposition header)
      const downloadUrl = resolvedFile.url_private_download ?? resolvedFile.url_private;
      if (!downloadUrl) continue;

      try {
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${this.botToken}` },
          signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.warn({ status: res.status, filename: file.name }, "slack file download failed");
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const stream = Readable.from([buf]);
        const result = await this.attachmentStore!.ingestStream({
          stream,
          declaredMimeType: mimetype,
          originalFilename:
            typeof resolvedFile.name === "string" ? resolvedFile.name : "file",
          direction: "inbound",
          provenance: "user_slack",
          maxSizeBytes: SLACK_INBOUND_MAX_BYTES,
        });
        attachmentRefs.push({
          id: result.id,
          originalFilename: result.originalFilename,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
        });
      } catch (err) {
        logger.error({ err, filename: resolvedFile.name }, "slack file ingest failed");
      }
    }

    this.emitSlackEvent(message, senderId, text, isDm, isMention, attachmentRefs);
  }

  private emitSlackEvent(
    message: SlackInboundMessage,
    senderId: string,
    text: string,
    isDm: boolean,
    isMention: boolean,
    attachments: AttachmentRef[],
  ): void {
    const event: Event = createEvent({
      type: "message.received",
      source: "slack",
      priority: isDm || isMention ? EventPriority.HIGH : EventPriority.LOW,
      data: {
        slackTs: message.ts ?? null,
        slackTeam: message.team ?? null,
      },
    });

    // Extend to MessageEvent shape
    Object.assign(event, {
      sender: senderId,
      channel: message.channel ?? "",
      content: text,
      platform: "slack",
      threadId: message.thread_ts ?? null,
      isDm,
      isMention,
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    this.onMessage(event);
  }

  /**
   * Atomically promote a user ID to "owner" and notify the daemon.
   *
   * We set `mutableOwnerId` BEFORE awaiting the callback because
   * `recordDetectedOwner` (in index.ts) immediately sends a "pairing
   * successful" DM via `messageHub.sendToPlatform(platform, "user", ...)`,
   * which resolves through `resolveUserChannel()` and reads
   * `this.mutableOwnerId`. If we set it after the callback, the welcome
   * DM would have no owner to address.
   *
   * If the callback throws (env-write failed, etc.) we ROLL BACK
   * `mutableOwnerId` to its previous value so the adapter doesn't claim
   * a pairing that didn't actually persist — otherwise the next daemon
   * restart would lose the binding and the user would think the pair
   * succeeded. Returns `true` on success so the caller can decide
   * whether to `cancelPairing()` (success) or keep the matcher armed
   * for retry (failure).
   */
  private async captureOwner(userId: string): Promise<boolean> {
    const previousOwnerId = this.mutableOwnerId;
    this.mutableOwnerId = userId;
    if (!this.onOwnerDetected) return true;
    try {
      await this.onOwnerDetected(userId);
      return true;
    } catch (err) {
      this.mutableOwnerId = previousOwnerId;
      logger.error(
        { err, userId },
        "slack onOwnerDetected callback failed; pairing rolled back",
      );
      return false;
    }
  }
}
