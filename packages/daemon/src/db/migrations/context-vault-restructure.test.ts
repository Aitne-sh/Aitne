import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __testing,
  assessVaultVersion,
  MIGRATION_ID,
  MigrationConflict,
  mergeReconcilerBlock,
  runContextVaultRestructure,
  VAULT_LAYOUT_VERSION,
  VAULT_VERSION_FILE,
  VerificationFailed,
} from "./context-vault-restructure.js";

interface TempLayout {
  baseDir: string;
  dataDir: string;
  contextDir: string;
  db: Database.Database;
}

function makeLayout(): TempLayout {
  const baseDir = mkdtempSync(join(tmpdir(), "vault-restructure-"));
  const dataDir = join(baseDir, "data");
  const contextDir = join(dataDir, "context");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(contextDir, { recursive: true });
  const db = new Database(":memory:");
  return { baseDir, dataDir, contextDir, db };
}

function destroyLayout(layout: TempLayout): void {
  layout.db.close();
  rmSync(layout.baseDir, { recursive: true, force: true });
}

function seedFile(absPath: string, contents: string): void {
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, contents, "utf-8");
}

function applyMinimalSchema(db: Database.Database): void {
  // Tables the migration touches. Shapes mirror packages/daemon/src/db/schema.ts
  // — keep these in sync with the real schema or the migration body will
  // pass the test against a fictional column layout and fail at runtime.
  //
  // Foreign keys are enabled to match the production client (see
  // packages/daemon/src/db/client.ts) so the entities → entity_source_keys
  // PRIMARY-KEY-rewrite path exercises the deferred-FK contract.
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      root_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS md_file_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      trigger TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- schema.ts:1603 — PRIMARY KEY is path; no surrogate id.
    CREATE TABLE IF NOT EXISTS entities (
      path TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      date TEXT,
      last_synced_at TEXT,
      sources_json TEXT NOT NULL DEFAULT '{}'
    );
    -- schema.ts:1637 — sidecar M:N keyed on (path, source_key); cascades
    -- on DELETE but NOT on UPDATE, so the migration body must defer FKs.
    CREATE TABLE IF NOT EXISTS entity_source_keys (
      path TEXT NOT NULL REFERENCES entities(path) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      source_key_normalized TEXT GENERATED ALWAYS AS (LOWER(source_key)) STORED,
      PRIMARY KEY (path, source_key)
    );
    CREATE TABLE IF NOT EXISTS managed_tasks (
      id TEXT PRIMARY KEY,
      output_path TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      detail TEXT,
      result TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metadata TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_wiki USING fts5(
      workspace_id UNINDEXED, path UNINDEXED, content
    );
  `);
}

describe("runContextVaultRestructure", () => {
  let layout: TempLayout;
  beforeEach(() => {
    layout = makeLayout();
    applyMinimalSchema(layout.db);
  });
  afterEach(() => destroyLayout(layout));

  it("(a) fresh-DB no-op: empty vault writes only the version marker", () => {
    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    expect(result.moved).toBe(false);
    expect(result.backupDir).toBeNull();
    expect(
      readFileSync(join(layout.contextDir, VAULT_VERSION_FILE), "utf-8").trim(),
    ).toBe(VAULT_LAYOUT_VERSION);
  });

  it("(b) pre-migration shape: dirs are moved into the six classes", () => {
    seedFile(join(layout.contextDir, "today.md"), "# Today\n");
    seedFile(join(layout.contextDir, "roadmap.md"), "# Roadmap\n");
    seedFile(
      join(layout.contextDir, "user", "profile.md"),
      "---\ntype: user\n---\n# Profile\n",
    );
    seedFile(
      join(layout.contextDir, "rules", "management.md"),
      "# Management\n",
    );
    seedFile(
      join(layout.contextDir, "rules", "policies", "foo.md"),
      "# Foo policy\n",
    );
    seedFile(
      join(layout.contextDir, "routines", "morning.md"),
      "# Morning\n",
    );
    seedFile(
      join(layout.contextDir, "daily", "2026-05-25.md"),
      "# 2026-05-25\n",
    );
    seedFile(
      join(layout.contextDir, "projects", "myproj.md"),
      "# My project\n",
    );
    seedFile(
      join(layout.contextDir, "agent", "journal.md"),
      "# Agent journal\n",
    );

    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    expect(result.moved).toBe(true);
    expect(result.backupDir).not.toBeNull();
    expect(existsSync(join(layout.contextDir, "state", "today.md"))).toBe(true);
    expect(existsSync(join(layout.contextDir, "plans", "roadmap.md"))).toBe(
      true,
    );
    expect(
      existsSync(join(layout.contextDir, "identity", "profile.md")),
    ).toBe(true);
    expect(
      existsSync(join(layout.contextDir, "policies", "management.md")),
    ).toBe(true);
    expect(
      existsSync(
        join(layout.contextDir, "policies", "management-captures", "foo.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(layout.contextDir, "policies", "routines", "morning.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(layout.contextDir, "journal", "daily", "2026-05-25.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(layout.contextDir, "plans", "projects", "myproj.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(join(layout.contextDir, "journal", "agent.md")),
    ).toBe(true);

    // Legacy dirs must be gone.
    expect(existsSync(join(layout.contextDir, "user"))).toBe(false);
    expect(existsSync(join(layout.contextDir, "rules"))).toBe(false);
    expect(existsSync(join(layout.contextDir, "routines"))).toBe(false);
    expect(existsSync(join(layout.contextDir, "daily"))).toBe(false);
    expect(existsSync(join(layout.contextDir, "projects"))).toBe(false);

    // Version marker written.
    expect(
      readFileSync(join(layout.contextDir, VAULT_VERSION_FILE), "utf-8").trim(),
    ).toBe(VAULT_LAYOUT_VERSION);
  });

  it("(c) re-run on a migrated DB is a complete no-op", () => {
    seedFile(join(layout.contextDir, "today.md"), "# Today\n");
    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    const second = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    expect(second.moved).toBe(false);
    expect(second.backupDir).toBeNull();
    expect(second.entries).toEqual([]);
  });

  it("(d) MigrationConflict throws when both source and target exist", () => {
    seedFile(join(layout.contextDir, "user", "profile.md"), "legacy\n");
    seedFile(join(layout.contextDir, "identity", "profile.md"), "new\n");
    expect(() =>
      runContextVaultRestructure({
        db: layout.db,
        dataDir: layout.dataDir,
        contextDir: layout.contextDir,
      }),
    ).toThrow(MigrationConflict);
  });

  it("(f) V13 rewrites typed SQLite path keys", () => {
    layout.db
      .prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      )
      .run("user/profile", "snapshot", "test");
    layout.db
      .prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      )
      .run("policies/management-captures/foo", "snapshot", "test");
    layout.db
      .prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      )
      .run("journal/daily/2026-05-25", "snapshot", "test");

    layout.db
      .prepare(
        "INSERT INTO entities (path, domain, type, slug, title) VALUES (?, ?, ?, ?, ?)",
      )
      .run("work/meetings/foo.md", "work", "meeting", "foo", "Foo Meeting");
    layout.db
      .prepare(
        "INSERT INTO entity_source_keys (path, source_key) VALUES (?, ?)",
      )
      .run("work/meetings/foo.md", "gmail:thr:abc");
    layout.db
      .prepare("INSERT INTO managed_tasks (id, output_path) VALUES (?, ?)")
      .run("mt1", "work/meetings/");

    seedFile(join(layout.contextDir, "today.md"), "# t\n");

    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    expect(result.sqlitePathKeysRewritten.mdFileSnapshots).toBeGreaterThan(0);
    expect(result.sqlitePathKeysRewritten.entities).toBe(1);
    expect(result.sqlitePathKeysRewritten.entitySourceKeys).toBe(1);
    expect(result.sqlitePathKeysRewritten.managedTasks).toBe(1);

    const snapshots = layout.db
      .prepare<[], { file_path: string }>("SELECT file_path FROM md_file_snapshots")
      .all()
      .map((r) => r.file_path)
      .sort();
    expect(snapshots).toEqual([
      "identity/profile",
      "journal/daily/2026-05-25",
      "policies/management-captures/foo",
    ]);
    expect(
      (layout.db.prepare<[], { path: string }>("SELECT path FROM entities").get())
        ?.path,
    ).toBe("knowledge/entities/work/meetings/foo.md");
    expect(
      (
        layout.db
          .prepare<[], { output_path: string }>(
            "SELECT output_path FROM managed_tasks",
          )
          .get()
      )?.output_path,
    ).toBe("knowledge/entities/work/meetings/");
  });

  it("(g) management entity files move under knowledge/entities/", () => {
    seedFile(
      join(layout.contextDir, "work", "_index.md"),
      "---\ntype: index\n---\n# Work\n",
    );
    seedFile(
      join(layout.contextDir, "work", "meetings", "kickoff.md"),
      "# Kickoff\n",
    );

    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    expect(
      existsSync(
        join(layout.contextDir, "knowledge", "entities", "work", "_index.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          layout.contextDir,
          "knowledge",
          "entities",
          "work",
          "meetings",
          "kickoff.md",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(layout.contextDir, "work"))).toBe(false);
  });

  it("(h) internal wiki workspaces are repointed under knowledge/wiki", () => {
    const oldWikiRoot = join(layout.dataDir, "wiki", "default");
    seedFile(join(oldWikiRoot, "20_wiki", "foo.md"), "# Foo\n");
    layout.db
      .prepare(
        "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?, ?, ?)",
      )
      .run("default", "internal", oldWikiRoot);

    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    const repoint = layout.db
      .prepare<[], { root_path: string }>("SELECT root_path FROM wiki_workspaces")
      .get();
    expect(repoint?.root_path).toBe(
      join(layout.contextDir, "knowledge", "wiki", "default"),
    );
    expect(
      existsSync(
        join(layout.contextDir, "knowledge", "wiki", "default", "20_wiki", "foo.md"),
      ),
    ).toBe(true);
    expect(existsSync(oldWikiRoot)).toBe(false);
  });

  it("moves integrations.md and user-skill dirs into the vault", () => {
    seedFile(join(layout.dataDir, "integrations.md"), "# Integrations\n");
    seedFile(
      join(layout.dataDir, "skills", "my-skill", "SKILL.md"),
      "# My skill\n",
    );
    seedFile(
      join(layout.dataDir, "skills", "overlays", "foo.json"),
      "{}",
    );

    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    expect(
      existsSync(
        join(layout.contextDir, "policies", "integrations.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(layout.contextDir, "policies", "skills", "my-skill", "SKILL.md"),
      ),
    ).toBe(true);
    // Overlays go to a NON-vault operational location.
    expect(
      existsSync(
        join(layout.dataDir, "skill-curation-overlays", "foo.json"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(layout.contextDir, "policies", "skills", "overlays"),
      ),
    ).toBe(false);
  });

  it("(V17) rewrites legacy paths inside JSON blobs", () => {
    layout.db
      .prepare(
        "INSERT INTO agent_actions (action_type, detail) VALUES (?, ?)",
      )
      .run(
        "test.seed",
        JSON.stringify({
          path: join(layout.contextDir, "user", "profile.md"),
          memo: "see rules/policies/foo",
        }),
      );
    layout.db
      .prepare("INSERT INTO observations (payload) VALUES (?)")
      .run(
        JSON.stringify({
          file: join(layout.dataDir, "integrations.md"),
        }),
      );

    seedFile(join(layout.contextDir, "today.md"), "# t\n");
    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    expect(result.jsonBlobRewrites.length).toBeGreaterThan(0);
    const action = JSON.parse(
      (layout.db
        .prepare<[], { detail: string }>(
          "SELECT detail FROM agent_actions WHERE action_type = 'test.seed'",
        )
        .get())!.detail,
    );
    expect(action.path).toBe(
      join(layout.contextDir, "identity", "profile.md"),
    );
    const observation = JSON.parse(
      (layout.db
        .prepare<[], { payload: string }>("SELECT payload FROM observations")
        .get())!.payload,
    );
    expect(observation.file).toBe(
      join(layout.contextDir, "policies", "integrations.md"),
    );
  });

  it("(i) git/<slug>/journal and git/<slug>/overview fan out correctly", () => {
    seedFile(
      join(layout.contextDir, "git", "myrepo", "overview.md"),
      "# Overview\n",
    );
    seedFile(
      join(
        layout.contextDir,
        "git",
        "myrepo",
        "journal",
        "2026-05-25.md",
      ),
      "# journal\n",
    );

    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    expect(
      existsSync(
        join(
          layout.contextDir,
          "knowledge",
          "repos",
          "myrepo",
          "overview.md",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          layout.contextDir,
          "journal",
          "repos",
          "myrepo",
          "2026-05-25.md",
        ),
      ),
    ).toBe(true);
  });

  it("merges context-index.md into _index.md reconciler block", () => {
    seedFile(
      join(layout.contextDir, "context-index.md"),
      "| File | mtime |\n|---|---|\n| today.md | 2026-05-25 |\n",
    );
    seedFile(
      join(layout.contextDir, "_index.md"),
      "# Vault\n\nManual navigation.\n",
    );

    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });

    const merged = readFileSync(
      join(layout.contextDir, "_index.md"),
      "utf-8",
    );
    expect(merged).toContain("# Vault");
    expect(merged).toContain("<!-- reconciler-section -->");
    expect(merged).toContain("today.md");
    expect(merged).toContain("<!-- /reconciler-section -->");
    expect(
      existsSync(join(layout.contextDir, "context-index.md")),
    ).toBe(false);
  });
});

describe("assessVaultVersion", () => {
  let layout: TempLayout;
  beforeEach(() => {
    layout = makeLayout();
  });
  afterEach(() => destroyLayout(layout));

  it("absent marker → run-migration", () => {
    expect(assessVaultVersion({ contextDir: layout.contextDir })).toEqual({
      action: "run-migration",
      observedVersion: null,
    });
  });

  it('marker "1" → run-migration', () => {
    writeFileSync(
      join(layout.contextDir, VAULT_VERSION_FILE),
      "1\n",
      "utf-8",
    );
    expect(assessVaultVersion({ contextDir: layout.contextDir })).toEqual({
      action: "run-migration",
      observedVersion: "1",
    });
  });

  it('marker "2" → noop', () => {
    writeFileSync(
      join(layout.contextDir, VAULT_VERSION_FILE),
      "2\n",
      "utf-8",
    );
    expect(assessVaultVersion({ contextDir: layout.contextDir })).toEqual({
      action: "noop",
      observedVersion: "2",
    });
  });

  it("unknown marker → throw-unknown-version", () => {
    writeFileSync(
      join(layout.contextDir, VAULT_VERSION_FILE),
      "99\n",
      "utf-8",
    );
    expect(
      assessVaultVersion({ contextDir: layout.contextDir }).action,
    ).toBe("throw-unknown-version");
  });
});

describe("mergeReconcilerBlock", () => {
  it("appends a new block when the target has no markers", () => {
    const result = mergeReconcilerBlock("# Vault\n\nUser content.\n", "row\n");
    expect(result).toContain("<!-- reconciler-section -->");
    expect(result).toContain("# Vault");
    expect(result).toContain("row");
  });

  it("replaces an existing block in place", () => {
    const target =
      "# Vault\n\n<!-- reconciler-section -->\nold\n<!-- /reconciler-section -->\n\nMore.\n";
    const result = mergeReconcilerBlock(target, "new\n");
    expect(result).toContain("new");
    expect(result).not.toContain("old");
    expect(result).toContain("More.");
  });

  it("handles empty target", () => {
    const result = mergeReconcilerBlock("", "x\n");
    expect(result).toContain("<!-- reconciler-section -->");
    expect(result).toContain("x");
  });
});

describe("MIGRATION_ID export", () => {
  it("matches the manifest id used by db/migrations.ts", () => {
    expect(MIGRATION_ID).toBe("0004-context-vault-restructure");
  });
});

// ───────────────────────────────────────────────────────────────────
// Branch coverage — defensive / edge paths that are awkward to drive
// through the full orchestrator. Internal helpers are exercised through
// the `__testing` export; integration-shaped branches go through
// `runContextVaultRestructure`.
// ───────────────────────────────────────────────────────────────────

describe("runContextVaultRestructure — edge paths", () => {
  let layout: TempLayout;
  beforeEach(() => {
    layout = makeLayout();
    applyMinimalSchema(layout.db);
  });
  afterEach(() => destroyLayout(layout));

  it("throws on an unknown version marker", () => {
    writeFileSync(
      join(layout.contextDir, VAULT_VERSION_FILE),
      "99\n",
      "utf-8",
    );
    expect(() =>
      runContextVaultRestructure({
        db: layout.db,
        dataDir: layout.dataDir,
        contextDir: layout.contextDir,
      }),
    ).toThrow(/Unknown context vault version/);
  });

  it("records skip-already-applied when only the target exists", () => {
    // `user/` source absent, `identity/` target present → the move was
    // already applied on a prior partial run.
    seedFile(join(layout.contextDir, "identity", "profile.md"), "new\n");
    seedFile(join(layout.contextDir, "today.md"), "# t\n");
    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    const userEntry = result.entries.find((e) => e.from === "user");
    expect(userEntry?.outcome).toBe("skip-already-applied");
  });

  it("renames into a pre-existing empty target dir (initDirectories pre-state)", () => {
    // Source present + target dir present-but-empty (and nested-empty) →
    // not a conflict; the empty target is rmdir'd before the rename.
    seedFile(join(layout.contextDir, "inbox", "memo.md"), "# memo\n");
    mkdirSync(join(layout.contextDir, "state", "inbox", "nested-empty"), {
      recursive: true,
    });
    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    expect(result.moved).toBe(true);
    expect(
      existsSync(join(layout.contextDir, "state", "inbox", "memo.md")),
    ).toBe(true);
  });

  it("conflicts when a dir-rename target already holds a file", () => {
    // Target `state/inbox/` is non-empty (contains a real file) → genuine
    // conflict, not the empty-husk pre-state.
    seedFile(join(layout.contextDir, "inbox", "memo.md"), "# memo\n");
    seedFile(join(layout.contextDir, "state", "inbox", "existing.md"), "x\n");
    expect(() =>
      runContextVaultRestructure({
        db: layout.db,
        dataDir: layout.dataDir,
        contextDir: layout.contextDir,
      }),
    ).toThrow(MigrationConflict);
  });

  it("captures unmanifested legacy entries into state/scratch", () => {
    // `agent/leftover.md` + `agent/leftoverdir/` match no manifest rule →
    // copied into state/scratch as recoverable artifacts.
    seedFile(join(layout.contextDir, "today.md"), "# t\n");
    seedFile(join(layout.contextDir, "agent", "leftover.md"), "orphan\n");
    seedFile(
      join(layout.contextDir, "agent", "leftoverdir", "inner.md"),
      "nested orphan\n",
    );
    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    expect(result.moved).toBe(true);
    const captured = result.entries.filter((e) =>
      e.to.startsWith("state/scratch/legacy-unmanifested-"),
    );
    expect(captured.length).toBeGreaterThanOrEqual(2);
    // The legacy `agent/` dir is emptied + removed.
    expect(existsSync(join(layout.contextDir, "agent"))).toBe(false);
    const scratchEntries = readdirSync(
      join(layout.contextDir, "state", "scratch"),
    );
    expect(
      scratchEntries.some((n) => n.includes("legacy-unmanifested-")),
    ).toBe(true);
  });

  it("prunes empty git/<slug> husks left after fanout moves", () => {
    seedFile(
      join(layout.contextDir, "git", "myrepo", "overview.md"),
      "# o\n",
    );
    runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    // The fanout moved git/myrepo/overview.md out; the git/ + git/myrepo/
    // husks are swept.
    expect(existsSync(join(layout.contextDir, "git"))).toBe(false);
  });

  it("rewrites snapshot/managed-task rows with already-canonical or empty values without tripping verification", () => {
    // output_path="" → the `!row.output_path` skip; an already-canonical
    // path → translateEntityPath returns null (no rewrite) and verification
    // still passes.
    layout.db
      .prepare("INSERT INTO managed_tasks (id, output_path) VALUES (?, ?)")
      .run("mt-empty", "");
    layout.db
      .prepare("INSERT INTO managed_tasks (id, output_path) VALUES (?, ?)")
      .run("mt-canonical", "knowledge/entities/work/meetings/");
    seedFile(join(layout.contextDir, "today.md"), "# t\n");
    const result = runContextVaultRestructure({
      db: layout.db,
      dataDir: layout.dataDir,
      contextDir: layout.contextDir,
    });
    expect(result.sqlitePathKeysRewritten.managedTasks).toBe(0);
  });

  it("continues without per-pair audit rows when agent_actions is absent", () => {
    // A DB missing agent_actions makes the V17 audit-insert `prepare`
    // throw; the catch returns null and the migration completes.
    const bareDir = mkdtempSync(join(tmpdir(), "vault-restructure-bare-"));
    const dataDir = join(bareDir, "data");
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    const bareDb = new Database(":memory:");
    // observations + messages exist (rewritePathsInDb tolerates the rest),
    // but agent_actions is deliberately missing.
    bareDb.exec(
      `CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT);
       CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, metadata TEXT);`,
    );
    writeFileSync(join(contextDir, "today.md"), "# t\n", "utf-8");
    try {
      const result = runContextVaultRestructure({
        db: bareDb,
        dataDir,
        contextDir,
      });
      expect(result.moved).toBe(true);
      expect(
        readFileSync(join(contextDir, VAULT_VERSION_FILE), "utf-8").trim(),
      ).toBe(VAULT_LAYOUT_VERSION);
    } finally {
      bareDb.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("swallows a per-pair audit-insert run failure", () => {
    // agent_actions exists but with an extra NOT NULL column the insert
    // doesn't populate → stmt.run throws → the inner catch swallows it.
    const bareDir = mkdtempSync(join(tmpdir(), "vault-restructure-auditfail-"));
    const dataDir = join(bareDir, "data");
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    const db2 = new Database(":memory:");
    db2.exec(
      `CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT);
       CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, metadata TEXT);
       CREATE TABLE agent_actions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         action_type TEXT NOT NULL,
         detail TEXT,
         result TEXT,
         started_at TEXT DEFAULT CURRENT_TIMESTAMP,
         completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
         mandatory TEXT NOT NULL
       );`,
    );
    writeFileSync(join(contextDir, "today.md"), "# t\n", "utf-8");
    try {
      const result = runContextVaultRestructure({
        db: db2,
        dataDir,
        contextDir,
      });
      expect(result.moved).toBe(true);
      // No audit rows landed because every insert threw and was swallowed.
      expect(
        db2
          .prepare<[], { c: number }>(
            "SELECT COUNT(*) AS c FROM agent_actions WHERE action_type = 'migration.json_path_rewrite'",
          )
          .get()?.c,
      ).toBe(0);
    } finally {
      db2.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("tolerates absent snapshot/entities/managed-task tables", () => {
    // A DB with none of the V13 path-key tables → each rewrite helper
    // returns 0 via its table-existence guard.
    const bareDir = mkdtempSync(join(tmpdir(), "vault-restructure-notbl-"));
    const dataDir = join(bareDir, "data");
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    const db3 = new Database(":memory:");
    writeFileSync(join(contextDir, "today.md"), "# t\n", "utf-8");
    try {
      const result = runContextVaultRestructure({
        db: db3,
        dataDir,
        contextDir,
      });
      expect(result.sqlitePathKeysRewritten).toEqual({
        mdFileSnapshots: 0,
        entities: 0,
        entitySourceKeys: 0,
        managedTasks: 0,
      });
      expect(result.wikiWorkspacesRewritten).toBe(0);
    } finally {
      db3.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe("__testing.translateSnapshotStem", () => {
  it("maps management-domain index and entity stems", () => {
    expect(__testing.translateSnapshotStem("work/_index")).toBe(
      "knowledge/entities/work/_index",
    );
    expect(__testing.translateSnapshotStem("travel/trips/kyoto")).toBe(
      "knowledge/entities/travel/trips/kyoto",
    );
  });
  it("returns null for an unrecognised stem", () => {
    expect(__testing.translateSnapshotStem("garage/widget")).toBeNull();
  });
});

describe("__testing.translateEntityPath", () => {
  it("prefixes a domain entity path and a bare domain", () => {
    expect(__testing.translateEntityPath("work/meetings/foo.md")).toBe(
      "knowledge/entities/work/meetings/foo.md",
    );
    expect(__testing.translateEntityPath("finance")).toBe(
      "knowledge/entities/finance",
    );
  });
  it("returns null for a non-domain path", () => {
    expect(__testing.translateEntityPath("garage/foo")).toBeNull();
  });
});

describe("__testing.expandEntry", () => {
  it("returns [] and warns on an unrecognised fanout pattern", () => {
    const out = __testing.expandEntry(
      { kind: "fanout", from: "weird/*/thing", to: "elsewhere/*" },
      "/tmp/does-not-matter",
    );
    expect(out).toEqual([]);
  });
});

describe("__testing.isEmptyDirectory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-empty-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns false for a non-existent path (statSync throws)", () => {
    expect(__testing.isEmptyDirectory(join(dir, "nope"))).toBe(false);
  });
  it("returns false for a regular file (not a directory)", () => {
    const f = join(dir, "f.md");
    writeFileSync(f, "x", "utf-8");
    expect(__testing.isEmptyDirectory(f)).toBe(false);
  });
  it("returns false when a real file lives in the tree", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f.md"), "x", "utf-8");
    expect(__testing.isEmptyDirectory(dir)).toBe(false);
  });
  it("returns false when a child cannot be statted (broken symlink)", () => {
    symlinkSync(join(dir, "missing-target"), join(dir, "dangling"));
    expect(__testing.isEmptyDirectory(dir)).toBe(false);
  });
  it("returns true for a tree of only (nested) empty directories", () => {
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    expect(__testing.isEmptyDirectory(dir)).toBe(true);
  });
});

describe("__testing.planOutOfContextDirMoves", () => {
  let dataDir: string;
  let contextDir: string;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "vault-ooc-"));
    dataDir = join(base, "data");
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
  });
  afterEach(() => rmSync(join(dataDir, ".."), { recursive: true, force: true }));

  it("plans integrations + user-skill dirs, skipping non-dirs, overlays, and SKILL.md-less dirs", () => {
    writeFileSync(join(dataDir, "integrations.md"), "# i\n", "utf-8");
    mkdirSync(join(dataDir, "skills"), { recursive: true });
    // A loose file under skills/ — not a dir → skipped.
    writeFileSync(join(dataDir, "skills", "loose.txt"), "x", "utf-8");
    // A real skill dir.
    mkdirSync(join(dataDir, "skills", "real-skill"), { recursive: true });
    writeFileSync(
      join(dataDir, "skills", "real-skill", "SKILL.md"),
      "# skill\n",
      "utf-8",
    );
    // A dir without SKILL.md → skipped.
    mkdirSync(join(dataDir, "skills", "no-skill-md"), { recursive: true });
    writeFileSync(
      join(dataDir, "skills", "no-skill-md", "notes.md"),
      "x",
      "utf-8",
    );
    // overlays → handled by the dedicated overlays move, not the skill scan.
    mkdirSync(join(dataDir, "skills", "overlays"), { recursive: true });
    writeFileSync(
      join(dataDir, "skills", "overlays", "o.json"),
      "{}",
      "utf-8",
    );

    const moves = __testing.planOutOfContextDirMoves({ dataDir, contextDir });
    const froms = moves.map((m) => m.from);
    expect(froms).toContain(join(dataDir, "integrations.md"));
    expect(froms).toContain(join(dataDir, "skills", "real-skill"));
    expect(froms).toContain(join(dataDir, "skills", "overlays"));
    expect(froms).not.toContain(join(dataDir, "skills", "no-skill-md"));
    expect(froms).not.toContain(join(dataDir, "skills", "loose.txt"));
  });

  it("skips a skill dir whose destination already exists", () => {
    mkdirSync(join(dataDir, "skills", "dup"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "dup", "SKILL.md"), "x", "utf-8");
    // Pre-create the destination so the move is skipped.
    mkdirSync(join(contextDir, "policies", "skills", "dup"), {
      recursive: true,
    });
    const moves = __testing.planOutOfContextDirMoves({ dataDir, contextDir });
    expect(moves.map((m) => m.from)).not.toContain(
      join(dataDir, "skills", "dup"),
    );
  });

  it("treats a skills path that is a file as empty (readdir throws)", () => {
    writeFileSync(join(dataDir, "skills"), "not a dir", "utf-8");
    expect(__testing.planOutOfContextDirMoves({ dataDir, contextDir })).toEqual(
      [],
    );
  });

  it("skips a skills child that cannot be statted (broken symlink)", () => {
    mkdirSync(join(dataDir, "skills"), { recursive: true });
    symlinkSync(
      join(dataDir, "skills", "missing"),
      join(dataDir, "skills", "dangling"),
    );
    expect(__testing.planOutOfContextDirMoves({ dataDir, contextDir })).toEqual(
      [],
    );
  });
});

describe("__testing.planInternalWikiMoves", () => {
  it("returns [] when wiki_workspaces table is absent", () => {
    const db = new Database(":memory:");
    try {
      expect(
        __testing.planInternalWikiMoves({
          dataDir: "/d",
          contextDir: "/d/context",
          db,
        }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("skips a workspace already pointing at the canonical wiki root", () => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE wiki_workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, root_path TEXT);`,
    );
    const dataDir = "/d";
    const contextDir = "/d/context";
    // root_path under legacy <dataDir>/wiki but already equal to its new
    // path computation → newPath === root_path branch.
    const already = join(contextDir, "knowledge", "wiki", "default");
    db.prepare(
      "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?,?,?)",
    ).run("legacy-but-canonical", "internal", join(dataDir, "wiki", "x"));
    // A workspace whose root is outside the legacy base → skipped by the
    // `startsWith` guard.
    db.prepare(
      "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?,?,?)",
    ).run("outside", "internal", "/somewhere/else");
    db.prepare(
      "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?,?,?)",
    ).run("already", "internal", already);
    try {
      const moves = __testing.planInternalWikiMoves({ dataDir, contextDir, db });
      // Only the legacy-but-relocatable one is planned.
      expect(moves).toHaveLength(1);
      expect(moves[0].oldRoot).toBe(join(dataDir, "wiki", "x"));
    } finally {
      db.close();
    }
  });
});

