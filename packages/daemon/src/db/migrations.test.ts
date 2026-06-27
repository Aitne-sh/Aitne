import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  CONTEXT_VAULT_MIGRATION_ENTRY,
  MIGRATIONS,
  columnExists,
  indexExists,
  runMigrations,
  tableExists,
  type Migration,
} from "./migrations.js";
import { applySchema } from "./schema.js";

function openDb(): Database.Database {
  return new Database(":memory:");
}

/**
 * Build a temporary `MigrationContext` for tests that exercise the
 * production `MIGRATIONS` list. The 0004 context-vault-restructure
 * migration reads `dataDir` / `contextDir` and refuses to run without
 * them. For tests that don't care about the filesystem effect, an
 * empty temp dir keeps the body a no-op (no legacy paths to migrate).
 */
function tempMigrationCtx(): {
  ctx: { dataDir: string; contextDir: string };
  cleanup: () => void;
} {
  const baseDir = mkdtempSync(join(tmpdir(), "migrations-test-"));
  const dataDir = join(baseDir, "data");
  const contextDir = join(dataDir, "context");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(contextDir, { recursive: true });
  return {
    ctx: { dataDir, contextDir },
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

describe("runMigrations", () => {
  it("creates schema_migrations table and applies nothing when the list is empty", () => {
    const db = openDb();
    const result = runMigrations(db, []);
    expect(result.applied).toEqual([]);
    expect(tableExists(db, "schema_migrations")).toBe(true);
  });

  it("applies a pending migration once and records it", () => {
    const db = openDb();
    let upCalls = 0;
    const migration: Migration = {
      id: "0001-test",
      description: "Creates a test table",
      up(target) {
        upCalls += 1;
        target.exec(
          "CREATE TABLE test_thing (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
        );
      },
    };
    const first = runMigrations(db, [migration]);
    expect(first.applied).toEqual(["0001-test"]);
    expect(upCalls).toBe(1);
    expect(tableExists(db, "test_thing")).toBe(true);

    const recorded = db
      .prepare<[], { id: string; applied_at: string }>(
        "SELECT id, applied_at FROM schema_migrations",
      )
      .all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].id).toBe("0001-test");
    expect(recorded[0].applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const second = runMigrations(db, [migration]);
    expect(second.applied).toEqual([]);
    expect(upCalls).toBe(1);
  });

  it("CONTEXT_VAULT_MIGRATION_ENTRY.up throws when no MigrationContext is supplied", () => {
    const db = openDb();
    expect(() => CONTEXT_VAULT_MIGRATION_ENTRY.up(db)).toThrow(
      /requires MigrationContext/,
    );
  });

  it("applies multiple migrations in array order", () => {
    const db = openDb();
    const order: string[] = [];
    const a: Migration = {
      id: "0001-a",
      description: "First",
      up() {
        order.push("a");
      },
    };
    const b: Migration = {
      id: "0002-b",
      description: "Second",
      up() {
        order.push("b");
      },
    };
    const result = runMigrations(db, [a, b]);
    expect(result.applied).toEqual(["0001-a", "0002-b"]);
    expect(order).toEqual(["a", "b"]);
  });

  it("rolls back a failing migration and rethrows, without recording it", () => {
    const db = openDb();
    const failing: Migration = {
      id: "0001-bad",
      description: "Throws inside up",
      up(target) {
        target.exec("CREATE TABLE partial (id INTEGER PRIMARY KEY)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [failing])).toThrow(/boom/);
    expect(tableExists(db, "partial")).toBe(false);
    const recorded = db
      .prepare<[], { id: string }>("SELECT id FROM schema_migrations")
      .all();
    expect(recorded).toEqual([]);
  });

  it("uses the production MIGRATIONS list when no override is passed", () => {
    const db = openDb();
    const { ctx, cleanup } = tempMigrationCtx();
    try {
      const result = runMigrations(db, { ctx });
      expect(result.applied).toEqual([...MIGRATIONS].map((m) => m.id));
    } finally {
      cleanup();
    }
  });
});

// BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — peer test for the
// `0001-browser-pending-offers-add-offered-kind` migration, per the
// CLAUDE.md release-status §4: every non-additive migration needs a
// test covering (a) fresh-DB no-op + applied id recorded, (b) pre-
// migration-shape ALTER applies, (c) re-run idempotent.
describe("0001-browser-pending-offers-add-offered-kind", () => {
  // Pick the migration from MIGRATIONS by id so we test the production
  // entry, not a parallel copy.
  const migration = MIGRATIONS.find(
    (m) => m.id === "0001-browser-pending-offers-add-offered-kind",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op on a fresh DB where applySchema produced the wider CHECK constraint", () => {
    const db = openDb();
    // Fresh-DB shape: wider CHECK constraint already present.
    db.exec(`
      CREATE TABLE browser_pending_offers (
        slug TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('offered', 'research_assist', 'wiki_summary')),
        offered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (slug, kind)
      );
      INSERT INTO browser_pending_offers VALUES ('quantum', 'offered', 0, 9999999999999);
    `);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0001-browser-pending-offers-add-offered-kind",
    ]);
    // Row survived (no-op rebuild) — pre-existing offered row still there.
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM browser_pending_offers")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rebuilds the table on a pre-migration-shape DB and preserves existing rows", () => {
    const db = openDb();
    // P3b shape: narrower CHECK constraint without 'offered'.
    db.exec(`
      CREATE TABLE browser_pending_offers (
        slug TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('research_assist', 'wiki_summary')),
        offered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (slug, kind)
      );
      INSERT INTO browser_pending_offers VALUES ('legacy-cluster', 'research_assist', 100, 9999999999999);
      INSERT INTO browser_pending_offers VALUES ('legacy-wiki', 'wiki_summary', 200, 9999999999999);
    `);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0001-browser-pending-offers-add-offered-kind",
    ]);
    // Rows preserved.
    const rows = db
      .prepare(
        "SELECT slug, kind, offered_at, expires_at FROM browser_pending_offers ORDER BY slug",
      )
      .all() as Array<{ slug: string; kind: string }>;
    expect(rows.map((r) => `${r.slug}/${r.kind}`)).toEqual([
      "legacy-cluster/research_assist",
      "legacy-wiki/wiki_summary",
    ]);
    // New 'offered' kind now accepted.
    db.prepare(
      "INSERT INTO browser_pending_offers VALUES ('new-cluster', 'offered', 300, 9999999999999)",
    ).run();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM browser_pending_offers")
      .get() as { n: number };
    expect(count.n).toBe(3);
  });

  it("is idempotent — re-running does not duplicate or modify the table", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_pending_offers (
        slug TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('research_assist', 'wiki_summary')),
        offered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (slug, kind)
      );
    `);
    runMigrations(db, [migration!]);
    // schema_migrations now has the id; re-running picks up nothing new.
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
  });
});

// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN Phase B-3 — peer test for the
// `0002-browser-automation-workflows-b3-outcomes` migration. Mirrors
// the shape of the §0001 peer test above per CLAUDE.md §4: covers
// fresh-DB no-op, pre-migration-shape ALTER, idempotency.
describe("0002-browser-automation-workflows-b3-outcomes", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0002-browser-automation-workflows-b3-outcomes",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when the wider B-3 CHECK constraint is already present", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_automation_workflows (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id       TEXT NOT NULL UNIQUE,
        workflow_name     TEXT NOT NULL,
        params_hash       TEXT NOT NULL,
        target_urls       TEXT NOT NULL,
        blocked_requests  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (
            'success', 'unknown_workflow', 'input_validation_error',
            'output_validation_error', 'url_not_allowlisted',
            'user_allowlist_blocked', 'host_not_extractable',
            'rate_limited', 'site_not_connected',
            'playwright_launch_timeout', 'playwright_error', 'timeout',
            'needs_approval', 'approval_expired',
            'approval_token_invalid', 'payment_path_blocked'
        )),
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER NOT NULL,
        screenshot_path   TEXT,
        trace_path        TEXT
      );
    `);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0002-browser-automation-workflows-b3-outcomes",
    ]);
    // New B-3 outcome inserts successfully.
    db.prepare(
      `INSERT INTO browser_automation_workflows
         (workflow_id, workflow_name, params_hash, target_urls,
          blocked_requests, duration_ms, outcome,
          started_at, finished_at)
        VALUES ('aaa', 'wf', 'h', '[]', '[]', 1, 'needs_approval', 1, 2)`,
    ).run();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM browser_automation_workflows")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rebuilds the table on a pre-B-3 narrower CHECK and preserves existing rows", () => {
    const db = openDb();
    // Pre-B-3 narrower CHECK — no needs_approval / approval_* / payment.
    db.exec(`
      CREATE TABLE browser_automation_workflows (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id       TEXT NOT NULL UNIQUE,
        workflow_name     TEXT NOT NULL,
        params_hash       TEXT NOT NULL,
        target_urls       TEXT NOT NULL,
        blocked_requests  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (
            'success', 'unknown_workflow', 'input_validation_error',
            'output_validation_error', 'url_not_allowlisted',
            'user_allowlist_blocked', 'host_not_extractable',
            'rate_limited', 'site_not_connected',
            'playwright_launch_timeout', 'playwright_error', 'timeout'
        )),
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER NOT NULL,
        screenshot_path   TEXT,
        trace_path        TEXT
      );
      INSERT INTO browser_automation_workflows
        (workflow_id, workflow_name, params_hash, target_urls,
         blocked_requests, duration_ms, outcome,
         started_at, finished_at)
        VALUES ('legacy', 'wf', 'h', '[]', '[]', 1, 'success', 1, 2);
    `);
    runMigrations(db, [migration!]);
    // Legacy row preserved.
    const rows = db
      .prepare(
        "SELECT workflow_id, outcome FROM browser_automation_workflows ORDER BY id",
      )
      .all() as Array<{ workflow_id: string; outcome: string }>;
    expect(rows).toEqual([{ workflow_id: "legacy", outcome: "success" }]);
    // New B-3 outcome now accepted.
    db.prepare(
      `INSERT INTO browser_automation_workflows
         (workflow_id, workflow_name, params_hash, target_urls,
          blocked_requests, duration_ms, outcome,
          started_at, finished_at)
        VALUES ('new', 'wf', 'h', '[]', '[]', 1, 'payment_path_blocked', 1, 2)`,
    ).run();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM browser_automation_workflows")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("is idempotent — re-running does not re-apply the migration", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_automation_workflows (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id       TEXT NOT NULL UNIQUE,
        workflow_name     TEXT NOT NULL,
        params_hash       TEXT NOT NULL,
        target_urls       TEXT NOT NULL,
        blocked_requests  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (
            'success', 'unknown_workflow', 'input_validation_error',
            'output_validation_error', 'url_not_allowlisted',
            'user_allowlist_blocked', 'host_not_extractable',
            'rate_limited', 'site_not_connected',
            'playwright_launch_timeout', 'playwright_error', 'timeout'
        )),
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER NOT NULL,
        screenshot_path   TEXT,
        trace_path        TEXT
      );
    `);
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
  });
});

// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN Phase B-4 — peer test for the
// `0003-browser-automation-workflows-b4-outcomes` migration. Mirrors
// the shape of the §0002 peer test above per CLAUDE.md §4: covers
// the no-table no-op, fresh-DB no-op (B-4 statuses already in
// sqlite_master), pre-migration-shape rebuild that preserves rows
// and widens the CHECK, and idempotency.
describe("0003-browser-automation-workflows-b4-outcomes", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0003-browser-automation-workflows-b4-outcomes",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when the browser_automation_workflows table does not exist", () => {
    // A DB that has never seen any browser-automation work — the
    // migration must skip cleanly without creating the table itself
    // (schema.ts is responsible for that on first boot).
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0003-browser-automation-workflows-b4-outcomes",
    ]);
    expect(tableExists(db, "browser_automation_workflows")).toBe(false);
  });

  it("is a no-op when the B-4 widened CHECK is already present (fresh-DB shape)", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_automation_workflows (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id       TEXT NOT NULL UNIQUE,
        workflow_name     TEXT NOT NULL,
        params_hash       TEXT NOT NULL,
        target_urls       TEXT NOT NULL,
        blocked_requests  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (
            'success', 'unknown_workflow', 'input_validation_error',
            'output_validation_error', 'url_not_allowlisted',
            'user_allowlist_blocked', 'host_not_extractable',
            'rate_limited', 'site_not_connected',
            'playwright_launch_timeout', 'playwright_error', 'timeout',
            'needs_approval', 'approval_expired',
            'approval_token_invalid', 'payment_path_blocked',
            'purchase_b4_disabled', 'purchase_site_not_enabled',
            'purchase_pending_exists', 'purchase_daily_cap_exceeded'
        )),
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER NOT NULL,
        screenshot_path   TEXT,
        trace_path        TEXT
      );
    `);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0003-browser-automation-workflows-b4-outcomes",
    ]);
    // The migration short-circuited on the `purchase_b4_disabled` marker —
    // a B-4 outcome inserts successfully without a rebuild having run.
    db.prepare(
      `INSERT INTO browser_automation_workflows
         (workflow_id, workflow_name, params_hash, target_urls,
          blocked_requests, duration_ms, outcome,
          started_at, finished_at)
        VALUES ('a', 'wf', 'h', '[]', '[]', 1, 'purchase_b4_disabled', 1, 2)`,
    ).run();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM browser_automation_workflows")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rebuilds the table on a pre-B-4 (B-3) CHECK and preserves existing rows", () => {
    const db = openDb();
    // Pre-B-4 CHECK — has the B-3 widening but not the B-4 statuses.
    db.exec(`
      CREATE TABLE browser_automation_workflows (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id       TEXT NOT NULL UNIQUE,
        workflow_name     TEXT NOT NULL,
        params_hash       TEXT NOT NULL,
        target_urls       TEXT NOT NULL,
        blocked_requests  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (
            'success', 'unknown_workflow', 'input_validation_error',
            'output_validation_error', 'url_not_allowlisted',
            'user_allowlist_blocked', 'host_not_extractable',
            'rate_limited', 'site_not_connected',
            'playwright_launch_timeout', 'playwright_error', 'timeout',
            'needs_approval', 'approval_expired',
            'approval_token_invalid', 'payment_path_blocked'
        )),
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER NOT NULL,
        screenshot_path   TEXT,
        trace_path        TEXT
      );
      INSERT INTO browser_automation_workflows
        (workflow_id, workflow_name, params_hash, target_urls,
         blocked_requests, duration_ms, outcome,
         started_at, finished_at)
        VALUES ('legacy', 'wf', 'h', '[]', '[]', 1, 'needs_approval', 1, 2);
    `);
    // A pre-B-4 row with a B-4-only outcome must be rejected by the
    // pre-migration CHECK — this proves we are starting from the
    // narrower shape.
    expect(() =>
      db.prepare(
        `INSERT INTO browser_automation_workflows
           (workflow_id, workflow_name, params_hash, target_urls,
            blocked_requests, duration_ms, outcome,
            started_at, finished_at)
          VALUES ('rejected', 'wf', 'h', '[]', '[]', 1, 'purchase_b4_disabled', 1, 2)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);

    runMigrations(db, [migration!]);

    // Legacy row preserved by the table rebuild.
    const rows = db
      .prepare(
        "SELECT workflow_id, outcome FROM browser_automation_workflows ORDER BY id",
      )
      .all() as Array<{ workflow_id: string; outcome: string }>;
    expect(rows).toEqual([{ workflow_id: "legacy", outcome: "needs_approval" }]);

    // Every B-4 status is now accepted by the widened CHECK.
    for (const outcome of [
      "purchase_b4_disabled",
      "purchase_site_not_enabled",
      "purchase_pending_exists",
      "purchase_daily_cap_exceeded",
    ]) {
      db.prepare(
        `INSERT INTO browser_automation_workflows
           (workflow_id, workflow_name, params_hash, target_urls,
            blocked_requests, duration_ms, outcome,
            started_at, finished_at)
          VALUES (?, 'wf', 'h', '[]', '[]', 1, ?, 1, 2)`,
      ).run(`new-${outcome}`, outcome);
    }
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM browser_automation_workflows")
      .get() as { n: number };
    expect(count.n).toBe(5);

    // The supporting indexes survive the rebuild.
    expect(indexExists(db, "idx_browser_automation_workflows_started_at"))
      .toBe(true);
    expect(indexExists(db, "idx_browser_automation_workflows_name")).toBe(true);
  });

  it("is idempotent — re-running does not re-apply the migration", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_automation_workflows (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id       TEXT NOT NULL UNIQUE,
        workflow_name     TEXT NOT NULL,
        params_hash       TEXT NOT NULL,
        target_urls       TEXT NOT NULL,
        blocked_requests  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN (
            'success', 'unknown_workflow', 'input_validation_error',
            'output_validation_error', 'url_not_allowlisted',
            'user_allowlist_blocked', 'host_not_extractable',
            'rate_limited', 'site_not_connected',
            'playwright_launch_timeout', 'playwright_error', 'timeout',
            'needs_approval', 'approval_expired',
            'approval_token_invalid', 'payment_path_blocked'
        )),
        started_at        INTEGER NOT NULL,
        finished_at       INTEGER NOT NULL,
        screenshot_path   TEXT,
        trace_path        TEXT
      );
    `);
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
  });
});

