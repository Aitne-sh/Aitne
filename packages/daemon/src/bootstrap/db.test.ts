/**
 * Peer tests for `./db.ts` (bootstrap factory).
 *
 * Scope: per `docs/design/appendices/index-bootstrap-stage-split.md` §7,
 * pin every branch the inline §3 logic in `index.ts` used to own but had
 * no isolated test for. Each named export has its own describe block; the
 * `initDatabase` factory itself is exercised end-to-end against an
 * in-memory SQLite to confirm the assembly preserves the design §11
 * ordering invariants (token resolver → backfill → orphan close →
 * settings merge → default correction).
 *
 * Network-touching steps inside `initDatabase` (the `PriceFetcher.refresh`
 * fire-and-forget call) are tolerated as best-effort: the factory does
 * not await them, and any failure is swallowed by the fetcher itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { createSettingsStore } from "../settings/settings-store.js";
import type { AgentConfig } from "../config.js";
import {
  DEFAULT_WIKI_WORKSPACE_NAME,
  DEFAULT_WIKI_LANGUAGE,
  DEFAULT_WIKI_SCHEMA_VERSION,
} from "../core/wiki/workspaces.js";
import { PriceFetcher } from "../core/backends/price-fetcher.js";
import {
  applyDelegatedTaskModeDefaultCorrection,
  closeOrphanedDashboardChatSessions,
  createWikiTokenResolver,
  initDatabase,
  loadPersistedSettings,
} from "./db.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function insertWikiWorkspace(
  db: Database.Database,
  options: {
    name: string;
    rootPath: string;
    language?: string;
    schemaVersion?: number;
    active?: 0 | 1;
  },
): void {
  db.prepare(
    `INSERT INTO wiki_workspaces (
       name, kind, root_path, language, dispatch_mode, concurrency_cap,
       dm_agent_write_enabled, bridge_enabled,
       full_compile_approval_threshold_usd, schema_version, active,
       updated_at
     ) VALUES (?, 'internal', ?, ?, 'parallel', 3, 0, 0, 2.0, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(
    options.name,
    options.rootPath,
    options.language ?? DEFAULT_WIKI_LANGUAGE,
    options.schemaVersion ?? DEFAULT_WIKI_SCHEMA_VERSION,
    options.active ?? 1,
  );
}

function insertDashboardChatSession(
  db: Database.Database,
  options: { scopeKey: string; status: "active" | "closed" },
): number {
  const result = db
    .prepare(
      `INSERT INTO conversation_sessions (
         scope, scope_key, status, platform, channel_id, started_at
       ) VALUES (?, ?, ?, 'dashboard', 'web', CURRENT_TIMESTAMP)`,
    )
    .run("dashboard_chat", options.scopeKey, options.status);
  return Number(result.lastInsertRowid);
}

function insertNonDashboardSession(
  db: Database.Database,
  options: {
    scope: "thread" | "owner_dm" | "docs_qa";
    scopeKey: string;
    status: "active" | "closed";
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO conversation_sessions (
         scope, scope_key, status, platform, channel_id, started_at
       ) VALUES (?, ?, ?, 'slack', 'C123', CURRENT_TIMESTAMP)`,
    )
    .run(options.scope, options.scopeKey, options.status);
  return Number(result.lastInsertRowid);
}

interface TestConfig extends AgentConfig {}

/**
 * Build a minimal `AgentConfig` shape that satisfies the bootstrap call
 * signatures. We do NOT round-trip through `loadConfig()` because the
 * real loader reads env / .env state we don't want to depend on; the
 * runtime keys the tests assert against are written / merged
 * explicitly in each test.
 */
function makeConfig(overrides: Partial<AgentConfig> = {}): TestConfig {
  return {
    delegatedTaskModeEnabled: false,
    dataDir: "/tmp/aitne-bootstrap-test",
    workspaceDir: "/tmp/aitne-bootstrap-test/workspace",
    ...overrides,
  } as unknown as TestConfig;
}

// ── createWikiTokenResolver ──────────────────────────────────────────────────

