import type { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  EDITABLE_RUNTIME_KEY_TUPLE,
  getBackendIds,
  normalizeAgentDisplayName,
  type BackendId,
  type ExecutionPermissionMode,
} from "@aitne/shared";
import type { ApiDependencies } from "../../server.js";
import { applyConfigUpdates } from "../../env-writer.js";
import { runDefaultSchedulesReconciler } from "../../../core/context/default-schedules-runner.js";
import { syncDmSessionTimesToQuietHours } from "../../../core/quiet-hours-sync.js";
import {
  retimeDeferredDmRows,
  retimeDeferredRunRows,
} from "../../../db/deferred-dm.js";
import { getContextDir } from "../../../config.js";
import { CONTEXT_RELATIVE_PATHS } from "../../../core/context-paths.js";
import { createLogger, toSafeErrorMessage } from "../../../logging.js";
import { upsertManagementRulesAgentIdentity } from "../../../management-rules.js";
import { DEFAULT_DISALLOWED_TOOLS, runtimeSettingsSchema } from "../../../settings/runtime-settings.js";
import { createSettingsStore } from "../../../settings/settings-store.js";
import { getSessionWorkdirPath } from "../../../core/workdir.js";
import { rewriteCharacterBlock } from "../../../core/skills-compiler-cli-renderer.js";
import { readJsonBody } from "../../json-body.js";
import { getSecretConfigSummary, type SecretConfigSummary } from "./secrets.js";

const PUBLIC_CONFIG_RUNTIME_KEYS = [
  "maxConcurrentSessions",
  "maxReactiveSessions",
  "delegatedProxyMaxConcurrent",
  "delegatedTaskModeEnabled",
  "delegatedTaskMaxPerDay",
  "delegatedTaskDefaultMaxToolCalls",
  "delegatedTaskDefaultMaxBudgetUsd",
  "delegatedTaskDefaultTimeoutMs",
  "delegatedTaskHeavyEnabled",
  "executeTimeoutMinutes",
  "agentDisplayName",
  "sessionTimeoutDmMinutes",
  "sessionTimeoutChannelMinutes",
  "sessionTimeoutDashboardMinutes",
  "timezone",
  "dayBoundaryHour",
  // The legacy activity-scan / monthly-review gate + cadence keys
  // (activityScanEnabled, activityScanIntervalMinutes, activityScanActive*,
  // activityScanMinObservations, monthlyReviewEnabled) left this surface at
  // the Agents-hub redesign: `agents.enabled` + the activity-scan row's
  // runtime_window own them now (PATCH /api/agents/activity-scan). The keys
  // remain valid in runtimeSettingsSchema as resolver fallbacks
  // (AGENTS_HUB_REDESIGN_PLAN.md §2).
  "authProbeDisabled",
  "authPreflightFreshnessMs",
  "maxNotificationsPerHour",
  "maxNotificationsPerDay",
  "quietHoursStart",
  "quietHoursEnd",
  "batchIntervalMinutes",
  "primaryPlatform",
  "defaultNotificationPlatforms",
  "whatsappEnabled",
  "whatsappAuthDir",
  "disallowedTools",
  "claudeExecutionPermissionMode",
  "codexExecutionPermissionMode",
  "geminiExecutionPermissionMode",
  "opencodeExecutionPermissionMode",
  "opencodeBaseUrl",
  "opencodeServerUsername",
  "externalObsidianVaultPath",
  "externalObsidianVaultName",
  // SETUP-FLOW-REDESIGN-PLAN §6.3 — kill switch for the external-vault
  // file watcher. Surfaced so the Note step's "Watch for changes"
  // checkbox round-trips through the dashboard.
  "externalObsidianWatch",
  "primaryVaultPath",
  "primaryVaultName",
  // gitRepos / gitWatchedRepos / githubRepos removed at the unified-
  // repositories cutover (docs/design/appendices/unified-repositories.md);
  // dashboard reads the rows from /api/repositories instead.
  "googleCalendarId",
  "notionDatabaseIds",
  "character",
  "historyInjectionMaxMessages",
  "historyInjectionMaxTokens",
  "dmStalenessStrict",
  "obsidianDebounceSeconds",
  "schedulePollIntervalSeconds",
  "gitPollIntervalSeconds",
  "gitPushOverdueMinutes",
  "gitProjectUpdateDebounceMinutes",
  "notionPollIntervalSeconds",
  "calendarPollIntervalSeconds",
  "gmailPollIntervalSeconds",
  "browserHistoryConsentAccepted",
  "browserHistoryBrowserOverrides",
  "browserHistoryCategories",
  "browserHistoryRetentionDays",
  "browserHistorySearchQueryRetentionDays",
  "browserHistoryLifecycle",
  "browserHistoryResearchDomainAllowlist",
  "browserHistoryResearchDomainDenylist",
  "browserTaskHostnameDenylist",
  "mcpAutoProbeIntervalMinutes",
  "delegatedProbeIntervalMinutes",
  "autonomousDailyCostCapUsd",
  "autonomousMonthlyCostCapUsd",
  // Feedback Learning Loop (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5) —
  // surfaced so the Lessons settings page can read + tune the master toggle,
  // promotion threshold, per-scope byte caps, staleness horizon, and signal
  // retention via the deferred-save EditableField flow.
  "feedbackLearningEnabled",
  "feedbackPromotionThreshold",
  "feedbackLessonMaxBytesGlobal",
  "feedbackLessonMaxBytesPerAgent",
  "feedbackLessonStaleDays",
  "feedbackSignalRetentionDays",
  // Opt-in toggle: push backend-execution-failure operator diagnostics to
  // the owner DM (default off — failures stay on the dashboard Activity feed).
  "backendFailureDmAlerts",
  "primaryLanguage",
  "vaultMode",
] as const;
const EXECUTION_PERMISSION_CONFIG_KEYS = {
  claude: "claudeExecutionPermissionMode",
  codex: "codexExecutionPermissionMode",
  gemini: "geminiExecutionPermissionMode",
  opencode: "opencodeExecutionPermissionMode",
} as const satisfies Record<BackendId, (typeof PUBLIC_CONFIG_RUNTIME_KEYS)[number]>;