// BROWSER_TASK_REDESIGN_PLAN.md §6.8 / Phase 6 — peer test for the
// `0004-drop-browser-automation-approvals` migration. Mirrors CLAUDE.md
// non-negotiable #4: fresh DB → no-op + id recorded; pre-migration-
// shape DB → DROP runs + id recorded; re-run on the dropped state →
// no second drop.
describe("0004-drop-browser-automation-approvals", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0004-drop-browser-automation-approvals",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when the browser_automation_approvals table does not exist (fresh DB)", () => {
    // A fresh install no longer materialises the table from schema.ts
    // (Phase 6 dropped the CREATE TABLE stanza). The migration body
    // short-circuits on `!tableExists`; the runner still records the
    // id so a subsequent boot doesn't re-evaluate.
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0004-drop-browser-automation-approvals",
    ]);
    expect(tableExists(db, "browser_automation_approvals")).toBe(false);
    // schema_migrations row landed.
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0004-drop-browser-automation-approvals");
    expect(recorded).toEqual({ id: "0004-drop-browser-automation-approvals" });
  });

  it("drops the table on an upgrading install that still carries it (pre-migration shape)", () => {
    // Re-materialise the legacy shape — same CREATE the retired
    // `schema.ts` stanza used — then run the migration. The body must
    // drop the table without disturbing surrounding objects.
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_automation_approvals (
        id              TEXT PRIMARY KEY,
        workflow_name   TEXT NOT NULL,
        params_hash     TEXT NOT NULL,
        params_summary  TEXT NOT NULL,
        origin          TEXT NOT NULL CHECK (origin IN ('agent', 'dashboard', 'schedule')),
        status          TEXT NOT NULL CHECK (status IN (
            'pending', 'approved', 'consumed', 'denied', 'expired'
        )),
        requested_at    INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        token_hash      TEXT,
        approved_at     INTEGER,
        consumed_at     INTEGER,
        denied_at       INTEGER,
        denial_reason   TEXT
      );
      CREATE INDEX idx_browser_automation_approvals_status
        ON browser_automation_approvals(status, requested_at DESC);
      CREATE INDEX idx_browser_automation_approvals_token_hash
        ON browser_automation_approvals(token_hash)
        WHERE token_hash IS NOT NULL;
      INSERT INTO browser_automation_approvals
        (id, workflow_name, params_hash, params_summary, origin, status,
         requested_at, expires_at)
        VALUES ('row-1', 'legacy_workflow', 'h', '{}', 'agent',
                'consumed', 1, 2);
    `);
    expect(tableExists(db, "browser_automation_approvals")).toBe(true);

    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0004-drop-browser-automation-approvals",
    ]);
    expect(tableExists(db, "browser_automation_approvals")).toBe(false);
    // Indexes go with the table — SQLite's DROP TABLE cascades.
    expect(indexExists(db, "idx_browser_automation_approvals_status")).toBe(
      false,
    );
    expect(indexExists(db, "idx_browser_automation_approvals_token_hash")).toBe(
      false,
    );
  });

  it("is idempotent — re-running on the dropped state does not re-apply", () => {
    // Same path as the fresh-DB case: the first call records the id;
    // the second call finds the id in `schema_migrations` and skips
    // the body. The table never reappears.
    const db = openDb();
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    expect(tableExists(db, "browser_automation_approvals")).toBe(false);
  });
});

// BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6.5 dead-code rip-out. Same
// CLAUDE.md non-negotiable #4 contract as the 0004 peer test above:
// fresh DB → no-op + id recorded; pre-migration-shape DB → DROP runs +
// id recorded; re-run on the dropped state → no second drop.
describe("0005-drop-browser-automation-allowlist", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0005-drop-browser-automation-allowlist",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when the browser_automation_allowlist table does not exist (fresh DB)", () => {
    // Fresh installs no longer materialise the table from schema.ts
    // (Phase 6.5 dropped the CREATE stanza). The migration body short-
    // circuits on `!tableExists`; the runner still records the id so a
    // subsequent boot doesn't re-evaluate.
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0005-drop-browser-automation-allowlist",
    ]);
    expect(tableExists(db, "browser_automation_allowlist")).toBe(false);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0005-drop-browser-automation-allowlist");
    expect(recorded).toEqual({
      id: "0005-drop-browser-automation-allowlist",
    });
  });

  it("drops the table on an upgrading install that still carries it (pre-migration shape)", () => {
    // Re-materialise the legacy shape — same CREATE the retired
    // `schema.ts` stanza used — then run the migration. The body must
    // drop the table without disturbing surrounding objects.
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_automation_allowlist (
        domain     TEXT PRIMARY KEY,
        mode       TEXT NOT NULL CHECK (mode IN ('read', 'denied')),
        added_at   INTEGER NOT NULL,
        added_by   TEXT NOT NULL CHECK (added_by IN ('user', 'system'))
      );
      INSERT INTO browser_automation_allowlist
        (domain, mode, added_at, added_by)
        VALUES ('example.com', 'read', 1, 'user');
    `);
    expect(tableExists(db, "browser_automation_allowlist")).toBe(true);

    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0005-drop-browser-automation-allowlist",
    ]);
    expect(tableExists(db, "browser_automation_allowlist")).toBe(false);
  });

  it("is idempotent — re-running on the dropped state does not re-apply", () => {
    const db = openDb();
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    expect(tableExists(db, "browser_automation_allowlist")).toBe(false);
  });
});