describe("bootstrap/db createWikiTokenResolver", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns null for non-wiki.* process keys", () => {
    insertWikiWorkspace(db, {
      name: DEFAULT_WIKI_WORKSPACE_NAME,
      rootPath: "/vault/default",
    });
    const resolver = createWikiTokenResolver(db);
    expect(resolver("morning_routine", undefined)).toBeNull();
    expect(resolver("message.dm", undefined)).toBeNull();
    expect(resolver("hourly_check", "default")).toBeNull();
  });

  it("returns the named workspace when present", () => {
    insertWikiWorkspace(db, {
      name: DEFAULT_WIKI_WORKSPACE_NAME,
      rootPath: "/vault/default",
    });
    insertWikiWorkspace(db, {
      name: "research",
      rootPath: "/vault/research",
      language: "ja",
      schemaVersion: 3,
    });
    const resolver = createWikiTokenResolver(db);
    expect(resolver("wiki.compile", "research")).toEqual({
      vault_path: "/vault/research",
      language: "ja",
      workspace_name: "research",
      schema_version: "3",
    });
  });

  it("falls back to the default workspace when the named workspace is missing", () => {
    insertWikiWorkspace(db, {
      name: DEFAULT_WIKI_WORKSPACE_NAME,
      rootPath: "/vault/default",
    });
    const resolver = createWikiTokenResolver(db);
    expect(resolver("wiki.ask", "does-not-exist")).toEqual({
      vault_path: "/vault/default",
      language: DEFAULT_WIKI_LANGUAGE,
      workspace_name: DEFAULT_WIKI_WORKSPACE_NAME,
      schema_version: String(DEFAULT_WIKI_SCHEMA_VERSION),
    });
  });

  it("uses the default workspace when no name is supplied", () => {
    insertWikiWorkspace(db, {
      name: DEFAULT_WIKI_WORKSPACE_NAME,
      rootPath: "/vault/default",
    });
    const resolver = createWikiTokenResolver(db);
    expect(resolver("wiki.compile", undefined)?.workspace_name).toBe(
      DEFAULT_WIKI_WORKSPACE_NAME,
    );
  });

  it("returns null when no workspace exists at all", () => {
    const resolver = createWikiTokenResolver(db);
    expect(resolver("wiki.compile", undefined)).toBeNull();
    expect(resolver("wiki.compile", "anything")).toBeNull();
  });
});

// ── closeOrphanedDashboardChatSessions ───────────────────────────────────────

describe("bootstrap/db closeOrphanedDashboardChatSessions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns 0 when there are no active dashboard_chat sessions", () => {
    expect(closeOrphanedDashboardChatSessions(db)).toBe(0);
  });

  it("closes only status='active' rows scoped to dashboard_chat", () => {
    const activeA = insertDashboardChatSession(db, {
      scopeKey: "sess-a",
      status: "active",
    });
    const activeB = insertDashboardChatSession(db, {
      scopeKey: "sess-b",
      status: "active",
    });
    const alreadyClosed = insertDashboardChatSession(db, {
      scopeKey: "sess-c",
      status: "closed",
    });
    const slackActive = insertNonDashboardSession(db, {
      scope: "owner_dm",
      scopeKey: "U999",
      status: "active",
    });

    const changes = closeOrphanedDashboardChatSessions(db);
    expect(changes).toBe(2);

    const rows = db
      .prepare("SELECT id, status FROM conversation_sessions ORDER BY id ASC")
      .all() as Array<{ id: number; status: string }>;

    const statusFor = (id: number) =>
      rows.find((r) => r.id === id)?.status;
    expect(statusFor(activeA)).toBe("closed");
    expect(statusFor(activeB)).toBe("closed");
    expect(statusFor(alreadyClosed)).toBe("closed");
    expect(statusFor(slackActive)).toBe("active");
  });

  it("is idempotent — a second call returns 0", () => {
    insertDashboardChatSession(db, { scopeKey: "x", status: "active" });
    expect(closeOrphanedDashboardChatSessions(db)).toBe(1);
    expect(closeOrphanedDashboardChatSessions(db)).toBe(0);
  });

  it("swallows DB errors and returns 0", () => {
    db.close();
    expect(closeOrphanedDashboardChatSessions(db)).toBe(0);
  });
});

