import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import type { Context, Telegraf } from "telegraf";
import { EventPriority, createEvent } from "@aitne/shared";
import type { AttachmentRef, Event } from "@aitne/shared";
import type { MessageAdapter, OnMessageCallback, OutboundAttachmentRef } from "./types.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { createLogger } from "../logging.js";
import { filenameForMime, splitOutboundText } from "./outbound-text.js";

const logger = createLogger("telegram-adapter");

type TelegrafModule = typeof import("telegraf");
type TelegrafContext = Context;
type TelegrafBot = Telegraf<TelegrafContext>;

/** Telegram Bot API PhotoSize (subset of @telegraf/types/message). Re-declared
 *  locally because telegraf's `Types` namespace doesn't re-export Schema types
 *  and we don't take a direct dep on @telegraf/types. */
interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/**
 * The wide union of fields the inbound handler reads off any message
 * subtype. Telegraf models `ctx.message` as a discriminated union; modelling
 * every variant here is noisy, so we type the surface we actually touch
 * and access via optional-chained reads. Bytes on the wire are the same.
 */
interface TelegramInboundMessage {
  message_id: number;
  text?: string;
  caption?: string;
  media_group_id?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string };
  reply_to_message?: { message_id?: number };
  photo?: TelegramPhotoSize[];
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  sticker?: unknown;
  audio?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  video?: Record<string, unknown>;
  video_note?: Record<string, unknown>;
}

const TELEGRAM_INBOUND_MAX_BYTES = 20 * 1024 * 1024; // 20 MB Telegram bot download cap
const TELEGRAM_CAPTION_MAX_CHARS = 1024;
const TELEGRAM_MESSAGE_MAX_CHARS = 4096;
const MEDIA_GROUP_DEBOUNCE_MS = 400;
// Hard wall-clock cap on Telegram REST fetches (getMe, file download).
// Without it a hung CDN stalls the inbound message handler forever and
// the media-group flush timer never fires. 30s is generous for 20 MB
// attachments over slow links.
const TELEGRAM_HTTP_TIMEOUT_MS = 30_000;

export interface TelegramBotInfo {
  id: number;
  username: string | null;
  firstName: string | null;
}

export interface TelegramAdapterOptions {
  botToken: string;
  ownerChatId: string | null;
  onMessage: OnMessageCallback;
  /**
   * Called when a matching pairing challenge captures a new owner chat ID.
   * The daemon wires this to write the value into .env via
   * applyConfigUpdates so the next restart still has the right owner.
   */
  onOwnerDetected?: (chatId: string) => void | Promise<void>;
  /** Canonical attachment store for inbound media download/ingest and
   *  outbound file delivery. When absent, media is silently skipped. */
  attachmentStore?: AttachmentStore;
}

/**
 * A pairing challenge that the user must satisfy in order to claim the
 * owner role. The matcher receives the raw inbound message text and
 * returns true iff the sender should be promoted to owner.
 *
 * For Telegram QR pairing the matcher checks for an exact `/start <token>`
 * payload (the token is encoded in the QR's deep link). For other use
 * cases the matcher could implement a magic-phrase contains check, etc.
 *
 * The challenge auto-expires at `expiresAt`; the adapter never uses it
 * past that point even if the matcher would return true.
 */
export interface PairingChallenge {
  match: (text: string) => boolean;
  expiresAt: number;
}

/** Buffered item for a Telegram media album (media_group_id). */
interface MediaGroupItem {
  fileId: string;
  declaredMime: string | null;
  filename: string;
  fileSizeBytes: number;
}

interface MediaGroupEntry {
  items: MediaGroupItem[];
  caption: string | null;
  channelId: string;
  senderId: string;
  chatType: string;
  isDm: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * TelegramAdapter — telegraf Long Polling integration.
 *
 * Listens for private chats via Telegram Bot API.
 *
 * Group / supergroup traffic is intentionally ignored. This adapter is for
 * owner DMs only; Telegram group mentions are out of scope.
 *
 * Pairing is challenge-based: the daemon must register a
 * {@link PairingChallenge} via
 * `startPairing()`; only inbound messages whose text passes the matcher
 * (e.g. `/start <random-token>` for QR pairing) capture the owner. This
 * closes the race where any unrelated DM during a 5-minute window could
 * hijack the owner role.
 */
export class TelegramAdapter implements MessageAdapter {
  readonly platformName = "telegram";

  private readonly botToken: string;
  private mutableOwnerId: string | null;
  private readonly onMessage: OnMessageCallback;
  private readonly onOwnerDetected:
    | ((chatId: string) => void | Promise<void>)
    | null;
  private readonly attachmentStore: AttachmentStore | null;