// `0006-message-dm-budget-bump` — same CLAUDE.md non-negotiable #4
// contract: fresh DB (no table) → no-op + id recorded; pre-migration
// preset-default row at $1.00 → bumped to $5.00 + id recorded;
// operator-pinned ('user') or already-custom rows → untouched; re-run
// → no second bump. Mirrors the "bump a default without clobbering
// operator overrides" pattern.
describe("0006-message-dm-budget-bump", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0006-message-dm-budget-bump",
  );

  function seedProcessConfigTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE process_backend_config (
        process_key    TEXT PRIMARY KEY,
        main_backend   TEXT NOT NULL,
        main_model     TEXT NOT NULL,
        max_turns      INTEGER NOT NULL,
        max_budget_usd REAL NOT NULL,
        updated_by     TEXT NOT NULL
      );
    `);
  }

  function insertRow(
    db: Database.Database,
    processKey: string,
    maxBudgetUsd: number,
    updatedBy: string,
    backend = "claude",
  ): void {
    db.prepare(
      `INSERT INTO process_backend_config
         (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
       VALUES (?, ?, 'seed-model', 50, ?, ?)`,
    ).run(processKey, backend, maxBudgetUsd, updatedBy);
  }

  function budgetOf(db: Database.Database, processKey: string): number {
    return (
      db
        .prepare<[string], { max_budget_usd: number }>(
          "SELECT max_budget_usd FROM process_backend_config WHERE process_key = ?",
        )
        .get(processKey) as { max_budget_usd: number }
    ).max_budget_usd;
  }

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when process_backend_config does not exist (fresh/empty DB)", () => {
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0006-message-dm-budget-bump"]);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0006-message-dm-budget-bump");
    expect(recorded).toEqual({ id: "0006-message-dm-budget-bump" });
  });

  it("is a no-op on a fresh install where the seed already wrote the new $5.00", () => {
    // Real fresh installs run applySchema (which now seeds message.dm at
    // $5.00) BEFORE the migration runner. The band gate must recognise
    // $5.00 as already-migrated and leave it alone — no double-touch.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 5.0, "preset", "claude");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(5.0);
  });

  it("bumps a claude preset-default message.dm row from $1.00 to $5.00", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.0, "preset", "claude");
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0006-message-dm-budget-bump"]);
    expect(budgetOf(db, "message.dm")).toBe(5.0);
  });

  it("bumps an opencode preset-default message.dm row from $1.00 to $5.00", () => {
    // opencode rides the Anthropic SDK — post-hoc factor 1, so its old
    // and new defaults match claude (no scaling).
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.0, "preset", "opencode");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(5.0);
  });

  it("bumps a codex preset row from the scaled $1.50 to $7.50", () => {
    // applyDefaultPresets stores the post-hoc-scaled budget — codex
    // medium x1.5 → message.dm was seeded at $1.50, not $1.00. The
    // migration must recognise that as the old default and lift it to
    // the scaled new default ($5.00 x 1.5 = $7.50), NOT $5.00.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.5, "preset", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(7.5);
  });

  it("bumps a gemini preset row from the scaled $1.50 to $7.50", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.5, "preset", "gemini");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(7.5);
  });

  it("does not bump a codex preset row sitting at the claude $1.00 band", () => {
    // Defensive: a codex row should only be lifted from its own scaled
    // old default ($1.50). A codex row at $1.00 is not a recognised old
    // default (it would be an operator oddity), so leave it untouched
    // rather than guessing.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.0, "preset", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(1.0);
  });

  it("leaves a codex operator-pinned ('user') row untouched even at $1.50", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.5, "user", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(1.5);
  });

  it("leaves operator-pinned ('user') rows untouched even at $1.00", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.0, "user");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(1.0);
  });

  it("leaves a preset row already at a custom value untouched", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 2.5, "preset");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.dm")).toBe(2.5);
  });

  it("does not touch sibling conversational rows (message.mention)", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.mention", 1.0, "preset");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "message.mention")).toBe(1.0);
  });

  it("is idempotent — re-running does not bump again", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "message.dm", 1.0, "preset");
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    expect(budgetOf(db, "message.dm")).toBe(5.0);
  });
});

// `0009-today-refresh-budget-bump` — same CLAUDE.md non-negotiable #4
// contract as 0006: fresh DB (no table) → no-op + id recorded; fresh
// install already seeded at the new $0.50 → untouched; pre-migration
// preset-default row at $0.30 (claude/opencode) or $0.45 (codex/gemini
// scaled) → bumped to $0.50 / $0.75 + id recorded; operator-pinned
// ('user') or already-custom rows → untouched; re-run → no second bump.
describe("0009-today-refresh-budget-bump", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0009-today-refresh-budget-bump",
  );

  function seedProcessConfigTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE process_backend_config (
        process_key    TEXT PRIMARY KEY,
        main_backend   TEXT NOT NULL,
        main_model     TEXT NOT NULL,
        max_turns      INTEGER NOT NULL,
        max_budget_usd REAL NOT NULL,
        updated_by     TEXT NOT NULL
      );
    `);
  }

  function insertRow(
    db: Database.Database,
    processKey: string,
    maxBudgetUsd: number,
    updatedBy: string,
    backend = "claude",
  ): void {
    db.prepare(
      `INSERT INTO process_backend_config
         (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
       VALUES (?, ?, 'seed-model', 20, ?, ?)`,
    ).run(processKey, backend, maxBudgetUsd, updatedBy);
  }

  function budgetOf(db: Database.Database, processKey: string): number {
    return (
      db
        .prepare<[string], { max_budget_usd: number }>(
          "SELECT max_budget_usd FROM process_backend_config WHERE process_key = ?",
        )
        .get(processKey) as { max_budget_usd: number }
    ).max_budget_usd;
  }

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when process_backend_config does not exist (fresh/empty DB)", () => {
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0009-today-refresh-budget-bump"]);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0009-today-refresh-budget-bump");
    expect(recorded).toEqual({ id: "0009-today-refresh-budget-bump" });
  });

  it("is a no-op on a fresh install where the seed already wrote the new $0.50", () => {
    // Real fresh installs run applySchema (which now seeds today_refresh at
    // $0.50) BEFORE the migration runner. The band gate must recognise
    // $0.50 as already-migrated and leave it alone — no double-touch.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.5, "preset", "claude");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.5);
  });

  it("bumps a claude preset-default today_refresh row from $0.30 to $0.50", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.3, "preset", "claude");
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0009-today-refresh-budget-bump"]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.5);
  });

  it("bumps an opencode preset-default today_refresh row from $0.30 to $0.50", () => {
    // opencode rides the Anthropic SDK — post-hoc factor 1, so its old and
    // new defaults match claude (no scaling).
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.3, "preset", "opencode");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.5);
  });

  it("bumps a codex preset row from the scaled $0.45 to $0.75", () => {
    // applyDefaultPresets stores the post-hoc-scaled budget — codex medium
    // x1.5 → today_refresh was seeded at $0.45, not $0.30. The migration
    // must recognise that as the old default and lift it to the scaled new
    // default ($0.50 x 1.5 = $0.75), NOT $0.50.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.45, "preset", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.75);
  });

  it("bumps a gemini preset row from the scaled $0.45 to $0.75", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.45, "preset", "gemini");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.75);
  });

  it("does not bump a codex preset row sitting at the claude $0.30 band", () => {
    // Defensive: a codex row should only be lifted from its own scaled old
    // default ($0.45). A codex row at $0.30 is not a recognised old default
    // (it would be an operator oddity), so leave it untouched.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.3, "preset", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.3);
  });

  it("leaves a codex operator-pinned ('user') row untouched even at $0.45", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.45, "user", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.45);
  });

  it("leaves operator-pinned ('user') rows untouched even at $0.30", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.3, "user");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.3);
  });

  it("leaves a preset row already at a custom value untouched", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 1.0, "preset");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(1.0);
  });

  it("does not touch sibling routine rows (routine.morning_routine_journal)", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.morning_routine_journal", 0.3, "preset");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.morning_routine_journal")).toBe(0.3);
  });

  it("is idempotent — re-running does not bump again", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.today_refresh", 0.3, "preset");
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    expect(budgetOf(db, "routine.today_refresh")).toBe(0.5);
  });
});

