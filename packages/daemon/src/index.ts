import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  getContextDir,
  runVaultHealthProbe,
  validateExternalObsidianVaultPath,
} from "./config.js";
import {
  getDegradedMode,
  isSetupCompleted,
  isDegraded as readDegradedMode,
} from "./db/runtime-state.js";
import { initDirectories } from "./init.js";

import { EventBus } from "./core/event-bus.js";
import { AgentScheduler } from "./core/scheduler.js";
import { CustomRoutineScheduler } from "./core/custom-routine-scheduler.js";
import { HealthMonitor } from "./core/health-monitor.js";
import { Heartbeat } from "./core/heartbeat.js";
import { MessageHub, type MessageDelivery } from "./adapters/message-hub.js";
import { resolvePrimaryPlatform } from "./adapters/primary-platform-resolver.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { SlackAdapter } from "./adapters/slack-adapter.js";
import { TelegramAdapter } from "./adapters/telegram-adapter.js";
import { DashboardAdapter } from "./adapters/dashboard-adapter.js";
import type {
  TelegramControls,
  SlackControls,
  DiscordControls,
} from "./api/server.js";
import { ObsidianService } from "./services/obsidian.js";
import { createServiceRegistry } from "./services/service-registry.js";
import { ensureSkeletonFiles, resolveTemplatesRoot } from "./core/skeleton.js";
import {
  reconcileTemplateAssets,
  recordInstructionAssetStatus,
  recordSkillAssetStatus,
} from "./core/release-assets.js";
import {
  bootstrapManagementMd,
  startManagementMdWatcher,
  type ManagementMdWatcherHandle,
} from "./core/management-md.js";
import {
  bootstrapManagementRegistry,
  startManagementRegistryWatcher,
  type ManagementRegistryWatcherHandle,
} from "./core/management-registry.js";
import {
  startDocsIndexer,
  type DocsIndexerHandle,
} from "./core/docs/indexer.js";
import type { IntegrationStatuses } from "./api/server.js";
import {
  APP_NAME,
  EventPriority,
  getBackendIds,
} from "@aitne/shared";
import {
  getOwnerChannel,
  selectFirstPairedPlatform,
} from "./messaging/owner-channels.js";
import {
  SUPPORTED_MESSAGING_PLATFORMS,
} from "./messaging/constants.js";
import { AgentWriteTracker } from "./safety/agent-write-tracker.js";
import {
  InMemoryTodayWriteLockManager,
  getTodayWriteLockTimeoutMs,
} from "./core/today-write-lock.js";
import {
  InMemoryRoadmapWriteLockManager,
  getRoadmapWriteLockTimeoutMs,
} from "./core/roadmap-write-lock.js";
import { runRoadmapMechanicalMaintenance } from "./core/roadmap-maintenance.js";
import { fanoutResearchClusterUpdates } from "./core/browser-history/research-cluster-fanout.js";
import { safeRunPreMorningDigestJob } from "./core/browser-history/pre-morning-digest-job.js";
import { shouldStartObserversFor } from "./core/integration-lifecycle.js";
import { sweepExpiredMigrationBackups } from "./api/routes/setup-migrate.js";
import { PlatformSecretStore } from "./secrets/platform-secret-store.js";
import { FileEncryptedBlobStore } from "./secrets/encrypted-blob-store.js";
import { MailAccountRegistry } from "./services/mail/account-registry.js";
import {
  loadOutlookClientConfig,
  OutlookClientConfigMissingError,
} from "./services/mail/outlook/client-config.js";
import { createRuntimeMsalApp } from "./services/mail/outlook/msal-app-factory.js";
import { OutlookGraphProvider } from "./services/mail/outlook/outlook-provider.js";
import { parseImapAccountSecret } from "./services/mail/imap/app-password.js";
import { ICloudImapProvider } from "./services/mail/imap/icloud-provider.js";
import { YahooImapProvider } from "./services/mail/imap/yahoo-provider.js";
import { GmailProvider } from "./services/mail/gmail/gmail-provider.js";
import { SecretBroker } from "./secrets/secret-broker.js";
import {
  captureOriginalShellEnv,
  syncBackendApiKeyToEnv,
} from "./secrets/backend-api-key-env.js";
import { createLogger, toSafeErrorMessage } from "./logging.js";
import {
  runCatchup,
  runPostMessagingCatchup,
} from "./bootstrap/catchup.js";
import {
  createAdapterReloaders,
  type AdapterState,
} from "./bootstrap/adapters.js";
import {
  createInitialSecretState,
  createServiceReloaders,
} from "./bootstrap/services.js";
import { initDatabase } from "./bootstrap/db.js";
import { createObservers } from "./bootstrap/observers.js";
import { startApiServer } from "./bootstrap/api.js";
import { createEventPipeline } from "./bootstrap/event-pipeline.js";

const logger = createLogger("daemon", {
  transport: {
    target: "pino-pretty",
    options: { colorize: !process.env.PA_DAEMONIZED },
  },
});

const startedAt = new Date();