  private bot: TelegrafBot | null = null;
  private botInfo: TelegramBotInfo | null = null;

  /** Active pairing challenge (null when pairing isn't in progress). */
  private pairingChallenge: PairingChallenge | null = null;

  /** Buffers for Telegram media albums (media_group_id → accumulated items). */
  private readonly mediaGroupBuffers: Map<string, MediaGroupEntry> = new Map();

  constructor(opts: TelegramAdapterOptions) {
    this.botToken = opts.botToken;
    this.mutableOwnerId = opts.ownerChatId;
    this.onMessage = opts.onMessage;
    this.onOwnerDetected = opts.onOwnerDetected ?? null;
    this.attachmentStore = opts.attachmentStore ?? null;
  }

  // ── Live config knobs ───────────────────────────────────────────────────

  setOwnerChatId(chatId: string | null): void {
    this.mutableOwnerId = chatId;
  }

  getOwnerChatId(): string | null {
    return this.mutableOwnerId;
  }

  /**
   * Register a one-shot pairing challenge. Inbound DMs that satisfy
   * `challenge.match(text)` (and arrive before `challenge.expiresAt`) will
   * promote their sender to owner. Anything else is dropped.
   */
  startPairing(challenge: PairingChallenge): void {
    this.pairingChallenge = challenge;
    logger.info(
      { ttlMs: challenge.expiresAt - Date.now() },
      "telegram pairing challenge registered",
    );
    // TTL sweep — see SlackAdapter.startPairing for rationale.
    const ttlMs = Math.max(0, challenge.expiresAt - Date.now());
    const sweep = setTimeout(() => {
      if (this.pairingChallenge === challenge) {
        this.pairingChallenge = null;
        logger.debug("telegram pairing challenge expired (TTL sweep)");
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

  getBotInfo(): TelegramBotInfo | null {
    return this.botInfo;
  }

  /**
   * Bot identity probe. Calls Telegram's `getMe` directly via fetch so we
   * can validate a token BEFORE constructing the heavyweight telegraf bot
   * instance. Used by the dashboard's "test token" button.
   */
  static async fetchBotInfo(botToken: string): Promise<TelegramBotInfo> {
    const url = `https://api.telegram.org/bot${botToken}/getMe`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TELEGRAM_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `Telegram getMe failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as {
      ok: boolean;
      result?: { id: number; username?: string; first_name?: string };
      description?: string;
    };
    if (!body.ok || !body.result) {
      throw new Error(body.description ?? "Telegram getMe returned ok=false");
    }
    return {
      id: body.result.id,
      username: body.result.username ?? null,
      firstName: body.result.first_name ?? null,
    };
  }

  // ── Adapter lifecycle ──────────────────────────────────────────────────

  async start(): Promise<void> {
    // Dynamic import — telegraf is an optional dependency
    let TelegrafCtor: TelegrafModule["Telegraf"];
    try {
      const mod = (await import("telegraf" as string)) as TelegrafModule;
      TelegrafCtor = mod.Telegraf;
    } catch {
      throw new Error(
        "telegraf not installed. Run: pnpm --filter @aitne/daemon add telegraf",
      );
    }

    this.bot = new TelegrafCtor(this.botToken);

    // Validate token + cache bot identity for the dashboard's QR deep link.
    try {
      this.botInfo = await TelegramAdapter.fetchBotInfo(this.botToken);
    } catch (err) {
      logger.warn({ err }, "telegram getMe failed during start");
    }

    // Subscribe to `message`, not `text` — media-with-caption messages
    // don't fire `text` but do carry user content via `caption`, and a
    // text-only handler would silently drop them.
    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx).catch((err) => {
        logger.error({ err }, "telegram message handler threw");
      });
    });

    // Start long polling (non-blocking)
    this.bot.launch({ dropPendingUpdates: true });
    logger.info(
      { botUsername: this.botInfo?.username },
      "Telegram adapter connected (Long Polling)",
    );
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop("SIGTERM");
      this.bot = null;
    }
    // Cancel any pending media-group debounce timers.
    for (const [, entry] of this.mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    this.mediaGroupBuffers.clear();
    logger.info("Telegram adapter disconnected");
  }

  async resolveUserChannel(): Promise<string | null> {
    return this.mutableOwnerId;
  }

  async sendMessage(params: {
    channel: string;
    text: string;
    threadId?: string;
    attachments?: OutboundAttachmentRef[];
  }): Promise<{ messageId?: string }> {
    if (!this.bot) {
      throw new Error("Telegram bot not started");
    }

    const { channel, text, threadId, attachments } = params;
    const replyOpts: { reply_parameters?: { message_id: number } } = threadId
      ? { reply_parameters: { message_id: Number(threadId) } }
      : {};

    if (!attachments?.length) {
      // Text only — existing behaviour.
      try {
        const result = await this.bot.telegram.sendMessage(channel, text, replyOpts);
        return {
          messageId:
            result?.message_id !== undefined ? String(result.message_id) : undefined,
        };
      } catch (err) {
        logger.error({ err, channel }, "Failed to send Telegram message");
        throw err;
      }
    }

    // Text + attachments: decide whether text fits as a media caption.
    const captionText = text.length <= TELEGRAM_CAPTION_MAX_CHARS ? text : null;
    let lastMessageId: string | undefined;

    // If text is too long for a caption, send it as a standalone message first.
    if (!captionText && text) {
      const chunks = splitOutboundText(text, TELEGRAM_MESSAGE_MAX_CHARS);
      for (const chunk of chunks) {
        try {
          const result = await this.bot.telegram.sendMessage(channel, chunk, replyOpts);
          lastMessageId =
            result?.message_id !== undefined ? String(result.message_id) : lastMessageId;
        } catch (err) {
          logger.error({ err, channel }, "Failed to send Telegram text chunk");
        }
      }
    }

    // Deliver each attachment individually (caption on the first one if it fits).
    let isFirst = true;
    for (const att of attachments) {
      const caption = isFirst && captionText ? captionText : undefined;
      isFirst = false;
      try {
        const buf = readFileSync(att.path);
        let result: { message_id?: number } | undefined;
        if (att.mimeType.startsWith("image/")) {
          result = await this.bot.telegram.sendPhoto(
            channel,
            { source: buf },
            caption ? { caption, ...replyOpts } : replyOpts,
          );
        } else {
          result = await this.bot.telegram.sendDocument(
            channel,
            { source: buf, filename: att.originalFilename },
            caption ? { caption, ...replyOpts } : replyOpts,
          );
        }
        lastMessageId =
          result?.message_id !== undefined ? String(result.message_id) : lastMessageId;
      } catch (err) {
        logger.error(
          { err, channel, filename: att.originalFilename },
          "Failed to send Telegram attachment",
        );
      }
    }

    return { messageId: lastMessageId };
  }

  // ── Inbound message handling ───────────────────────────────────────────

  private async handleMessage(ctx: TelegrafContext): Promise<void> {
    const msg = ctx.message as TelegramInboundMessage | undefined;
    if (!msg) return;

    const chatType = msg.chat?.type ?? "private";
    const isDm = chatType === "private";
    if (!isDm) return;

    const senderId = String(msg.from?.id ?? "unknown");
    const channelId = String(msg.chat?.id ?? "");
    // Prefer explicit text; fall back to caption (present on photo/document messages).
    const textContent: string = (msg.text ?? msg.caption ?? "") as string;
    const threadId: string | null =
      msg.reply_to_message?.message_id != null
        ? String(msg.reply_to_message.message_id)
        : null;

    // Pairing-challenge check: only pure-text DMs can satisfy the matcher —
    // a media message with a matching caption would be a coincidence.
    // `msg.text` is set only on text-only messages; `msg.photo` etc. use `caption`.
    if (msg.text && this.isPairingActive() && this.pairingChallenge!.match(textContent)) {
      logger.info({ channelId }, "telegram pairing challenge matched");
      // Await captureOwner so the env/DB write inside onOwnerDetected
      // completes before pairing is acknowledged. cancelPairing only
      // fires on success — if the callback throws (e.g. .env unwritable)
      // the matcher stays armed so the user can retry by resending the
      // phrase.
      const ok = await this.captureOwner(channelId);
      if (ok) {
        this.cancelPairing();
      }
      return;
    }

    // Strict owner filter.
    if (!this.mutableOwnerId || channelId !== this.mutableOwnerId) {
      logger.debug(
        { senderId, channelId },
        "telegram message dropped: unauthorized sender",
      );
      return;
    }

    // ── Media type routing ──────────────────────────────────────────────

    // Photo (Telegram compresses to JPEG and may use a media group / album).
    if (msg.photo) {
      if (!this.attachmentStore) {
        this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, [], threadId);
        return;
      }
      if (msg.media_group_id) {
        await this.bufferMediaGroupItem(
          msg.media_group_id as string,
          { fileId: this.pickLargestPhoto(msg.photo), declaredMime: "image/jpeg", filename: "photo.jpg", fileSizeBytes: this.photoSizeBytes(msg.photo) },
          textContent || null,
          channelId,
          senderId,
          chatType,
          isDm,
        );
        return;
      }
      const ref = await this.downloadAndIngest(
        this.pickLargestPhoto(msg.photo),
        "image/jpeg",
        "photo.jpg",
        this.photoSizeBytes(msg.photo),
        TELEGRAM_INBOUND_MAX_BYTES,
        textContent || undefined,
      );
      this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, ref ? [ref] : [], threadId);
      return;
    }

    // Document (sent as file — original format preserved, MIME from Telegram).
    if (msg.document) {
      const doc = msg.document;
      if (!this.attachmentStore) {
        this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, [], threadId);
        return;
      }
      if (msg.media_group_id) {
        await this.bufferMediaGroupItem(
          msg.media_group_id as string,
          {
            fileId: doc.file_id as string,
            declaredMime: typeof doc.mime_type === "string" ? doc.mime_type : null,
            filename: typeof doc.file_name === "string" ? doc.file_name : "file",
            fileSizeBytes: typeof doc.file_size === "number" ? doc.file_size : 0,
          },
          textContent || null,
          channelId,
          senderId,
          chatType,
          isDm,
        );
        return;
      }
      const ref = await this.downloadAndIngest(
        doc.file_id as string,
        typeof doc.mime_type === "string" ? doc.mime_type : null,
        typeof doc.file_name === "string" ? doc.file_name : "file",
        typeof doc.file_size === "number" ? doc.file_size : 0,
        TELEGRAM_INBOUND_MAX_BYTES,
        textContent || undefined,
      );
      this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, ref ? [ref] : [], threadId);
      return;
    }

    // Sticker messages should be ignored: no user-facing error and no agent
    // turn. Telegram exposes stickers as their own object instead of a
    // generic document/photo attachment.
    if (msg.sticker) {
      logger.debug("telegram sticker ignored");
      return;
    }

    // Audio / voice / video / video_note.
    if (msg.audio || msg.voice || msg.video || msg.video_note) {
      if (!this.attachmentStore) {
        if (textContent) {
          this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, [], threadId);
        }
        return;
      }

      const audio = msg.audio as Record<string, unknown> | undefined;
      const voice = msg.voice as Record<string, unknown> | undefined;
      const video = msg.video as Record<string, unknown> | undefined;
      const videoNote = msg.video_note as Record<string, unknown> | undefined;
      const media = audio ?? voice ?? video ?? videoNote;
      if (!media) return;

      const declaredMime =
        typeof media.mime_type === "string"
          ? media.mime_type
          : audio || voice
            ? "audio/ogg"
            : "video/mp4";
      const filename =
        typeof media.file_name === "string"
          ? media.file_name
          : audio
            ? filenameForMime("audio", declaredMime, "ogg")
            : voice
              ? filenameForMime("voice", declaredMime, "ogg")
              : video
                ? filenameForMime("video", declaredMime, "mp4")
                : filenameForMime("video-note", declaredMime, "mp4");
      const fileSize =
        typeof media.file_size === "number" ? media.file_size : 0;

      if (msg.media_group_id && (audio || video)) {
        await this.bufferMediaGroupItem(
          msg.media_group_id as string,
          {
            fileId: media.file_id as string,
            declaredMime,
            filename,
            fileSizeBytes: fileSize,
          },
          textContent || null,
          channelId,
          senderId,
          chatType,
          isDm,
        );
        return;
      }

      const ref = await this.downloadAndIngest(
        media.file_id as string,
        declaredMime,
        filename,
        fileSize,
        TELEGRAM_INBOUND_MAX_BYTES,
        textContent || undefined,
      );
      this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, ref ? [ref] : [], threadId);
      return;
    }

    // Text-only message (or unknown — fall through to text event).
    // Drop messages with no textual content.
    if (!textContent) return;
    this.emitTextEvent(channelId, senderId, textContent, chatType, isDm, [], threadId);
  }

  // ── Media group buffering (album debounce) ────────────────────────────

  private async bufferMediaGroupItem(
    groupId: string,
    item: MediaGroupItem,
    caption: string | null,
    channelId: string,
    senderId: string,
    chatType: string,
    isDm: boolean,
  ): Promise<void> {
    const existing = this.mediaGroupBuffers.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      // Prefer the first non-empty caption.
      if (!existing.caption && caption) existing.caption = caption;
      existing.timer = setTimeout(
        () => void this.flushMediaGroup(groupId).catch((err) => logger.error({ err, groupId }, "media group flush failed")),
        MEDIA_GROUP_DEBOUNCE_MS,
      );
    } else {
      const timer = setTimeout(
        () => void this.flushMediaGroup(groupId).catch((err) => logger.error({ err, groupId }, "media group flush failed")),
        MEDIA_GROUP_DEBOUNCE_MS,
      );
      this.mediaGroupBuffers.set(groupId, {
        items: [item],
        caption,
        channelId,
        senderId,
        chatType,
        isDm,
        timer,
      });
    }
  }

  private async flushMediaGroup(groupId: string): Promise<void> {
    const entry = this.mediaGroupBuffers.get(groupId);
    if (!entry) return;
    this.mediaGroupBuffers.delete(groupId);

    const refs: AttachmentRef[] = [];
    await Promise.all(
      entry.items.map(async (item) => {
        const ref = await this.downloadAndIngest(
          item.fileId,
          item.declaredMime,
          item.filename,
          item.fileSizeBytes,
          TELEGRAM_INBOUND_MAX_BYTES,
          entry.caption ?? undefined,
        );
        if (ref) refs.push(ref);
      }),
    );

    this.emitTextEvent(
      entry.channelId,
      entry.senderId,
      entry.caption ?? "",
      entry.chatType,
      entry.isDm,
      refs,
    );
  }

  // ── Download + ingest helper ──────────────────────────────────────────

  private async downloadAndIngest(
    fileId: string,
    declaredMime: string | null,
    filename: string,
    fileSizeBytes: number,
    maxBytes: number,
    caption?: string,
  ): Promise<AttachmentRef | null> {
    if (!this.attachmentStore) return null;
    if (fileSizeBytes > maxBytes) {
      logger.warn({ fileId, fileSizeBytes, maxBytes }, "telegram file exceeds size cap, skipping");
      return null;
    }

    if (!this.bot) return null;
    let filePath: string | undefined;
    try {
      const fileInfo = await this.bot.telegram.getFile(fileId);
      filePath = fileInfo?.file_path;
    } catch (err) {
      logger.error({ err, fileId }, "telegram getFile failed");
      return null;
    }
    if (!filePath) return null;

    const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
    let buf: Buffer;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TELEGRAM_HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching telegram file`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      logger.error({ err, fileId }, "telegram file download failed");
      return null;
    }

    try {
      const stream = Readable.from([buf]);
      const result = await this.attachmentStore.ingestStream({
        stream,
        declaredMimeType: declaredMime,
        originalFilename: filename,
        direction: "inbound",
        provenance: "user_telegram",
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
      logger.error({ err, fileId }, "telegram file ingest failed");
      return null;
    }
  }

  // ── Event construction helpers ────────────────────────────────────────

  private emitTextEvent(
    channelId: string,
    senderId: string,
    text: string,
    chatType: string,
    isDm: boolean,
    attachments: AttachmentRef[],
    threadId: string | null = null,
  ): void {
    const event: Event = createEvent({
      type: "message.received",
      source: "telegram",
      priority: EventPriority.HIGH,
      data: {
        telegramChatType: chatType,
      },
    });

    Object.assign(event, {
      sender: senderId,
      channel: channelId,
      content: text,
      platform: "telegram",
      threadId,
      isDm,
      isMention: false,
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    this.onMessage(event);
  }

  // ── Photo helpers ─────────────────────────────────────────────────────

  private pickLargestPhoto(photos: TelegramPhotoSize[]): string {
    if (!Array.isArray(photos) || photos.length === 0) return "";
    const largest = [...photos].sort(
      (a, b) => (b.file_size ?? 0) - (a.file_size ?? 0),
    )[0];
    return largest?.file_id ?? "";
  }

  private photoSizeBytes(photos: TelegramPhotoSize[]): number {
    if (!Array.isArray(photos) || photos.length === 0) return 0;
    const largest = [...photos].sort(
      (a, b) => (b.file_size ?? 0) - (a.file_size ?? 0),
    )[0];
    return largest?.file_size ?? 0;
  }

  /**
   * Atomically promote a chat ID to "owner" and notify the daemon. See
   * slack-adapter.captureOwner for the full rationale — the env/DB
   * write must complete before we acknowledge pairing, and
   * mutableOwnerId rolls back if the callback throws so a daemon restart
   * doesn't silently lose the binding.
   */
  private async captureOwner(chatId: string): Promise<boolean> {
    const previousOwnerId = this.mutableOwnerId;
    this.mutableOwnerId = chatId;
    if (!this.onOwnerDetected) return true;
    try {
      await this.onOwnerDetected(chatId);
      return true;
    } catch (err) {
      this.mutableOwnerId = previousOwnerId;
      logger.error(
        { err, chatId },
        "telegram onOwnerDetected callback failed; pairing rolled back",
      );
      return false;
    }
  }
}