// AGENT_DEFINITIONS_DESIGN.md §5 — peer test for the `0007-agent-identity`
// migration. The two new tables (agents / agent_executions) are created by
// applySchema, so the migration body carries ONLY the agent_actions ALTER +
// index. Same CLAUDE.md non-negotiable #4 contract: fresh DB (applySchema) →
// no-op + id recorded; no-table DB → no-op + id recorded; pre-migration-shape
// DB (agent_actions sans agent_id) → ALTER + index applied + id recorded;
// re-run → no second apply.
describe("0007-agent-identity", () => {
  const migration = MIGRATIONS.find((m) => m.id === "0007-agent-identity");

  // Minimal pre-migration shape: agent_actions as it stood BEFORE this
  // migration — no agent_id column, no idx_agent_actions_agent index.
  function seedLegacyAgentActions(db: Database.Database): void {
    db.exec(`
      CREATE TABLE agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        result TEXT,
        detail JSON,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );
      INSERT INTO agent_actions (action_type, result, started_at)
        VALUES ('legacy.action', 'success', '2026-05-01 00:00:00');
    `);
  }

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("on a fresh DB: ALTER is skipped (column from CREATE body) but the index branch creates the index", () => {
    const db = openDb();
    applySchema(db);
    // applySchema creates the two new tables + the agent_id column (CREATE
    // body) — but NOT the idx_agent_actions_agent index. That index is
    // migration-owned: creating it in applySchema would throw on a pre-0007
    // upgrader whose agent_actions predates the column, since applySchema runs
    // before runMigrations (see schema.ts note + upgrade-safety.test.ts).
    expect(tableExists(db, "agents")).toBe(true);
    expect(tableExists(db, "agent_executions")).toBe(true);
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(true);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(false);

    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0007-agent-identity"]);
    // Column was already present (ALTER skipped); the index branch ran.
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(true);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(true);
  });

  it("is a no-op when agent_actions does not exist (bare DB)", () => {
    // The runner's own "production MIGRATIONS list" test runs against a bare
    // :memory: DB with no agent_actions; the body must short-circuit on the
    // missing table rather than throwing on the ALTER (columnExists returns
    // false for a missing table). The id is still recorded.
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0007-agent-identity"]);
    expect(tableExists(db, "agent_actions")).toBe(false);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0007-agent-identity");
    expect(recorded).toEqual({ id: "0007-agent-identity" });
  });

  it("adds the agent_id column + index on a pre-migration-shape DB and preserves rows", () => {
    const db = openDb();
    seedLegacyAgentActions(db);
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(false);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(false);

    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0007-agent-identity"]);
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(true);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(true);

    // Legacy row preserved with a NULL agent_id stamp.
    const legacy = db
      .prepare<[], { action_type: string; agent_id: string | null }>(
        "SELECT action_type, agent_id FROM agent_actions ORDER BY id",
      )
      .all();
    expect(legacy).toEqual([{ action_type: "legacy.action", agent_id: null }]);

    // New rows can now carry the stamp.
    db.prepare(
      "INSERT INTO agent_actions (action_type, agent_id) VALUES (?, ?)",
    ).run("agent.action", "morning-routine");
    const stamped = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM agent_actions WHERE agent_id = ?",
      )
      .get("morning-routine");
    expect(stamped).toEqual({ n: 1 });
  });

  it("adds only the missing half when the column exists but the index does not", () => {
    // Defensive: an install whose agent_id column landed via a hand-rolled
    // ALTER but never got the index. The body must create the index without
    // re-ALTERing (which SQLite would reject as a duplicate column).
    const db = openDb();
    seedLegacyAgentActions(db);
    db.exec("ALTER TABLE agent_actions ADD COLUMN agent_id TEXT");
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(true);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(false);

    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0007-agent-identity"]);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(true);
  });

  it("is idempotent — re-running does not re-apply", () => {
    const db = openDb();
    seedLegacyAgentActions(db);
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    // Column + index still present after the no-op second run.
    expect(columnExists(db, "agent_actions", "agent_id")).toBe(true);
    expect(indexExists(db, "idx_agent_actions_agent")).toBe(true);
  });
});

