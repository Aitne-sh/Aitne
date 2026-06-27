import { Hono } from "hono";
import { existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getContextDir } from "../../config.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";
import { validateContextFileFrontmatter } from "../../core/context-frontmatter.js";
import { ensureSkeletonFiles } from "../../core/skeleton.js";
import {
  BACKEND_IDS,
  normalizeAgentDisplayName,
  validateAgentDisplayName,
  type BackendId,
  type ExecutionPermissionMode,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { toSafeErrorMessage, createLogger } from "../../logging.js";
import { upsertManagementRulesAgentIdentity } from "../../management-rules.js";
import {
  extractActivePoliciesSection,
  upsertManagementRulesActivePolicies,
} from "../../core/context/policy-index-reconciler.js";
import {
  renderDefaultSchedulesSection,
  upsertManagementRulesDefaultSchedules,
} from "../../core/context/default-schedules-reconciler.js";
import { buildDefaultSchedulesSnapshot } from "../../core/context/default-schedules-runner.js";
import { createRecurringSchedule } from "../../db/recurring-schedules.js";
import type { RecurrenceRule } from "@aitne/shared";
import { createSettingsStore } from "../../settings/settings-store.js";
import type { RuntimeSettings, RuntimeSettingKey } from "../../settings/runtime-settings.js";
import { cleanupSessionWorkdir, getSessionWorkdirPath } from "../../core/workdir.js";
import type Database from "better-sqlite3";
import { readJsonBody } from "../json-body.js";
import {
  getVaultRestructureAck,
  getVaultRestructurePendingConsent,
  setVaultRestructureAck,
} from "../../db/runtime-state.js";

const logger = createLogger("api:setup");

const EXECUTION_PERMISSION_SETTING_KEYS = {
  claude: "claudeExecutionPermissionMode",
  codex: "codexExecutionPermissionMode",
  gemini: "geminiExecutionPermissionMode",
  opencode: "opencodeExecutionPermissionMode",
} as const satisfies Record<BackendId, RuntimeSettingKey>;

function getExecutionPermissionMode(
  config: ApiDependencies["config"],
  backend: BackendId,
): ExecutionPermissionMode {
  return config[EXECUTION_PERMISSION_SETTING_KEYS[backend]];
}

function setExecutionPermissionMode(
  config: ApiDependencies["config"],
  backend: BackendId,
  mode: ExecutionPermissionMode,
): void {
  config[EXECUTION_PERMISSION_SETTING_KEYS[backend]] = mode;
}

/**
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §6.6 — idempotently insert the
 * morning briefing recurring schedule on first save-rules. Returns
 * silently when a `dm_session` row with `task_context.sub_flow =
 * 'morning_briefing'` already exists.
 *
 * Default time = `max('08:00', config.quietHoursEnd)` so the briefing
 * never fires inside quiet hours. `pin_to_quiet_hours_end` is true so
 * the quiet-hours sync hook (§6.7) keeps it tracking — until the user
 * pins a custom time via DM.
 */
function ensureMorningBriefingRecurring(
  db: import("better-sqlite3").Database,
  config: { quietHoursEnd?: string | null; timezone?: string | null },
): void {
  const existing = db
    .prepare(
      `SELECT id FROM recurring_schedules
       WHERE task_type = 'dm_session'
         AND json_extract(task_context, '$.sub_flow') = 'morning_briefing'
       LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  if (existing) return;

  const quietHoursEnd =
    typeof config.quietHoursEnd === "string" && /^\d{2}:\d{2}$/.test(config.quietHoursEnd)
      ? config.quietHoursEnd
      : "08:00";
  // HH:MM strings sort lexicographically the same as time-of-day; pick
  // whichever is later so we never schedule inside quiet hours.
  const briefingTime = quietHoursEnd > "08:00" ? quietHoursEnd : "08:00";

  const tz =
    typeof config.timezone === "string" && config.timezone.length > 0
      ? config.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const rule: RecurrenceRule = {
    frequency: "daily",
    time: briefingTime,
    timezone: tz,
  };

  // Intentionally NOT passing `model` — leaves the column NULL so the
  // briefing's tier resolves from `agent.dm_task` defaults (light) and
  // any operator pin in `process_backend_config`. Hardcoding 'sonnet'
  // would propagate as `event.requestedModel` and force the dispatcher
  // to override the user's dashboard pin every fire.
  createRecurringSchedule(db, {
    taskType: "dm_session",
    description: "morning briefing — daily summary",
    recurrenceRule: rule,
    taskContext: {
      sub_flow: "morning_briefing",
      pin_to_quiet_hours_end: true,
    },
  });
  logger.info(
    { taskType: "dm_session", time: briefingTime, timezone: tz },
    "Morning briefing recurring schedule seeded",
  );
}

/**
 * Delete a setup conversation session (messages + row) by id. Restricted to
 * `dashboard_chat` scope so a misdirected sessionId from the client can
 * never wipe owner DMs or other scopes. Tolerates an active status because
 * setup sessions are live at save-rules time — the regular `deleteChatSession`
 * helper rejects active rows to protect the live chat path.
 */
function deleteSetupSession(
  db: Database.Database,
  dataDir: string,
  sessionId: number,
): { deleted: number } {
  let deleted = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
    const info = db
      .prepare(
        `DELETE FROM conversation_sessions
          WHERE id = ? AND scope = 'dashboard_chat'`,
      )
      .run(sessionId);
    deleted = info.changes;
  })();

  if (deleted > 0) {
    cleanupSessionWorkdir(getSessionWorkdirPath(dataDir, sessionId));
  }
  return { deleted };
}

export function createSetupRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const settingsStore = createSettingsStore(db);

  // B-007 §5.1 — management-rules.md moved under rules/.
  const managementRulesRelPath = CONTEXT_RELATIVE_PATHS.rules.management;
  const managementRulesApiKey = managementRulesRelPath.replace(/\.md$/, "");

  // Phase 4: `getContextDir(config)` is re-evaluated per request rather than
  // captured at route-construction time. A wizard-driven migration (POST
  // /api/setup/migrate-context) can change the effective context directory
  // between daemon startup and `/setup/save-rules`; a stale closure capture
  // would write the skeleton + rules into the old location.

  // POST /setup/mode — Execution-mode setup step.
  //
  // Body: { mode: "safe" | "allow", perBackend?: { [backendId]?: "safe" | "allow" } }
  //
  // Writes each backend's `ExecutionPermissionMode` in one transaction.
  // Top-level `mode` is applied to every backend not covered by `perBackend`.
  // See EXECUTION-MODE-DESIGN.md §5.3 — the UI labels are `safe`/`allow`
  // but the settings rows use `strict`/`allow`, so this endpoint also owns
  // the single translation point.
  app.post("/setup/mode", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const raw = parsed.body as
      | { mode?: unknown; perBackend?: unknown }
      | undefined;
    if (!raw || typeof raw !== "object") {
      return c.json({ error: "body must be an object" }, 400);
    }
    const modeUi = raw.mode;
    if (modeUi !== "safe" && modeUi !== "allow") {
      return c.json(
        { error: "mode must be 'safe' or 'allow'" },
        400,
      );
    }

    const perBackendRaw = raw.perBackend;
    const perBackend: Partial<Record<BackendId, ExecutionPermissionMode>> = {};
    if (perBackendRaw !== undefined) {
      if (
        perBackendRaw === null
        || typeof perBackendRaw !== "object"
        || Array.isArray(perBackendRaw)
      ) {
        return c.json(
          { error: "perBackend must be an object when provided" },
          400,
        );
      }
      for (const [key, value] of Object.entries(
        perBackendRaw as Record<string, unknown>,
      )) {
        if (!(BACKEND_IDS as readonly string[]).includes(key)) {
          return c.json(
            { error: `unknown backend in perBackend: ${key}` },
            400,
          );
        }
        if (value !== "safe" && value !== "allow") {
          return c.json(
            { error: `perBackend.${key} must be 'safe' or 'allow'` },
            400,
          );
        }
        perBackend[key as BackendId] = value === "safe" ? "strict" : "allow";
      }
    }

    const topInternal: ExecutionPermissionMode =
      modeUi === "safe" ? "strict" : "allow";
    const resolved = Object.fromEntries(
      BACKEND_IDS.map((backend) => [
        backend,
        perBackend[backend] ?? topInternal,
      ]),
    ) as Record<BackendId, ExecutionPermissionMode>;

    // Snapshot previous values so the audit row below can capture the
    // before → after transition per backend.
    const before = Object.fromEntries(
      BACKEND_IDS.map((backend) => [
        backend,
        getExecutionPermissionMode(config, backend),
      ]),
    ) as Record<BackendId, ExecutionPermissionMode>;

    try {
      const updates = Object.fromEntries(
        BACKEND_IDS.map((backend) => [
          EXECUTION_PERMISSION_SETTING_KEYS[backend],
          resolved[backend],
        ]),
      ) as Partial<RuntimeSettings>;
      settingsStore.setMany(updates);
      for (const backend of BACKEND_IDS) {
        setExecutionPermissionMode(config, backend, resolved[backend]);
      }
    } catch (err) {
      return c.json(
        { error: toSafeErrorMessage(err, "failed_to_persist_execution_mode") },
        500,
      );
    }

    // EXECUTION-MODE-DESIGN.md §5.2 / §6.3 — record one audit row per
    // backend whose value actually moved. Best-effort: audit failure does
    // not abort the write. Action type `execution_mode_changed` is
    // distinct from the `blocked_absolute` row emitted by the
    // absolute-block classifier hook.
    const changed: Array<{
      backend: BackendId;
      before: ExecutionPermissionMode;
      after: ExecutionPermissionMode;
    }> = [];
    for (const backend of BACKEND_IDS) {
      if (before[backend] !== resolved[backend]) {
        changed.push({
          backend,
          before: before[backend],
          after: resolved[backend],
        });
      }
    }
    if (changed.length > 0) {
      for (const row of changed) {
        try {
          db.prepare(
            `INSERT INTO agent_actions (action_type, trigger, result, detail, backend)
               VALUES (?, ?, ?, ?, ?)`,
          ).run(
            "execution_mode_changed",
            "setup_mode_endpoint",
            "success",
            JSON.stringify({
              before: row.before,
              after: row.after,
              topLevelMode: modeUi,
              perBackendOverride: perBackend[row.backend] ?? null,
            }),
            row.backend,
          );
        } catch (err) {
          logger.warn(
            { err, backend: row.backend },
            "failed to record execution_mode_changed audit row",
          );
        }
      }
    }

    return c.json({
      status: "applied",
      mode: modeUi,
      resolved: Object.fromEntries(
        BACKEND_IDS.map((backend) => [
          backend,
          resolved[backend] === "strict" ? "safe" : "allow",
        ]),
      ),
      changedRows: changed.length,
    });
  });

  // GET /setup/status — Check if initial setup is needed
  app.get("/setup/status", (c) => {
    const rulesPath = join(getContextDir(config), managementRulesRelPath);
    const exists = existsSync(rulesPath);
    return c.json({
      needsSetup: !exists,
      completedAt: exists ? statSync(rulesPath).mtime.toISOString() : null,
    });
  });

  // POST /setup/start — Trigger agent setup conversation.
  //
  // mode='update' is still accepted by this endpoint, but the dashboard UI
  // entry point has been hidden — see docs/design/backlog/setup-update-mode-ui.md.
  // The route is preserved so the feature can be restored without re-plumbing
  // the API. Manual callers (curl / scripts / a future dashboard surface) keep
  // working.
  app.post("/setup/start", async (c) => {
    const adapter = deps.dashboardAdapter;
    if (!adapter) {
      return c.json({ error: "Dashboard adapter not available" }, 503);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    // SETUP-FLOW-REDESIGN-PLAN §5.8 / §7 — `selections` was removed
    // from the request body. The agent now derives the
    // Source-of-Truth table from the integrations registry and asks
    // only about rows it could not infer. Older dashboard builds may
    // still send the field; we accept and ignore it for backwards
    // tolerance during the cutover.
    const body = parsedBody.body as {
      channelId?: string;
      mode?: string;
      agentDisplayName?: string;
      // Tolerated-but-ignored: legacy dashboards may still send this.
      selections?: Record<string, string>;
    };
    const { channelId, mode, agentDisplayName } = body;
    if (!channelId || typeof channelId !== "string") {
      return c.json({ error: "channelId is required" }, 400);
    }
    if (mode !== "initial" && mode !== "update") {
      return c.json({ error: "mode must be 'initial' or 'update'" }, 400);
    }

    if (!adapter.isConnected(channelId)) {
      return c.json({ error: "channel not connected" }, 404);
    }

    // Close any stale active dashboard_chat sessions so the history restore
    // on the next page load starts clean (no old setup messages appear).
    try {
      db.prepare(
        `UPDATE conversation_sessions
         SET status = 'closed'
         WHERE scope = 'dashboard_chat' AND status = 'active'`,
      ).run();
    } catch (err) {
      logger.warn({ err }, "failed to close stale dashboard sessions before setup");
    }

    // Validate preconditions
    const rulesPath = join(getContextDir(config), managementRulesRelPath);
    if (mode === "initial" && existsSync(rulesPath)) {
      return c.json(
        {
          error: "already_setup",
          message: `${managementRulesRelPath} already exists. Use mode='update'.`,
        },
        409,
      );
    }
    if (mode === "update" && !existsSync(rulesPath)) {
      return c.json(
        {
          error: "not_setup",
          message: `${managementRulesRelPath} does not exist. Use mode='initial'.`,
        },
        409,
      );
    }

    // SETUP-FLOW-REDESIGN-PLAN §5.8 — the greeting no longer carries
    // the legacy "Selected tools" preamble. The setup.initial task
    // flow now teaches the agent to fetch integration state + derive
    // the Source-of-Truth table itself; this prompt just opens the
    // turn.
    let greeting: string;
    if (mode === "initial") {
      greeting = "Please start the setup process.";
    } else {
      greeting = `I'd like to update ${managementRulesRelPath}.`;
    }

    // Engage the autonomous-work gate BEFORE enqueuing the greeting so any
    // concurrent cron tick / ScheduleWatcher poll observes the flag and
    // yields. Without this, a activity_scan firing in the same tick could
    // still race the setup conversation and patch today.md, which would
    // mark the owner-DM session stale and orphan the setup mode.
    deps.onSetupStart?.(mode);

    adapter.handleIncomingMessage(channelId, greeting, {
      metadata: {
        setupMode: mode,
        ...(typeof agentDisplayName === "string"
          ? { agentDisplayName: normalizeAgentDisplayName(agentDisplayName) }
          : {}),
      },
    });

    return c.json({ status: "started", mode });
  });

  // POST /setup/save-rules — Write rules/management.md (bypasses Context API whitelist)
  app.post("/setup/save-rules", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.body as {
      content?: string;
      agentDisplayName?: string;
      sessionId?: number;
    };
    const { content, agentDisplayName, sessionId: rawSessionId } = body;
    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return c.json({ error: "content is required and must be non-empty" }, 400);
    }

    // Size limit: rules/management.md should be small (< 100KB)
    if (content.length > 100_000) {
      return c.json({ error: "content too large (max 100KB)" }, 400);
    }

    // Phase 4 — obsidian mode requires `primaryVaultPath` to be set before
    // save-rules can materialize the skeleton. Without it, `getContextDir`
    // returns the plain fallback (`~/.personal-agent/context/`) but the
    // daemon is in degraded mode — writes return 503 and the user would
    // see a confusing half-finished setup. Surfacing a structured 400 here
    // lets the wizard steer the user back to the obsidian-path step.
    if (
      config.vaultMode === "obsidian"
      && (!config.primaryVaultPath || config.primaryVaultPath.length === 0)
    ) {
      return c.json(
        {
          error: "primary_vault_path_required",
          message:
            "Obsidian mode requires a primary vault path. Complete the Obsidian step or switch to plain mode.",
        },
        400,
      );
    }

    const contextDir = getContextDir(config);

    let nextAgentDisplayName = config.agentDisplayName;
    if (typeof agentDisplayName === "string") {
      const validationError = validateAgentDisplayName(agentDisplayName);
      if (validationError) {
        return c.json({ error: validationError }, 400);
      }
      nextAgentDisplayName = normalizeAgentDisplayName(agentDisplayName);
    }

    const rulesPath = join(contextDir, managementRulesRelPath);
    const isUpdate = existsSync(rulesPath);
    const previousAgentDisplayName = config.agentDisplayName;
    const previousRulesContent = isUpdate
      ? readFileSync(rulesPath, "utf-8")
      : null;

    const contentWithIdentity = upsertManagementRulesAgentIdentity(
      content,
      nextAgentDisplayName,
    );
    // MANAGEMENT-POLICY-CAPTURE-PLAN §5.7 — preserve the auto-maintained
    // `## Active Policies` section. The wizard payload doesn't carry it,
    // so without this merge every save-rules run would strip it; the FS-
    // watch policy-index reconciler would re-render it later, but in the
    // meantime the user-visible file is missing the section. We splice
    // the on-disk version in pre-write so the file is coherent immediately.
    const preservedActivePolicies =
      previousRulesContent !== null
        ? extractActivePoliciesSection(previousRulesContent)
        : null;
    const contentWithPolicies =
      preservedActivePolicies !== null
        ? upsertManagementRulesActivePolicies(
            contentWithIdentity,
            preservedActivePolicies,
          )
        : contentWithIdentity;

    // SCHEDULED-DM-IMPLEMENTATION-PLAN §6.6 — idempotently seed the
    // morning briefing recurring schedule, then mirror the
    // `recurring_schedules` table into `## Default Schedules` so the
    // wizard's atomic save lands a coherent file.
    try {
      ensureMorningBriefingRecurring(db, config);
    } catch (err) {
      logger.warn(
        { err },
        "failed to seed morning briefing recurring schedule (continuing)",
      );
    }
    const renderedDefaultSchedules = renderDefaultSchedulesSection(
      buildDefaultSchedulesSnapshot(db),
    );
    const contentWithDefaultSchedules = upsertManagementRulesDefaultSchedules(
      contentWithPolicies,
      renderedDefaultSchedules,
    );

    const frontmatterError = validateContextFileFrontmatter(
      contentWithDefaultSchedules,
      managementRulesRelPath,
    );
    if (frontmatterError) {
      return c.json({ error: frontmatterError.message }, 422);
    }

    const shouldPersistAgentDisplayName =
      nextAgentDisplayName !== previousAgentDisplayName;

    if (shouldPersistAgentDisplayName) {
      try {
        settingsStore.set("agentDisplayName", nextAgentDisplayName);
        config.agentDisplayName = nextAgentDisplayName;
      } catch (err) {
        return c.json({
          error: toSafeErrorMessage(err, "failed_to_persist_agent_name"),
        }, 500);
      }
    }

    try {
      // Snapshot existing content after validation so rejected setup updates
      // do not create misleading history rows.
      if (isUpdate) {
        try {
          db.prepare(
            "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
          ).run(managementRulesApiKey, previousRulesContent, "setup_update");
        } catch {
          // Non-critical — proceed with save.
        }
      }
      mkdirSync(dirname(rulesPath), { recursive: true });
      writeFileSync(rulesPath, contentWithDefaultSchedules, "utf-8");
    } catch (err) {
      if (shouldPersistAgentDisplayName) {
        try {
          settingsStore.set("agentDisplayName", previousAgentDisplayName);
        } catch {
          // Best-effort rollback. Keep the original write error as the response.
        }
        config.agentDisplayName = previousAgentDisplayName;
      }
      return c.json({
        error: toSafeErrorMessage(err, "failed_to_write_management_rules"),
      }, 500);
    }

    deps.onPromptContextChanged?.(
      managementRulesApiKey,
      isUpdate ? "setup_update" : "setup_initial",
      "loud",
      { tierReason: "setup_rules_save" },
    );

    // On initial setup, create skeleton context files if they don't exist
    if (!isUpdate) {
      ensureSkeletonFiles(contextDir, config.workspaceDir);
    }

    // Clear setup mode from dispatcher so subsequent chat messages use normal template
    deps.onSetupComplete?.();

    // Delete the setup conversation session so it doesn't appear in the
    // chat sidebar and can't be resumed mid-setup. Scoped to dashboard_chat
    // + the specific id the client sent — a misdirected id silently matches
    // nothing rather than wiping another scope. Failure is non-fatal;
    // management rules are already saved.
    const setupSessionId =
      typeof rawSessionId === "number" && Number.isFinite(rawSessionId) && rawSessionId > 0
        ? rawSessionId
        : null;
    if (setupSessionId !== null) {
      try {
        deleteSetupSession(db, config.dataDir, setupSessionId);
      } catch (err) {
        logger.warn(
          { err, setupSessionId },
          "failed to delete setup conversation session",
        );
      }
    }

    return c.json({
      status: isUpdate ? "updated" : "created",
    });
  });

  // POST /setup/backends/opencode/probe — docs/design/appendices/opencode-backend.md
  // §6.6.2 setup-wizard probe. Performs an autonomous-read health check
  // against the managed loopback opencode server: enumerates providers
  // and reports the live tool-use capability matrix so the wizard can
  // surface "OpenCode is healthy with N providers, M models support
  // tool-use" without committing a `backends` row.
  //
  // The probe is risk-classified as autonomous read by the
  // `/api/setup` prefix rule in risk-classifier.ts (Approve tier — but
  // the read side has no destructive blast radius; the wizard relays
  // this to a UI that the operator confirms before mutating any
  // `process_backend_config` row).
  app.post("/setup/backends/opencode/probe", async (c) => {
    const opencodeCore = deps.agentBackends?.find(
      (core) => core.backendId === "opencode",
    );
    if (!opencodeCore) {
      return c.json(
        {
          status: "error",
          aitneSignal: "transient" as const,
          message: "OpenCode backend is not wired into this daemon build.",
        },
        503,
      );
    }

    try {
      const auth = await opencodeCore.checkAuthDetailed();
      if (!auth.ok) {
        return c.json(
          {
            status: "error",
            aitneSignal:
              auth.status === "expired" || auth.status === "missing"
                ? ("auth-invalid" as const)
                : ("transient" as const),
            message:
              auth.detail
                ?? "OpenCode server is not reachable or has no providers configured.",
            ...(auth.recoveryCommand
              ? { recoveryCommand: auth.recoveryCommand }
              : {}),
          },
          200,
        );
      }

      // Healthy — surface the model registry + tool-use breakdown
      // (§6.1.2). Static-registry first; Phase 6 widens this with a
      // live `client.config.providers()` capability sniff.
      const models = opencodeCore.listModels();
      const modelsTotal = models.length;
      const modelsWithToolUse = models.filter(
        (model) => model.supportsToolUse !== false,
      ).length;
      const providers = Array.from(
        new Set(
          models.map((model) => {
            const slash = model.modelId.indexOf("/");
            return slash > 0 ? model.modelId.slice(0, slash) : model.modelId;
          }),
        ),
      );

      return c.json({
        status: "ok" as const,
        healthy: true,
        mode: "managed" as const,
        providers,
        modelsTotal,
        modelsWithToolUse,
        warnings: [] as string[],
      });
    } catch (err) {
      logger.warn({ err }, "opencode setup probe failed");
      return c.json(
        {
          status: "error" as const,
          aitneSignal: "transient" as const,
          message: toSafeErrorMessage(err, "opencode_probe_failed"),
        },
        200,
      );
    }
  });

  // CONTEXT_VAULT_REDESIGN_PLAN.md §11.3.4 / V16 — dashboard consent
  // surface for the Obsidian-mode vault restructure. On Obsidian
  // installs the boot layer defers the migration until the user opts
  // in; this endpoint records that opt-in. The migration runs on the
  // NEXT daemon boot — the response carries that instruction so the
  // dashboard can ask the user to restart (or trigger a supervisor
  // restart if one is wired).
  //
  // GET returns the current pending-consent state so the dashboard
  // can decide whether to show the banner.
  app.get("/setup/vault-restructure-status", (c) => {
    const pending = getVaultRestructurePendingConsent(db);
    const ack = getVaultRestructureAck(db);
    return c.json({
      pendingConsent: pending,
      acknowledgement: ack,
    });
  });

  app.post("/setup/vault-restructure-ack", async (c) => {
    const ack = getVaultRestructureAck(db);
    if (ack) {
      return c.json(
        {
          ok: true,
          alreadyAcknowledged: true,
          acknowledgement: ack,
          restartRequired: false,
          message:
            "Vault restructure consent was already recorded; nothing to do.",
        },
        200,
      );
    }
    setVaultRestructureAck(db, {
      at: new Date().toISOString(),
      source: "dashboard",
    });
    logger.info(
      { source: "dashboard" },
      "Vault restructure consent recorded — migration will run on next daemon boot.",
    );
    return c.json(
      {
        ok: true,
        alreadyAcknowledged: false,
        restartRequired: true,
        message:
          "Consent recorded. Restart the daemon (e.g. `aitne restart`) to run the vault restructure.",
      },
      200,
    );
  });

  return app;
}
