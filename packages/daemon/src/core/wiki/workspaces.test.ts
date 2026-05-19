import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
import type { AgentConfig } from "../../config.js";
import { applySchema } from "../../db/schema.js";
import {
  buildWikiWorkspaceStats,
  createExternalWikiWorkspace,
  DEFAULT_WIKI_FULL_COMPILE_APPROVAL_USD,
  DEFAULT_WIKI_LANGUAGE,
  DEFAULT_WIKI_SCHEMA_VERSION,
  DEFAULT_WIKI_WORKSPACE_NAME,
  defaultWikiRoot,
  ensureDefaultWikiWorkspace,
  listActiveWikiWorkspaces,
  listWikiWorkspaces,
  readDefaultWikiWorkspace,
  readWikiWorkspaceByName,
  resolveWikiWorkspace,
  seedWikiWorkspaceFiles,
  validateWikiRootPath,
  type WikiWorkspaceRow,
} from "./workspaces.js";

function makeConfig(rootDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dataDir: rootDir,
    workspaceDir: rootDir,
    primaryLanguage: "en",
    ...overrides,
  } as AgentConfig;
}

describe("defaultWikiRoot", () => {
  it("resolves <dataDir>/wiki", () => {
    expect(defaultWikiRoot("/var/lib/agent")).toBe("/var/lib/agent/wiki");
  });

  it("normalizes relative segments", () => {
    expect(defaultWikiRoot("/a/b/../c")).toBe("/a/c/wiki");
  });
});

describe("ensureDefaultWikiWorkspace", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-workspaces-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("inserts a default-named row with documented defaults on first call", () => {
    const config = makeConfig(tmp);
    const row = ensureDefaultWikiWorkspace(db, config);

    expect(row.name).toBe(DEFAULT_WIKI_WORKSPACE_NAME);
    expect(row.kind).toBe("internal");
    expect(row.root_path).toBe(defaultWikiRoot(tmp));
    expect(row.language).toBe(DEFAULT_WIKI_LANGUAGE);
    expect(row.full_compile_approval_threshold_usd).toBe(
      DEFAULT_WIKI_FULL_COMPILE_APPROVAL_USD,
    );
    expect(row.schema_version).toBe(DEFAULT_WIKI_SCHEMA_VERSION);
    expect(row.active).toBe(1);

    // Vault skeleton is seeded on disk.
    expect(existsSync(join(row.root_path, "20_wiki/_index.md"))).toBe(true);
    expect(existsSync(join(row.root_path, "10_raw/images"))).toBe(true);
    expect(existsSync(join(row.root_path, "90_meta/schemas/wiki.md"))).toBe(true);
  });

  it("is idempotent — a second call returns the same row without re-inserting", () => {
    const config = makeConfig(tmp);
    const first = ensureDefaultWikiWorkspace(db, config);
    const second = ensureDefaultWikiWorkspace(db, config);
    expect(second.id).toBe(first.id);
    expect(listWikiWorkspaces(db)).toHaveLength(1);
  });
});

describe("createExternalWikiWorkspace", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-external-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("inserts an external-kind row when no row with that name exists", () => {
    const externalRoot = join(tmp, "external-wiki");
    const row = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: externalRoot,
    });
    expect(row.kind).toBe("external");
    expect(row.root_path).toBe(externalRoot);
    expect(row.write_strategy).toBe("auto");
    expect(row.active).toBe(1);
    expect(row.language).toBe(DEFAULT_WIKI_LANGUAGE);
  });

  it("updates an existing row in place when called twice (re-activation path)", () => {
    const firstPath = join(tmp, "wiki-a");
    const secondPath = join(tmp, "wiki-b");
    const first = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: firstPath,
      name: "research",
      language: "ja",
    });
    // Soft-archive it to verify the UPDATE branch flips `active` back on.
    db.prepare(`UPDATE wiki_workspaces SET active = 0 WHERE id = ?`).run(first.id);

    const second = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: secondPath,
      name: "research",
      language: "fr",
    });
    expect(second.id).toBe(first.id);
    expect(second.root_path).toBe(secondPath);
    expect(second.language).toBe("fr");
    expect(second.active).toBe(1);
    expect(listWikiWorkspaces(db)).toHaveLength(1);
  });
});

describe("readDefaultWikiWorkspace / readWikiWorkspaceByName", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-read-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when the table is empty", () => {
    expect(readDefaultWikiWorkspace(db)).toBeNull();
    expect(readWikiWorkspaceByName(db, "anything")).toBeNull();
  });

  it("returns the lowest-id active row from readDefaultWikiWorkspace", () => {
    createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "first"),
      name: "first",
    });
    createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "second"),
      name: "second",
    });
    const row = readDefaultWikiWorkspace(db);
    expect(row?.name).toBe("first");
  });
});