// schedule prompt-required rework — peer test for the
// `0008-agent-schedule-backfill-task-prompt` migration. CLAUDE.md
// non-negotiable #4: fresh DB (applySchema) → no-op + id recorded; no-table
// DB → no-op + id recorded; pre-migration-shape DB (a pending row with NULL
// task_prompt) → backfilled from task_description + id recorded; re-run → no
// second apply.
describe("0008-agent-schedule-backfill-task-prompt", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0008-agent-schedule-backfill-task-prompt",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op on a fresh DB (applySchema) — empty table, id recorded", () => {
    const db = openDb();
    applySchema(db);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0008-agent-schedule-backfill-task-prompt",
    ]);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0008-agent-schedule-backfill-task-prompt");
    expect(recorded).toEqual({
      id: "0008-agent-schedule-backfill-task-prompt",
    });
  });

  it("is a no-op when agent_schedule does not exist (bare DB)", () => {
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0008-agent-schedule-backfill-task-prompt",
    ]);
    expect(tableExists(db, "agent_schedule")).toBe(false);
  });

  it("backfills task_prompt from task_description for NULL-prompt rows; leaves set prompts alone", () => {
    const db = openDb();
    applySchema(db);
    // A legacy pending row that relied on the dispatcher's old fallback
    // (task_prompt NULL, task_description carries the body)…
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_prompt, status)
       VALUES ('2099-01-01 09:00:00', 'wake', 'Legacy body in description', NULL, 'pending')`,
    ).run();
    // …and a row that already carries a distinct task_prompt (must be untouched).
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_prompt, status)
       VALUES ('2099-01-02 09:00:00', 'wake', 'Short label', 'A full instruction', 'pending')`,
    ).run();

    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0008-agent-schedule-backfill-task-prompt",
    ]);

    const rows = db
      .prepare<[], { task_description: string; task_prompt: string | null }>(
        "SELECT task_description, task_prompt FROM agent_schedule ORDER BY scheduled_for",
      )
      .all();
    expect(rows).toEqual([
      // NULL prompt backfilled from description.
      { task_description: "Legacy body in description", task_prompt: "Legacy body in description" },
      // Pre-set prompt preserved verbatim.
      { task_description: "Short label", task_prompt: "A full instruction" },
    ]);
  });

  it("is idempotent — re-running does not re-apply and does not re-touch rows", () => {
    const db = openDb();
    applySchema(db);
    db.prepare(
      `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_prompt, status)
       VALUES ('2099-01-01 09:00:00', 'wake', 'Legacy body', NULL, 'pending')`,
    ).run();
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    const row = db
      .prepare<[], { task_prompt: string | null }>(
        "SELECT task_prompt FROM agent_schedule LIMIT 1",
      )
      .get();
    expect(row).toEqual({ task_prompt: "Legacy body" });
  });
});

describe("schema introspection helpers", () => {
  it("tableExists returns true for an existing table and false otherwise", () => {
    const db = openDb();
    db.exec("CREATE TABLE present (id INTEGER PRIMARY KEY)");
    expect(tableExists(db, "present")).toBe(true);
    expect(tableExists(db, "missing")).toBe(false);
  });

  it("columnExists returns true only when both table and column are present", () => {
    const db = openDb();
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)");
    expect(columnExists(db, "things", "name")).toBe(true);
    expect(columnExists(db, "things", "missing")).toBe(false);
    expect(columnExists(db, "no_such_table", "name")).toBe(false);
  });

  it("columnExists rejects identifiers that are not plain SQL names", () => {
    const db = openDb();
    db.exec("CREATE TABLE safe (id INTEGER PRIMARY KEY)");
    expect(() => columnExists(db, "safe; DROP TABLE safe; --", "id")).toThrow(
      /Invalid SQL identifier/,
    );
  });

  it("indexExists returns true only for an existing index", () => {
    const db = openDb();
    db.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT)");
    db.exec("CREATE INDEX idx_rows_value ON rows(value)");
    expect(indexExists(db, "idx_rows_value")).toBe(true);
    expect(indexExists(db, "idx_missing")).toBe(false);
  });
});

