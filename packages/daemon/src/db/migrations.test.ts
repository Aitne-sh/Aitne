import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      .prepare<[], { id: string }>(
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
      .prepare<[], { id: string }>(
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
      .prepare<[], { id: string }>(
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