// ── loadPersistedSettings ────────────────────────────────────────────────────

describe("bootstrap/db loadPersistedSettings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    db.close();
  });

  it("preserves env defaults when no DB rows are present", () => {
    const config = makeConfig({
      executeTimeoutMinutes: 17,
    } as unknown as Partial<AgentConfig>);
    const { persistedSettings } = loadPersistedSettings({ db, config });
    expect(persistedSettings).toEqual({});
    expect(
      (config as unknown as { executeTimeoutMinutes: number }).executeTimeoutMinutes,
    ).toBe(17);
  });

  it("merges DB rows on top of the env config (DB wins)", () => {
    const store = createSettingsStore(db);
    store.set("executeTimeoutMinutes", 42);
    const config = makeConfig({
      executeTimeoutMinutes: 17,
    } as unknown as Partial<AgentConfig>);
    const { persistedSettings } = loadPersistedSettings({ db, config });
    expect(persistedSettings.executeTimeoutMinutes).toBe(42);
    expect(
      (config as unknown as { executeTimeoutMinutes: number }).executeTimeoutMinutes,
    ).toBe(42);
  });

  it("returns a SettingsStore writing into the same DB", () => {
    const config = makeConfig();
    const { settingsStore } = loadPersistedSettings({ db, config });
    settingsStore.set("executeTimeoutMinutes", 99);
    expect(createSettingsStore(db).get("executeTimeoutMinutes")).toBe(99);
  });
});

// ── applyDelegatedTaskModeDefaultCorrection ──────────────────────────────────

describe("bootstrap/db applyDelegatedTaskModeDefaultCorrection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    db.close();
  });

  function run(args: {
    persisted: Record<string, unknown>;
    configFlag: boolean;
    delegatedKeys?: string[];
  }) {
    const config = makeConfig({
      delegatedTaskModeEnabled: args.configFlag,
    });
    const settingsStore = createSettingsStore(db);
    if ("delegatedTaskModeEnabled" in args.persisted) {
      settingsStore.set(
        "delegatedTaskModeEnabled",
        args.persisted.delegatedTaskModeEnabled as boolean,
      );
    }
    if (args.delegatedKeys && args.delegatedKeys.length > 0) {
      const now = new Date().toISOString();
      const update: Record<string, unknown> = {};
      for (const key of args.delegatedKeys) {
        update[key] = {
          mode: "delegated",
          delegatedBackend: "claude",
          deniedTools: [],
          lastChangedAt: now,
        };
      }
      writeIntegrations(db, update as never);
    }
    applyDelegatedTaskModeDefaultCorrection({
      db,
      config,
      settingsStore,
      persistedSettings: settingsStore.getAll(),
    });
    return { config, settingsStore };
  }

  it("flips the flag when: row absent, config false, ≥1 delegated integration", () => {
    const { config, settingsStore } = run({
      persisted: {},
      configFlag: false,
      delegatedKeys: ["gmail"],
    });
    expect(config.delegatedTaskModeEnabled).toBe(true);
    expect(settingsStore.get("delegatedTaskModeEnabled")).toBe(true);
  });

  it("does NOT flip when there are zero delegated integrations", () => {
    const { config, settingsStore } = run({
      persisted: {},
      configFlag: false,
      delegatedKeys: [],
    });
    expect(config.delegatedTaskModeEnabled).toBe(false);
    expect(settingsStore.get("delegatedTaskModeEnabled")).toBeNull();
  });

  it("does NOT flip when an explicit `false` is persisted (operator intent)", () => {
    const { config, settingsStore } = run({
      persisted: { delegatedTaskModeEnabled: false },
      configFlag: false,
      delegatedKeys: ["gmail", "github"],
    });
    expect(config.delegatedTaskModeEnabled).toBe(false);
    expect(settingsStore.get("delegatedTaskModeEnabled")).toBe(false);
  });

  it("is a no-op when the flag is already true on the config (cannot flip back to false)", () => {
    const { config, settingsStore } = run({
      persisted: {},
      configFlag: true,
      delegatedKeys: [],
    });
    expect(config.delegatedTaskModeEnabled).toBe(true);
    // Should not have written a row.
    expect(settingsStore.get("delegatedTaskModeEnabled")).toBeNull();
  });

  it("never flips a stored `true` back to false", () => {
    const { config, settingsStore } = run({
      persisted: { delegatedTaskModeEnabled: true },
      configFlag: true,
      delegatedKeys: [],
    });
    expect(config.delegatedTaskModeEnabled).toBe(true);
    expect(settingsStore.get("delegatedTaskModeEnabled")).toBe(true);
  });

  it("logs an error and leaves config unchanged when settingsStore.set throws", () => {
    const settingsStore = createSettingsStore(db);
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    } as never);
    const config = makeConfig({ delegatedTaskModeEnabled: false });
    const setSpy = vi
      .spyOn(settingsStore, "set")
      .mockImplementation(() => {
        throw new Error("simulated settings write failure");
      });
    expect(() =>
      applyDelegatedTaskModeDefaultCorrection({
        db,
        config,
        settingsStore,
        persistedSettings: {},
      }),
    ).not.toThrow();
    // The mutation line runs *after* the failing set call, so the
    // config flag should remain at its pre-call value. This pins the
    // contract that a failed persist does not leak a half-applied state
    // into the running process.
    expect(config.delegatedTaskModeEnabled).toBe(false);
    setSpy.mockRestore();
  });
});

