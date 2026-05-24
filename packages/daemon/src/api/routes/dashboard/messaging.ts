import type { Hono } from "hono";
import { APP_NAME } from "@aitne/shared";
import type { ApiDependencies } from "../../server.js";
import { toSafeErrorMessage } from "../../../logging.js";

export function registerMessagingRoutes(app: Hono, deps: ApiDependencies): void {
  const { config } = deps;

  /**
   * POST /messaging/whatsapp/pair
   *
   * Triggers Baileys pairing and waits up to ~10s for the first scannable QR.
   * Returns 409 (not 404) when WhatsApp isn't enabled yet so the dashboard
   * can show an actionable hint instead of a generic not-found.
   */
  app.post("/messaging/whatsapp/pair", async (c) => {
    if (!deps.whatsappControls) {
      return c.json({ error: "whatsapp_not_available" }, 404);
    }
    if (!config.whatsappEnabled) {
      return c.json(
        {
          error: "whatsapp_not_enabled",
          message:
            "Enable WhatsApp first (toggle the Enable button), then click Pair.",
        },
        409,
      );
    }
    if (!config.whatsappOwnerPhone) {
      return c.json(
        {
          error: "whatsapp_phone_missing",
          message:
            "Set the owner phone (E.164, e.g. +818012345678) and save before pairing.",
        },
        409,
      );
    }

    try {
      const response = await deps.whatsappControls.waitForQr(10_000);
      return c.json(response);
    } catch (err) {
      const message = toSafeErrorMessage(err, "Unknown WhatsApp error");
      return c.json(
        {
          error: "whatsapp_pair_failed",
          message,
          state: deps.whatsappControls.getQrResponse().state,
        },
        500,
      );
    }
  });

  /**
   * GET /messaging/whatsapp/qr
   *
   * Returns the current QR snapshot WITHOUT triggering a fresh pair flow.
   * Dashboard polls this every ~3s while pairing is in progress so the user
   * always sees the latest QR (Baileys rotates them every ~20s).
   */
  app.get("/messaging/whatsapp/qr", (c) => {
    if (!deps.whatsappControls) {
      return c.json({ error: "whatsapp_not_available" }, 404);
    }
    const response = deps.whatsappControls.getQrResponse();
    return c.json({
      ...response,
      error: response.error ? toSafeErrorMessage(response.error) : null,
    });
  });

  /**
   * POST /messaging/whatsapp/reset
   *
   * Recovery path for "unlinked from phone" or "broken link" situations
   * where the cached Baileys auth would otherwise prevent a fresh pair
   * from succeeding. Tears the adapter down, wipes the auth directory
   * (creds.json, session-*.json, qr.txt, …) plus the owner_channels
   * mapping, then — if WhatsApp is currently enabled — rebuilds the
   * adapter and waits up to ~10s for the first QR so the dashboard can
   * render it in the same response.
   */
  app.post("/messaging/whatsapp/reset", async (c) => {
    if (!deps.whatsappControls) {
      return c.json({ error: "whatsapp_not_available" }, 404);
    }
    try {
      const response = await deps.whatsappControls.reset(10_000);
      return c.json(response);
    } catch (err) {
      const message = toSafeErrorMessage(err, "Unknown WhatsApp error");
      return c.json(
        {
          error: "whatsapp_reset_failed",
          message,
          state: deps.whatsappControls.getQrResponse().state,
        },
        500,
      );
    }
  });

  /**
   * GET /messaging/whatsapp/status
   *
   * Lightweight health probe — connection state + last error, no QR fetch.
   */
  app.get("/messaging/whatsapp/status", (c) => {
    if (!deps.whatsappControls) {
      return c.json({ error: "whatsapp_not_available" }, 404);
    }
    const response = deps.whatsappControls.getQrResponse();
    return c.json({
      enabled: config.whatsappEnabled,
      initialized: deps.whatsappControls.isInitialized(),
      state: response.state,
      error: response.error ? toSafeErrorMessage(response.error) : null,
    });
  });

  // ── Telegram pairing ──────────────────────────────────────────────────
  //
  // Three endpoints support the dashboard's QR-deep-link pairing flow:
  //   POST /messaging/telegram/test-token   — getMe (validate token)
  //   POST /messaging/telegram/start-pairing — generate token + QR + deep link
  //   GET  /messaging/telegram/pairing-status — poll until paired
  //
  // The QR encodes `https://t.me/<bot>?start=<token>`. When the user scans
  // it, Telegram opens the bot and sends `/start <token>`; the adapter
  // matches the token, captures the chat ID via discovery mode, and the
  // daemon writes the ID into .env via the onOwnerDetected callback.

  app.post("/messaging/telegram/test-token", async (c) => {
    if (!deps.messagingControls?.telegram) {
      return c.json({ error: "telegram_not_configured" }, 404);
    }
    // Accept an optional candidate token in the request body so the
    // dashboard can validate an UNSAVED draft before persisting it.
    const body = await c.req.json().catch(() => ({}));
    const candidate = typeof body?.token === "string" && body.token.length > 0
      ? body.token
      : undefined;
    try {
      const info = await deps.messagingControls.telegram.testToken(candidate);
      return c.json(info);
    } catch (err) {
      return c.json(
        {
          error: "telegram_test_failed",
          message: toSafeErrorMessage(err, "Telegram token validation failed"),
        },
        400,
      );
    }
  });

  app.post("/messaging/telegram/start-pairing", async (c) => {
    if (!deps.messagingControls?.telegram) {
      return c.json({ error: "telegram_not_configured" }, 404);
    }
    try {
      const result = await deps.messagingControls.telegram.startPairing();
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "telegram_pair_start_failed",
          message: toSafeErrorMessage(err, "Telegram pairing could not start"),
        },
        500,
      );
    }
  });

  app.get("/messaging/telegram/pairing-status", (c) => {
    if (!deps.messagingControls?.telegram) {
      return c.json({ error: "telegram_not_configured" }, 404);
    }
    return c.json(deps.messagingControls.telegram.getPairingStatus());
  });

  app.post("/messaging/telegram/cancel-pairing", (c) => {
    if (!deps.messagingControls?.telegram) {
      return c.json({ error: "telegram_not_configured" }, 404);
    }
    deps.messagingControls.telegram.cancelPairing();
    return c.json({ status: "cancelled" });
  });

  // ── Slack pairing ─────────────────────────────────────────────────────
  //
  // Slack has no QR/deep-link mechanism, so we offer two helpers:
  //   1. Token validation via auth.test
  //   2. A pre-built app manifest (one-click app creation at api.slack.com)
  //   3. Discovery mode for owner user ID — user DMs the bot, daemon captures
  //
  // The manifest uses Aitne's required scopes (im:history,
  // chat:write, app_mentions:read) + Socket Mode + bot scopes. We do NOT
  // include any oauth_redirect_url since Socket Mode bots don't need one.

  app.post("/messaging/slack/test-token", async (c) => {
    if (!deps.messagingControls?.slack) {
      return c.json({ error: "slack_not_configured" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const candidate = typeof body?.token === "string" && body.token.length > 0
      ? body.token
      : undefined;
    try {
      const info = await deps.messagingControls.slack.testToken(candidate);
      return c.json(info);
    } catch (err) {
      return c.json(
        {
          error: "slack_test_failed",
          message: toSafeErrorMessage(err, "Slack token validation failed"),
        },
        400,
      );
    }
  });

  app.get("/messaging/slack/manifest", (c) => {
    // App manifest in JSON form. Slack supports both YAML and JSON in the
    // `?manifest_json=` and `?manifest_yaml=` query params on the new-app
    // create page (https://docs.slack.dev/app-manifests/...).
    //
    // Scope minimization (intentional, do not re-broaden):
    //   - app_mentions:read — for @mentions in channels the user invited the bot to
    //   - chat:write        — required to send messages
    //   - files:read        — required to download user-uploaded files
    //   - im:history        — required to receive `message.im` events
    //   - im:read           — list/inspect direct-message channels
    //   - im:write          — open a DM channel with the owner
    //
    // We DELIBERATELY OMIT:
    //   - channels:history  — would let the bot read every message in every
    //                         channel it's added to. Aitne only DMs,
    //                         so this scope is pure attack surface.
    //   - users:read        — not needed; resolveUserChannel() uses
    //                         conversations.open with the configured user ID.
    const manifest = {
      display_information: {
        name: APP_NAME,
        description: "Local-first proactive assistant",
        background_color: "#1a1a2e",
      },
      features: {
        bot_user: {
          display_name: APP_NAME,
          always_online: true,
        },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "chat:write",
            "files:read",
            "im:history",
            "im:read",
            "im:write",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: ["app_mention", "message.im"],
        },
        interactivity: { is_enabled: false },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    };
    const manifestJson = JSON.stringify(manifest);
    // Slack's "create app from manifest" deep link.
    const createAppUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;
    return c.json({
      manifest,
      manifestJson,
      createAppUrl,
      instructions: [
        "1. Click 'Open Slack app builder' below — Slack will pre-fill the manifest.",
        "2. On the app page, scroll to 'Install App' and click Install to your workspace.",
        "3. Copy the Bot User OAuth Token (xoxb-…) from 'OAuth & Permissions' into the field below.",
        "4. Generate an App-Level Token (xapp-…) under 'Basic Information' → 'App-Level Tokens' with `connections:write` scope, paste it below.",
        "5. Click Save Slack Config, then 'Generate pairing phrase' and DM the bot with the phrase.",
      ],
    });
  });

  /**
   * POST /messaging/slack/start-pairing
   *
   * Generates a fresh magic phrase, registers it as the Slack adapter's
   * pairing challenge, and returns it to the dashboard. The user must
   * include this phrase in the next DM they send to the bot — only that
   * matching DM captures the owner role. The previous "enable-discovery"
   * endpoint was vulnerable to a 5-minute race where any DM could
   * hijack ownership; the magic phrase closes that.
   */
  app.post("/messaging/slack/start-pairing", async (c) => {
    if (!deps.messagingControls?.slack) {
      return c.json({ error: "slack_not_configured" }, 404);
    }
    try {
      const result = await deps.messagingControls.slack.startPairing();
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "slack_pair_start_failed",
          message: toSafeErrorMessage(err, "Slack pairing could not start"),
        },
        400,
      );
    }
  });

  app.post("/messaging/slack/cancel-pairing", (c) => {
    if (!deps.messagingControls?.slack) {
      return c.json({ error: "slack_not_configured" }, 404);
    }
    deps.messagingControls.slack.cancelPairing();
    return c.json({ status: "cancelled" });
  });

  app.get("/messaging/slack/pairing-status", (c) => {
    if (!deps.messagingControls?.slack) {
      return c.json({ error: "slack_not_configured" }, 404);
    }
    return c.json(deps.messagingControls.slack.getPairingStatus());
  });

  // ── Discord pairing ───────────────────────────────────────────────────
  //
  // Discord parity: token validation + magic-phrase pairing for owner user ID.

  app.post("/messaging/discord/test-token", async (c) => {
    if (!deps.messagingControls?.discord) {
      return c.json({ error: "discord_not_configured" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const candidate = typeof body?.token === "string" && body.token.length > 0
      ? body.token
      : undefined;
    try {
      const info = await deps.messagingControls.discord.testToken(candidate);
      return c.json(info);
    } catch (err) {
      return c.json(
        {
          error: "discord_test_failed",
          message: toSafeErrorMessage(err, "Discord token validation failed"),
        },
        400,
      );
    }
  });

  app.post("/messaging/discord/start-pairing", async (c) => {
    if (!deps.messagingControls?.discord) {
      return c.json({ error: "discord_not_configured" }, 404);
    }
    try {
      const result = await deps.messagingControls.discord.startPairing();
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "discord_pair_start_failed",
          message: toSafeErrorMessage(err, "Discord pairing could not start"),
        },
        400,
      );
    }
  });

  app.post("/messaging/discord/cancel-pairing", (c) => {
    if (!deps.messagingControls?.discord) {
      return c.json({ error: "discord_not_configured" }, 404);
    }
    deps.messagingControls.discord.cancelPairing();
    return c.json({ status: "cancelled" });
  });

  app.get("/messaging/discord/pairing-status", (c) => {
    if (!deps.messagingControls?.discord) {
      return c.json({ error: "discord_not_configured" }, 404);
    }
    return c.json(deps.messagingControls.discord.getPairingStatus());
  });
}