describe("__testing.verifyMigrationCompleteness throws", () => {
  let dataDir: string;
  let contextDir: string;
  let db: Database.Database;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "vault-verify-"));
    dataDir = join(base, "data");
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    db = new Database(":memory:");
    applyMinimalSchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  function verify(): void {
    __testing.verifyMigrationCompleteness({
      contextDir,
      dataDir,
      db,
      absoluteRewrites: [],
    });
  }

  it("step 2 — a populated legacy top-level dir", () => {
    mkdirSync(join(contextDir, "user"), { recursive: true });
    writeFileSync(join(contextDir, "user", "leftover.md"), "x", "utf-8");
    expect(() => verify()).toThrow(VerificationFailed);
  });

  it("step 3 — an internal wiki workspace still on a legacy root", () => {
    db.prepare(
      "INSERT INTO wiki_workspaces (name, kind, root_path) VALUES (?,?,?)",
    ).run("w", "internal", join(dataDir, "wiki", "default"));
    expect(() => verify()).toThrow(/wiki_workspaces still references legacy/);
  });

  it("step 4 — integrations.md present at both paths", () => {
    writeFileSync(join(dataDir, "integrations.md"), "# i\n", "utf-8");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    writeFileSync(
      join(contextDir, "policies", "integrations.md"),
      "# i\n",
      "utf-8",
    );
    expect(() => verify()).toThrow(/both legacy and canonical/);
  });

  it("step 5 — md_file_snapshots row still under a legacy prefix", () => {
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?,?,?)",
    ).run("git/foo/bar", "x", "test");
    expect(() => verify()).toThrow(/md_file_snapshots.*legacy prefix/);
  });

  it("step 5 — entities row not under knowledge/entities/", () => {
    db.prepare(
      "INSERT INTO entities (path, domain, type, slug, title) VALUES (?,?,?,?,?)",
    ).run("garage/x.md", "garage", "thing", "x", "X");
    expect(() => verify()).toThrow(/entities\.path/);
  });

  it("step 5 — entity_source_keys row not under knowledge/entities/", () => {
    // The entities check runs first, so all `entities` rows must be
    // canonical. To leave a stray legacy `entity_source_keys.path` we drop
    // FK enforcement and insert an orphan row.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO entities (path, domain, type, slug, title) VALUES (?,?,?,?,?)",
    ).run("knowledge/entities/work/meetings/foo.md", "work", "meeting", "foo", "Foo");
    db.prepare(
      "INSERT INTO entity_source_keys (path, source_key) VALUES (?,?)",
    ).run("legacy/strays.md", "gmail:thr:abc");
    expect(() => verify()).toThrow(/entity_source_keys\.path/);
  });

  it("step 5 — managed_tasks row not under knowledge/entities/", () => {
    db.prepare(
      "INSERT INTO managed_tasks (id, output_path) VALUES (?,?)",
    ).run("mt", "garage/out");
    expect(() => verify()).toThrow(/managed_tasks\.output_path/);
  });

  it("step 6 — a legacy <dataDir>/skills/<x>/SKILL.md survives", () => {
    mkdirSync(join(dataDir, "skills", "survivor"), { recursive: true });
    writeFileSync(
      join(dataDir, "skills", "survivor", "SKILL.md"),
      "# s\n",
      "utf-8",
    );
    expect(() => verify()).toThrow(/user skill was not relocated/);
  });

  it("step 6 — a legacy <dataDir>/skills/overlays survives", () => {
    mkdirSync(join(dataDir, "skills", "overlays"), { recursive: true });
    writeFileSync(
      join(dataDir, "skills", "overlays", "o.json"),
      "{}",
      "utf-8",
    );
    expect(() => verify()).toThrow(/overlay JSON was not relocated/);
  });

  it("step 7 — V17 second pass still finds rewritable paths", () => {
    const oldPrefix = join(contextDir, "user");
    const newPrefix = join(contextDir, "identity");
    db.prepare(
      "INSERT INTO agent_actions (action_type, detail) VALUES (?,?)",
    ).run("seed", JSON.stringify({ p: join(oldPrefix, "profile.md") }));
    expect(() =>
      __testing.verifyMigrationCompleteness({
        contextDir,
        dataDir,
        db,
        absoluteRewrites: [[oldPrefix, newPrefix]],
      }),
    ).toThrow(/V17 second-pass/);
  });

  it("step 2 — tolerates a legacy 'dir' that is actually a file (readdir throws)", () => {
    writeFileSync(join(contextDir, "user"), "not a dir", "utf-8");
    expect(() => verify()).not.toThrow();
  });

  it("step 6 — tolerates a legacy <dataDir>/skills that is a file (readdir throws)", () => {
    writeFileSync(join(dataDir, "skills"), "not a dir", "utf-8");
    expect(() => verify()).not.toThrow();
  });

  it("passes cleanly on a fully-migrated vault", () => {
    expect(() => verify()).not.toThrow();
  });
});

