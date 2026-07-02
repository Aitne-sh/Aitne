import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { applySchema } from "./schema.js";
import {
  runMigrations,
  MIGRATIONS,
  columnExists,
  tableExists,
  indexExists,
} from "./migrations.js";
import { createRecurringSchedule } from "./recurring-schedules.js";
import { loadAgents } from "../core/agents/loader.js";
import { buildAgentLoadOptions } from "../core/agents/loader-boot.js";
import type { AgentConfig } from "../config.js";

// AGENT_DEFINITIONS_IMPLEMENTATION_PLAN.md Phase 10 — the "upgrade-safety
// dry run" exit-criterion, encoded as a repeatable integration test rather
// than a one-off manual procedure (best practice; CLAUDE.md "Upgrade safety
// is non-negotiable").
//
// The migration RUNNER mechanics for `0007-agent-identity` (fresh no-op,
// bare-DB, pre-shape ALTER, half-apply, idempotency) are unit-tested in
// `migrations.test.ts`. THIS suite is the higher-level whole-boot check the
// plan calls for: take a realistically data-bearing PRE-0007 DB, run the
// real boot DB path (`applySchema` + `runMigrations(MIGRATIONS)`) followed
// by the Agent loader, and prove:
//   1. `0007-agent-identity` applies exactly once,
//   2. every built-in Agent loads + legacy recurring rows auto-import,
//   3. no pre-existing user data is lost,
//   4. a second boot is a total no-op (idempotent).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");

const BUILTIN_SLUGS = [
  "morning-routine",
  "evening-review",
  "weekly-review",
  "monthly-review",
  "activity-scan",
  "user-profile-sweep-morning",
  "user-profile-sweep-evening",
  "roadmap-maintenance",
  "lesson-maintenance",
  "context-index-reconcile",
  "skill-curation",
  "source-librarian",
].sort();

const MIGRATION_0007 = "0007-agent-identity";

interface SeededSnapshot {
  recurringId: number;
  counts: Record<string, number>;
}

const COUNTED_TABLES = [
  "recurring_schedules",
  "agent_schedule",
  "agent_actions",
  "settings",
  "runtime_state",
  "conversation_sessions",
  "messages",
];

function countRows(db: Database.Database, table: string): number {
  return (
    db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()
      ?.n ?? 0
  );
}

function snapshotCounts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED_TABLES) out[t] = countRows(db, t);
  return out;
}

/**
 * Build a realistic PRE-0007 DB: the full current schema with the three
 * `0007` deltas surgically reverted (agents / agent_executions tables
 * dropped, the `agent_actions.agent_id` column + its index removed), the
 * `schema_migrations` ledger pre-populated with every id that shipped BEFORE
 * `0007` (so a real upgrader's "already applied" history is reproduced), and
 * representative user data seeded across the durable tables.
 */
function buildPre0007Db(db: Database.Database): SeededSnapshot {
  applySchema(db);

  // ── seed durable user data while the schema is intact ──
  const recurring = createRecurringSchedule(db, {
    taskType: "agent.task",
    description: "Legacy daily inbox triage created on the pre-0007 release",
    prompt: "Triage the inbox and DM a digest",
    recurrenceRule: { frequency: "daily", time: "09:00", timezone: "UTC" },
  });
  db.prepare(
    "INSERT INTO conversation_sessions (platform, channel_id) VALUES (?, ?)",
  ).run("slack", "C-legacy");
  db.prepare(
    "INSERT INTO messages (session_id, role, content, platform) VALUES (?, ?, ?, ?)",
  ).run(1, "user", "legacy message that must survive the upgrade", "slack");
  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES (?, ?)",
  ).run("legacy.setting", '"keep-me"');
  db.prepare(
    "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
  ).run("legacy.state", "{}");

  // ── revert the 0007 delta → pre-migration shape ──
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE IF EXISTS agent_executions");
  db.exec("DROP TABLE IF EXISTS agents");
  db.exec("DROP INDEX IF EXISTS idx_agent_actions_agent");
  db.exec("ALTER TABLE agent_actions DROP COLUMN agent_id");
  db.pragma("foreign_keys = ON");

  // Legacy agent_actions row (written by the pre-0007 daemon, no agent_id).
  db.prepare(
    "INSERT INTO agent_actions (action_type, result, started_at) VALUES (?, ?, ?)",
  ).run("legacy.action", "success", "2026-05-01 00:00:00");

  // Reproduce the upgrader's migration ledger: everything before 0007 applied.
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const idx = MIGRATIONS.findIndex((m) => m.id === MIGRATION_0007);
  const priorIds = MIGRATIONS.slice(0, idx).map((m) => m.id);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (const id of priorIds) insert.run(id, "2026-05-01T00:00:00.000Z");

  return { recurringId: recurring.id, counts: snapshotCounts(db) };
}

function makeConfig(tmp: string): AgentConfig {
  return {
    workspaceDir: REPO_ROOT,
    dataDir: tmp,
    dayBoundaryHour: 4,
    timezone: "UTC",
  } as unknown as AgentConfig;
}

