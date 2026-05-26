import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assessVaultVersion,
  MIGRATION_ID,
  MigrationConflict,
  mergeReconcilerBlock,
  runContextVaultRestructure,
  VAULT_LAYOUT_VERSION,
  VAULT_VERSION_FILE,
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