async function startup(): Promise<void> {
  logger.info({ logLevel: logger.level }, `${APP_NAME} Daemon starting...`);

  // Snapshot the original shell-set values for ANTHROPIC_API_KEY /
  // OPENAI_API_KEY / GEMINI_API_KEY+GOOGLE_API_KEY *before* any keychain
  // mirroring runs. The capture is the source of truth for "fall back to
  // shell env" when the operator clears the keychain entry via the
  // dashboard. See `secrets/backend-api-key-env.ts` for precedence.
  captureOriginalShellEnv();

  // ── 1. Configuration ──
  const config = loadConfig();
  const secretBroker = new SecretBroker(new PlatformSecretStore());
  const releaseAssetBackupRoot = join(config.dataDir, "backups", "release-assets");

  // Tighten .env permissions BEFORE the first read/write so bootstrap
  // values aren't world-readable between env-writer's later chmod calls.
  // Best-effort: log and continue if chmod fails (some filesystems and
  // CI sandboxes don't honor mode bits).
  const {
    getEnvFilePath: getEnvFilePathEarly,
    ensureEnvFilePermissions: ensureEnvFilePermissionsEarly,
  } = await import("./api/env-writer.js");
  try {
    ensureEnvFilePermissionsEarly(getEnvFilePathEarly());
  } catch (err) {
    logger.warn({ err }, "Could not chmod .env to 0o600 — secrets may be world-readable");
  }

  logger.info({ dataDir: config.dataDir, apiPort: config.apiPort }, "Config loaded");

  // ── 2. Directory structure ──
  initDirectories(config);

  // ── 3. Database ──
  // Schema apply + boot-time backfills + settings merge + delegated-task-mode
  // default-correction. See `bootstrap/db.ts` for the per-step rationale.
  const { db, settingsStore, persistedSettings, attachmentStore } = initDatabase({
    config,
  });

  // ── Integration Delegation Framework (Phase 1) ──
  // Reconcile `<dataDir>/integrations.md` with the DB integrations map.
  // Creates the file on first run, parses hand-edits if present, and
  // re-renders unconditionally so daemon-owned columns are canonical.
  // The watcher is started later (after the observer manager) so fs-watch
  // errors don't block boot.
  let managementMdWatcher: ManagementMdWatcherHandle | null = null;
  let managementRegistryWatcher: ManagementRegistryWatcherHandle | null = null;
  try {
    await bootstrapManagementMd(config.dataDir, db, config.workspaceDir, {
      externalObsidianVaultPath: config.externalObsidianVaultPath,
      externalObsidianWatch: config.externalObsidianWatch,
    });
  } catch (err) {
    logger.error(
      { err, dataDir: config.dataDir },
      "integrations.md bootstrap failed; continuing with DB state",
    );
  }

  // ── Docs corpus indexer (DOCS_QA_DESIGN.md P1) ──
  // Seeds `docs/user/` from `agent-assets/docs/` on first launch, then
  // runs a boot-scan and starts a chokidar watcher with the same 300ms
  // debounce window the management-md watcher uses. A startup failure
  // is non-fatal — the daemon still serves but `/api/docs/health`
  // surfaces `status: "degraded"`.
  let docsIndexer: DocsIndexerHandle | null = null;
  try {
    docsIndexer = await startDocsIndexer(db, {
      workspaceDir: config.workspaceDir,
      backupRoot: releaseAssetBackupRoot,
    });
  } catch (err) {
    logger.error({ err }, "docs indexer failed to start");
  }

  try {
    recordInstructionAssetStatus(db, config.workspaceDir);
    const skillStatus = recordSkillAssetStatus(db, config.dataDir, config.workspaceDir);
    if (skillStatus.builtinShadowedUserSkills.length > 0) {
      logger.warn(
        { slugs: skillStatus.builtinShadowedUserSkills },
        "User skills are shadowed by newly-shipped built-in skills",
      );
    }
  } catch (err) {
    logger.warn({ err }, "release asset status scan failed");
  }

  // ── Management Mode startup validation (plan §5.4) ──
  // Delegated to `runVaultHealthProbe` so startup and the 30-second timer
  // use identical logic. The probe internally handles:
  //   - plain mode  → clear any stale degraded state
  //   - obsidian mode + setup incomplete → clear (bootstrapping bypass so
  //     the DM-driven setup flow is not blocked by 503)
  //   - obsidian mode + primaryVaultPath null → degraded
  //   - obsidian mode + path unreachable → degraded
  //   - obsidian mode + path reachable → lift
  const startupProbe = runVaultHealthProbe(config, db);
  if (startupProbe.action === "entered") {
    logger.warn(
      { reason: startupProbe.reason },
      "Management Mode degraded at startup",
    );
  } else if (startupProbe.action === "lifted") {
    logger.info("Management Mode degraded state cleared at startup");
  }

  if (process.env.PA_VAULT_STRICT === "1" && readDegradedMode(db)) {
    const state = getDegradedMode(db);
    logger.fatal(
      { degradedState: state },
      "PA_VAULT_STRICT=1 and degraded mode active — exiting",
    );
    process.exit(1);
  }

  if (isSetupCompleted(db) && !readDegradedMode(db)) {
    const contextDir = getContextDir(config);
    ensureSkeletonFiles(contextDir, config.workspaceDir);

    // ── Management Registry boot reconcile (design 21 §7.2 / P2) ──
    // Mirrors `bootstrapManagementMd` (which owns integrations.md). Reads
    // `<contextDir>/rules/management.md` and reconciles its A-section with
    // `settings.sot_bindings`; renders a fresh file when the on-disk
    // schema_version does not match the current daemon's. Run after
    // `ensureSkeletonFiles` so the seeded template is the parse target
    // on first install.
    try {
      await bootstrapManagementRegistry(contextDir, db);
    } catch (err) {
      logger.error(
        { err, contextDir },
        "rules/management.md bootstrap failed; continuing with DB state",
      );
    }

    // Release asset reconcile (future-proofing for format changes).
    // Missing templates are added, unedited versioned templates are
    // refreshed from the shipped tree, and edited files are preserved and
    // reported in `runtime_state.templates.pending` for review.
    try {
      const templatesRoot = resolveTemplatesRoot(config.workspaceDir);
      const templateStatus = reconcileTemplateAssets({
        db,
        templatesRoot,
        contextDir,
        backupRoot: releaseAssetBackupRoot,
      });
      if (templateStatus.pending.length > 0) {
        logger.warn(
          { pending: templateStatus.pending, count: templateStatus.pending.length },
          "template upgrades pending — user-edited files were preserved (inspect via /api/health.templatesPending)",
        );
      }
      if (templateStatus.autoUpdated > 0 || templateStatus.added > 0) {
        logger.info(
          { added: templateStatus.added, autoUpdated: templateStatus.autoUpdated },
          "release template assets reconciled",
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        "template asset reconcile failed — continuing startup; pending snapshot unchanged",
      );
    }
  }

  if (config.externalObsidianVaultPath) {
    const externalCheck = validateExternalObsidianVaultPath(
      config.externalObsidianVaultPath,
      config,
    );
    if (!externalCheck.ok) {
      logger.warn(
        {
          path: config.externalObsidianVaultPath,
          error: externalCheck.error,
          message: externalCheck.message,
        },
        "externalObsidianVaultPath invalid — the Obsidian CLI skill will be degraded",
      );
    }
  }

  // Auto-generate API token if it does not exist in the secret store yet.
  if (!(await secretBroker.getApiToken())) {
    await secretBroker.set("apiToken", randomBytes(32).toString("hex"));
    logger.info("Generated PA_API_TOKEN in secret store");
  }

  // Mirror keychain-stored backend API keys into process.env so the
  // existing Claude SDK / Codex CLI / Gemini CLI subprocesses pick them
  // up via the unchanged `process.env.ANTHROPIC_API_KEY` etc. read paths.
  // Keychain values take precedence over shell env (the captured
  // snapshot above acts as the fallback when the operator clears the
  // dashboard entry).
  for (const backendId of getBackendIds()) {
    try {
      const result = await syncBackendApiKeyToEnv(
        secretBroker,
        backendId,
        process.env,
        { dataDir: config.dataDir },
      );
      if (result.source === "keychain") {
        logger.info(
          { backendId, source: result.source },
          "Mirrored backend API key from keychain into process.env",
        );
      }
    } catch (err) {
      logger.warn(
        { err, backendId },
        "Failed to read backend API key from keychain — backend will fall back to existing env / CLI auth",
      );
    }
  }
  logger.info("Database initialized");

  // ── 4. Core components ──
  const eventBus = new EventBus();
  const writeTracker = new AgentWriteTracker();
  // Morning-routine and roadmap write locks are constructed here (earlier
  // than their historical home at §11) so the reconciler observer can
  // consult the morning-routine lock when its cron trigger fires. Both
  // locks are passed into the dispatcher later without re-construction.
  const morningRoutineLock = new InMemoryTodayWriteLockManager(
    getTodayWriteLockTimeoutMs(config.executeTimeoutMinutes),
  );
  const roadmapWriteLock = new InMemoryRoadmapWriteLockManager(
    getRoadmapWriteLockTimeoutMs(config.executeTimeoutMinutes),
  );

  // ── 5. Messaging adapters ──
  const messageHub = new MessageHub(config, db);

  /**
   * Persist a freshly-detected owner ID into .env + in-memory config and
   * send a welcome DM. Called by Slack/Telegram/Discord adapters when
   * discovery (or a Telegram pair token) captures the owner from the first
   * inbound DM.
   *
   * Why this lives in index.ts (not the adapter): the adapter must not
   * import env-writer directly — that would couple the adapter layer to the
   * config-persistence layer. The adapter just calls back; index.ts owns
   * the wiring.
   */
  async function recordDetectedOwner(
    platform: "slack" | "telegram" | "discord",
    ownerId: string,
  ): Promise<void> {
    const fieldByPlatform = {
      slack: "slackOwnerUserId",
      telegram: "telegramOwnerChatId",
      discord: "discordOwnerUserId",
    } as const;

    const { applyConfigUpdates } = await import("./api/env-writer.js");
    // No `db` option needed — owner-id pairing never touches Note Sources
    // keys, so the §6.2 side-effect inside applyConfigUpdates is a no-op.
    const result = await applyConfigUpdates(config, settingsStore, {
      [fieldByPlatform[platform]]: ownerId,
    });

    if (Object.keys(result.errors).length > 0) {
      logger.error(
        { platform, ownerId, errors: result.errors },
        "Failed to persist detected owner ID to .env",
      );
      // Throw so the adapter's captureOwner rolls back mutableOwnerId.
      // Without this, the adapter would silently accept owner DMs in
      // memory while .env shows no pairing — and the next daemon restart
      // would lose the binding. The user's matcher stays armed
      // (cancelPairing was not called) so they can retry by resending
      // the phrase once the underlying env-write issue is resolved.
      const errorKeys = Object.keys(result.errors).join(", ");
      throw new Error(
        `Failed to persist ${platform} owner ID to .env: ${errorKeys}`,
      );
    }

    logger.info({ platform, ownerId }, "auto-paired owner from discovery");

    // Greet the user so they know pairing landed. The consolidated
    // welcome path (via sendSetupWelcomeDm / WELCOME_DM_TEXT) is preferred
    // over emitting an inline "Pairing successful…" ack: pairing during
    // setup would otherwise fire two greetings in quick succession.
    //
    // Three-way UX contract:
    //
    //   1. First-time pairing (no latch yet) — `sendSetupWelcomeDm` fires
    //      the full WELCOME_DM_TEXT (includes ack + bang-command menu) and
    //      sets the latch. No inline ack needed.
    //
    //   2. Re-pairing onto a DIFFERENT platform (latch set on a prior
    //      platform) — the welcome path is latched globally and returns
    //      null. Without a fallback the operator would hear nothing back
    //      from the new platform, indistinguishable from a failed
    //      pairing. We send a short per-platform "Pairing successful" ack
    //      ONLY in this branch so the newly-paired platform confirms
    //      pairing landed without re-firing the full menu.
    //
    //   3. Re-pairing the SAME platform — same as case 2 (welcome latched,
    //      short ack fires). The ack is harmless even if the operator
    //      remembers the menu from before.
    //
    // Best-effort throughout: env-write already succeeded so the pairing
    // is durable; a transient send failure must NOT roll back the
    // persisted owner ID.
    try {
      const { sendSetupWelcomeDm } = await import(
        "./messaging/setup-welcome-dm.js"
      );
      const welcomeDeliveries = await sendSetupWelcomeDm({ db, messageHub });
      if (welcomeDeliveries === null) {
        // Latched or no eligible at the time of first run — fall back to
        // the targeted ack so the newly-paired platform doesn't end up
        // silent. Scoped to JUST the platform that paired (not fan-out)
        // because the welcome ALREADY covered the other configured
        // platforms on the original pairing event.
        try {
          await messageHub.sendToPlatform(
            platform,
            "user",
            `Pairing successful — this channel is now linked as your owner DM.`,
          );
        } catch (err) {
          logger.warn(
            { err, platform },
            "Failed to deliver inline pairing ack (welcome was latched)",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, platform },
        "Failed to deliver welcome DM after auto-pairing",
      );
    }
  }

  const adapterState: AdapterState = {
    discord: null,
    slack: null,
    telegram: null,
    whatsapp: null,
  };

  const {
    reloadDiscordAdapter,
    reloadSlackAdapter,
    reloadTelegramAdapter,
    buildWhatsAppAdapter,
    teardownWhatsAppAdapter,
    enableWhatsAppAdapter,
  } = createAdapterReloaders({
    config,
    secretBroker,
    messageHub,
    eventBus,
    attachmentStore,
    recordDetectedOwner,
    onWhatsAppLoggedOut: async () => {
      try {
        await messageHub.sendToUser(
          "WhatsApp session logged out — re-run foreground pairing",
        );
      } catch (err) {
        logger.error(
          { err },
          "Failed to deliver WhatsApp logout notification via fallback channel",
        );
      }
    },
    state: adapterState,
  });

  await Promise.all([
    reloadDiscordAdapter(false),
    reloadSlackAdapter(false),
    reloadTelegramAdapter(false),
  ]);

  if (config.whatsappEnabled) {
    if (!config.whatsappOwnerPhone) {
      throw new Error(
        "PA_WHATSAPP_ENABLED=true but PA_WHATSAPP_OWNER_PHONE is not set",
      );
    }
    buildWhatsAppAdapter();
  }

  /**
   * Build the per-platform pairing helpers (`messagingControls`) for the
   * dashboard API. Each block returns `undefined` when its adapter wasn't
   * registered, so the dashboard route can branch on existence to render
   * "not configured" messaging without 404'ing the user.
   *
   * Why a builder, not three separate consts: keeps the wiring co-located
   * with the adapter declarations and short-circuits the cases where
   * dynamic imports (e.g. `qrcode` for Telegram QR rendering) would
   * otherwise be loaded for adapters the user never configured.
   */
  /**
   * Refuse to start a pairing flow on an adapter that isn't actually
   * connected to its upstream service. Without this gate the dashboard
   * would happily display a QR or magic phrase even though the daemon's
   * Slack/Telegram/Discord client failed to come up — the user would scan
   * or type the phrase forever and nothing would arrive.
   */
  function assertAdapterReady(platform: "telegram" | "slack" | "discord"): void {
    const status = messageHub.getPlatformRuntimeStatus(platform);
    if (status.runtimeState !== "ok") {
      throw new Error(
        `${platform} adapter is not connected (${status.error ?? status.runtimeState}). `
          + `Verify the token, then save and retry.`,
      );
    }
  }

  function buildTelegramControls(): TelegramControls {
    return {
      testToken: async (candidate?: string) => {
        // Prefer the candidate token from the request body so the
        // dashboard can validate an unsaved draft. Falls back to the
        // currently-saved token if no candidate was supplied.
        const tokenToTest = candidate ?? await secretBroker.getTelegramBotToken();
        if (!tokenToTest) {
          throw new Error("No Telegram bot token provided.");
        }
        const info = await TelegramAdapter.fetchBotInfo(tokenToTest);
        return {
          ok: true,
          id: info.id,
          username: info.username,
          firstName: info.firstName,
        };
      },
      startPairing: async (ttlMs = 5 * 60_000) => {
        assertAdapterReady("telegram");
        const adapter = adapterState.telegram;
        if (!adapter) {
          throw new Error("Telegram adapter is not initialized. Save the token and retry.");
        }
        const savedToken = await secretBroker.getTelegramBotToken();
        if (!savedToken) {
          throw new Error("No Telegram bot token provided.");
        }

        // Always re-fetch bot info on pair start. Caching it on adapter
        // start meant a stale username (e.g. user renamed the bot via
        // BotFather) would silently break the deep link.
        const info = await TelegramAdapter.fetchBotInfo(savedToken);
        if (!info.username) {
          throw new Error(
            "Telegram bot has no username — set one via @BotFather (/setname or /newbot) before pairing.",
          );
        }

        // 96 bits of entropy in the pair token. The QR encodes a deep link
        // of the form `https://t.me/<bot>?start=<token>`; when the user
        // taps START in Telegram, the bot receives `/start <token>` and
        // the matcher below promotes them to owner. WITHOUT a separate
        // discovery fallback — that combination was unsafe (any DM during
        // the window would claim the role even without the token).
        const pairToken = randomBytes(12).toString("base64url");
        const expiresAt = Date.now() + ttlMs;

        // Matcher rules:
        //   - The `/start` and optional `@<botname>` prefix are matched
        //     case-INSENSITIVELY. Telegram bot usernames are case-
        //     insensitive in URLs and mentions, and clients normalize
        //     differently — `MyBot`, `mybot`, `MYBOT` must all work.
        //   - The token itself is matched case-SENSITIVELY (base64url
        //     uses both cases) so we keep the full 96-bit search space.
        //   - Anything after the token (extra args, trailing whitespace
        //     beyond what trim() handles) rejects, so we can't be tricked
        //     into matching a longer payload that happens to start with
        //     `/start <token>`.
        const escapedUsername = info.username.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const prefixRe = new RegExp(
          `^/start(?:@${escapedUsername})?\\s+`,
          "i",
        );

        adapter.startPairing({
          match: (text) => {
            const trimmed = text.trim();
            const prefixMatch = trimmed.match(prefixRe);
            if (!prefixMatch) return false;
            const remainder = trimmed.slice(prefixMatch[0].length);
            return remainder === pairToken;
          },
          expiresAt,
        });

        const deepLink = `https://t.me/${info.username}?start=${pairToken}`;
        const qrcodeMod = await import("qrcode" as string);
        const toDataURL = (qrcodeMod.default ?? qrcodeMod).toDataURL as (
          text: string,
          options?: { width?: number; margin?: number },
        ) => Promise<string>;
        const qrDataUrl = await toDataURL(deepLink, { width: 320, margin: 2 });

        return {
          pairToken,
          deepLink,
          qrDataUrl,
          expiresAt,
          botUsername: info.username,
        };
      },
      getPairingStatus: () => ({
        paired: adapterState.telegram?.getOwnerChatId() !== null,
        ownerChatId: adapterState.telegram?.getOwnerChatId() ?? null,
        pairingActive: adapterState.telegram?.isPairingActive() ?? false,
      }),
      cancelPairing: () => {
        adapterState.telegram?.cancelPairing();
      },
    };
  }

  function buildSlackControls(): SlackControls {
    return {
      testToken: async (candidate?: string) => {
        const tokenToTest = candidate ?? await secretBroker.getSlackBotToken();
        if (!tokenToTest) {
          throw new Error("No Slack bot token provided.");
        }
        const info = await SlackAdapter.fetchBotInfo(tokenToTest);
        return {
          ok: true,
          botUserId: info.botUserId,
          botName: info.botName,
          team: info.team,
          url: info.url,
        };
      },
      startPairing: async (ttlMs = 5 * 60_000) => {
        assertAdapterReady("slack");
        const adapter = adapterState.slack;
        if (!adapter) {
          throw new Error("Slack adapter is not initialized. Save the tokens and retry.");
        }
        // Magic-phrase pairing: the dashboard displays the phrase, the
        // user copies/types it into their bot DM, the matcher (closed over
        // the normalized phrase) accepts only DMs containing it. Defeats
        // the previous "first DM wins" race entirely because attackers
        // who can't see the dashboard can't see the phrase.
        const { generateMagicPhrase, buildPhraseMatcher, isPhraseWrappedInExtraText } = await import(
          "./messaging/magic-phrase.js"
        );
        const phrase = generateMagicPhrase();
        const expiresAt = Date.now() + ttlMs;
        adapter.startPairing({
          match: buildPhraseMatcher(phrase),
          expiresAt,
          hintReply: (text) =>
            isPhraseWrappedInExtraText(phrase, text)
              ? "Send the pairing phrase by itself, with no other text."
              : null,
        });
        return { phrase, expiresAt };
      },
      cancelPairing: () => {
        adapterState.slack?.cancelPairing();
      },
      getPairingStatus: () => ({
        paired: adapterState.slack?.getOwnerUserId() !== null,
        ownerUserId: adapterState.slack?.getOwnerUserId() ?? null,
        pairingActive: adapterState.slack?.isPairingActive() ?? false,
      }),
    };
  }

  function buildDiscordControls(): DiscordControls {
    return {
      testToken: async (candidate?: string) => {
        const tokenToTest = candidate ?? await secretBroker.getDiscordBotToken();
        if (!tokenToTest) {
          throw new Error("No Discord bot token provided.");
        }
        const info = await DiscordAdapter.fetchBotInfo(tokenToTest);
        return {
          ok: true,
          id: info.id,
          username: info.username,
          discriminator: info.discriminator,
          avatarUrl: info.avatarUrl,
        };
      },
      startPairing: async (ttlMs = 5 * 60_000) => {
        assertAdapterReady("discord");
        const adapter = adapterState.discord;
        if (!adapter) {
          throw new Error("Discord adapter is not initialized. Save the token and retry.");
        }
        const { generateMagicPhrase, buildPhraseMatcher, isPhraseWrappedInExtraText } = await import(
          "./messaging/magic-phrase.js"
        );
        const phrase = generateMagicPhrase();
        const expiresAt = Date.now() + ttlMs;
        adapter.startPairing({
          match: buildPhraseMatcher(phrase),
          expiresAt,
          hintReply: (text) =>
            isPhraseWrappedInExtraText(phrase, text)
              ? "Send the pairing phrase by itself, with no other text."
              : null,
        });
        return { phrase, expiresAt };
      },
      cancelPairing: () => {
        adapterState.discord?.cancelPairing();
      },
      getPairingStatus: () => ({
        paired: adapterState.discord?.getOwnerUserId() !== null,
        ownerUserId: adapterState.discord?.getOwnerUserId() ?? null,
        pairingActive: adapterState.discord?.isPairingActive() ?? false,
      }),
    };
  }

  // Dashboard adapter — always registered (activates on SSE connect)
  const dashboardAdapter = new DashboardAdapter(
    (event) => void eventBus.put(event),
  );
  messageHub.register(dashboardAdapter);

  dashboardAdapter.setAttachmentStore(attachmentStore);

  // ── 6. External services (mutable registry for hot-reload) ──
  const services = createServiceRegistry();
  const blobStore = new FileEncryptedBlobStore(
    resolve(config.dataDir, "secrets", "blobs"),
    new PlatformSecretStore(),
  );
  // Forward-declared so the registry constructor can wire its scope-change
  // observer before `sessionManager` / `eventBroadcaster` exist. The real
  // implementation is assigned below once those deps are live — until then,
  // `onMailScopeChanged` is a no-op (which is correct: no DM sessions can
  // exist pre-dispatcher).
  let onMailScopeChanged: (reason: string) => void = () => undefined;

  services.mail = new MailAccountRegistry({
    db,
    blobStore: blobStore,
    getEnabledKinds: () => config.enabledMailProviders,
    onScopeChanged: (reason) => onMailScopeChanged(reason),
    providerFactories: {
      // Gmail credentials remain on the shared Google OAuth path, so the
      // row stores a sentinel in `secret_blob_name` and the factory reads
      // the live GmailService from the registry instead of the blob store.
      gmail: (account) => {
        const service = services.gmail;
        if (!service || !service.available) {
          throw new Error(
            `Gmail service not initialized for account ${account.id}. Complete Google OAuth in the dashboard.`,
          );
        }
        return new GmailProvider({ account, service });
      },
      outlook: async (account, ctx) => {
        const clientConfig = await loadOutlookClientConfig(blobStore);
        if (!clientConfig) throw new OutlookClientConfigMissingError();
        const msalApp = createRuntimeMsalApp(clientConfig, account.id, blobStore);
        return new OutlookGraphProvider({
          account,
          msalApp,
          abortSignal: ctx.signal,
        });
      },
      yahoo: async (account) => {
        const raw = await blobStore.readUtf8(`mail:${account.kind}:${account.id}`);
        if (!raw) throw new Error(`Missing IMAP secret for ${account.id}`);
        return new YahooImapProvider({
          account,
          secret: parseImapAccountSecret(raw),
          onCapabilitiesProbed: (id, caps) => {
            services.mail?.updateCapabilities(id, caps);
          },
        });
      },
      icloud: async (account) => {
        const raw = await blobStore.readUtf8(`mail:${account.kind}:${account.id}`);
        if (!raw) throw new Error(`Missing IMAP secret for ${account.id}`);
        return new ICloudImapProvider({
          account,
          secret: parseImapAccountSecret(raw),
          onCapabilitiesProbed: (id, caps) => {
            services.mail?.updateCapabilities(id, caps);
          },
        });
      },
    },
  });
  const secretState = createInitialSecretState();
  const {
    reloadGoogleServices,
    reloadAppleCalendarService,
    reloadNotionService,
    reloadGitHubService,
  } = createServiceReloaders({
    db,
    config,
    secretBroker,
    services,
    secretState,
  });

  // Obsidian
  if (config.externalObsidianVaultName) {
    const obsidianService = new ObsidianService(config);
    if (obsidianService.available) {
      logger.info({ vaultName: config.externalObsidianVaultName }, "Probing Obsidian CLI...");
      const running = await obsidianService.isRunning();
      if (running) {
        services.obsidian = obsidianService;
        logger.info({ vaultName: config.externalObsidianVaultName }, "Obsidian service available");
      } else {
        services.errors.obsidian = "Obsidian CLI not accessible — is Obsidian running?";
        logger.warn("Obsidian CLI not accessible — is Obsidian running?");
      }
    }
  } else if (config.externalObsidianVaultPath && !config.externalObsidianVaultName) {
    services.errors.obsidian = "externalObsidianVaultName is required for the Obsidian CLI service (externalObsidianVaultPath alone enables file watching only)";
  }


  await Promise.all([
    reloadGoogleServices(),
    reloadAppleCalendarService(),
    reloadNotionService(),
    reloadGitHubService(),
  ]);

  /** Build integration status snapshot for /api/health */
  const getIntegrationStatus = (): IntegrationStatuses => {
    const whatsappState = config.whatsappEnabled
      ? (adapterState.whatsapp?.getStatus() ?? "disabled")
      : "not_configured";

    return {
      google: {
        configured: secretState.googleCredentialsConfigured,
        connected: services.calendar !== null || services.gmail !== null,
        error: services.errors.googleCalendar
          ? toSafeErrorMessage(services.errors.googleCalendar)
          : null,
        services: {
          calendar: {
            connected: services.calendar !== null,
            error: services.errors.googleCalendar
              ? toSafeErrorMessage(services.errors.googleCalendar)
              : null,
          },
          gmail: {
            connected: services.gmail !== null,
            error: services.errors.gmail
              ? toSafeErrorMessage(services.errors.gmail)
              : null,
          },
        },
      },
      appleCalendar: {
        // `configured` reflects whether credentials are stored in the
        // keychain; `connected` reflects whether last principal-discovery
        // succeeded. The Overview's "Apple selected but not connected"
        // banner reads `appleCalendar.configured && !appleCalendar.connected`.
        configured: services.appleCalendar !== null || !!services.errors.appleCalendar,
        connected: services.appleCalendar?.available ?? false,
        error: services.errors.appleCalendar
          ? toSafeErrorMessage(services.errors.appleCalendar)
          : null,
      },
      obsidian: {
        configured: !!(config.externalObsidianVaultPath || config.externalObsidianVaultName),
        connected: services.obsidian !== null,
        error: services.errors.obsidian
          ? toSafeErrorMessage(services.errors.obsidian)
          : null,
      },
      notion: {
        configured: secretState.notionConfigured,
        connected: services.notion !== null,
        error: services.errors.notion
          ? toSafeErrorMessage(services.errors.notion)
          : null,
      },
      whatsapp: {
        configured: config.whatsappEnabled,
        connected: whatsappState === "ok",
        error:
          whatsappState === "disconnected"
            ? "WhatsApp disconnected"
            : whatsappState === "logged_out"
              ? "WhatsApp logged out"
              : null,
        state: whatsappState,
      },
    };
  };

  const getMessagingStatus = (): Record<string, {
    configured: boolean;
    runtimeState: "ok" | "error" | "not_configured" | "connecting";
    ownerConfigured: boolean;
    ownerChannelKnown: boolean;
    notificationEligible: boolean;
    lastInboundAt: string | null;
    error: string | null;
  }> => {
    return Object.fromEntries(
      SUPPORTED_MESSAGING_PLATFORMS.map((platform) => {
        const ownerChannel = getOwnerChannel(db, platform);
        const configured = messageHub.isPlatformConfigured(platform);
        const ownerConfigured = messageHub.isOwnerConfigured(platform);
        const { runtimeState, error } = messageHub.getPlatformRuntimeStatus(platform);

        const ownerChannelKnown = platform === "dashboard"
          ? dashboardAdapter.getActiveChannels().length > 0 || !!ownerChannel
          : platform === "telegram"
            ? !!config.telegramOwnerChatId
            : platform === "whatsapp"
              ? !!config.whatsappOwnerPhone
              : !!ownerChannel;

        const notificationEligible = messageHub.isPlatformNotificationEligible(platform);

        return [
          platform,
          {
            configured,
            runtimeState,
            ownerConfigured,
            ownerChannelKnown,
            notificationEligible,
            lastInboundAt: ownerChannel?.last_inbound_at ?? null,
            error,
          },
        ];
      }),
    );
  };

  // ── 7. Observers ──
  // The §7 block (5 hot-register builders + secondary observer
  // registrations + the entity-mirror / context-index / MCP-auto-probe /
  // observation-summarizer chain) lives in `bootstrap/observers.ts`.
  // Mutable indirection: observers are constructed inside the factory,
  // but the dispatcher (owner of `emitRoadmapRefresh`) is created later
  // in §10. Pollers store the `triggerRoadmapRefresh` callback below
  // and only invoke it from their poll loops, which run after
  // `observerManager.startAll()` — by then the dispatcher has been
  // wired via the assignment in §13 and the indirection resolves.
  // ROADMAP-REDESIGN §3.4 RFC-C.
  let emitRoadmapRefreshSink: ((source: string) => void) | null = null;
  const triggerRoadmapRefresh = (source: string): void => {
    emitRoadmapRefreshSink?.(source);
  };

  const observers = await createObservers({
    db,
    config,
    eventBus,
    secretBroker,
    services,
    writeTracker,
    blobStore,
    messageHub,
    morningRoutineLock,
    secretState,
    triggerRoadmapRefresh,
  });
  const {
    observerManager,
    primaryVaultWatcher,
    contextIndexReconciler,
    gitAccountRegistry,
    buildGitWatcher,
    buildGithubPoller,
    buildGitDelegatedCronObserver,
    buildCalendarPoller,
    buildNotionPoller,
    queueGitProjectInitsForCurrentConfig,
  } = observers;

  // ── 8. Health Monitor ──
  const healthMonitor = new HealthMonitor({
    db,
    config,
    eventBus,
    messageHub,
    observerManager,
    startedAt,
  });

  // Notifications Center heartbeat (see docs/design/20-notifications-center.md).
  // Updates an in-memory tick timestamp every 30s; surfaced via /api/health
  // so the dashboard can detect a frozen event loop.
  const heartbeat = new Heartbeat();

  // ── 9. Scheduler ──
  const scheduler = new AgentScheduler(eventBus, db, config);

  // ── 9.1 Custom routine scheduler (B-007 §5.8) ──
  // Reads `routines/custom/*.md` from the context dir and registers a
  // cron job per enabled routine. Reloaded from the context API whenever
  // the agent or dashboard edits a file under that directory.
  const customRoutineScheduler = new CustomRoutineScheduler({
    contextDir: getContextDir(config),
    eventBus,
    timezone: config.timezone || undefined,
  });

  // ── 10. Event Processing Pipeline ──
  // §9.5 SignalDetector + §10 event-processing pipeline (agent cores,
  // BackendRouter, dispatcher + setters, NotificationManager,
  // AuthHealthMonitor + recovery, DelegatedBackendInvoker / sync worker,
  // VoiceTranscriber, DocsQAAdapter, rematerializeActiveDmWorkdirs,
  // handleSecretChange, handleGoogleServicesReady) live in
  // `bootstrap/event-pipeline.ts`. The factory closes over the existing
  // adapter + service reloaders and observer builders so secret-change
  // hot-reload routing remains a single dispatch table.
  //
  // The factory also installs the real `onMailScopeChanged` handler and
  // the roadmap-refresh sink via the setter callbacks below — both are
  // forward-references kept open by `let` slots above (mail) and at the
  // observers factory call (roadmap).
  // Declared BEFORE the event-pipeline factory call so the
  // `isStartupComplete` getter passed below closes over the live latch.
  // The latch flips to `true` at the end of §13 once every subsystem is
  // started; until then `handleSecretChange("notion")` defers calling
  // `poller.start()` to avoid double-starting the timer that
  // `observerManager.startAll()` is about to start (see the matching
  // comment in event-pipeline.ts:SecretChangeHandlerDeps).
  let startupComplete = false;
  let pendingGoogleServicesReady = false;

  const eventPipeline = await createEventPipeline({
    db,
    config,
    eventBus,
    secretBroker,
    blobStore,
    writeTracker,
    services,
    messageHub,
    dashboardAdapter,
    attachmentStore,
    morningRoutineLock,
    roadmapWriteLock,
    secretState,
    observerManager,
    buildCalendarPoller,
    buildNotionPoller,
    getGitWatcher: observers.getGitWatcher,
    reloadDiscordAdapter,
    reloadSlackAdapter,
    reloadTelegramAdapter,
    reloadGoogleServices,
    reloadAppleCalendarService,
    reloadNotionService,
    reloadGitHubService,
    scheduler,
    isStartupComplete: () => startupComplete,
    setMailScopeChangedHandler: (cb) => {
      onMailScopeChanged = cb;
    },
    setRoadmapRefreshSink: (cb) => {
      emitRoadmapRefreshSink = cb;
    },
  });

  const {
    dispatcher,
    sessionManager,
    notificationManager,
    signalDetector,
    eventBroadcaster,
    auditLogger,
    docsQAAdapter,
    agentBackends,
    opencodeServerManager,
    delegatedBackendInvoker,
    authHealthMonitor,
    authRecovery,
    authTelemetry,
    readTokenManager,
    migrationLock,
    contextWriteGate,
    buildDelegatedSyncWorker,
    getDelegatedSyncWorker,
    rematerializeActiveDmWorkdirs,
    handleSecretChange,
    handleGoogleServicesReady,
    handlePromptContextChanged,
    keepaliveTimer,
  } = eventPipeline;

  // ── 11. Hono HTTP Server ──
  // Enable webhook fallback: when GitHub webhook is configured at boot,
  // upgrade the existing GitWatcher to webhook mode. (The runtime
  // `handleSecretChange("github")` branch handles the post-boot case.)
  {
    const startupGitWatcher = observers.getGitWatcher();
    if (startupGitWatcher && secretState.githubWebhookConfigured) {
      startupGitWatcher.enableWebhookMode();
    }
  }

  // §11 Hono server — composed via `bootstrap/api.ts` per
  // `docs/design/appendices/index-bootstrap-stage-split.md` Phase B-3.
  // The factory assembles `ApiDependencies` from the live subsystem
  // refs + the cross-stage closures (`handleSecretChange`,
  // `handleGoogleServicesReady`, `handlePromptContextChanged`,
  // `rematerializeActiveDmWorkdirs`, `fireRoadmapMaintenance`) that
  // remain in this scope until Phase B-4 lifts them into
  // `bootstrap/event-pipeline.ts`. The `overrideGlobalObjects: false`
  // workaround for `@huggingface/transformers`'s cache-put path stays
  // wired inside the factory — see the inline comment there.
  const { server } = startApiServer({
    db,
    config,
    secretBroker,
    services,
    blobStore,
    agentBackends,
    authHealthMonitor,
    authRecovery,
    authTelemetry,
    eventBus,
    readTokenManager,
    morningRoutineLock,
    roadmapWriteLock,
    migrationLock,
    contextWriteGate,
    dispatcher,
    sessionManager,
    scheduler,
    customRoutineScheduler,
    healthMonitor,
    heartbeat,
    messageHub,
    observerManager,
    contextIndexReconciler,
    primaryVaultWatcher,
    delegatedBackendInvoker,
    gitAccountRegistry,
    writeTracker,
    auditLogger,
    attachmentStore,
    dashboardAdapter,
    docsQAAdapter,
    docsIndexer,
    eventBroadcaster,
    getIntegrationStatus,
    getMessagingStatus,
    isStartupComplete: () => startupComplete,
    getDelegatedSyncWorker,
    handleSecretChange,
    handlePromptContextChanged,
    onGoogleServicesReady: () => {
      if (!startupComplete) {
        pendingGoogleServicesReady = true;
        logger.info(
          "Google services ready during bootstrap — deferring startup-sensitive actions",
        );
        return;
      }
      handleGoogleServicesReady();
    },
    rematerializeActiveDmWorkdirs,
    fireRoadmapMaintenance,
    buildCalendarPoller,
    buildNotionPoller,
    buildGitWatcher,
    buildGithubPoller,
    buildDelegatedSyncWorker,
    buildGitDelegatedCronObserver,
    clearGitWatcher: observers.clearGitWatcher,
    adapterState,
    buildWhatsAppAdapter,
    teardownWhatsAppAdapter,
    enableWhatsAppAdapter,
    buildTelegramControls,
    buildSlackControls,
    buildDiscordControls,
    queueGitProjectInitsForCurrentConfig,
  });

  void dispatcher.run(); // Start consuming dashboard events as soon as the API is live

  // Notifications Center heartbeat (docs/design/20-notifications-center.md
  // §"Daemon heartbeat"). MUST start immediately after the API server is
  // listening — i.e. before any awaited startup work below (catchup,
  // observers, etc.). `/api/health.lastTickAt` is exposed the moment the
  // server accepts requests, so any window in which the heartbeat is
  // constructed but not yet ticking shows the dashboard a stale timestamp
  // and trips the client-side `system.daemon_frozen` alert (90s threshold).
  // Startup catchup that runs a morning_routine inline can take several
  // minutes, so this ordering is load-bearing, not cosmetic.
  heartbeat.start();

  // ── 12. Catchup (recover missed actions after restart) ──
  // Register day boundary callback: summarize DM sessions at 4 AM before
  // morning routine. Then fan out one
  // `routine.research_cluster_update` event per active browser-history
  // research cluster with new activity in the last 24h
  // (BROWSER_HISTORY_INTEGRATION_PLAN §10.6 step 3). The fan-out is
  // bounded at 25 clusters / cycle; backlog clusters surface on the
  // next day-boundary tick.
  scheduler.setDayBoundaryCallback(async () => {
    await dispatcher.summarizeDmSessions();
    try {
      const result = await fanoutResearchClusterUpdates(db, eventBus);
      if (result.enqueuedSlugs.length > 0) {
        logger.info(
          { enqueuedSlugs: result.enqueuedSlugs },
          "Research cluster updates enqueued at day boundary",
        );
      }
    } catch (err) {
      logger.error(
        { err },
        "Research cluster update fan-out failed; will retry next day boundary",
      );
    }
  });

  // Register direct DM callback: sends scheduled messages without running an agent
  scheduler.setSendDmCallback(async (message, platforms): Promise<MessageDelivery[]> => {
    if (platforms && platforms.length > 0) {
      const deliveries: MessageDelivery[] = [];
      for (const platform of platforms) {
        deliveries.push(
          await messageHub.sendToPlatform(platform, "user", message),
        );
      }
      return deliveries;
    }
    return messageHub.sendToUser(message);
  });
  scheduler.setHourlyCheckCallback((source) => dispatcher.triggerHourlyCheck(source));
  // B-004 Phase 2a — nightly context-index reconciler. The design doc
  // (§4.1, §5.3) originally proposed an `agent_schedule` row with
  // `task_type: "internal.reconcile_context_index"`, but the dispatcher's
  // non-"dm" scheduled-task path runs a model-backed task flow. A direct
  // scheduler-owned cron callback keeps all scheduled work visible in
  // `AgentScheduler` — the intent of the design — without dispatching a
  // backend for an internal daemon job.
  scheduler.setContextIndexReconcilerCallback(() =>
    contextIndexReconciler.requestReconcile("cron"),
  );
  // Reconciler writes go through the same prompt-cache invalidation path as
  // API-origin context writes. Installing the sink here (post-dispatcher)
  // means a reconcile during setup.initial does not destroy in-flight
  // setup session state — see the matching `onPromptContextChanged`
  // handler in the createApp dependencies above for the layered guards.
  observers.setPromptContextChangedSink(handlePromptContextChanged);
  // Evening-review slimdown §2.2 — daily mechanical roadmap.md
  // maintenance at 17:45 local. The pass acquires the same
  // `roadmapWriteLock` singleton the dispatcher uses for
  // `routine.roadmap_refresh` so a refresh mid-flight (rare at that
  // time of day) defers the maintenance to the next tick instead of
  // racing. `writeTracker.markWriting` tags the resulting fs event as
  // agent-originated so the Obsidian / Git observers do not loop on
  // their own output.
  // Shared closure used by both the 17:45 cron callback above and the
  // `triggerRoadmapMaintenance` API dependency wired into `createApp`.
  // Keeping a single fire site means the cron path and the
  // `aitne run-now roadmap_maintenance` path operate on identical deps
  // — no drift between the scheduled and the manual surface.
  //
  // Async because the runner now wraps its roadmap.md write in the
  // per-path serializer (avoids HTTP-vs-direct clobbers). Callers
  // must await or fire-and-forget through `.catch`.
  function fireRoadmapMaintenance() {
    return runRoadmapMechanicalMaintenance({
      db,
      contextDir: getContextDir(config, db),
      roadmapWriteLock,
      writeTracker,
      timezone: config.timezone || undefined,
      onIndexableContextChange: () =>
        contextIndexReconciler.requestReconcile("manual"),
    });
  }
  scheduler.setRoadmapMaintenanceCallback(() => {
    fireRoadmapMaintenance().catch((err: unknown) => {
      logger.error({ err }, "runRoadmapMechanicalMaintenance threw");
    });
  });
  // BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a — pre-morning digest
  // job. Fires at `dayBoundaryHour − 1` local, gated by the same
  // integration-state check that hides the rest of the browser-history
  // surface when the user has set `browser_history` to `disabled`.
  // The callback owns its own try/catch (`safeRunPreMorningDigestJob`)
  // so a transient SQL or fs failure never crashes the cron tick.
  scheduler.setBrowserHistoryPreMorningDigestCallback(() => {
    if (!shouldStartObserversFor(db, "browser_history")) return;
    safeRunPreMorningDigestJob({
      db,
      contextDir: getContextDir(config, db),
      boundary: {
        timezone: config.timezone || undefined,
        dayBoundaryHour: config.dayBoundaryHour,
      },
    });
  });
  // Phase 4 auth probe — runs BEFORE the hourly check on each cron
  // tick so auth health detection happens independently of the
  // observation-threshold gate. checkAll() owns its own kill switch
  // (authProbeDisabled), morning-routine skip, and in-flight dedupe.
  scheduler.setAuthProbeCallback(() => authHealthMonitor.checkAll());
  // Wire the autonomous-work gate: when rules/management.md is missing
  // or a setup conversation is active, the scheduler pauses cron routines
  // and ScheduleWatcher claims. This prevents any autonomous turn from
  // racing with the dashboard setup flow and triggering the stale-session
  // bug that killed setup mode mid-conversation.
  scheduler.setAutonomousGate(() => dispatcher.isAutonomousAllowed());
  // Pre-routine morning_routine gate (sleep-skip recovery). When the
  // current agent-day's morning_routine has not completed yet — typical
  // cause: Mac slept through the 04:00 cron tick — hourly_check and the
  // review routines enqueue a wake row instead of running on stale state.
  // Wired here after both `dispatcher` and `scheduler` exist so the
  // binding is a single, stable function reference for the duration of
  // the process.
  dispatcher.setQueueMorningRoutineWake((source, options) =>
    scheduler.queueMorningRoutineWake(source, options),
  );

  const startupCatchup = await runCatchup(db, dispatcher, config);

  // ── 13. Start all components ──
  await messageHub.startAll();
  scheduler.start();
  customRoutineScheduler.start();
  signalDetector.start();
  const registeredPlatforms = messageHub.getPlatforms();
  // Single-app installs (Telegram-only / Discord-only / etc.) would
  // otherwise log "Primary platform is not registered, falling back" on
  // every boot because the schema default is "slack" and the fallback was
  // never persisted. The resolver checks whether the operator ever made
  // an explicit choice (DB settings row or `PA_PRIMARY_PLATFORM` env);
  // when they didn't, we adopt and persist the first eligible adapter so
  // the next boot is silent.
  //
  // "First set up" semantics for the multi-adapter case (spec: when
  // multiple adapters are configured, the first one paired wins) come from
  // `selectFirstPairedPlatform`, which reads `owner_channels.rowid` ASC —
  // a chronological proxy that captures the first platform to complete
  // the cred+pairing loop. The single-adapter case (the common one)
  // collapses to "the only eligible adapter" without touching the DB.
  const explicitEnvPrimary = process.env.PA_PRIMARY_PLATFORM?.trim();
  const action = resolvePrimaryPlatform({
    configuredPrimary: config.primaryPlatform,
    primaryAdapterRegistered: !!messageHub.getAdapter(config.primaryPlatform),
    registeredPlatforms,
    effectiveFallback: selectFirstPairedPlatform(
      db,
      messageHub.getEffectiveFallbackPlatforms(),
    ),
    userExplicitlySetPrimary:
      "primaryPlatform" in persistedSettings
      || (explicitEnvPrimary !== undefined && explicitEnvPrimary.length > 0),
  });
  if (action.kind === "switch") {
    if (action.reason === "auto-resolve") {
      logger.info(
        {
          previousPrimary: config.primaryPlatform,
          autoResolvedPrimary: action.newPrimary,
        },
        "Primary platform unset; auto-resolving to first configured messaging app",
      );
    } else {
      logger.warn(
        {
          requestedPrimary: config.primaryPlatform,
          fallbackPrimary: action.newPrimary,
        },
        "Primary platform is not registered, falling back (preference kept; restore the adapter to revert)",
      );
    }
    messageHub.setPrimaryPlatform(action.newPrimary);
    config.primaryPlatform = action.newPrimary;
    if (action.persist) {
      try {
        settingsStore.set("primaryPlatform", action.newPrimary);
      } catch (err) {
        logger.warn(
          { err },
          "Failed to persist auto-resolved primaryPlatform; next boot will repeat the resolution",
        );
      }
    }
  } else if (action.kind === "no-fallback") {
    logger.warn(
      {
        configuredPrimary: config.primaryPlatform,
        registeredPlatforms,
      },
      "Primary platform adapter not registered and no eligible messaging fallback found",
    );
  }
  await observerManager.startAll();

  // Start the integrations.md fs-watcher after the observer manager is up so
  // a chokidar initialization error surfaces alongside the main observer
  // lifecycle instead of during boot critical path.
  try {
    managementMdWatcher = startManagementMdWatcher(config.dataDir, db, {
      workspaceDir: config.workspaceDir,
      // SETUP-FLOW-REDESIGN-PLAN §6.2 — supply live external-vault state
      // each reconcile so the Note Sources section tracks
      // `PATCH /api/config` edits that don't touch integrations.md
      // directly.
      getNoteSources: () => ({
        externalObsidianVaultPath: config.externalObsidianVaultPath,
        externalObsidianWatch: config.externalObsidianWatch,
      }),
      sendNotification: async (params) => {
        await notificationManager.send(
          params.message,
          {
            type: params.notificationType ?? "integration.variant_missing",
            source: "management-md-watcher",
            priority: EventPriority.NORMAL,
            timestamp: new Date(),
            data: {},
            correlationId: randomBytes(8).toString("hex"),
          },
          {
            priority: params.priority ?? "normal",
            destinationMode: "configured_only",
          },
        );
      },
    });
  } catch (err) {
    logger.error({ err }, "integrations.md watcher failed to start");
  }

  // Start the rules/management.md fs-watcher alongside its integrations.md
  // sibling so hand-edits to A-section bindings flow back into the DB. The
  // watcher is a no-op when the post-setup branch above did not run
  // (contextDir absent), since chokidar against a missing path is silent.
  if (isSetupCompleted(db) && !readDegradedMode(db)) {
    try {
      managementRegistryWatcher = startManagementRegistryWatcher(
        getContextDir(config),
        db,
      );
    } catch (err) {
      logger.error(
        { err },
        "rules/management.md watcher failed to start",
      );
    }
  }
  healthMonitor.start();
  // heartbeat.start() ran earlier — see the comment near the API listen
  // call. Keeping it there is required so the dashboard's frozen-alert
  // does not fire during a long startup catchup.

  // ── Management Mode health probe (plan §5.4) ──
  // Poll every 30s. Probe is read-only (no mkdir) so a user deleting their
  // vault directory flips us to degraded instead of silently re-creating.
  // Timer runs in all modes so `vaultMode: plain ↔ obsidian` flips via
  // PATCH /api/config are picked up without restart.
  const vaultHealthTimer = setInterval(() => {
    try {
      const probe = runVaultHealthProbe(config, db);
      if (probe.action === "entered") {
        logger.warn({ reason: probe.reason }, "Vault health probe entered degraded mode");
      } else if (probe.action === "lifted") {
        logger.info("Vault health probe lifted degraded mode");
      }
    } catch (err) {
      logger.error({ err }, "vault health probe failed");
    }
  }, 30_000);
  vaultHealthTimer.unref();

  // Management Mode Phase 2 — daily backup retention sweep. Runs once
  // per day to remove completed `migration-backups/*` directories whose
  // 7-day retention has expired. An initial tick fires shortly after
  // startup so a daemon that runs for less than a full day still sweeps
  // old backups left from a previous session.
  const migrationBackupSweepInitial = setTimeout(() => {
    try {
      sweepExpiredMigrationBackups(db);
    } catch (err) {
      logger.error({ err }, "Initial migration-backup sweep failed");
    }
  }, 60_000);
  migrationBackupSweepInitial.unref();
  const migrationBackupSweepTimer = setInterval(() => {
    try {
      sweepExpiredMigrationBackups(db);
    } catch (err) {
      logger.error({ err }, "Daily migration-backup sweep failed");
    }
  }, 24 * 60 * 60 * 1000);
  migrationBackupSweepTimer.unref();

  startupComplete = true;
  if (pendingGoogleServicesReady) {
    pendingGoogleServicesReady = false;
    handleGoogleServicesReady();
  }
  logger.info("All components started");
  void runPostMessagingCatchup(dispatcher, startupCatchup).catch((err) => {
    logger.error(
      { err },
      "Post-messaging catchup failed",
    );
  });

  // ── 15. Graceful shutdown ──
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    dispatcher.stop(); // Signals dispatcher to exit run() loop
    scheduler.stop();
    customRoutineScheduler.stop();
    healthMonitor.stop();
    heartbeat.stop();
    signalDetector.stop();
    notificationManager.stop(); // Clear pending batch-flush timer
    authRecovery.shutdown(); // Kill any active recovery subprocesses
    // docs/design/appendices/opencode-backend.md Phase 2 — stop the loopback opencode
    // server (if any) so the spawned child releases its port. shutdown()
    // is idempotent; lazy-spawned managers that never booted no-op.
    await opencodeServerManager.shutdown().catch((err) => {
      logger.warn({ err }, "opencode server manager shutdown failed");
    });
    clearInterval(vaultHealthTimer);
    clearInterval(keepaliveTimer);
    clearTimeout(migrationBackupSweepInitial);
    clearInterval(migrationBackupSweepTimer);
    if (managementMdWatcher) {
      await managementMdWatcher.stop().catch((err) => {
        logger.warn({ err }, "integrations.md watcher stop failed");
      });
    }
    if (managementRegistryWatcher) {
      await managementRegistryWatcher.stop().catch((err) => {
        logger.warn({ err }, "rules/management.md watcher stop failed");
      });
    }
    if (docsIndexer) {
      await docsIndexer.stop().catch((err) => {
        logger.warn({ err }, "docs indexer stop failed");
      });
    }
    await observerManager.stopAll();
    await messageHub.stopAll();
    eventBus.close();

    // Close HTTP server
    if ("close" in server) {
      (server as { close: () => void }).close();
    }

    db.close();
    logger.info("Daemon stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  logger.info(`${APP_NAME} Daemon ready`);
}

// Catchup (`runCatchup` / `runPostMessagingCatchup`) and the pure schedule
// predicates (`getDueCatchupRoutines`, `shouldCatchUpHourlyCheck`,
// `getProgressMinutesForHour`, `hasFreshAgentDayTodayMd`,
// `readSkillCurationCadence`) live in `./bootstrap/` — see
// `docs/design/appendices/file-split-plan.md` §10. Imports are at the top
// of this file.

// ── Global safety net ──
// Catch unhandled rejections from fire-and-forget patterns (void async calls)
// so they are logged before Node.js 22+ terminates the process.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.fatal({ error: err.message, stack: err.stack }, "Unhandled promise rejection — this is a bug");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ error: err.message, stack: err.stack }, "Uncaught exception — process will exit");
  process.exit(1);
});

// ── Entry point ──
startup().catch((err) => {
  const e = err as Error & { code?: string };
  logger.fatal(
    { error: e?.message, code: e?.code, stack: e?.stack },
    "Daemon startup failed",
  );
  process.exit(1);
});