// ── applySchema sanity / initDatabase end-to-end ─────────────────────────────

describe("bootstrap/db initDatabase", () => {
  let tmpDir: string;
  let priceFetcherSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aitne-bootstrap-db-"));
    // PriceFetcher.refresh() is fire-and-forget inside initDatabase and
    // ends with a SQL write to runtime_state. If we close the test DB
    // before that write lands, the unawaited promise throws an unhandled
    // rejection. Mock it to a resolved no-op so the factory's contract
    // (start the refresh, do not block on it) is preserved without any
    // network or DB tail.
    priceFetcherSpy = vi
      .spyOn(PriceFetcher.prototype, "refresh")
      .mockResolvedValue({
        source: "hardcoded",
        fetchedAt: null,
        lastAttemptAt: null,
        lastError: null,
        stale: true,
        sourceUrl: "https://example.invalid",
      } as never);
  });
  afterEach(() => {
    priceFetcherSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function configFor(): AgentConfig {
    return makeConfig({
      dataDir: tmpDir,
      workspaceDir: join(tmpDir, "workspace"),
    });
  }

  it("applies the schema such that idempotency holds (sanity check)", () => {
    const config = configFor();
    const { db } = initDatabase({ config });
    // Re-applying must not throw.
    expect(() => applySchema(db)).not.toThrow();
    db.close();
  });

  it("returns a populated result: db open, settingsStore usable, attachmentStore constructed", () => {
    const config = configFor();
    const result = initDatabase({ config });
    expect(result.db.open).toBe(true);
    expect(typeof result.settingsStore.get).toBe("function");
    expect(result.attachmentStore).toBeDefined();
    expect(result.persistedSettings).toEqual({});
    result.db.close();
  });

  it("preserves design §11 ordering — orphan dashboard_chat sessions are closed before the result is returned", () => {
    // Seed a separate DB at the expected path with an active orphan,
    // then run initDatabase against that same path. The factory must
    // have closed the row by the time we read it back.
    const config = configFor();
    // First boot to create the DB file at the canonical path.
    const seedRun = initDatabase({ config });
    insertDashboardChatSession(seedRun.db, {
      scopeKey: "orphan",
      status: "active",
    });
    seedRun.db.close();

    // Second boot — initDatabase should close the orphan as part of its run.
    const result = initDatabase({ config });
    const row = result.db
      .prepare(
        "SELECT status FROM conversation_sessions WHERE scope = 'dashboard_chat' AND scope_key = 'orphan'",
      )
      .get() as { status: string } | undefined;
    expect(row?.status).toBe("closed");
    result.db.close();
  });

  it("swallows and logs a seedGitProjectDocTemplates failure without aborting the run", () => {
    // `seedGitProjectDocTemplates` calls `mkdirSync(<dataDir>/templates,
    // { recursive: true })`. Pre-create a *file* at that path so the
    // mkdir call throws ENOTDIR (a regular file blocks directory
    // creation under the same name). This pins the design §7
    // "best-effort with try/catch" contract — a template-seed failure
    // must not abort initDatabase, since the daemon can still run with
    // bundled defaults.
    const config = configFor();
    // The factory will mkdir `<dataDir>/data/` for the DB file; we only
    // need to block the `<dataDir>/templates` path, leaving siblings
    // free for the rest of the boot.
    writeFileSync(join(config.dataDir, "templates"), "blocker");
    const result = initDatabase({ config });
    expect(result.db.open).toBe(true);
    // The factory must still finish wiring its downstream pieces.
    expect(typeof result.settingsStore.get).toBe("function");
    expect(result.attachmentStore).toBeDefined();
    result.db.close();
  });

  it("preserves design §11 ordering — delegated-mode integrations trigger the default-correction during the run", () => {
    const config = configFor();
    // Seed a delegated integration in the DB before initDatabase reads it.
    const seedRun = initDatabase({ config });
    writeIntegrations(seedRun.db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    } as never);
    // Pin the seed config to its post-run state and re-run — the
    // correction should fire because the settings row was never set.
    seedRun.db.close();

    const config2 = configFor();
    expect(config2.delegatedTaskModeEnabled).toBe(false);
    const result = initDatabase({ config: config2 });
    expect(config2.delegatedTaskModeEnabled).toBe(true);
    expect(result.settingsStore.get("delegatedTaskModeEnabled")).toBe(true);
    result.db.close();
  });

  // ── SCHEDULE_API_REDESIGN_PLAN §9 — legacy-model scan on boot ────────

  it("emits a schedule.legacy_model audit row for pre-Phase-D rows with model but no backend_id", () => {
    const config = configFor();
    // Seed once to create the DB, then mutate to inject a legacy-shaped row.
    const seedRun = initDatabase({ config });
    seedRun.db
      .prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'claude-opus-4-7', 'pending')`,
      )
      .run();
    // Also seed a recurring row with the legacy shape so both sources surface.
    seedRun.db
      .prepare(
        `INSERT INTO recurring_schedules (task_type, task_description, model, recurrence_rule, enabled)
         VALUES ('routine.x', 'desc', 'gpt-5.4', '{"frequency":"daily","time":"09:00"}', 1)`,
      )
      .run();
    seedRun.db.close();

    // Second boot — the scan fires and emits one audit row per legacy entry.
    const result = initDatabase({ config });
    const rows = result.db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type = 'schedule.legacy_model' ORDER BY id",
      )
      .all() as Array<{ detail: string }>;
    expect(rows.length).toBe(2);
    const details = rows.map((r) => JSON.parse(r.detail) as { table: string; model: string });
    expect(details).toEqual([
      expect.objectContaining({ table: "agent_schedule", model: "claude-opus-4-7" }),
      expect.objectContaining({ table: "recurring_schedules", model: "gpt-5.4" }),
    ]);
    result.db.close();
  });

  it("does not emit schedule.legacy_model rows when no legacy rows exist (steady-state idempotency)", () => {
    const config = configFor();
    const result = initDatabase({ config });
    const count = result.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_actions WHERE action_type = 'schedule.legacy_model'",
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
    result.db.close();
  });

  it("skips alias-shaped rows (model='sonnet'/'opus' is not legacy)", () => {
    const config = configFor();
    const seedRun = initDatabase({ config });
    seedRun.db
      .prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'sonnet', 'pending')`,
      )
      .run();
    seedRun.db.close();

    const result = initDatabase({ config });
    const count = result.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_actions WHERE action_type = 'schedule.legacy_model'",
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
    result.db.close();
  });
});