describe("__testing.captureUnmanifestedEntries", () => {
  let contextDir: string;
  beforeEach(() => {
    contextDir = mkdtempSync(join(tmpdir(), "vault-capture-"));
  });
  afterEach(() => rmSync(contextDir, { recursive: true, force: true }));

  it("leaves an entry in place when its child cannot be statted (broken symlink)", () => {
    // A broken symlink under a forbidden dir makes statSync throw; the
    // per-child catch continues and leaves it untouched (NOT captured).
    mkdirSync(join(contextDir, "agent"), { recursive: true });
    symlinkSync(
      join(contextDir, "agent", "missing"),
      join(contextDir, "agent", "dangling"),
    );
    const captured = __testing.captureUnmanifestedEntries(contextDir);
    expect(captured).toEqual([]);
    expect(
      readdirSync(join(contextDir, "agent")).includes("dangling"),
    ).toBe(true);
  });

  it("skips a forbidden 'directory' that is actually a file (readdir throws)", () => {
    // `agent` exists but as a file → readdirSync throws → the per-dir catch
    // continues without capturing anything.
    writeFileSync(join(contextDir, "agent"), "not a dir", "utf-8");
    expect(__testing.captureUnmanifestedEntries(contextDir)).toEqual([]);
  });
});

describe("__testing.removeEmptyLegacyDirs", () => {
  let contextDir: string;
  beforeEach(() => {
    contextDir = mkdtempSync(join(tmpdir(), "vault-rmdirs-"));
  });
  afterEach(() => rmSync(contextDir, { recursive: true, force: true }));

  it("swallows readdir failures on a candidate that is a file", () => {
    // `inbox` exists but as a file → readdirSync throws → outer catch.
    writeFileSync(join(contextDir, "inbox"), "x", "utf-8");
    expect(() => __testing.removeEmptyLegacyDirs(contextDir)).not.toThrow();
    expect(existsSync(join(contextDir, "inbox"))).toBe(true);
  });

  it("swallows readdir failures on a git child that is a file", () => {
    // `git/` holds a file child → readdirSync(child) throws ENOTDIR → inner
    // catch; the husk survives, no throw escapes.
    mkdirSync(join(contextDir, "git"), { recursive: true });
    writeFileSync(join(contextDir, "git", "stray.txt"), "x", "utf-8");
    expect(() => __testing.removeEmptyLegacyDirs(contextDir)).not.toThrow();
  });
});