// 0010 carries the "Hourly Check" → "Activity Scan" rename across every
// persisted surface (CLAUDE.md upgrade-safety checklist): agents row id,
// agent_executions FK rows, process_backend_config keys, settings keys,
// self-tuning ledger keys, and the two on-disk vault files (+ snapshot
// paths). Contract per non-negotiable #4: fresh DB (applySchema) → no-op
// with id recorded; pre-rename-shape DB → renames applied; re-run → no
// second apply.
describe("0010-hourly-check-to-activity-scan", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0010-hourly-check-to-activity-scan",
  );

  function runWithCtx(
    db: Database.Database,
    ctx: { dataDir: string; contextDir: string },
  ) {
    return runMigrations(db, { ctx, migrations: [migration!] });
  }

  function insertAgentRow(
    db: Database.Database,
    id: string,
    opts: { enabled: number; overriddenAt: number | null },
  ): void {
    db.prepare(
      `INSERT INTO agents (
         id, name, description, source, definition_path, definition_hash,
         enabled, enabled_overridden_at, process_key, schedule_kind,
         schedule_expression, schedule_timezone, tags_json,
         stop_warning_json, metadata_json, created_at, updated_at
       ) VALUES (?, 'Hourly Check', 'desc', 'builtin',
         '/assets/agents/hourly-check/agent.md', 'hash-old',
         ?, ?, 'routine.hourly_check', 'cron', '0 4-23 * * *', 'UTC', '[]',
         '{}', '{"runtime_window":{"interval_minutes":45}}', 1, 1)`,
    ).run(id, opts.enabled, opts.overriddenAt);
  }

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("throws without a MigrationContext (vault file step needs contextDir)", () => {
    const db = openDb();
    applySchema(db);
    expect(() => runMigrations(db, [migration!])).toThrow(/MigrationContext/);
  });

  it("is a no-op on a fresh DB — applySchema already seeds the new names", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      const result = runWithCtx(db, ctx);
      expect(result.applied).toEqual(["0010-hourly-check-to-activity-scan"]);
      const keys = db
        .prepare<[], { process_key: string }>(
          `SELECT process_key FROM process_backend_config
            WHERE process_key LIKE 'routine.activity_scan%'
            ORDER BY process_key`,
        )
        .all()
        .map((r) => r.process_key);
      expect(keys).toEqual([
        "routine.activity_scan",
        "routine.activity_scan.triage",
      ]);
      expect(
        db
          .prepare("SELECT 1 FROM process_backend_config WHERE process_key LIKE 'routine.hourly_check%'")
          .get(),
      ).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("renames the agents row preserving enabled state and moves executions", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      insertAgentRow(db, "hourly-check", { enabled: 0, overriddenAt: 1781157396084 });
      db.prepare(
        `INSERT INTO agent_executions (agent_id, trigger, started_at)
         VALUES ('hourly-check', 'cron', 1)`,
      ).run();

      runWithCtx(db, ctx);

      expect(
        db.prepare("SELECT 1 FROM agents WHERE id = 'hourly-check'").get(),
      ).toBeUndefined();
      const renamed = db
        .prepare<[], {
          name: string;
          enabled: number;
          enabled_overridden_at: number;
          process_key: string;
          definition_path: string;
          metadata_json: string;
        }>(
          `SELECT name, enabled, enabled_overridden_at, process_key,
                  definition_path, metadata_json
             FROM agents WHERE id = 'activity-scan'`,
        )
        .get()!;
      expect(renamed.name).toBe("Activity Scan");
      expect(renamed.enabled).toBe(0);
      expect(renamed.enabled_overridden_at).toBe(1781157396084);
      expect(renamed.process_key).toBe("routine.activity_scan");
      expect(renamed.definition_path).toBe(
        "/assets/agents/activity-scan/agent.md",
      );
      expect(JSON.parse(renamed.metadata_json)).toEqual({
        runtime_window: { interval_minutes: 45 },
      });
      const exec = db
        .prepare<[], { agent_id: string }>(
          "SELECT agent_id FROM agent_executions",
        )
        .get()!;
      expect(exec.agent_id).toBe("activity-scan");
    } finally {
      cleanup();
    }
  });

  it("drops the stale old row when BOTH slugs exist, re-homing executions", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      // Mixed-version backup restore: the live (new) row coexists with a
      // stale pre-rename row that still owns execution history.
      insertAgentRow(db, "hourly-check", { enabled: 0, overriddenAt: 123 });
      db.prepare(
        `INSERT INTO agents (
           id, name, description, source, definition_path, definition_hash,
           enabled, process_key, schedule_kind, schedule_timezone, tags_json,
           metadata_json, created_at, updated_at
         ) VALUES ('activity-scan', 'Activity Scan', 'desc', 'builtin',
           '/assets/agents/activity-scan/agent.md', 'hash-new', 1,
           'routine.activity_scan', 'cron', 'UTC', '[]', '{}', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO agent_executions (agent_id, trigger, started_at)
         VALUES ('hourly-check', 'cron', 1)`,
      ).run();

      runWithCtx(db, ctx);

      expect(
        db.prepare("SELECT 1 FROM agents WHERE id = 'hourly-check'").get(),
      ).toBeUndefined();
      // The live row keeps ITS values (not the stale row's enabled=0).
      const live = db
        .prepare<[], { enabled: number }>(
          "SELECT enabled FROM agents WHERE id = 'activity-scan'",
        )
        .get()!;
      expect(live.enabled).toBe(1);
      expect(
        db
          .prepare<[], { agent_id: string }>(
            "SELECT agent_id FROM agent_executions",
          )
          .get()!.agent_id,
      ).toBe("activity-scan");
    } finally {
      cleanup();
    }
  });

  it("renames the pre-restructure root spellings on a 0004-deferred vault", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      // Obsidian vault whose 0004 consent is pending: the rulebook and
      // dossier still live at the legacy roots, not under policies/ /
      // knowledge/.
      mkdirSync(join(ctx.contextDir, "routines"), { recursive: true });
      mkdirSync(join(ctx.contextDir, "dossiers"), { recursive: true });
      writeFileSync(
        join(ctx.contextDir, "routines", "hourly.md"),
        "# Legacy checks\n",
        "utf-8",
      );
      writeFileSync(
        join(ctx.contextDir, "dossiers", "hourly.md"),
        "# Legacy dossier\n",
        "utf-8",
      );
      db.prepare(
        `INSERT INTO md_file_snapshots (file_path, content, trigger)
         VALUES ('routines/hourly.md', '# old', 'pre-write')`,
      ).run();

      runWithCtx(db, ctx);

      expect(
        existsSync(join(ctx.contextDir, "routines", "activity-scan.md")),
      ).toBe(true);
      expect(existsSync(join(ctx.contextDir, "routines", "hourly.md"))).toBe(
        false,
      );
      expect(
        existsSync(join(ctx.contextDir, "dossiers", "activity-scan.md")),
      ).toBe(true);
      expect(
        db
          .prepare(
            "SELECT 1 FROM md_file_snapshots WHERE file_path = 'routines/activity-scan.md'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("does not touch an already-renamed agents row (re-run shape)", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      db.prepare(
        `INSERT INTO agents (
           id, name, description, source, definition_path, definition_hash,
           enabled, process_key, schedule_kind, schedule_timezone, tags_json,
           metadata_json, created_at, updated_at
         ) VALUES ('activity-scan', 'Activity Scan', 'desc', 'builtin',
           '/assets/agents/activity-scan/agent.md', 'hash-new', 1,
           'routine.activity_scan', 'cron', 'UTC', '[]', '{}', 1, 1)`,
      ).run();
      runWithCtx(db, ctx);
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM agents").get()!
          .n,
      ).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("renames process_backend_config keys, old row beating the fresh seed", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      // Simulate the upgrade moment: the operator's pre-rename row exists
      // alongside the new-key preset row applySchema just seeded.
      db.prepare(
        `INSERT INTO process_backend_config
           (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
         VALUES ('routine.hourly_check', 'claude', 'user-pinned-model', 99, 9.99, 'user')`,
      ).run();

      runWithCtx(db, ctx);

      const row = db
        .prepare<[], { main_model: string; max_budget_usd: number; updated_by: string }>(
          `SELECT main_model, max_budget_usd, updated_by
             FROM process_backend_config WHERE process_key = 'routine.activity_scan'`,
        )
        .get()!;
      expect(row.main_model).toBe("user-pinned-model");
      expect(row.max_budget_usd).toBe(9.99);
      expect(row.updated_by).toBe("user");
      expect(
        db
          .prepare("SELECT 1 FROM process_backend_config WHERE process_key = 'routine.hourly_check'")
          .get(),
      ).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("renames settings keys; canonical row wins when both exist", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      const put = db.prepare(
        "INSERT INTO settings (key, value_json) VALUES (?, ?)",
      );
      put.run("hourlyCheckEnabled", "false");
      put.run("hourlyCheckPrePassFreshnessMinutes", "240");
      put.run("hourlyCheckIntervalMinutes", "60");
      // Both-keys conflict: canonical wins, legacy dropped.
      put.run("activityScanIntervalMinutes", "90");

      runWithCtx(db, ctx);

      const get = (key: string) =>
        (
          db
            .prepare<[string], { value_json: string }>(
              "SELECT value_json FROM settings WHERE key = ?",
            )
            .get(key) ?? null
        )?.value_json ?? null;
      expect(get("activityScanEnabled")).toBe("false");
      expect(get("activityScanPrePassFreshnessMinutes")).toBe("240");
      expect(get("activityScanIntervalMinutes")).toBe("90");
      expect(get("hourlyCheckEnabled")).toBeNull();
      expect(get("hourlyCheckPrePassFreshnessMinutes")).toBeNull();
      expect(get("hourlyCheckIntervalMinutes")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("renames self-tuning ledger keys in runtime_state; new key wins a conflict", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      const put = db.prepare(
        "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
      );
      put.run(
        "self_tuning:hourlyCheckPrePassFreshnessMinutes",
        '{"applied_at":"2026-06-01T00:00:00Z"}',
      );
      // Conflict shape (mixed-version backup restore): both spellings of the
      // OTHER knob exist — the new-key blob must survive, the old dropped.
      put.run(
        "self_tuning:hourlyCheckLowSignalPendingCeiling",
        '{"applied_at":"old"}',
      );
      put.run(
        "self_tuning:activityScanLowSignalPendingCeiling",
        '{"applied_at":"new"}',
      );
      runWithCtx(db, ctx);
      expect(
        db
          .prepare(
            "SELECT 1 FROM runtime_state WHERE key = 'self_tuning:activityScanPrePassFreshnessMinutes'",
          )
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare(
            "SELECT 1 FROM runtime_state WHERE key = 'self_tuning:hourlyCheckPrePassFreshnessMinutes'",
          )
          .get(),
      ).toBeUndefined();
      const ceiling = db
        .prepare<[], { value_json: string }>(
          "SELECT value_json FROM runtime_state WHERE key = 'self_tuning:activityScanLowSignalPendingCeiling'",
        )
        .get()!;
      expect(JSON.parse(ceiling.value_json)).toEqual({ applied_at: "new" });
      expect(
        db
          .prepare(
            "SELECT 1 FROM runtime_state WHERE key = 'self_tuning:hourlyCheckLowSignalPendingCeiling'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("renames the two vault files and rewrites their snapshot paths", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      mkdirSync(join(ctx.contextDir, "policies", "routines"), { recursive: true });
      mkdirSync(join(ctx.contextDir, "knowledge", "dossiers"), { recursive: true });
      writeFileSync(
        join(ctx.contextDir, "policies", "routines", "hourly.md"),
        "# My checks\n",
        "utf-8",
      );
      writeFileSync(
        join(ctx.contextDir, "knowledge", "dossiers", "hourly.md"),
        "# Dossier\n",
        "utf-8",
      );
      db.prepare(
        `INSERT INTO md_file_snapshots (file_path, content, trigger)
         VALUES ('policies/routines/hourly.md', '# old', 'pre-write')`,
      ).run();

      runWithCtx(db, ctx);

      expect(
        existsSync(join(ctx.contextDir, "policies", "routines", "activity-scan.md")),
      ).toBe(true);
      expect(
        existsSync(join(ctx.contextDir, "policies", "routines", "hourly.md")),
      ).toBe(false);
      expect(
        existsSync(join(ctx.contextDir, "knowledge", "dossiers", "activity-scan.md")),
      ).toBe(true);
      expect(
        readFileSync(
          join(ctx.contextDir, "policies", "routines", "activity-scan.md"),
          "utf-8",
        ),
      ).toBe("# My checks\n");
      expect(
        db
          .prepare(
            "SELECT 1 FROM md_file_snapshots WHERE file_path = 'policies/routines/activity-scan.md'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("re-run is a recorded no-op (id already applied)", () => {
    const { ctx, cleanup } = tempMigrationCtx();
    const db = openDb();
    applySchema(db);
    try {
      insertAgentRow(db, "hourly-check", { enabled: 1, overriddenAt: null });
      const first = runWithCtx(db, ctx);
      expect(first.applied).toEqual(["0010-hourly-check-to-activity-scan"]);
      const second = runWithCtx(db, ctx);
      expect(second.applied).toEqual([]);
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM agents").get()!
          .n,
      ).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// RESEARCH_CLUSTER_COST_FIX_PLAN.md F1 — peer test for
// `0011-research-clusters-journal-enqueue-stamp`, per the CLAUDE.md
// non-negotiable #4 contract: fresh DB (applySchema already added the
// column) → no-op + id recorded; pre-migration-shape table (no column)
// → ALTER applied + id recorded; bare DB (no table) → no-op + id
// recorded; re-run → no second apply.
describe("0011-research-clusters-journal-enqueue-stamp", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0011-research-clusters-journal-enqueue-stamp",
  );

  /** The browser_research_clusters shape as it existed before this
   *  migration (v0.1.10) — no journal_update_enqueued_on column. */
  function seedPreMigrationTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE browser_research_clusters (
          slug TEXT PRIMARY KEY,
          root_task_id INTEGER NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          visits_total INTEGER NOT NULL,
          meaningful_visits_total INTEGER NOT NULL,
          meaningful_foreground_sec_total INTEGER NOT NULL,
          distinct_meaningful_domains INTEGER NOT NULL,
          status TEXT NOT NULL
              CHECK (status IN ('active', 'dormant', 'concluded', 'muted')),
          last_dm_at INTEGER,
          last_research_offer_at INTEGER,
          last_wiki_offer_at INTEGER,
          research_offer_accepted_at INTEGER,
          wiki_summary_written_at INTEGER,
          agent_summary_revision INTEGER DEFAULT 0
      );
    `);
  }

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when the table does not exist (bare/empty DB)", () => {
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0011-research-clusters-journal-enqueue-stamp",
    ]);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0011-research-clusters-journal-enqueue-stamp");
    expect(recorded).toEqual({
      id: "0011-research-clusters-journal-enqueue-stamp",
    });
  });

  it("is a no-op on a fresh DB where applySchema already created the column", () => {
    const db = openDb();
    applySchema(db);
    expect(
      columnExists(db, "browser_research_clusters", "journal_update_enqueued_on"),
    ).toBe(true);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0011-research-clusters-journal-enqueue-stamp",
    ]);
    expect(
      columnExists(db, "browser_research_clusters", "journal_update_enqueued_on"),
    ).toBe(true);
  });

  it("adds the column to a pre-migration-shape table and preserves rows", () => {
    const db = openDb();
    seedPreMigrationTable(db);
    db.prepare(
      `INSERT INTO browser_research_clusters
         (slug, root_task_id, display_name, started_at, last_activity_at,
          visits_total, meaningful_visits_total,
          meaningful_foreground_sec_total, distinct_meaningful_domains, status)
       VALUES ('keep-me', 1, 'Keep Me', 1, 1, 1, 1, 120, 1, 'active')`,
    ).run();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0011-research-clusters-journal-enqueue-stamp",
    ]);
    expect(
      columnExists(db, "browser_research_clusters", "journal_update_enqueued_on"),
    ).toBe(true);
    const row = db
      .prepare(
        `SELECT slug, journal_update_enqueued_on AS stamp
           FROM browser_research_clusters WHERE slug = 'keep-me'`,
      )
      .get() as { slug: string; stamp: string | null };
    expect(row).toEqual({ slug: "keep-me", stamp: null });
  });

  it("re-run is a recorded no-op (id already applied)", () => {
    const db = openDb();
    seedPreMigrationTable(db);
    const first = runMigrations(db, [migration!]);
    expect(first.applied).toEqual([
      "0011-research-clusters-journal-enqueue-stamp",
    ]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    expect(
      columnExists(db, "browser_research_clusters", "journal_update_enqueued_on"),
    ).toBe(true);
  });
});

// RESEARCH_CLUSTER_COST_FIX_PLAN.md F3 — peer test for
// `0012-research-budget-bump`, same CLAUDE.md non-negotiable #4 contract
// as 0006/0009: fresh DB (no table) → no-op + id recorded; fresh install
// already seeded at the new values → untouched; pre-migration
// preset-default rows ($0.05 / $0.02 on claude-opencode, the lite-factor
// 2.5 scaled $0.13 / $0.05 on codex/gemini) → bumped to $0.50 / $0.15
// (resp. $1.25 / $0.38) + id recorded; operator-pinned ('user') or
// already-custom rows → untouched; re-run → no second bump.
describe("0012-research-budget-bump", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0012-research-budget-bump",
  );

  function seedProcessConfigTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE process_backend_config (
        process_key    TEXT PRIMARY KEY,
        main_backend   TEXT NOT NULL,
        main_model     TEXT NOT NULL,
        max_turns      INTEGER NOT NULL,
        max_budget_usd REAL NOT NULL,
        updated_by     TEXT NOT NULL
      );
    `);
  }

  function insertRow(
    db: Database.Database,
    processKey: string,
    maxBudgetUsd: number,
    updatedBy: string,
    backend = "claude",
  ): void {
    db.prepare(
      `INSERT INTO process_backend_config
         (process_key, main_backend, main_model, max_turns, max_budget_usd, updated_by)
       VALUES (?, ?, 'seed-model', 5, ?, ?)`,
    ).run(processKey, backend, maxBudgetUsd, updatedBy);
  }

  function budgetOf(db: Database.Database, processKey: string): number {
    return (
      db
        .prepare<[string], { max_budget_usd: number }>(
          "SELECT max_budget_usd FROM process_backend_config WHERE process_key = ?",
        )
        .get(processKey) as { max_budget_usd: number }
    ).max_budget_usd;
  }

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op when process_backend_config does not exist (fresh/empty DB)", () => {
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0012-research-budget-bump"]);
    const recorded = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
      )
      .get("0012-research-budget-bump");
    expect(recorded).toEqual({ id: "0012-research-budget-bump" });
  });

  it("is a no-op on a fresh install already seeded at the new values", () => {
    // Real fresh installs run applySchema (which now seeds
    // cluster_update at $0.50) BEFORE the migration runner; offer_dm has
    // no seed row but applyDefaultPresets materializes it at $0.15. The
    // band gates must recognise both as already-migrated.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.5, "preset", "claude");
    insertRow(db, "routine.research_offer_dm", 0.15, "preset", "claude");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.5);
    expect(budgetOf(db, "routine.research_offer_dm")).toBe(0.15);
  });

  it("bumps claude preset-default rows ($0.05→$0.50, $0.02→$0.15)", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.05, "preset", "claude");
    insertRow(db, "routine.research_offer_dm", 0.02, "preset", "claude");
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual(["0012-research-budget-bump"]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.5);
    expect(budgetOf(db, "routine.research_offer_dm")).toBe(0.15);
  });

  it("bumps opencode preset-default rows like claude (no scaling)", () => {
    // opencode rides the Anthropic SDK — post-hoc factor 1, so its old
    // and new defaults match claude.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.05, "preset", "opencode");
    insertRow(db, "routine.research_offer_dm", 0.02, "preset", "opencode");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.5);
    expect(budgetOf(db, "routine.research_offer_dm")).toBe(0.15);
  });

  it("bumps codex preset rows from the lite-scaled band ($0.13→$1.25, $0.05→$0.38)", () => {
    // applyDefaultPresets stores the post-hoc-scaled budget — the LITE
    // factor for codex/gemini is 2.5 (not the medium 1.5), so
    // cluster_update was seeded at $0.13 (0.05 x 2.5, 2-decimal rounded)
    // and offer_dm at $0.05. The migration must lift them to the scaled
    // new defaults ($0.50 x 2.5 = $1.25, $0.15 x 2.5 = $0.38), NOT the
    // claude bases.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.13, "preset", "codex");
    insertRow(db, "routine.research_offer_dm", 0.05, "preset", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(1.25);
    expect(budgetOf(db, "routine.research_offer_dm")).toBe(0.38);
  });

  it("bumps gemini preset rows from the lite-scaled band", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.13, "preset", "gemini");
    insertRow(db, "routine.research_offer_dm", 0.05, "preset", "gemini");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(1.25);
    expect(budgetOf(db, "routine.research_offer_dm")).toBe(0.38);
  });

  it("does not bump a codex row sitting at the claude band", () => {
    // Defensive: a codex row should only be lifted from its own scaled
    // old default. A codex cluster_update row at $0.05 is not a
    // recognised old default, so leave it untouched rather than guess.
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.05, "preset", "codex");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.05);
  });

  it("leaves operator-pinned ('user') rows untouched even in the old band", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.05, "user", "claude");
    insertRow(db, "routine.research_offer_dm", 0.02, "user", "claude");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.05);
    expect(budgetOf(db, "routine.research_offer_dm")).toBe(0.02);
  });

  it("leaves preset rows already at a custom value untouched", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.2, "preset", "claude");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.2);
  });

  it("does not touch sibling research rows (research_dispatch / wiki_summary)", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_dispatch", 1.0, "preset", "claude");
    insertRow(db, "routine.research_wiki_summary", 0.5, "preset", "claude");
    runMigrations(db, [migration!]);
    expect(budgetOf(db, "routine.research_dispatch")).toBe(1.0);
    expect(budgetOf(db, "routine.research_wiki_summary")).toBe(0.5);
  });

  it("is idempotent — re-running does not bump again", () => {
    const db = openDb();
    seedProcessConfigTable(db);
    insertRow(db, "routine.research_cluster_update", 0.05, "preset", "claude");
    runMigrations(db, [migration!]);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
    expect(budgetOf(db, "routine.research_cluster_update")).toBe(0.5);
  });
});

