import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Events,
  type TextChannel,
  type DMChannel,
} from "discord.js";
import { EventPriority, createEvent } from "@aitne/shared";
import type { AttachmentRef, Event } from "@aitne/shared";
import type { MessageAdapter, OnMessageCallback, OutboundAttachmentRef } from "./types.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { createLogger } from "../logging.js";
import { splitOutboundText } from "./outbound-text.js";

// Discord DM bot outbound cap: 10 MB without Nitro boost inheritance.
const DISCORD_OUTBOUND_MAX_BYTES = 10 * 1024 * 1024;
// Keep inbound aligned with the dashboard's non-image attachment cap.
const DISCORD_INBOUND_MAX_BYTES = 25 * 1024 * 1024;

// Discord CDN / REST timeouts. Without a hard wall-clock cap, a hung CDN
// stalls the raw-packet handler and blocks subsequent DMs. 30s is
// generous for 25 MB attachments over slow links.
const DISCORD_HTTP_TIMEOUT_MS = 30_000;

const logger = createLogger("discord-adapter");

export interface DiscordBotInfo {
  id: string;
  username: string;
  discriminator: string | null;
  avatarUrl: string | null;
}

/**
 * Minimal shape of the Discord Gateway MESSAGE_CREATE payload we rely on.
 * We consume the raw packet directly (see handleRawMessage) because
 * discord.js 14.26.2's MessageCreateAction drops DMs for uncached channels.
 */
interface RawAttachment {
  id?: string;
  url?: string;
  filename?: string;
  size?: number;
  content_type?: string;
}

interface RawMessagePayload {
  id?: string;
  channel_id?: string;
  channel_type?: number;
  guild_id?: string | null;
  content?: string;
  author?: { id?: string; bot?: boolean };
  mentions?: Array<{ id?: string }>;
  attachments?: RawAttachment[];
  sticker_items?: unknown[];
}

export interface DiscordAdapterOptions {
  botToken: string;
  ownerUserId: string | null;
  onMessage: OnMessageCallback;
  /** Called when a matching pairing challenge captures a new owner user ID. */
  onOwnerDetected?: (userId: string) => void | Promise<void>;
  /** Phase 2: canonical attachment store for inbound media download/ingest
   *  and outbound file delivery. When absent, media is silently skipped. */
  attachmentStore?: AttachmentStore;
}

/**
 * Pairing challenge — see SlackAdapter / TelegramAdapter for the design.
 * Same one-shot matcher pattern, replaces the previous "first DM wins"
 * discovery logic that was vulnerable to a 5-minute race.
 */
export interface DiscordPairingChallenge {
  match: (text: string) => boolean;
  expiresAt: number;
  /** P2-23 — see SlackPairingChallenge.hintReply. */
  hintReply?: (text: string) => string | null;
}

/**
 * DiscordAdapter — discord.js WebSocket Gateway integration.
 *
 * Inbound (DMs + @mentions): consumed from the raw MESSAGE_CREATE
 * gateway packet. See start() for why we bypass Events.MessageCreate.
 * Outbound: discord.js REST (`channels.fetch` + `channel.send`,
 * `users.fetch` + `user.createDM`).
 *
 * Challenge-based pairing: the daemon registers a matcher via
 * `startPairing()`; only DMs whose text passes the matcher promote their
 * sender to owner. There is no implicit first-DM-wins fallback.
 */
export class DiscordAdapter implements MessageAdapter {
  readonly platformName = "discord";

  private readonly client: Client;
  private readonly botToken: string;
  private mutableOwnerId: string | null;
  private readonly onMessage: OnMessageCallback;
  private readonly onOwnerDetected:
    | ((userId: string) => void | Promise<void>)
    | null;
  private botUserId: string | null = null;
  private botInfo: DiscordBotInfo | null = null;
  private pairingChallenge: DiscordPairingChallenge | null = null;
  private readonly attachmentStore: AttachmentStore | null;