function getExecutionPermissionMode(
  config: ApiDependencies["config"],
  backend: BackendId,
): ExecutionPermissionMode {
  return config[EXECUTION_PERMISSION_CONFIG_KEYS[backend]];
}
const PUBLIC_CONFIG_NULLABLE_STRING_KEYS = new Set([
  "whatsappAuthDir",
  "externalObsidianVaultPath",
  "externalObsidianVaultName",
  "primaryVaultPath",
  "primaryVaultName",
]);

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([key, entryValue]) => typeof key === "string" && typeof entryValue === "string",
  );
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([key, value]) => b[key] === value);
}

function buildSafeConfig(
  config: ApiDependencies["config"],
  secretSummary: SecretConfigSummary,
): Record<string, unknown> {
  const safeConfig: Record<string, unknown> = {};

  for (const key of PUBLIC_CONFIG_RUNTIME_KEYS) {
    const value = config[key];
    safeConfig[key] = PUBLIC_CONFIG_NULLABLE_STRING_KEYS.has(key)
      ? (value as string | null) ?? ""
      : value;
  }

  safeConfig.apiPort = config.apiPort;
  safeConfig.allowedTools = config.allowedToolsOverride ?? [];
  // Derived — the actual directory `getContextDir(config)` resolves to.
  // Surfaces the mode/path → disk outcome to the dashboard so the
  // Management Mode section can show the effective location without
  // reimplementing the resolution logic. Always an absolute path.
  safeConfig.contextDir = getContextDir(config);
  safeConfig.slackConfigured = secretSummary.slackConfigured;
  safeConfig.slackOwnerUserConfigured = !!config.slackOwnerUserId;
  safeConfig.telegramConfigured = secretSummary.telegramConfigured;
  safeConfig.telegramOwnerChatConfigured = !!config.telegramOwnerChatId;
  safeConfig.discordConfigured = secretSummary.discordConfigured;
  safeConfig.discordOwnerUserConfigured = !!config.discordOwnerUserId;
  safeConfig.notionConfigured = secretSummary.notionConfigured;
  safeConfig.githubConfigured = secretSummary.githubConfigured;
  safeConfig.githubWebhookSecretConfigured = secretSummary.githubWebhookSecretConfigured;
  safeConfig.apiTokenConfigured = secretSummary.apiTokenConfigured;
  safeConfig.whatsappOwnerPhoneConfigured = !!config.whatsappOwnerPhone;
  safeConfig.googleCalendarCredentialsConfigured = secretSummary.googleCalendarCredentialsConfigured;
  safeConfig.googleCalendarTokenConfigured = secretSummary.googleCalendarTokenConfigured;
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — surface Outlook BYOA presence so
  // dashboards can decide when direct-mode Outlook integrations are
  // resumable.
  safeConfig.outlookClientConfigConfigured = secretSummary.outlookClientConfigConfigured;
  safeConfig.googleCredentialType = secretSummary.googleCredentialType;

  return safeConfig;
}

