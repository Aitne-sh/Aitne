import { resolve } from "node:path";
import { Hono } from "hono";
import {
  MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
  formatSqliteDatetime,
  getAgentDayBoundsUtc,
  parseSqliteUtcMs,
  type Alert,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import { getContextDir } from "../../config.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";
import { checkAgentJournalHealth } from "../../core/retention.js";
import { getDegradedMode } from "../../db/runtime-state.js";
import { buildIntegrationHealthMap } from "../../core/integration-health.js";
import { loadAllCurationDeclarations } from "../../core/skill-curation/declarations.js";
import { readPendingTemplateUpgrades } from "../../core/template-versions.js";
import { readReleaseAssetStatus } from "../../core/release-assets.js";
import {
  aggregateAlerts,
  type BackendAuthSignal,
  type MailAccountSignal,
} from "../../core/alerts.js";
import {
  createDefaultBangCommandRegistry,
  getBangCommandName,
} from "../../core/bang-commands/index.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("health-api");

const ROLLING_MONTHLY_COST_DAYS = 30;

/**
 * Best-effort signal extraction. Each block guards its own DB query so a
 * single failure (e.g. a malformed row) does not blank the whole alerts
 * payload — we'd rather show a partial list than zero alerts.
 */
function safeQuery<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    logger.warn({ err, label }, "Health alerts: signal query failed");
    return fallback;
  }
}