describe("listActiveWikiWorkspaces", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-list-active-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("filters out archived rows and orders by name", () => {
    createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "z"),
      name: "zebra",
    });
    const apple = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "a"),
      name: "apple",
    });
    const mango = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "m"),
      name: "mango",
    });
    db.prepare(`UPDATE wiki_workspaces SET active = 0 WHERE id = ?`).run(
      mango.id,
    );

    const active = listActiveWikiWorkspaces(db);
    expect(active.map((r) => r.name)).toEqual(["apple", "zebra"]);
    expect(active[0]!.id).toBe(apple.id);
  });
});

describe("resolveWikiWorkspace", () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-resolve-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the default workspace when no name is passed", () => {
    const row = ensureDefaultWikiWorkspace(db, makeConfig(tmp));
    expect(resolveWikiWorkspace(db, null)?.id).toBe(row.id);
    expect(resolveWikiWorkspace(db, undefined)?.id).toBe(row.id);
  });

  it("returns null when no rows exist and no name is passed", () => {
    expect(resolveWikiWorkspace(db, null)).toBeNull();
  });

  it("returns the named row when it is active", () => {
    const row = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "named"),
      name: "research",
    });
    expect(resolveWikiWorkspace(db, "research")?.id).toBe(row.id);
  });

  it("returns null when the named row is archived", () => {
    const row = createExternalWikiWorkspace(db, makeConfig(tmp), {
      rootPath: join(tmp, "archived"),
      name: "old",
    });
    db.prepare(`UPDATE wiki_workspaces SET active = 0 WHERE id = ?`).run(row.id);
    expect(resolveWikiWorkspace(db, "old")).toBeNull();
  });

  it("returns null when the named row does not exist", () => {
    expect(resolveWikiWorkspace(db, "nonexistent")).toBeNull();
  });
});