const logger = createLogger("dashboard-api");

export function registerConfigRoutes(app: Hono, deps: ApiDependencies): void {
  const { db, config } = deps;
  const settingsStore = createSettingsStore(db);

  /**
   * design/15-character.md §15.6.1 live-overwrite: when character changes,
   * rewrite the `## Character` block inside every active session's
   * instruction files (CLAUDE.md / AGENTS.md / GEMINI.md) so the next turn
   * in the session picks up the new value without waiting for a session
   * spawn. Per-workdir errors are counted and logged but never thrown —
   * the DB write is already durable at the caller.
   *
   * Shared by PATCH /config (dashboard path, Approve tier) and
   * PATCH /config/character (agent path, Notify tier).
   */
  function fanOutCharacterToActiveSessions(): void {
    const sessions = db
      .prepare(
        `SELECT id FROM conversation_sessions WHERE status = 'active'`,
      )
      .all() as Array<{ id: number | bigint }>;
    const totals = { rewritten: 0, skipped: 0, failed: 0, missing: 0 };
    for (const row of sessions) {
      const sessionId =
        typeof row.id === "bigint" ? Number(row.id) : row.id;
      const workdir = getSessionWorkdirPath(config.dataDir, sessionId);
      if (!existsSync(workdir)) {
        totals.missing++;
        continue;
      }
      try {
        const summary = rewriteCharacterBlock(workdir, config.character);
        totals.rewritten += summary.rewritten;
        totals.skipped += summary.skipped;
        totals.failed += summary.failed;
      } catch (err) {
        totals.failed++;
        logger.warn(
          { err, sessionId, workdir },
          "rewriteCharacterBlock threw on character live-overwrite",
        );
      }
    }
    logger.info(
      { ...totals, activeSessions: sessions.length },
      "Character block fanned out to active session workdirs",
    );
  }

  /** GET /config — return current configuration */
  app.get("/config", async (c) => {
    const secretSummary = await getSecretConfigSummary(deps);
    const safeConfig = buildSafeConfig(
      { ...config, agentDisplayName: normalizeAgentDisplayName(config.agentDisplayName) },
      secretSummary,
    );
    return c.json(safeConfig);
  });

  /** GET /config/defaults — return Zod schema defaults for all editable keys */
  app.get("/config/defaults", (c) => {
    const zodDefaults = runtimeSettingsSchema.parse({});
    const defaults: Record<string, unknown> = {};
    for (const key of EDITABLE_RUNTIME_KEY_TUPLE) {
      const val = zodDefaults[key as keyof typeof zodDefaults];
      // Mirror GET /config shape: allowedToolsOverride null → empty array
      if (key === "allowedToolsOverride") {
        defaults.allowedTools = (val as string[] | null) ?? [];
      } else {
        defaults[key] = val;
      }
    }
    // Bootstrap keys not in runtimeSettingsSchema
    defaults.apiPort = 8321;
    return c.json(defaults);
  });

  /** PATCH /config — update one or more config fields */
  app.patch("/config", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const bodyRecord = { ...(body as Record<string, unknown>) };

    if (Object.hasOwn(bodyRecord, "notionDatabaseIdsBase")) {
      if (!Object.hasOwn(bodyRecord, "notionDatabaseIds")) {
        return c.json({
          error: "validation_failed",
          details: {
            notionDatabaseIdsBase: "notionDatabaseIdsBase requires notionDatabaseIds in the same request",
          },
        }, 400);
      }
      if (!isStringRecord(bodyRecord.notionDatabaseIdsBase)) {
        return c.json({
          error: "validation_failed",
          details: {
            notionDatabaseIdsBase: "notionDatabaseIdsBase must be an object mapping labels to database IDs",
          },
        }, 400);
      }
      if (!sameStringRecord(config.notionDatabaseIds, bodyRecord.notionDatabaseIdsBase)) {
        return c.json({
          error: "conflict",
          message: "Notion database mappings changed on another tab. Reload and try again.",
        }, 409);
      }
      delete bodyRecord.notionDatabaseIdsBase;
    }

    // Snapshot WhatsApp state BEFORE applying so we can detect a transition
    // and trigger live enable/disable of the adapter (no daemon restart).
    const prevWhatsappEnabled = config.whatsappEnabled;
    const prevWhatsappOwnerPhone = config.whatsappOwnerPhone;
    const prevWhatsappAuthDir = config.whatsappAuthDir;

    // EXECUTION-MODE-DESIGN.md §5.2 / §6.3 — snapshot pre-apply execution mode
    // so audit rows below can capture before → after per backend. The
    // dedicated `POST /api/setup/mode` is the usual path (it emits its own
    // audit row); this PATCH covers the power-user / env-style API caller
    // who edits the key directly without going through the settings UI.
    const prevExecMode = Object.fromEntries(
      getBackendIds().map((backend) => [
        backend,
        getExecutionPermissionMode(config, backend),
      ]),
    ) as Record<BackendId, ExecutionPermissionMode>;

    // design/15-character.md §15.6.1 — snapshot character pre-apply so the
    // live-overwrite pass below has a stable "after" value to fan out to
    // every active session workdir.
    const prevCharacter = config.character;
    // gitRepos / gitWatchedRepos no longer live in config — repository
    // changes go through /api/repositories and trigger
    // `onGitReposChanged` directly from that route.

    // §6.2 Note Sources regeneration is centralized inside
    // applyConfigUpdates (via the db option) — no inline hook in this
    // handler. Any future caller of applyConfigUpdates that carries
    // externalObsidianVaultPath / externalObsidianWatch automatically
    // gets the same regeneration without copy-paste.
    const result = await applyConfigUpdates(config, settingsStore, bodyRecord, {
      db: deps.db,
    });

    if (Object.keys(result.errors).length > 0 && result.updated.length === 0) {
      return c.json({ error: "validation_failed", details: result.errors }, 400);
    }

    // Hot-reload cron schedules when schedule-related config changes.
    // The activityScan* entries are legacy-API back-compat only: the dashboard
    // no longer surfaces them (agent-row runtime_window owns the cadence), but
    // a direct PATCH of the deprecated keys must still rebuild the cron so the
    // resolver fallback change takes effect.
    const SCHEDULE_KEYS = [
      "dayBoundaryHour",
      "timezone",
      "activityScanEnabled",
      "activityScanIntervalMinutes",
      "activityScanActiveStartHour",
      "activityScanActiveEndHour",
    ];
    if (result.updated.some((k) => SCHEDULE_KEYS.includes(k))) {
      deps.onScheduleConfigChanged?.();
    }

    // git repository changes route through POST/PATCH /api/repositories
    // (unified-repositories cutover); they trigger onGitReposChanged
    // from there, not from the dashboard config PATCH path.

    // SCHEDULED-DM-IMPLEMENTATION-PLAN §6.7 — when quietHoursEnd
    // changes, retime every enabled `dm_session` recurring row whose
    // `task_context.pin_to_quiet_hours_end === true` so the briefing
    // tracks the user's quiet-hours edge by default. Rows with the
    // pin flag false (user-pinned a custom time) are left alone.
    if (
      result.updated.includes("quietHoursEnd")
      && typeof config.quietHoursEnd === "string"
      && /^\d{2}:\d{2}$/.test(config.quietHoursEnd)
    ) {
      try {
        syncDmSessionTimesToQuietHours(db, config.quietHoursEnd);
        runDefaultSchedulesReconciler({
          db,
          contextDir: getContextDir(config, db),
          writeTracker: deps.writeTracker,
          onPromptContextChanged: deps.onPromptContextChanged,
          trigger: "manual",
        }).catch((err) => {
          logger.warn(
            { err },
            "Default-schedules reconciler failed after quietHoursEnd change",
          );
        });
      } catch (err) {
        logger.warn(
          { err },
          "syncDmSessionTimesToQuietHours threw after dashboard config PATCH",
        );
      }
    }

    // QUIET_HOURS_HARDENING_PLAN.md Phase 1 follow-up — pending
    // quiet-hours-deferred DM rows (`task_context.deferred_from`) were
    // stamped with the *old* window's end; retime them so a widened
    // window doesn't fire them inside the new quiet hours and a
    // narrowed one doesn't hold them past the new edge. Phase 2's
    // deferred RUN rows (`task_context.quiet_hours_deferred` — agent.task
    // opt-in + browser_task) get the same treatment; for them only the
    // narrowed/disabled direction matters (a widened window re-defers at
    // claim time anyway). `timezone` is in the trigger set because the
    // window's *absolute* position is tz-relative — an unchanged
    // "22:00→08:00" still moves on the UTC axis when the tz changes, and
    // deferred DM rows are delivered by `handleDirectDm`, which skips the
    // quiet-hours check by design.
    if (
      (result.updated.includes("quietHoursEnd")
        || result.updated.includes("quietHoursStart")
        || result.updated.includes("timezone"))
      && /^\d{2}:\d{2}$/.test(config.quietHoursStart)
      && /^\d{2}:\d{2}$/.test(config.quietHoursEnd)
    ) {
      const window = {
        start: config.quietHoursStart,
        end: config.quietHoursEnd,
        timezone: config.timezone || undefined,
      };
      try {
        retimeDeferredDmRows(db, window);
        retimeDeferredRunRows(db, window);
      } catch (err) {
        logger.warn(
          { err },
          "Retiming quiet-hours-deferred rows threw after dashboard config PATCH",
        );
      }
    }

    // Hot-refresh DM session skill dirs when enabledMailProviders changes
    // through the generic config PATCH. The per-endpoint `PATCH /mail/providers`
    // handler already drives this through MailAccountRegistry.onScopeChanged,
    // but the dashboard's catch-all config PATCH bypasses that route, so
    // without this dispatch the scope toggle wouldn't reach active workdirs.
    if (result.updated.includes("enabledMailProviders")) {
      try {
        deps.services.mail?.onProviderSelectionChanged(
          config.enabledMailProviders,
        );
      } catch (err) {
        logger.warn(
          { err },
          "onProviderSelectionChanged threw after dashboard config PATCH",
        );
      }
    }

    // Hot-reload WhatsApp adapter when whatsappEnabled / phone / auth dir change.
    // This eliminates the daemon-restart requirement that previously made
    // pairing impossible from the dashboard.
    const whatsappKeysTouched = result.updated.some((k) =>
      ["whatsappEnabled", "whatsappOwnerPhone", "whatsappAuthDir"].includes(k),
    );
    if (whatsappKeysTouched && deps.whatsappControls) {
      const phoneChanged =
        config.whatsappOwnerPhone !== prevWhatsappOwnerPhone;
      const authDirChanged = config.whatsappAuthDir !== prevWhatsappAuthDir;

      try {
        if (!config.whatsappEnabled && prevWhatsappEnabled) {
          // disabled — tear down
          await deps.whatsappControls.disable();
        } else if (config.whatsappEnabled) {
          if (!prevWhatsappEnabled) {
            // newly enabled — build and start
            await deps.whatsappControls.enable();
          } else if (phoneChanged || authDirChanged) {
            // settings changed while enabled — bounce
            await deps.whatsappControls.disable();
            await deps.whatsappControls.enable();
          }
        }
        // Drop "whatsappEnabled" / phone / auth dir from requiresRestart since
        // we just hot-reloaded them. Other restart-required keys (like Slack
        // tokens) still report restart.
        result.requiresRestart = result.requiresRestart.filter(
          (k) => !["whatsappEnabled", "whatsappOwnerPhone", "whatsappAuthDir"].includes(k),
        );
      } catch (err) {
        const message = toSafeErrorMessage(err, "unknown WhatsApp error");
        result.errors.whatsapp = `WhatsApp hot-reload failed: ${message}`;
      }
    }

    // EXECUTION-MODE-DESIGN.md §6.3 — emit one `execution_mode_changed`
    // audit row per backend whose mode moved through this PATCH, matching
    // the row shape that `POST /api/setup/mode` writes. Without this the
    // PATCH path would silently bypass audit coverage for a power-user
    // API caller.
    for (const backend of getBackendIds()) {
      const key = EXECUTION_PERMISSION_CONFIG_KEYS[backend];
      if (!result.updated.includes(key)) continue;
      const before = prevExecMode[backend];
      const after = getExecutionPermissionMode(config, backend);
      if (before === after) continue;
      try {
        db.prepare(
          `INSERT INTO agent_actions (action_type, trigger, result, detail, backend)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(
          "execution_mode_changed",
          "dashboard_config_patch",
          "success",
          JSON.stringify({ before, after }),
          backend,
        );
      } catch (err) {
        logger.warn(
          { err, backend },
          "failed to record execution_mode_changed audit row (PATCH path)",
        );
      }
    }

    if (result.updated.includes("agentDisplayName")) {
      try {
        const rulesRelPath = CONTEXT_RELATIVE_PATHS.rules.management;
        const rulesSnapshotKey = rulesRelPath.replace(/\.md$/, "");
        const rulesPath = join(getContextDir(config, db), rulesRelPath);
        if (existsSync(rulesPath)) {
          const currentRules = readFileSync(rulesPath, "utf-8");
          const nextRules = upsertManagementRulesAgentIdentity(
            currentRules,
            normalizeAgentDisplayName(config.agentDisplayName),
          );
          if (nextRules !== currentRules) {
            db.prepare(
              "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
            ).run(rulesSnapshotKey, currentRules, "agent_name_update");
            writeFileSync(rulesPath, nextRules, "utf-8");
          }
        }
      } catch (err) {
        const message = toSafeErrorMessage(
          err,
          `unknown ${CONTEXT_RELATIVE_PATHS.rules.management} error`,
        );
        result.errors.agentDisplayName = `Saved config, but failed to sync ${CONTEXT_RELATIVE_PATHS.rules.management}: ${message}`;
      }
      deps.onPromptContextChanged?.(
        "agentDisplayName",
        "config_update:agentDisplayName",
        "loud",
        { tierReason: "config_agent_display_name" },
      );
    }

    // design/15-character.md §15.6.1 — character changed; fan the new value
    // out to every active session's instruction files.
    if (result.updated.includes("character") && config.character !== prevCharacter) {
      fanOutCharacterToActiveSessions();
    }

    return c.json({
      status: "updated",
      updated: result.updated,
      requiresRestart: result.requiresRestart,
      errors: result.errors,
    });
  });

  /**
   * GET /config/character — agent-callable read of the persona string.
   *
   * design/15-character.md §15.6 — the general /api/config surface is
   * Approve-tier (contains secret summaries, OAuth state, schedule keys),
   * so bearer-less callers (the agent's curl from a session workdir) need
   * a narrowly scoped read. Returns the single field shape `{character}`
   * so `jq .character` in skills keeps working.
   */
  app.get("/config/character", (c) => {
    return c.json({ character: config.character });
  });

  /**
   * PATCH /config/character — agent-callable write of the persona string.
   *
   * Notify tier: audit-logged by the auth middleware, no Bearer required.
   * Accepts only `{character: string}` — extra keys are rejected so this
   * route cannot be used as a side channel into other config fields.
   * Zod validation (max 1000 chars, no marker substring, non-blank-or-empty)
   * runs inside `applyConfigUpdates` as usual.
   */
  app.patch("/config/character", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const bodyRecord = body as Record<string, unknown>;
    const extraKeys = Object.keys(bodyRecord).filter((k) => k !== "character");
    if (extraKeys.length > 0) {
      return c.json(
        {
          error: "validation_failed",
          details: {
            _extraKeys: `Only "character" is accepted on this endpoint; got: ${extraKeys.join(", ")}`,
          },
        },
        400,
      );
    }
    if (!Object.hasOwn(bodyRecord, "character")) {
      return c.json(
        {
          error: "validation_failed",
          details: { character: "character field is required" },
        },
        400,
      );
    }

    const prevCharacter = config.character;
    const result = await applyConfigUpdates(config, settingsStore, {
      character: bodyRecord.character,
    });

    if (Object.keys(result.errors).length > 0 && result.updated.length === 0) {
      return c.json({ error: "validation_failed", details: result.errors }, 400);
    }

    if (result.updated.includes("character") && config.character !== prevCharacter) {
      fanOutCharacterToActiveSessions();
    }

    return c.json({
      status: "updated",
      character: config.character,
      updated: result.updated,
      errors: result.errors,
    });
  });

  /** POST /config/reset-safety — reset disallowedTools to defaults */
  app.post("/config/reset-safety", async (c) => {
    const defaults = [...DEFAULT_DISALLOWED_TOOLS];

    // Actually persist the reset — update in-memory config and .env
    // Use null for allowedToolsOverride to match the Zod default (null = "no override")
    const result = await applyConfigUpdates(config, settingsStore, {
      disallowedTools: defaults,
      allowedToolsOverride: null,
    });

    return c.json({ status: "reset", disallowedTools: defaults, ...result });
  });
}
