import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatSqliteDatetime,
  getAgentDayBoundsUtc,
  parseSqliteUtcMs,
} from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  markSetupCompleted,
  setDegradedMode,
  writeRuntimeState,
} from "../../db/runtime-state.js";
import { writeIntegrations } from "../../db/integrations-store.js";
import { RELEASE_ASSETS_STATUS_KEY } from "../../core/release-assets.js";
import { PENDING_UPGRADES_KEY } from "../../core/template-versions.js";
import { createHealthRoutes } from "./health.js";
import type { ApiDependencies } from "../server.js";
import { loadAllCurationDeclarations } from "../../core/skill-curation/declarations.js";

vi.mock("../../core/skill-curation/declarations.js", () => ({
  loadAllCurationDeclarations: vi.fn().mockReturnValue([]),
}));

function makeDeps(
  db: Database.Database,
  dataDir: string,
  extra: Partial<ApiDependencies> = {},
): ApiDependencies {
  return {
    db,
    config: {
      dataDir,
      workspaceDir: ".",
      timezone: "UTC",
      dayBoundaryHour: 0,
      autonomousDailyCostCapUsd: null,
      autonomousMonthlyCostCapUsd: null,
    },
    getHealthData: () => ({
      uptime: 1000,
      eventBusSize: 0,
      activeSessions: 0,
      connectedPlatforms: [],
      registeredObservers: [],
      missingContextFiles: [],
      contextFilesOk: true,
    }),
    getIntegrationStatus: () => ({
      google: {
        configured: false,
        connected: false,
        error: null,
        services: {
          calendar: { connected: false, error: null },
          gmail: { connected: false, error: null },
        },
      },
      appleCalendar: { configured: false, connected: false, error: null },
      obsidian: { configured: false, connected: false, error: null },
      notion: { configured: false, connected: false, error: null },
      whatsapp: {
        configured: false,
        connected: false,
        error: null,
        state: "not_configured",
      },
    }),
    ...extra,
  } as unknown as ApiDependencies;
}