describe("validateWikiRootPath", () => {
  let tmp: string;
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-validate-"));
    dataDir = join(tmp, "data");
    mkdirSync(dataDir, { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("forwards the underlying error when the base validator rejects the path", () => {
    const result = validateWikiRootPath("relative/path", db, makeConfig(dataDir));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_absolute");
  });

  it("rejects a path that overlaps the primary vault", () => {
    const primary = join(tmp, "primary-vault");
    mkdirSync(primary, { recursive: true });
    const overlap = join(primary, "wiki");
    mkdirSync(overlap, { recursive: true });
    const config = makeConfig(dataDir, {
      primaryVaultPath: primary,
    } as Partial<AgentConfig>);
    const result = validateWikiRootPath(overlap, db, config);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_primary_vault");
  });

  it("passes through the base validator's overlaps_external_vault when the candidate sits under the Obsidian vault", () => {
    // The wiki function lists `overlaps_external_obsidian` in its error
    // enum but the underlying `validatePrimaryVaultPath` catches the
    // overlap first with `overlaps_external_vault` — the wiki function's
    // own block is documented as a pass-through (see WikiVaultPathValidation).
    const ext = join(tmp, "obsidian-vault");
    mkdirSync(ext, { recursive: true });
    const overlap = join(ext, "wiki");
    mkdirSync(overlap, { recursive: true });
    const config = makeConfig(dataDir, {
      externalObsidianVaultPath: ext,
    } as Partial<AgentConfig>);
    const result = validateWikiRootPath(overlap, db, config);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_external_vault");
  });

  it("rejects a path that overlaps another active wiki workspace", () => {
    const other = join(tmp, "wiki-a");
    mkdirSync(other, { recursive: true });
    createExternalWikiWorkspace(db, makeConfig(dataDir), {
      rootPath: other,
      name: "alpha",
    });
    const overlap = join(other, "nested");
    mkdirSync(overlap, { recursive: true });
    const result = validateWikiRootPath(overlap, db, makeConfig(dataDir));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_other_wiki");
  });

  it("skips the self-workspace when selfWorkspaceName matches", () => {
    const other = join(tmp, "wiki-self");
    mkdirSync(other, { recursive: true });
    createExternalWikiWorkspace(db, makeConfig(dataDir), {
      rootPath: other,
      name: "self",
    });
    const result = validateWikiRootPath(other, db, makeConfig(dataDir), {
      selfWorkspaceName: "self",
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBeDefined();
  });

  it("skips archived workspaces during the overlap scan", () => {
    const archived = join(tmp, "wiki-archived");
    mkdirSync(archived, { recursive: true });
    const row = createExternalWikiWorkspace(db, makeConfig(dataDir), {
      rootPath: archived,
      name: "ghost",
    });
    db.prepare(`UPDATE wiki_workspaces SET active = 0 WHERE id = ?`).run(row.id);
    const result = validateWikiRootPath(archived, db, makeConfig(dataDir));
    expect(result.ok).toBe(true);
  });

  it("accepts a clean path with no overlaps", () => {
    const candidate = join(tmp, "fresh-wiki");
    mkdirSync(candidate, { recursive: true });
    const result = validateWikiRootPath(candidate, db, makeConfig(dataDir));
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBeDefined();
  });
});

describe("seedWikiWorkspaceFiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-seed-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the standard 4-layer directory skeleton and seed files", () => {
    const root = join(tmp, "wiki");
    seedWikiWorkspaceFiles(root, tmp);
    for (const rel of [
      "00_inbox",
      "10_raw/images",
      "20_wiki",
      "30_outputs",
      "90_meta/schemas",
      "90_meta/health",
    ]) {
      expect(existsSync(join(root, rel))).toBe(true);
    }
    expect(existsSync(join(root, "20_wiki/_index.md"))).toBe(true);
    expect(existsSync(join(root, "log.md"))).toBe(true);
    expect(existsSync(join(root, "90_meta/schemas/wiki.md"))).toBe(true);
  });

  it("does not overwrite existing seed files on a re-seed", () => {
    const root = join(tmp, "wiki");
    seedWikiWorkspaceFiles(root, tmp);
    writeFileSync(join(root, "20_wiki/_index.md"), "# Custom Index\n");
    seedWikiWorkspaceFiles(root, tmp);
    // re-seed must preserve the user's edits to the index file.
    expect(readFileSync(join(root, "20_wiki/_index.md"), "utf-8")).toBe(
      "# Custom Index\n",
    );
  });

  it("prefers checked-in seeds under <workspaceDir>/agent-assets/wiki-seeds when present", () => {
    const seedRoot = join(tmp, "agent-assets/wiki-seeds/schemas");
    mkdirSync(seedRoot, { recursive: true });
    writeFileSync(join(seedRoot, "wiki.md"), "# From repo seeds\n");
    const root = join(tmp, "wiki");
    seedWikiWorkspaceFiles(root, tmp);
    expect(readFileSync(join(root, "90_meta/schemas/wiki.md"), "utf-8")).toBe(
      "# From repo seeds\n",
    );
  });
});

describe("buildWikiWorkspaceStats", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pa-wiki-stats-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeRow(rootPath: string): WikiWorkspaceRow {
    return {
      id: 1,
      name: DEFAULT_WIKI_WORKSPACE_NAME,
      kind: "internal",
      root_path: rootPath,
      language: "en",
      dispatch_mode: "parallel",
      concurrency_cap: 3,
      dm_agent_write_enabled: 0,
      bridge_enabled: 0,
      bridge_measurement_only: 1,
      bridge_min_confidence: 0.7,
      full_compile_approval_threshold_usd: 2,
      write_strategy: "fs",
      git_pre_compile_enabled: 1,
      schema_version: 1,
      active: 1,
      last_ingest_at: "2026-05-01T00:00:00Z",
      last_compile_at: null,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
    };
  }

  it("returns zeros when the layer dirs do not exist", () => {
    const stats = buildWikiWorkspaceStats(makeRow(join(tmp, "missing")));
    expect(stats).toEqual({
      rawCount: 0,
      wikiCount: 0,
      outputCount: 0,
      lastIngestAt: "2026-05-01T00:00:00Z",
      lastCompileAt: null,
    });
  });

  it("counts markdown files recursively in each layer", () => {
    const root = join(tmp, "wiki");
    mkdirSync(join(root, "10_raw/sub"), { recursive: true });
    mkdirSync(join(root, "20_wiki"), { recursive: true });
    mkdirSync(join(root, "30_outputs"), { recursive: true });
    writeFileSync(join(root, "10_raw/a.md"), "");
    writeFileSync(join(root, "10_raw/sub/b.md"), "");
    writeFileSync(join(root, "10_raw/skip.txt"), "");
    writeFileSync(join(root, "20_wiki/page.md"), "");
    writeFileSync(join(root, "30_outputs/answer.md"), "");

    const stats = buildWikiWorkspaceStats(makeRow(root));
    expect(stats.rawCount).toBe(2);
    expect(stats.wikiCount).toBe(1);
    expect(stats.outputCount).toBe(1);
  });
});