describe("0013-browser-task-delivery-timestamps", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0013-browser-task-delivery-timestamps",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op on a fresh DB where applySchema already created the columns", () => {
    const db = openDb();
    applySchema(db);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0013-browser-task-delivery-timestamps",
    ]);
    expect(columnExists(db, "browser_task", "delivered_at")).toBe(true);
    expect(
      columnExists(db, "browser_task_clarifications", "delivered_at"),
    ).toBe(true);
  });

  it("adds delivered_at to pre-migration browser-task tables", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE browser_task (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        state TEXT NOT NULL,
        require_final_confirm INTEGER NOT NULL DEFAULT 1,
        blocked_requests_count INTEGER NOT NULL DEFAULT 0,
        extract_chars_total INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE browser_task_clarifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        question TEXT NOT NULL,
        asked_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
    `);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0013-browser-task-delivery-timestamps",
    ]);
    expect(columnExists(db, "browser_task", "delivered_at")).toBe(true);
    expect(
      columnExists(db, "browser_task_clarifications", "delivered_at"),
    ).toBe(true);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
  });
});

describe("0014-background-task-significance-criteria", () => {
  const migration = MIGRATIONS.find(
    (m) => m.id === "0014-background-task-significance-criteria",
  );

  it("is registered in the production MIGRATIONS list", () => {
    expect(migration).toBeDefined();
  });

  it("is a no-op on a fresh DB where applySchema already created the column", () => {
    const db = openDb();
    applySchema(db);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0014-background-task-significance-criteria",
    ]);
    expect(columnExists(db, "background_task", "significance_criteria")).toBe(true);
  });

  it("adds significance_criteria to a pre-migration background_task table", () => {
    const db = openDb();
    db.exec(`
      CREATE TABLE background_task (
        id TEXT PRIMARY KEY,
        brief TEXT NOT NULL,
        state TEXT NOT NULL,
        notification_policy TEXT NOT NULL DEFAULT 'always',
        created_at INTEGER NOT NULL
      );
    `);
    expect(columnExists(db, "background_task", "significance_criteria")).toBe(false);
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0014-background-task-significance-criteria",
    ]);
    expect(columnExists(db, "background_task", "significance_criteria")).toBe(true);
    const second = runMigrations(db, [migration!]);
    expect(second.applied).toEqual([]);
  });

  it("is a recorded no-op when the table is absent (bare :memory: db)", () => {
    const db = openDb();
    const result = runMigrations(db, [migration!]);
    expect(result.applied).toEqual([
      "0014-background-task-significance-criteria",
    ]);
  });
});