describe("__testing.expandEntry — defensive fs branches", () => {
  let contextDir: string;
  beforeEach(() => {
    contextDir = mkdtempSync(join(tmpdir(), "vault-expand-"));
  });
  afterEach(() => rmSync(contextDir, { recursive: true, force: true }));

  it("git fanout: filters out a slug entry that cannot be statted", () => {
    mkdirSync(join(contextDir, "git"), { recursive: true });
    symlinkSync(join(contextDir, "git", "missing"), join(contextDir, "git", "dangling"));
    const out = __testing.expandEntry(
      { kind: "fanout", from: "git/*/overview.md", to: "knowledge/repos/*/overview.md" },
      contextDir,
    );
    expect(out).toEqual([]);
  });

  it("domain fanout: skips a domain that is a file (readdir throws)", () => {
    writeFileSync(join(contextDir, "work"), "not a dir", "utf-8");
    const out = __testing.expandEntry(
      { kind: "fanout", from: "{domain}/{typePlural}", to: "knowledge/entities/{domain}/{typePlural}" },
      contextDir,
    );
    expect(out).toEqual([]);
  });

  it("domain fanout: skips a child that cannot be statted or is not a directory", () => {
    mkdirSync(join(contextDir, "travel"), { recursive: true });
    // A plain file child (not _index.md) → isDir false → skipped.
    writeFileSync(join(contextDir, "travel", "loose.md"), "x", "utf-8");
    // A broken symlink child → statSync throws → skipped.
    symlinkSync(
      join(contextDir, "travel", "missing"),
      join(contextDir, "travel", "dangling"),
    );
    // A real type-plural dir → kept.
    mkdirSync(join(contextDir, "travel", "trips"), { recursive: true });
    const out = __testing.expandEntry(
      { kind: "fanout", from: "{domain}/{typePlural}", to: "knowledge/entities/{domain}/{typePlural}" },
      contextDir,
    );
    expect(out).toEqual([
      { from: "travel/trips", to: "knowledge/entities/travel/trips" },
    ]);
  });
});

