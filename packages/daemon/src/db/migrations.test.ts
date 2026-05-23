import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MIGRATIONS,
  columnExists,
  indexExists,
  runMigrations,
  tableExists,
  type Migration,
} from "./migrations.js";

function openDb(): Database.Database {
  return new Database(":memory:");
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
    const result = runMigrations(db);
    expect(result.applied).toEqual([...MIGRATIONS].map((m) => m.id));
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