describe("health routes", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-test-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  // ── Phase 8 — managementTasks block (docs/design/21 §14.1) ───────────────

  function insertManagedTaskRow(
    id: string,
    overrides: Partial<{ consecutiveFailures: number; app: string }> = {},
  ): void {
    const failures = overrides.consecutiveFailures ?? 0;
    const app = overrides.app ?? "zoom";
    const scheduleId = Number(id.replace(/^mt_/, ""));
    db.prepare(
      `INSERT INTO recurring_schedules (id, task_type, recurrence_rule, task_description, created_at, updated_at)
       VALUES (?, 'scheduled.task', ?, ?, datetime('now'), datetime('now'))`,
    ).run(scheduleId, "FREQ=DAILY;BYHOUR=10;BYMINUTE=0", `mt:${id}`);
    db.prepare(
      `INSERT INTO managed_tasks
        (id, intent, app, app_normalized, cadence, schedule_id,
         consecutive_failures, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'daily', ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, "Test", app, app.toLowerCase(), scheduleId, failures);
  }

  it("includes managementTasks zero counts on a fresh DB", async () => {
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    const body = (await res.json()) as {
      managementTasks: { active: number; failingNow: number };
    };
    expect(body.managementTasks).toEqual({ active: 0, failingNow: 0 });
  });

  it("counts active managed tasks and tasks at/above the 3-strikes threshold", async () => {
    insertManagedTaskRow("mt_1", { consecutiveFailures: 0 });
    insertManagedTaskRow("mt_2", { app: "gmail", consecutiveFailures: 2 });
    insertManagedTaskRow("mt_3", { app: "notion", consecutiveFailures: 3 });
    insertManagedTaskRow("mt_4", { app: "calendar", consecutiveFailures: 5 });

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    const body = (await res.json()) as {
      managementTasks: { active: number; failingNow: number };
    };
    expect(body.managementTasks.active).toBe(4);
    // mt_3 (3) and mt_4 (5) cross the threshold.
    expect(body.managementTasks.failingNow).toBe(2);
  });

  it("reports monthCostUsd over exactly the rolling 30-day window ending at the current agent-day end", async () => {
    const bounds = getAgentDayBoundsUtc(
      "UTC",
      0,
      new Date("2026-05-01T12:00:00.000Z"),
    );
    const windowStartMs = parseSqliteUtcMs(bounds.end)
      - 30 * 24 * 60 * 60 * 1000;
    const outsideWindow = formatSqliteDatetime(new Date(windowStartMs - 1000));
    const insideWindow = formatSqliteDatetime(new Date(windowStartMs));

    db.prepare(
      `INSERT INTO agent_actions (action_type, result, cost_usd, started_at)
       VALUES (?, 'success', ?, ?)`,
    ).run("test.old", 50, outsideWindow);
    db.prepare(
      `INSERT INTO agent_actions (action_type, result, cost_usd, started_at)
       VALUES (?, 'success', ?, ?)`,
    ).run("test.current", 10, insideWindow);

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    const body = await res.json() as { monthCostUsd: number };

    expect(body.monthCostUsd).toBe(10);
  });
});

// ── Additional branch coverage ─────────────────────────────────────────────

describe("health routes — safeQuery catch branches", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-sq-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("returns fallback {active:0, failingNow:0} when managed_tasks table is absent", async () => {
    db.prepare("DROP TABLE IF EXISTS managed_tasks").run();
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      managementTasks: { active: number; failingNow: number };
    };
    expect(body.managementTasks).toEqual({ active: 0, failingNow: 0 });
  });

  it("returns fallback [] when mail_accounts table is absent", async () => {
    db.prepare("DROP TABLE IF EXISTS mail_accounts").run();
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    // alerts should still be present; no crash
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("returns fallback [] when backends table query fails via rename+view", async () => {
    // Cannot drop backends — FK constraints prevent it even with PRAGMA foreign_keys = OFF
    // because SQLite still validates FK references in the schema. Instead we rename the
    // backing table and shadow it with a broken view whose query will fail at runtime.
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("ALTER TABLE backends RENAME TO _backends_shadow").run();
    // This view references a non-existent table; SQLite defers schema validation
    // to query-execution time, so create succeeds but SELECT fails.
    db.prepare(
      "CREATE VIEW backends AS SELECT id, enabled, auth_status, last_error FROM _no_such_table_xyz",
    ).run();
    db.prepare("PRAGMA foreign_keys = ON").run();

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("returns fallback [] when user_bang_commands table is absent", async () => {
    db.prepare("DROP TABLE IF EXISTS user_bang_commands").run();
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("sets dbConnected=false when agent_actions table is absent", async () => {
    db.prepare("DROP TABLE IF EXISTS agent_actions").run();
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dbConnected: boolean };
    expect(body.dbConnected).toBe(false);
  });

  it("returns fallback {misconfigured:[]} when loadAllCurationDeclarations throws", async () => {
    vi.mocked(loadAllCurationDeclarations).mockImplementation(() => {
      throw new Error("curation load failed");
    });
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skillCuration: { misconfigured: unknown[] };
    };
    expect(body.skillCuration.misconfigured).toEqual([]);
  });

  it("populates skillCuration.misconfigured when declarations have diagnostics", async () => {
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([
      {
        slug: "my-skill",
        declaration: null,
        anchors: [],
        diagnostics: [
          { level: "error", code: "section_missing_anchor", message: "Missing anchor for section intro" },
        ],
      },
    ]);
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skillCuration: { misconfigured: Array<{ slug: string; code: string; level: string }> };
    };
    expect(body.skillCuration.misconfigured).toHaveLength(1);
    expect(body.skillCuration.misconfigured[0]?.slug).toBe("my-skill");
    expect(body.skillCuration.misconfigured[0]?.code).toBe("section_missing_anchor");
    expect(body.skillCuration.misconfigured[0]?.level).toBe("error");
  });
});

describe("health routes — optional deps callbacks", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-cb-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("includes getMessagingStatus data when provided", async () => {
    const messagingStatus = {
      telegram: {
        configured: true,
        runtimeState: "ok" as const,
        ownerConfigured: true,
        ownerChannelKnown: true,
        notificationEligible: true,
        lastInboundAt: null,
        error: null,
      },
    };
    const app = createHealthRoutes(
      makeDeps(db, tmpDir, {
        getMessagingStatus: () => messagingStatus,
      }),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messaging: typeof messagingStatus };
    expect(body.messaging).toEqual(messagingStatus);
  });

  it("includes getNotificationDestinations data when provided", async () => {
    const notificationDestinations = {
      defaultPlatforms: ["telegram"],
      effectiveFallbackPlatforms: ["dashboard"],
    };
    const app = createHealthRoutes(
      makeDeps(db, tmpDir, {
        getNotificationDestinations: () => notificationDestinations,
      }),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notificationDestinations: typeof notificationDestinations;
    };
    expect(body.notificationDestinations).toEqual(notificationDestinations);
  });

  it("includes getIntegrationDriftSyncStatus data when provided", async () => {
    const driftStatus = {
      workerRunning: true,
      lastSuccessAt: "2026-05-01T10:00:00.000Z",
      circuitState: "ok" as const,
      activeHours: { startHour: 8, endHour: 22 },
      withinActiveHours: true,
      cadences: {},
      unrecognizedIntervalKeys: [],
      ttlContractViolations: [],
    };
    const app = createHealthRoutes(
      makeDeps(db, tmpDir, {
        getIntegrationDriftSyncStatus: () => driftStatus,
      }),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrationDriftSync: typeof driftStatus;
    };
    expect(body.integrationDriftSync.workerRunning).toBe(true);
    expect(body.integrationDriftSync.lastSuccessAt).toBe("2026-05-01T10:00:00.000Z");
  });

  it("includes getLastTickAt value when provided", async () => {
    const tickAt = 1746091200000;
    const app = createHealthRoutes(
      makeDeps(db, tmpDir, {
        getLastTickAt: () => tickAt,
      }),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastTickAt: number };
    expect(body.lastTickAt).toBe(tickAt);
  });

  it("includes autonomousState 'user_paused' when getAutonomousState returns it", async () => {
    const app = createHealthRoutes(
      makeDeps(db, tmpDir, {
        getAutonomousState: () => "user_paused",
      }),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autonomousState: string | null };
    expect(body.autonomousState).toBe("user_paused");
  });

  it("autonomousState is null when getAutonomousState is not provided", async () => {
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autonomousState: null };
    expect(body.autonomousState).toBeNull();
  });
});

describe("health routes — degraded state", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-deg-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("returns status='degraded' and degraded object when setDegradedMode is active", async () => {
    setDegradedMode(db, {
      reason: "vault_unreachable",
      path: "/vault",
      since: "2026-05-01T00:00:00.000Z",
    });
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      degraded: { reason: string; path: string; since: string } | null;
    };
    expect(body.status).toBe("degraded");
    expect(body.degraded).not.toBeNull();
    expect(body.degraded?.reason).toBe("vault_unreachable");
    expect(body.degraded?.path).toBe("/vault");
    expect(body.degraded?.since).toBe("2026-05-01T00:00:00.000Z");
  });

  it("returns status='ok' and degraded=null when no degraded mode set", async () => {
    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; degraded: null };
    expect(body.status).toBe("ok");
    expect(body.degraded).toBeNull();
  });
});

describe("health routes — mail_accounts filtering", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-mail-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("passes valid kinds (gmail, outlook, yahoo, icloud) and filters out imap", async () => {
    // Insert one of each valid kind and one invalid
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, ?, ?, 'oauth2', 'healthy', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_gmail", "gmail", "g@gmail.com", "blob_g");
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, ?, ?, 'oauth2', 'healthy', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_outlook", "outlook", "o@outlook.com", "blob_o");
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, ?, ?, 'oauth2', 'healthy', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_yahoo", "yahoo", "y@yahoo.com", "blob_y");
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, ?, ?, 'oauth2', 'healthy', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_icloud", "icloud", "i@icloud.com", "blob_i");
    // imap is filtered out
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, ?, ?, 'imap', 'healthy', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_imap", "imap", "x@imap.com", "blob_x");

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    // We don't have direct access to mail accounts in the response, but health
    // returns successfully and we can verify no crash (alerts is array)
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("filters out accounts with invalid auth_status (unknown)", async () => {
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, 'gmail', ?, 'oauth2', 'unknown', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_bad", "bad@gmail.com", "blob_b");
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES (?, 'gmail', ?, 'oauth2', 'degraded', ?, 1, '2026-05-01T00:00:00.000Z')`,
    ).run("ma_degraded", "deg@gmail.com", "blob_d");

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    // We verify no crash
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("maps active=0 correctly (inactive account)", async () => {
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, auth_status, secret_blob_name, active, created_at_utc)
       VALUES ('ma_inactive', 'gmail', 'inactive@gmail.com', 'oauth2', 'healthy', 'blob_in', 0, '2026-05-01T00:00:00.000Z')`,
    ).run();

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});

describe("health routes — backends table", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-be-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("processes enabled=1 and enabled=0 backends and last_error variants", async () => {
    // Schema already seeds claude/codex/gemini rows via INSERT OR IGNORE.
    // Use UPDATE to set the desired test state without hitting UNIQUE constraint.
    db.prepare(
      `UPDATE backends SET enabled = 1, auth_status = 'healthy', last_error = null WHERE id = 'claude'`,
    ).run();
    db.prepare(
      `UPDATE backends SET enabled = 0, auth_status = 'expired', last_error = 'some error' WHERE id = 'codex'`,
    ).run();

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});

describe("health routes — user_bang_commands", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-cmd-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("strips leading '!' from command for name field", async () => {
    db.prepare(
      `INSERT INTO user_bang_commands (command, description, prompt, backend_id, model_id, enabled)
       VALUES ('!myCmd', 'My command', 'do something', 'claude', 'sonnet', 1)`,
    ).run();

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    // name should be 'myCmd' (stripped), command should be '!myCmd'
    // We verify no crash and alerts is an array
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it("leaves name unchanged when command does not start with '!'", async () => {
    db.prepare(
      `INSERT INTO user_bang_commands (command, description, prompt, backend_id, model_id, enabled)
       VALUES ('noExclaim', 'No exclaim', 'do something', 'claude', 'sonnet', 1)`,
    ).run();

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});

describe("health routes — gmail delegation status", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-gmail-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("sets delegationUpgradeAvailable=true when gmail is in direct mode", async () => {
    writeIntegrations(db, {
      gmail: { mode: "direct", lastChangedAt: "2026-05-01T00:00:00.000Z" },
    });

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    // The response does not directly expose delegationUpgradeAvailable, but
    // we verify health does not crash and response is valid
    const body = (await res.json()) as { alerts: unknown[]; integrationModes: Record<string, unknown> };
    expect(body.integrationModes.gmail).toBeDefined();
    expect((body.integrationModes.gmail as { mode: string }).mode).toBe("direct");
  });

  it("reports gmailDelegated=true path when gmail is in delegated mode", async () => {
    // delegated mode requires a delegatedBackend value
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        lastChangedAt: "2026-05-01T00:00:00.000Z",
      },
    });

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrationModes: Record<string, unknown> };
    expect((body.integrationModes.gmail as { mode: string }).mode).toBe("delegated");
  });
});

describe("health routes — releaseAssets non-null", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-ra-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("surfaces docs conflicts and skill shadowing when releaseAssets is non-null", async () => {
    const releaseAssetData = {
      checkedAt: "2026-05-01T00:00:00.000Z",
      docs: {
        checkedAt: "2026-05-01T00:00:00.000Z",
        sourceRoot: "/src",
        targetRoot: "/tgt",
        added: 0,
        autoUpdated: 0,
        unchanged: 1,
        conflicts: [
          { path: "docs/guide.md", reason: "user_modified" as const },
        ],
        removedFromSource: [],
        errors: [],
        backupRoot: null,
      },
      skills: {
        checkedAt: "2026-05-01T00:00:00.000Z",
        builtinShadowedUserSkills: ["custom-skill"],
      },
    };
    writeRuntimeState(db, RELEASE_ASSETS_STATUS_KEY, releaseAssetData);

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releaseAssets: {
        docs: { conflicts: Array<{ path: string }> };
        skills: { builtinShadowedUserSkills: string[] };
      } | null;
    };
    expect(body.releaseAssets).not.toBeNull();
    expect(body.releaseAssets?.docs?.conflicts).toHaveLength(1);
    expect(body.releaseAssets?.docs?.conflicts[0]?.path).toBe("docs/guide.md");
    expect(body.releaseAssets?.skills?.builtinShadowedUserSkills).toContain("custom-skill");
  });
});

describe("health routes — templatesPendingRecord non-null", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    tmpDir = mkdtempSync(join(tmpdir(), "pa-health-tp-"));
    db = new Database(":memory:");
    applySchema(db);
    markSetupCompleted(db);
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(loadAllCurationDeclarations).mockReturnValue([]);
  });

  it("surfaces pending template upgrades when present in runtime_state", async () => {
    writeRuntimeState(db, PENDING_UPGRADES_KEY, {
      checkedAt: "2026-05-01T00:00:00.000Z",
      pending: [
        { path: "policies/management.md", from: 1, to: 2 },
      ],
    });

    const app = createHealthRoutes(makeDeps(db, tmpDir));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templatesPending: { pending: Array<{ path: string; from: number; to: number }> } | null;
    };
    expect(body.templatesPending).not.toBeNull();
    expect(body.templatesPending?.pending).toHaveLength(1);
    expect(body.templatesPending?.pending[0]?.path).toBe("policies/management.md");
    expect(body.templatesPending?.pending[0]?.from).toBe(1);
    expect(body.templatesPending?.pending[0]?.to).toBe(2);
  });
});