  constructor(opts: DiscordAdapterOptions) {
    this.botToken = opts.botToken;
    this.mutableOwnerId = opts.ownerUserId;
    this.onMessage = opts.onMessage;
    this.onOwnerDetected = opts.onOwnerDetected ?? null;
    this.attachmentStore = opts.attachmentStore ?? null;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // We do not declare any `partials`: inbound messages are consumed
      // via the raw gateway packet (see start() / handleRawMessage), and
      // outbound paths (sendMessage, resolveUserChannel) fetch channel
      // data via REST which returns a fully-typed response.
    });
  }

  // ── Live config knobs ───────────────────────────────────────────────────

  setOwnerUserId(userId: string | null): void {
    this.mutableOwnerId = userId;
  }

  getOwnerUserId(): string | null {
    return this.mutableOwnerId;
  }

  startPairing(challenge: DiscordPairingChallenge): void {
    this.pairingChallenge = challenge;
    logger.info(
      { ttlMs: challenge.expiresAt - Date.now() },
      "discord pairing challenge registered",
    );
    // P2-20: TTL sweep — see SlackAdapter.startPairing for rationale.
    const ttlMs = Math.max(0, challenge.expiresAt - Date.now());
    const sweep = setTimeout(() => {
      if (this.pairingChallenge === challenge) {
        this.pairingChallenge = null;
        logger.debug("discord pairing challenge expired (TTL sweep)");
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

  getBotInfo(): DiscordBotInfo | null {
    return this.botInfo;
  }

  /**
   * Token validation against Discord REST `/users/@me`. Used by the
   * dashboard's "test token" button before the gateway client is started.
   */
  static async fetchBotInfo(botToken: string): Promise<DiscordBotInfo> {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(DISCORD_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Discord /users/@me failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      id: string;
      username: string;
      discriminator?: string;
      avatar?: string | null;
    };
    return {
      id: body.id,
      username: body.username,
      discriminator: body.discriminator ?? null,
      avatarUrl: body.avatar
        ? `https://cdn.discordapp.com/avatars/${body.id}/${body.avatar}.png`
        : null,
    };
  }

  async start(): Promise<void> {
    // discord.js's typed event map omits "raw", but the underlying
    // EventEmitter still fires it. Narrow once via a local shape so the
    // wide-event surface doesn't leak elsewhere.
    type RawEventClient = {
      removeAllListeners(event: "raw"): void;
      on(
        event: "raw",
        listener: (packet: { t?: string; d?: RawMessagePayload }) => void,
      ): void;
    };
    const rawClient = this.client as unknown as RawEventClient;

    // Remove all listeners first to prevent duplicates on re-start
    this.client.removeAllListeners(Events.Error);
    this.client.removeAllListeners(Events.Warn);
    rawClient.removeAllListeners("raw");

    this.client.on(Events.Error, (err) => {
      logger.error({ error: err.message }, "Discord client error");
    });

    this.client.on(Events.Warn, (info) => {
      logger.warn({ info }, "Discord client warn");
    });

    // We deliberately do NOT subscribe to Events.MessageCreate.
    //
    // discord.js 14.26.2 has a bug where MessageCreateAction silently
    // drops DM messages for uncached DM channels. The action's handler
    // forwards only `{ id: data.channel_id, author, guild_id? }` to
    // getChannel() — crucially dropping `type`/`channel_type` — so
    // createChannel() in util/Channels.js cannot identify the channel
    // as a DM and returns null, suppressing the event. Declaring
    // `Partials.Channel` does not help because the partial factory
    // still needs a type to decide what to build.
    //
    // Consuming the raw gateway packet directly bypasses that broken
    // resolution path. Outbound paths (sendMessage, resolveUserChannel)
    // go through REST, which returns fully-typed channel data and works
    // unmodified. If a future discord.js release fixes the bug, we stay
    // on the raw path regardless — re-enabling Events.MessageCreate
    // would produce duplicate deliveries without deduplication plumbing.
    rawClient.on("raw", (packet) => {
      if (packet.t === "MESSAGE_CREATE" && packet.d) {
        void this.handleRawMessage(packet.d).catch((err) => {
          logger.error({ err }, "discord raw message handler threw");
        });
      }
    });

    await this.client.login(this.botToken);
    this.botUserId = this.client.user?.id ?? null;
    if (this.client.user) {
      this.botInfo = {
        id: this.client.user.id,
        username: this.client.user.username,
        discriminator: this.client.user.discriminator ?? null,
        avatarUrl: this.client.user.avatarURL() ?? null,
      };
    }
    logger.info(
      { botUser: this.client.user?.tag },
      "Discord adapter connected",
    );
  }

  async stop(): Promise<void> {
    this.client.destroy();
    logger.info("Discord adapter disconnected");
  }

  async resolveUserChannel(): Promise<string | null> {
    if (!this.mutableOwnerId) return null;
    const user = await this.client.users.fetch(this.mutableOwnerId);
    const dm = await user.createDM();
    return dm.id;
  }

  async sendMessage(params: {
    channel: string;
    text: string;
    threadId?: string;
    attachments?: OutboundAttachmentRef[];
  }): Promise<{ messageId?: string }> {
    try {
      const ch = await this.client.channels.fetch(params.channel);
      if (!ch || !("send" in ch)) {
        throw new Error("Channel not found or not text");
      }

      const textChannel = ch as TextChannel | DMChannel;
      const chunks = splitOutboundText(params.text, 2000);
      let lastMessageId: string | undefined;

      if (!params.attachments?.length) {
        // Text only — existing behaviour.
        for (const chunk of chunks) {
          const sent = await textChannel.send(chunk);
          lastMessageId = sent.id;
        }
        return { messageId: lastMessageId };
      }

      // Text + attachments: send all but the last text chunk, then combine
      // the last chunk with the file builders in a single send call (up to 10
      // files). Discord DM bot cap is 10 MB per file.
      for (const chunk of chunks.slice(0, -1)) {
        await textChannel.send(chunk);
      }
      const lastChunk = chunks[chunks.length - 1] ?? "";

      const eligible = params.attachments.filter(
        (att) => att.sizeBytes <= DISCORD_OUTBOUND_MAX_BYTES,
      );
      const oversized = params.attachments.filter(
        (att) => att.sizeBytes > DISCORD_OUTBOUND_MAX_BYTES,
      );

      // Notify about oversized files that can't be delivered.
      for (const att of oversized) {
        await textChannel.send(
          `[File too large for Discord DM (max 10 MB): ${att.originalFilename}]`,
        );
      }

      // Discord allows up to 10 files per message.
      for (let i = 0; i < eligible.length; i += 10) {
        const batch = eligible.slice(i, i + 10);
        const builders = batch.map((att) =>
          new AttachmentBuilder(readFileSync(att.path), {
            name: att.originalFilename,
            description: att.caption,
          }),
        );
        const content = i === 0 ? lastChunk : "";
        const sent = await textChannel.send(
          content
            ? { content, files: builders }
            : { files: builders },
        );
        if (i === 0) lastMessageId = sent.id;
      }

      if (!eligible.length) {
        // Only oversized files — still send the last text chunk.
        if (lastChunk) {
          const sent = await textChannel.send(lastChunk);
          lastMessageId = sent.id;
        }
      }

      return { messageId: lastMessageId };
    } catch (err) {
      logger.error({ err, channel: params.channel }, "Failed to send Discord message");
      throw err;
    }
  }

  private async handleRawMessage(data: RawMessagePayload): Promise<void> {
    const authorId = data.author?.id;
    if (!authorId) return;

    // Ignore own messages
    if (authorId === this.botUserId) return;
    // Ignore other bots
    if (data.author?.bot) return;

    // channel_type 1 = DM, 3 = GroupDM. Guild text channels are 0 etc.
    // B-4: reject GroupDM (type 3) outright. The earlier logic let it
    // fall through the !isDm + isMention path, so owner @-mentions in a
    // GroupDM would emit agent replies into a channel visible to
    // non-owner participants — violating the single-owner scope
    // invariant in CLAUDE.md. We block the entire packet here, before
    // any pairing or owner check.
    if (data.channel_type === 3) {
      logger.debug(
        { channel: data.channel_id },
        "discord message dropped: GroupDM rejected (B-4)",
      );
      return;
    }

    const isDm = data.channel_type === 1;
    const isMention =
      !isDm
      && this.botUserId !== null
      && Array.isArray(data.mentions)
      && data.mentions.some((m) => m?.id === this.botUserId);

    // Only process DMs and @mentions (ignore other channel messages)
    if (!isDm && !isMention) return;

    const content = data.content ?? "";

    // Pairing-challenge check: only DMs (not channel mentions) can capture
    // ownership, and only if the message text satisfies the registered
    // matcher. No "first DM wins" fallback.
    if (isDm && this.isPairingActive()) {
      const challenge = this.pairingChallenge!;
      if (challenge.match(content)) {
        logger.info({ senderId: authorId }, "discord pairing challenge matched");
        // Await captureOwner so the env/DB write inside onOwnerDetected
        // completes before pairing is acknowledged. cancelPairing only
        // fires on success — if the callback throws (e.g. .env unwritable)
        // the matcher stays armed so the user can retry by resending the
        // phrase. See B-1.
        const ok = await this.captureOwner(authorId);
        if (ok) {
          this.cancelPairing();
        }
        // Do NOT fall through — see slack-adapter for rationale. The
        // welcome DM from recordDetectedOwner is the user response.
        return;
      }
      // P2-23 — wrapped-phrase hint (see SlackAdapter for rationale).
      const hint = challenge.hintReply?.(content);
      if (hint) {
        try {
          const ch = await this.client.channels.fetch(data.channel_id ?? "");
          if (ch && "send" in ch) {
            await (ch as TextChannel | DMChannel).send(hint);
          }
        } catch (err) {
          logger.warn(
            { err, channel: data.channel_id },
            "discord pairing hint reply failed",
          );
        }
        return;
      }
    }

    if (!this.mutableOwnerId || authorId !== this.mutableOwnerId) {
      logger.debug(
        { senderId: authorId, channel: data.channel_id },
        "discord message dropped: unauthorized sender",
      );
      return;
    }

    // Inbound file attachments — download immediately before the signed URLs
    // (valid ~24 h) expire.
    const rawAttachments: RawAttachment[] = Array.isArray(data.attachments)
      ? data.attachments
      : [];
    const attachmentRefs: AttachmentRef[] = [];

    if (rawAttachments.length > 0 && this.attachmentStore) {
      for (const att of rawAttachments) {
        if (!att.url || !att.filename) continue;
        const size = att.size ?? 0;
        const mimeType = att.content_type ?? null;

        if (size > DISCORD_INBOUND_MAX_BYTES) {
          logger.warn(
            { size, filename: att.filename },
            "discord inbound file exceeds 25 MB cap, skipping",
          );
          continue;
        }

        try {
          const res = await fetch(att.url, {
            signal: AbortSignal.timeout(DISCORD_HTTP_TIMEOUT_MS),
          });
          if (!res.ok) {
            logger.warn(
              { status: res.status, filename: att.filename },
              "discord file download failed",
            );
            // P2-13: Discord CDN URLs expire after ~24h. If the daemon is
            // late picking up a DM (queue, restart, throttle), the URL is
            // already dead. Surface a sentinel so the agent prompt can
            // include "attachment couldn't be fetched — please resend"
            // rather than silently dropping the file from the turn.
            attachmentRefs.push({
              id: "",
              originalFilename: att.filename,
              mimeType: mimeType ?? "application/octet-stream",
              sizeBytes: 0,
              missing: true,
              missingReason: res.status === 404 || res.status === 403
                ? "cdn_expired_or_blocked"
                : `http_${res.status}`,
            });
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const stream = Readable.from([buf]);
          const result = await this.attachmentStore.ingestStream({
            stream,
            declaredMimeType: mimeType,
            originalFilename: att.filename,
            direction: "inbound",
            provenance: "user_discord",
            maxSizeBytes: DISCORD_INBOUND_MAX_BYTES,
          });
          attachmentRefs.push({
            id: result.id,
            originalFilename: result.originalFilename,
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
          });
        } catch (err) {
          logger.error(
            { err, filename: att.filename },
            "discord file ingest failed",
          );
          attachmentRefs.push({
            id: "",
            originalFilename: att.filename,
            mimeType: mimeType ?? "application/octet-stream",
            sizeBytes: 0,
            missing: true,
            missingReason: "ingest_error",
          });
        }
      }
    }

    const stickerItems = Array.isArray(data.sticker_items)
      ? data.sticker_items
      : [];
    if (!content && attachmentRefs.length === 0 && stickerItems.length > 0) {
      logger.debug({ messageId: data.id }, "discord sticker-only message ignored");
      return;
    }

    const event: Event = createEvent({
      type: "message.received",
      source: "discord",
      priority: isDm ? EventPriority.HIGH : EventPriority.NORMAL,
      data: {
        discordMessageId: data.id,
        discordGuildId: data.guild_id ?? null,
      },
    });

    // Extend to MessageEvent shape
    Object.assign(event, {
      sender: authorId,
      channel: data.channel_id,
      content,
      platform: "discord",
      threadId: null,
      isDm,
      isMention,
      ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
    });

    this.onMessage(event);
  }

  /**
   * Atomically promote a user ID to "owner" and notify the daemon. See
   * slack-adapter.captureOwner for the full B-1 design rationale —
   * pairing must persist through env/DB before we acknowledge it, and
   * mutableOwnerId rolls back if the callback throws.
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
        "discord onOwnerDetected callback failed; pairing rolled back",
      );
      return false;
    }
  }
}