export function createHealthRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config, getHealthData, getIntegrationStatus } = deps;
  const builtInBangRegistry = createDefaultBangCommandRegistry();
  const builtInCommandNames = builtInBangRegistry
    .list()
    .map((c) => getBangCommandName(c));

  app.get("/health", (c) => {
    const healthData = getHealthData();
    const integrations = getIntegrationStatus();
    const messaging = deps.getMessagingStatus?.() ?? {};
    const notificationDestinations = deps.getNotificationDestinations?.() ?? {
      defaultPlatforms: [],
      effectiveFallbackPlatforms: [],
    };
    const integrationDriftSync = deps.getIntegrationDriftSyncStatus?.() ?? {
      workerRunning: false,
      lastSuccessAt: null,
      circuitState: "ok",
      activeHours: { startHour: 4, endHour: 24 },
      withinActiveHours: false,
      cadences: {},
      unrecognizedIntervalKeys: [],
      ttlContractViolations: [],
    };

    let dbConnected = true;
    let todaySessions = 0;
    let todayCostUsd = 0;
    let monthCostUsd = 0;

    try {
      const bounds = getAgentDayBoundsUtc(config.timezone, config.dayBoundaryHour);
      const todayStats = db
        .prepare(
          "SELECT COUNT(*) as sessions, COALESCE(SUM(cost_usd), 0) as cost FROM agent_actions WHERE started_at >= ? AND started_at < ?",
        )
        .get(bounds.start, bounds.end) as { sessions: number; cost: number };
      todaySessions = todayStats.sessions;
      todayCostUsd = todayStats.cost;

      const monthStartMs = parseSqliteUtcMs(bounds.end)
        - ROLLING_MONTHLY_COST_DAYS * 24 * 60 * 60 * 1000;
      const monthStart = formatSqliteDatetime(new Date(monthStartMs));
      const monthStats = db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) as cost FROM agent_actions WHERE started_at >= ? AND started_at < ?",
        )
        .get(monthStart, bounds.end) as { cost: number };
      monthCostUsd = monthStats.cost;
    } catch (err) {
      logger.error({ err }, "Health check DB query failed");
      dbConnected = false;
    }

    // Agent-journal health: live read-only check for section counts and
    // oversized sections so the dashboard can surface journal bloat without
    // requiring the operator to watch structured logs. Pass `db` so
    // degraded-mode returns the safe fallback (plan §5.3).
    const contextDir = getContextDir(config, db);
    const agentJournal = checkAgentJournalHealth(
      resolve(contextDir, CONTEXT_RELATIVE_PATHS.agent.journal),
    );

    // Management Mode (plan §5.4, §10): degraded mode when the primary
    // vault is unreachable. The dashboard banner reads this field.
    const degradedState = getDegradedMode(db);
    const topLevelStatus = degradedState ? "degraded" : "ok";

    // Messaging bang-commands (`!stop`/`!start`) — `autonomousState` carries
    // the full enum from `EventDispatcher.isAutonomousAllowed()`, including
    // `"user_paused"`. Older callers can keep reading the legacy `status` /
    // `degraded` fields without change.
    const autonomousState = deps.getAutonomousState?.() ?? null;

    const integrationModes = buildIntegrationHealthMap(db, config.workspaceDir);
    const templatesPendingRecord = readPendingTemplateUpgrades(db);
    const releaseAssets = readReleaseAssetStatus(db);

    // P22 §1.6 rule 5 — surface anchor / curation declaration misconfigurations
    // so the dashboard banner can flag drift between SKILL.md and curation.json.
    // Best-effort: a fresh checkout with no curation.json files returns an
    // empty list (the loader yields zero diagnostics).
    const skillCuration = safeQuery<{
      misconfigured: Array<{ slug: string; code: string; message: string; level: "error" | "warning" }>;
    }>(
      "skill_curation_health",
      () => {
        const skillsRoot = resolve(config.workspaceDir, "agent-assets", "skills");
        const all = loadAllCurationDeclarations(skillsRoot);
        const misconfigured: Array<{ slug: string; code: string; message: string; level: "error" | "warning" }> = [];
        for (const entry of all) {
          for (const d of entry.diagnostics) {
            misconfigured.push({ slug: entry.slug, code: d.code, message: d.message, level: d.level });
          }
        }
        return { misconfigured };
      },
      { misconfigured: [] },
    );

    // Management Mode (docs/design/21-management-registry-and-entities.md
    // §14.1) — surface the active count and the count of tasks whose
    // consecutive-failure counter has reached the 3-strikes notify
    // threshold so the dashboard banner can light up before the user
    // checks the History tab. Best-effort read: a missing `managed_tasks`
    // table on a fresh DB returns zero (never the entire `/health`
    // payload's failure mode).
    const managementTasks = safeQuery<{ active: number; failingNow: number }>(
      "managed_tasks_summary",
      () => {
        const row = db
          .prepare(
            `SELECT
               COUNT(*) AS active,
               COUNT(*) FILTER (WHERE consecutive_failures >= ?) AS failing_now
             FROM managed_tasks`,
          )
          .get(MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT) as {
          active: number;
          failing_now: number;
        };
        // SQL COUNT() always returns an integer (zero on an empty table,
        // never NULL), so a `?? 0` fallback would be dead defensive code.
        return {
          active: row.active,
          failingNow: row.failing_now,
        };
      },
      { active: 0, failingNow: 0 },
    );

    // ── Notifications Center inputs ────────────────────────────────────
    // Each query is best-effort; a partial alerts list is more useful
    // than a blank payload when one signal source fails.
    const mailAccounts = safeQuery<MailAccountSignal[]>(
      "mail_accounts",
      () => {
        const rows = db
          .prepare(
            "SELECT id, kind, email, auth_status, active FROM mail_accounts",
          )
          .all() as Array<{
          id: string;
          kind: string;
          email: string;
          auth_status: string;
          active: number;
        }>;
        return rows
          .filter((r): r is typeof r & {
            kind: MailAccountSignal["kind"];
            auth_status: MailAccountSignal["authStatus"];
          } =>
            (r.kind === "gmail"
              || r.kind === "outlook"
              || r.kind === "yahoo"
              || r.kind === "icloud")
            && (r.auth_status === "healthy"
              || r.auth_status === "requires_consent"
              || r.auth_status === "degraded"),
          )
          .map((r) => ({
            id: r.id,
            kind: r.kind,
            email: r.email,
            authStatus: r.auth_status,
            active: r.active === 1,
          }));
      },
      [],
    );

    const backendSignals = safeQuery<BackendAuthSignal[]>(
      "backends",
      () =>
        (
          db
            .prepare(
              "SELECT id, enabled, auth_status, last_error FROM backends",
            )
            .all() as Array<{
            id: string;
            enabled: number;
            auth_status: string;
            last_error: string | null;
          }>
        ).map((r) => ({
          id: r.id,
          enabled: r.enabled === 1,
          authStatus: r.auth_status,
          lastError: r.last_error,
          // CLI-installed flag lives on the in-memory backend list, not the
          // db row. Probing requires PATH lookup; treat as installed here
          // and surface CLI-missing warnings via the existing health card.
          cliInstalled: true,
        })),
      [],
    );

    const userCommands = safeQuery<
      Array<{ id: number; name: string; command: string }>
    >(
      "user_bang_commands",
      () => {
        const rows = db
          .prepare(
            "SELECT id, command FROM user_bang_commands WHERE enabled = 1",
          )
          .all() as Array<{ id: number; command: string }>;
        return rows.map((r) => ({
          id: r.id,
          // The schema only stores `command` (with the leading `!`).
          // Strip it for the `name` field; the conflict detector matches
          // on `command` anyway.
          name: r.command.startsWith("!") ? r.command.slice(1) : r.command,
          command: r.command,
        }));
      },
      [],
    );

    const gmailMode = integrationModes.gmail?.mode;
    const gmailDelegated = gmailMode === "delegated";
    const delegationUpgradeAvailable =
      integrationModes.gmail?.mode === "direct"
      || integrationModes.google_calendar?.mode === "direct";

    const googleStatus = integrations.google;

    const now = new Date();
    const alerts: Alert[] = aggregateAlerts({
      now,
      degradedMode: degradedState,
      missingContextFiles: healthData.missingContextFiles,
      mailAccounts,
      gmailDelegated,
      templatesPending: templatesPendingRecord?.pending ?? [],
      docsAssetConflicts: releaseAssets?.docs?.conflicts.map((conflict) => conflict.path) ?? [],
      skillConflicts: releaseAssets?.skills?.builtinShadowedUserSkills ?? [],
      builtInCommandNames,
      userCommands,
      backends: backendSignals,
      todayCostUsd,
      monthCostUsd,
      dailyCapUsd: config.autonomousDailyCostCapUsd,
      monthlyCapUsd: config.autonomousMonthlyCostCapUsd,
      googleConfigured: googleStatus?.configured ?? false,
      googleConnected: googleStatus?.connected ?? false,
      delegationUpgradeAvailable,
    });

    return c.json({
      status: topLevelStatus,
      degraded: degradedState
        ? {
            reason: degradedState.reason,
            path: degradedState.path,
            since: degradedState.since,
          }
        : null,
      autonomousState,
      uptime: healthData.uptime,
      lastTickAt: deps.getLastTickAt?.() ?? Date.now(),
      eventBusSize: healthData.eventBusSize,
      activeSessions: healthData.activeSessions,
      todaySessions,
      todayCostUsd,
      monthCostUsd,
      dbConnected,
      contextFilesOk: healthData.contextFilesOk,
      missingContextFiles: healthData.missingContextFiles,
      connectedPlatforms: healthData.connectedPlatforms,
      messaging,
      notificationDestinations,
      registeredObservers: healthData.registeredObservers,
      integrations,
      // Integration delegation framework — registry-keyed sibling field
      // (§4.11). The legacy `integrations` field above is preserved
      // verbatim so the dashboard's existing service-health cards keep
      // working; Phase 5 owns the atomic cutover when it rewrites the
      // dashboard's per-integration cards. Until then both fields
      // coexist intentionally.
      integrationModes,
      integrationDriftSync,
      agentJournal,
      // Template upgrade check (course 4 — future format changes). The
      // daemon diffs shipped template versions against user-side file
      // frontmatter at startup and persists the result in runtime_state.
      templatesPending: templatesPendingRecord,
      releaseAssets,
      // Notifications Center (see docs/design/20-notifications-center.md).
      // Severity-sorted; clients render verbatim.
      alerts,
      // docs/design/21-management-registry-and-entities.md §14.1 (P8)
      // — `{active, failingNow}`. The dashboard's settings/management
      // page and the Notifications Center both subscribe to this field.
      managementTasks,
      // P22 §1.6 — anchor + declaration misconfigurations across skills.
      // Empty list = healthy. The dashboard surfaces non-empty arrays as
      // a banner on `/settings/self-learning`.
      skillCuration,
    });
  });

  return app;
}