describe("upgrade safety — pre-0007 DB boots cleanly with no data loss", () => {
  let db: Database.Database;
  let tmp: string;
  let seeded: SeededSnapshot;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    tmp = mkdtempSync(join(tmpdir(), "agent-upgrade-"));
    // Deliberately DO NOT pre-create `context/policies/agents`. A genuine
    // pre-0007 upgrader has no such directory — it is a brand-new subdir this
    // feature introduces — so the boot path must survive its absence: the
    // loader's scan `existsSync`-guards a missing user root, and auto-import
    // recursively creates the chain when it writes the first `imported-<id>`
    // file. Pre-creating it here would mask exactly that upgrade-path branch
    // (and a regression that drops the `existsSync` guard would go uncaught).
    seeded = buildPre0007Db(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts from a genuine pre-0007 shape", () => {
    expect(tableExists(db, "agents")).toBe(false);
    expect(tableExists(db, "agent_executions")).toBe(false);
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(false);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(false);
    // A real upgrader has no `policies/agents` user-Agent root yet — the boot
    // path must create it, not assume it.
    expect(existsSync(join(tmp, "context", "policies", "agents"))).toBe(false);
    // Pre-existing user data is present.
    expect(countRows(db, "recurring_schedules")).toBe(1);
    expect(countRows(db, "agent_actions")).toBe(1);
  });

  it("first boot: 0007 applies once, schema reaches target, legacy data preserved", () => {
    // The real boot DB path: applySchema then runMigrations.
    applySchema(db);
    const result = runMigrations(db, { ctx: { dataDir: tmp, contextDir: join(tmp, "context") }, migrations: MIGRATIONS });

    // 0007 applied exactly once on this boot.
    expect(result.applied).toContain(MIGRATION_0007);
    expect(result.applied.filter((id) => id === MIGRATION_0007)).toHaveLength(1);

    // Target schema reached.
    expect(tableExists(db, "agents")).toBe(true);
    expect(tableExists(db, "agent_executions")).toBe(true);
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(true);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(true);

    // No data loss — every counted table is >= its pre-upgrade count.
    for (const t of COUNTED_TABLES) {
      expect(countRows(db, t)).toBeGreaterThanOrEqual(seeded.counts[t]);
    }
    // The legacy agent_actions row survived and carries a NULL stamp.
    const legacy = db
      .prepare<[], { action_type: string; agent_id: string | null }>(
        "SELECT action_type, agent_id FROM agent_actions WHERE action_type = 'legacy.action'",
      )
      .get();
    expect(legacy).toEqual({ action_type: "legacy.action", agent_id: null });
    // The legacy setting + recurring row are intact.
    expect(
      db
        .prepare<[], { value_json: string }>(
          "SELECT value_json FROM settings WHERE key = 'legacy.setting'",
        )
        .get()?.value_json,
    ).toBe('"keep-me"');
    expect(
      db
        .prepare<[number], { task_description: string }>(
          "SELECT task_description FROM recurring_schedules WHERE id = ?",
        )
        .get(seeded.recurringId)?.task_description,
    ).toContain("Legacy daily inbox triage");
  });

  it("first boot: the Agent loader installs every built-in and auto-imports the orphan recurring row", () => {
    applySchema(db);
    runMigrations(db, { ctx: { dataDir: tmp, contextDir: join(tmp, "context") }, migrations: MIGRATIONS });

    const result = loadAgents(db, buildAgentLoadOptions({ db, config: makeConfig(tmp) }));

    // Every built-in landed (from the real agent-assets/agents/*/agent.md).
    // The `agents` PK column `id` IS the slug (schema.ts: "id TEXT PRIMARY KEY").
    const builtinSlugs = db
      .prepare<[], { id: string }>(
        "SELECT id FROM agents WHERE source = 'builtin' ORDER BY id",
      )
      .all()
      .map((r) => r.id);
    expect(builtinSlugs).toEqual(BUILTIN_SLUGS);
    for (const slug of BUILTIN_SLUGS) expect(result.upserted).toContain(slug);

    // The loader created the `policies/agents` user root from scratch — it did
    // not exist on the pre-0007 upgrader (see beforeEach), so a surviving boot
    // proves the missing-dir branch (scan `existsSync` guard + auto-import's
    // recursive mkdir) holds end-to-end.
    expect(existsSync(join(tmp, "context", "policies", "agents"))).toBe(true);
    // The legacy orphan recurring row auto-imported into a user Agent (§6.5).
    const importedOwner = db
      .prepare<[number], { id: string; source: string }>(
        "SELECT id, source FROM agents WHERE recurring_schedule_id = ?",
      )
      .get(seeded.recurringId);
    expect(importedOwner).toBeTruthy();
    expect(importedOwner!.source).toBe("user");
    // The original recurring row still exists (auto-import does not consume it).
    expect(countRows(db, "recurring_schedules")).toBe(1);
  });

  it("second boot is idempotent: no migration re-applies, no Agent duplicates, data intact", () => {
    // First boot.
    applySchema(db);
    runMigrations(db, { ctx: { dataDir: tmp, contextDir: join(tmp, "context") }, migrations: MIGRATIONS });
    loadAgents(db, buildAgentLoadOptions({ db, config: makeConfig(tmp) }));

    const builtinCountAfterFirst = countRows(db, "agents");
    const recurringCountAfterFirst = countRows(db, "recurring_schedules");

    // Second boot — same sequence.
    applySchema(db);
    const rerun = runMigrations(db, { ctx: { dataDir: tmp, contextDir: join(tmp, "context") }, migrations: MIGRATIONS });
    loadAgents(db, buildAgentLoadOptions({ db, config: makeConfig(tmp) }));

    // No migration runs a second time.
    expect(rerun.applied).toEqual([]);
    // No duplicate Agents (built-ins re-found on disk, orphan already imported).
    expect(countRows(db, "agents")).toBe(builtinCountAfterFirst);
    expect(countRows(db, "recurring_schedules")).toBe(recurringCountAfterFirst);
    // Legacy data still present.
    expect(
      db
        .prepare<[], { value_json: string }>(
          "SELECT value_json FROM settings WHERE key = 'legacy.setting'",
        )
        .get()?.value_json,
    ).toBe('"keep-me"');
  });
});
