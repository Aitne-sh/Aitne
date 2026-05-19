import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { createFsRoutes } from "./fs.js";
import type { ApiDependencies } from "../server.js";

function makeDeps(db: Database.Database, dataDir: string): ApiDependencies {
  return {
    db,
    config: {
      dataDir,
      workspaceDir: ".",
      primaryLanguage: "en",
    },
    services: { obsidian: null },
  } as unknown as ApiDependencies;
}

describe("GET /fs/probe", () => {
  let db: Database.Database;
  let dataDir: string;
  let scratch: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-fs-data-"));
    scratch = mkdtempSync(join(tmpdir(), "pa-fs-scratch-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("returns 400 when path is missing", async () => {
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_path");
  });

  it("returns 400 for a relative path", async () => {
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=Documents/foo");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      exists: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("relative_path");
    expect(body.exists).toBe(false);
  });

  it("returns 400 for a forbidden system prefix", async () => {
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent("/etc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden_prefix");
  });

  it("returns 400 for a secret-shape path", async () => {
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request(
      "/fs/probe?path=" + encodeURIComponent("/Users/alice/.ssh"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("secret_path");
  });

  it("reports exists=false for a not-yet-created path", async () => {
    const fake = join(scratch, "future-vault");
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(fake));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      exists: boolean;
      isDir: boolean;
      writable: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.exists).toBe(false);
    expect(body.isDir).toBe(false);
    expect(body.writable).toBe(false);
  });

  it("reports writable=true for an existing empty directory", async () => {
    const dir = join(scratch, "empty");
    mkdirSync(dir);
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(dir));
    const body = (await res.json()) as {
      exists: boolean;
      isDir: boolean;
      writable: boolean;
      existingWiki: unknown;
      hasObsidianStructure: boolean;
    };
    expect(body.exists).toBe(true);
    expect(body.isDir).toBe(true);
    expect(body.writable).toBe(true);
    expect(body.existingWiki).toBeNull();
    expect(body.hasObsidianStructure).toBe(false);
  });

  it("reports isDir=false when the path exists as a regular file", async () => {
    const filePath = join(scratch, "regular.txt");
    writeFileSync(filePath, "hi");
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(filePath));
    const body = (await res.json()) as {
      exists: boolean;
      isDir: boolean;
      writable: boolean;
    };
    expect(body.exists).toBe(true);
    expect(body.isDir).toBe(false);
    expect(body.writable).toBe(false);
  });

  it("detects an .obsidian directory marker", async () => {
    const dir = join(scratch, "vault");
    mkdirSync(join(dir, ".obsidian"), { recursive: true });
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(dir));
    const body = (await res.json()) as { hasObsidianStructure: boolean };
    expect(body.hasObsidianStructure).toBe(true);
  });

  it("detects an existing LLM-Wiki layout (two or more layer dirs)", async () => {
    const dir = join(scratch, "wiki-vault");
    mkdirSync(join(dir, "10_raw"), { recursive: true });
    mkdirSync(join(dir, "20_wiki"), { recursive: true });
    mkdirSync(join(dir, "90_meta"), { recursive: true });
    writeFileSync(join(dir, "10_raw", "example.md"), "---\ntitle: x\n---\n");
    writeFileSync(join(dir, "20_wiki", "page.md"), "---\ntitle: y\n---\n");
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(dir));
    const body = (await res.json()) as {
      existingWiki: { kind: string; layers: string[] } | null;
    };
    expect(body.existingWiki).not.toBeNull();
    expect(body.existingWiki?.kind).toBe("wiki");
    expect(body.existingWiki?.layers).toEqual(
      expect.arrayContaining(["10_raw", "20_wiki", "90_meta"]),
    );
  });

  it("flags `data_dir` collision when probing inside the daemon's runtime tree", async () => {
    // Probing `dataDir` itself overlaps the daemon's runtime tree
    // (context/, sqlite, snapshots, …). `validateWikiRootPath`
    // composes `validatePrimaryVaultPath`, which emits
    // `overlaps_data_dir` for this case.
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(dataDir));
    const body = (await res.json()) as { collision: string | null };
    expect(body.collision).toBe("data_dir");
  });

  it("flags `primary_vault` collision against config.primaryVaultPath", async () => {
    const primary = join(scratch, "primary-vault");
    mkdirSync(primary);
    const deps = {
      db,
      config: {
        dataDir,
        workspaceDir: ".",
        primaryLanguage: "en",
        primaryVaultPath: primary,
      },
      services: { obsidian: null },
    } as unknown as ApiDependencies;
    const app = createFsRoutes(deps);
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(primary));
    const body = (await res.json()) as { collision: string | null };
    // Wiki validator's overlap check fires before the primary-vault
    // validator gets to `overlaps_data_dir`, so the chosen path
    // resolves to `primary_vault` first.
    expect(body.collision).toBe("primary_vault");
  });

  it("flags `external_obsidian` collision against config.externalObsidianVaultPath", async () => {
    const external = join(scratch, "external-obsidian");
    mkdirSync(external);
    const deps = {
      db,
      config: {
        dataDir,
        workspaceDir: ".",
        primaryLanguage: "en",
        externalObsidianVaultPath: external,
      },
      services: { obsidian: null },
    } as unknown as ApiDependencies;
    const app = createFsRoutes(deps);
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(external));
    const body = (await res.json()) as { collision: string | null };
    expect(body.collision).toBe("external_obsidian");
  });

  it("flags `other_wiki` collision when an active workspace already owns the path", async () => {
    const existingRoot = join(scratch, "first-wiki");
    mkdirSync(existingRoot);
    // Insert a fake `wiki_workspaces` row directly so the test does
    // not have to go through the full create flow.
    db.prepare(
      `INSERT INTO wiki_workspaces (
         name, kind, root_path, language, dispatch_mode, concurrency_cap,
         dm_agent_write_enabled, bridge_enabled, bridge_measurement_only,
         bridge_min_confidence, full_compile_approval_threshold_usd,
         write_strategy, git_pre_compile_enabled, schema_version, active
       ) VALUES (?, 'external', ?, 'en', 'parallel', 3, 0, 0, 0, 0.7, 2.0, 'auto', 0, 1, 1)`,
    ).run("test-existing", existingRoot);

    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent(existingRoot));
    const body = (await res.json()) as { collision: string | null };
    expect(body.collision).toBe("other_wiki");
  });

  it("returns 400 for a forbidden path with structured body", async () => {
    const app = createFsRoutes(makeDeps(db, dataDir));
    const res = await app.request("/fs/probe?path=" + encodeURIComponent("/etc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      exists: boolean;
      writable: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("forbidden_prefix");
    expect(body.exists).toBe(false);
    expect(body.writable).toBe(false);
  });
});