describe("context-vault-restructure — remaining orchestrator branches", () => {
  it("logs the Obsidian-vault notice when contextDir is outside dataDir", () => {
    const base = mkdtempSync(join(tmpdir(), "vault-obsidian-"));
    const dataDir = join(base, "data");
    const contextDir = join(base, "vault"); // NOT under dataDir
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(contextDir, { recursive: true });
    const db = new Database(":memory:");
    applyMinimalSchema(db);
    writeFileSync(join(contextDir, "today.md"), "# t\n", "utf-8");
    try {
      const result = runContextVaultRestructure({ db, dataDir, contextDir });
      expect(result.moved).toBe(true);
      expect(existsSync(join(contextDir, "state", "today.md"))).toBe(true);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("merges context-index.md into a brand-new _index.md (no pre-existing target)", () => {
    const base = mkdtempSync(join(tmpdir(), "vault-merge-"));
    const dataDir = join(base, "data");
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    const db = new Database(":memory:");
    applyMinimalSchema(db);
    writeFileSync(
      join(contextDir, "context-index.md"),
      "| f | m |\n|---|---|\n| today.md | x |\n",
      "utf-8",
    );
    try {
      runContextVaultRestructure({ db, dataDir, contextDir });
      const merged = readFileSync(join(contextDir, "_index.md"), "utf-8");
      expect(merged).toContain("<!-- reconciler-section -->");
      expect(merged).toContain("today.md");
      expect(existsSync(join(contextDir, "context-index.md"))).toBe(false);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("creates the contextDir for an empty, not-yet-existing vault", () => {
    const base = mkdtempSync(join(tmpdir(), "vault-mkctx-"));
    const dataDir = join(base, "data");
    const contextDir = join(dataDir, "context"); // deliberately NOT created
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(":memory:");
    applyMinimalSchema(db);
    try {
      const result = runContextVaultRestructure({ db, dataDir, contextDir });
      expect(result.moved).toBe(false);
      expect(existsSync(contextDir)).toBe(true);
      expect(
        readFileSync(join(contextDir, VAULT_VERSION_FILE), "utf-8").trim(),
      ).toBe(VAULT_LAYOUT_VERSION);
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rewrites entities when entity_source_keys table is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "vault-noesk-"));
    const dataDir = join(base, "data");
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE entities (path TEXT PRIMARY KEY, domain TEXT, type TEXT, slug TEXT, title TEXT);`,
    );
    db.prepare(
      "INSERT INTO entities (path, domain, type, slug, title) VALUES (?,?,?,?,?)",
    ).run("work/meetings/foo.md", "work", "meeting", "foo", "Foo");
    writeFileSync(join(contextDir, "today.md"), "# t\n", "utf-8");
    try {
      const result = runContextVaultRestructure({ db, dataDir, contextDir });
      expect(result.sqlitePathKeysRewritten.entities).toBe(1);
      expect(result.sqlitePathKeysRewritten.entitySourceKeys).toBe(0);
      expect(
        db
          .prepare<[], { path: string }>("SELECT path FROM entities")
          .get()?.path,
      ).toBe("knowledge/entities/work/meetings/foo.md");
    } finally {
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
