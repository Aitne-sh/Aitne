import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../../db/schema.js";
import { createWikiRoutes } from "./wiki.js";
import type { ApiDependencies } from "../server.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..", "..", "..");

function makeDeps(db: Database.Database, dataDir: string): ApiDependencies {
  return {
    db,
    config: {
      dataDir,
      workspaceDir: REPO_ROOT,
      primaryLanguage: "en",
    },
    services: { obsidian: null },
  } as unknown as ApiDependencies;
}

describe("Wiki API routes", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-wiki-api-"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps wiki disabled until POST /wiki/workspaces enables it", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    const res = await app.request("/wiki/workspaces");

    expect(res.status).toBe(200);
    const initial = (await res.json()) as {
      workspaces: unknown[];
      defaultInternalRoot: string;
    };
    expect(initial.workspaces).toEqual([]);
    expect(initial.defaultInternalRoot).toBe(join(dataDir, "wiki"));

    const enable = await app.request("/wiki/workspaces", { method: "POST" });
    expect(enable.status).toBe(201);
    const enabledBody = (await enable.json()) as {
      workspace: { name: string; rootPath: string; kind: string };
    };
    expect(enabledBody.workspace).toMatchObject({
      name: "default",
      kind: "internal",
    });
    expect(existsSync(join(enabledBody.workspace.rootPath, "90_meta/taxonomy.md"))).toBe(true);
  });

  it("lists an enabled default internal workspace", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    const res = await app.request("/wiki/workspaces");
    const body = (await res.json()) as {
      workspaces: Array<{ name: string; rootPath: string; kind: string }>;
    };
    expect(body.workspaces[0]).toMatchObject({
      name: "default",
      kind: "internal",
    });
    expect(existsSync(join(body.workspaces[0].rootPath, "90_meta/taxonomy.md"))).toBe(true);
  });

  it("enforces process-key layer permissions for writes", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });

    const createRaw = await app.request("/wiki/default/files/10_raw/example.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.ingest_url",
      },
      body: JSON.stringify({ content: "# Example\n\nSource: https://example.com" }),
    });
    expect(createRaw.status).toBe(200);

    const duplicateRaw = await app.request("/wiki/default/files/10_raw/example.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.ingest_url",
      },
      body: JSON.stringify({ content: "# Example again" }),
    });
    expect(duplicateRaw.status).toBe(409);

    const deniedWiki = await app.request("/wiki/default/files/20_wiki/example.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.ingest_url",
      },
      body: JSON.stringify({ content: "# Example" }),
    });
    expect(deniedWiki.status).toBe(403);

    const allowedWiki = await app.request("/wiki/default/files/20_wiki/example.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.compile",
      },
      body: JSON.stringify({ content: "# Example" }),
    });
    expect(allowedWiki.status).toBe(200);
  });

  it("returns wiki_not_enabled when workspace is archived", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    await app.request("/wiki/workspaces/default/archive", { method: "POST" });

    const res = await app.request("/wiki/default/files/20_wiki/x.md", {
      headers: { "x-process-key": "message.dm" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toBe("wiki_not_enabled");
    expect(body.hint).toContain("/settings/wiki");
  });

  it("seeds the wiki with the design-default language and threshold", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    const res = await app.request("/wiki/workspaces");
    const body = (await res.json()) as {
      workspaces: Array<{ language: string; fullCompileApprovalThresholdUsd: number }>;
    };
    // §14 Q2 — wiki has its own language; never cascades from primaryLanguage.
    expect(body.workspaces[0]?.language).toBe("en");
    // §6.0 / §11 — default approval threshold is $2.00.
    expect(body.workspaces[0]?.fullCompileApprovalThresholdUsd).toBe(2);
  });

  it("records file writes under their originating process key", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    await app.request("/wiki/default/files/20_wiki/note.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.compile",
      },
      body: JSON.stringify({ content: "# Note" }),
    });
    const row = db
      .prepare(
        `SELECT action_type, json_extract(detail, '$.targets[0]') AS target,
                json_extract(detail, '$.bytes_written') AS bytes
         FROM agent_actions
         WHERE source_kind = 'wiki' AND source_ref = 'default'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { action_type: string; target: string; bytes: number };
    // §11.1 — `action_type = 'wiki.<command>'`; detail carries the touched
    // target path and the number of bytes written.
    expect(row.action_type).toBe("wiki.compile");
    expect(row.target).toBe("20_wiki/note.md");
    expect(row.bytes).toBeGreaterThan(0);
  });

  it("allows DM reads but requires x-process-key", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    await app.request("/wiki/default/files/20_wiki/readable.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.compile",
      },
      body: JSON.stringify({ content: "# Readable" }),
    });

    const missingHeader = await app.request("/wiki/default/files/20_wiki/readable.md");
    expect(missingHeader.status).toBe(403);

    const dmRead = await app.request("/wiki/default/files/20_wiki/readable.md", {
      headers: { "x-process-key": "message.dm" },
    });
    expect(dmRead.status).toBe(200);
    const body = (await dmRead.json()) as { content: string };
    expect(body.content).toContain("# Readable");

    const log = readFileSync(join(dataDir, "wiki", "log.md"), "utf-8");
    expect(log).toContain("wiki.compile post 20_wiki/readable.md");
  });

  // Regression: Hono 4.x does NOT populate `c.req.param("*")` for bare-`*`
  // wildcard routes. The wiki sub-app is mounted under `/api` in production,
  // so any handler that tried to recover the wildcard from `c.req.path`
  // returned 400 "Invalid wiki path" for every `/api/wiki/:ws/files/...`
  // request — surfacing as the "Recent activity" error on /wiki. The fix
  // moved the route to the named-param form (`:path{.+}`), which Hono
  // populates correctly. Mount the sub-app under `/api` (mirroring
  // `api/server.ts` exactly) so this case is exercised end-to-end.
  it("captures the path parameter when wiki routes are mounted under /api", async () => {
    const app = new Hono();
    app.route("/api", createWikiRoutes(makeDeps(db, dataDir)));
    await app.request("/api/wiki/workspaces", { method: "POST" });
    await app.request("/api/wiki/default/files/20_wiki/note.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.compile",
      },
      body: JSON.stringify({ content: "# Note" }),
    });

    // Single-segment wildcard — the exact path the dashboard's "Recent
    // activity" card hits. This was the original 400.
    const logRead = await app.request("/api/wiki/default/files/log.md", {
      headers: { "x-process-key": "message.dm" },
    });
    expect(logRead.status).toBe(200);
    const logBody = (await logRead.json()) as { path: string; content: string };
    expect(logBody.path).toBe("log.md");
    expect(logBody.content).toContain("wiki.compile post 20_wiki/note.md");

    // Multi-segment wildcard — confirms `:path{.+}` greedily captures
    // across `/` so `10_raw/<slug>.md` etc. still resolve.
    const noteRead = await app.request("/api/wiki/default/files/20_wiki/note.md", {
      headers: { "x-process-key": "message.dm" },
    });
    expect(noteRead.status).toBe(200);
    const noteBody = (await noteRead.json()) as { path: string };
    expect(noteBody.path).toBe("20_wiki/note.md");
  });

  it("rejects external-mode probe when path overlaps dataDir", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    const res = await app.request("/wiki/workspaces/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: dataDir }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(["overlaps_data_dir", "overlaps_primary_vault", "not_directory"]).toContain(body.error);
  });

  it("creates an external workspace via /wiki/workspaces with kind=external", async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), "pa-wiki-external-target-"));
    try {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      const res = await app.request("/wiki/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "external", rootPath: externalRoot }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        workspace: {
          name: string;
          kind: string;
          rootPath: string;
          writeStrategy: string;
        };
      };
      expect(body.workspace).toMatchObject({
        kind: "external",
        writeStrategy: "auto",
      });
      // Seed files were written into the external root.
      expect(existsSync(join(body.workspace.rootPath, "90_meta/taxonomy.md"))).toBe(true);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("exposes /estimate with the per-workspace threshold and counts", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    const res = await app.request("/wiki/default/estimate", {
      headers: { "x-process-key": "wiki.compile" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspace: string;
      estimate: { rawCount: number; thresholdUsd: number };
    };
    expect(body.workspace).toBe("default");
    expect(body.estimate.thresholdUsd).toBe(2);
    expect(body.estimate.rawCount).toBe(0);
  });

  it("returns wiki_not_enabled from /estimate when archived", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    await app.request("/wiki/workspaces/default/archive", { method: "POST" });
    const res = await app.request("/wiki/default/estimate", {
      headers: { "x-process-key": "wiki.compile" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("wiki_not_enabled");
  });

  it("returns import plan + outcome via /import endpoints", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    const planRes = await app.request("/wiki/default/import/plan", {
      headers: { "x-process-key": "wiki.compile" },
    });
    expect(planRes.status).toBe(200);
    const planBody = (await planRes.json()) as {
      probe: { kind: string };
      plan: { flattenMoves: unknown[]; frontmatterMigrations: unknown[] };
    };
    // A freshly-seeded internal workspace already has 00_inbox/, 10_raw/,
    // 20_wiki/, 30_outputs/, 90_meta/ — that's a full layered vault, so
    // the probe classifies it as kind=wiki rather than kind=empty.
    expect(planBody.probe.kind).toBe("wiki");
    expect(planBody.plan.flattenMoves).toEqual([]);

    const applyRes = await app.request("/wiki/default/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.compile",
      },
      body: JSON.stringify({ dateStamp: "2026-05-12" }),
    });
    expect(applyRes.status).toBe(200);
  });

  it("rejects /import/apply without a wiki process key", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    const applyRes = await app.request("/wiki/default/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "message.dm",
      },
      body: JSON.stringify({}),
    });
    expect(applyRes.status).toBe(403);
  });

  it("/index serves the cached _index.md catalog alongside the file listing", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    // Replace the seeded `_index.md` so we can detect a fresh read.
    await app.request("/wiki/default/files/20_wiki/_index.md", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.compile",
      },
      body: JSON.stringify({ content: "# Custom Index\n- one\n- two\n" }),
    });
    const res = await app.request("/wiki/default/index", {
      headers: { "x-process-key": "message.dm" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      indexFile: { exists: boolean; content: string | null };
      files: Array<{ path: string }>;
    };
    expect(body.indexFile.exists).toBe(true);
    expect(body.indexFile.content).toContain("# Custom Index");
    // The file listing remains for back-compat with the DM-agent
    // discovery flow.
    expect(body.files.some((f) => f.path === "20_wiki/_index.md")).toBe(true);
  });

  // ── WIKI_BUILDER_DESIGN.md Phase 3 — operational triad layer auth ──

  it("authorizes wiki.lint to write the dated health report and taxonomy candidates", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });

    // wiki.lint must be allowed to write `90_meta/health/<date>.md`.
    const writeHealth = await app.request(
      "/wiki/default/files/90_meta/health/2026-05-12.md",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-process-key": "wiki.lint",
        },
        body: JSON.stringify({
          content:
            "# Wiki Health — 2026-05-12\n\n## Summary\n- 0 orphans\n\n## Action items\n- none\n",
        }),
      },
    );
    expect(writeHealth.status).toBe(200);

    // wiki.lint may PATCH `90_meta/taxonomy.md` with its `# Candidates` section.
    const patchTaxonomy = await app.request("/wiki/default/files/90_meta/taxonomy.md", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.lint",
      },
      body: JSON.stringify({ mode: "append", content: "\n# Candidates\n- foo\n" }),
    });
    expect(patchTaxonomy.status).toBe(200);

    // The DM-read process keys must still NOT be able to write health files.
    const deniedDm = await app.request(
      "/wiki/default/files/90_meta/health/2026-05-13.md",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-process-key": "message.dm",
        },
        body: JSON.stringify({ content: "# Wiki Health\n" }),
      },
    );
    expect(deniedDm.status).toBe(403);
  });

  it("authorizes wiki.trace and wiki.connect to write dated output files", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });

    const writeTrace = await app.request(
      "/wiki/default/files/30_outputs/2026-05-12-trace-quantum-computing.md",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-process-key": "wiki.trace",
        },
        body: JSON.stringify({ content: "# Trace — Quantum Computing\n" }),
      },
    );
    expect(writeTrace.status).toBe(200);

    const writeConnect = await app.request(
      "/wiki/default/files/30_outputs/2026-05-12-connect-quantum--classical.md",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-process-key": "wiki.connect",
        },
        body: JSON.stringify({ content: "# Connect — Quantum ↔ Classical\n" }),
      },
    );
    expect(writeConnect.status).toBe(200);

    // wiki.lint must NOT be able to write the output layer — that
    // surface is owned by wiki.ask / wiki.trace / wiki.connect.
    const deniedLint = await app.request(
      "/wiki/default/files/30_outputs/2026-05-12-trace-x.md",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-process-key": "wiki.lint",
        },
        body: JSON.stringify({ content: "# x\n" }),
      },
    );
    expect(deniedLint.status).toBe(403);
  });

  it("round-trips a health report write → GET → contents preserved", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });

    const reportPath = "90_meta/health/2026-05-12.md";
    const reportBody = [
      "# Wiki Health — 2026-05-12",
      "",
      "## Summary",
      "- 1 orphan, 0 broken links",
      "",
      "## Action items",
      "- Re-link `20_wiki/orphan.md`",
      "",
    ].join("\n");

    const write = await app.request(`/wiki/default/files/${reportPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-process-key": "wiki.lint",
      },
      body: JSON.stringify({ content: reportBody }),
    });
    expect(write.status).toBe(200);

    // wiki.* GETs always pass (any wiki process key reads any layer).
    const read = await app.request(`/wiki/default/files/${reportPath}`, {
      headers: { "x-process-key": "wiki.ask" },
    });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      path: string;
      content: string;
      sizeBytes: number;
    };
    expect(readBody.path).toBe(reportPath);
    expect(readBody.content).toContain("# Wiki Health — 2026-05-12");
    expect(readBody.content).toContain("## Action items");
    expect(readBody.content).toContain("Re-link `20_wiki/orphan.md`");

    // The report must surface in /index so the dashboard timeline
    // page can find it via `findLatestHealthReportPath`.
    const index = await app.request("/wiki/default/index", {
      headers: { "x-process-key": "wiki.ask" },
    });
    expect(index.status).toBe(200);
    const indexBody = (await index.json()) as {
      files: Array<{ path: string }>;
    };
    expect(indexBody.files.some((f) => f.path === reportPath)).toBe(true);

    // The write must appear in log.md as a `wiki.lint post …` line so
    // the activity timeline can render it.
    const logRead = await app.request("/wiki/default/files/log.md", {
      headers: { "x-process-key": "wiki.ask" },
    });
    expect(logRead.status).toBe(200);
    const logBody = (await logRead.json()) as { content: string };
    expect(logBody.content).toMatch(/wiki\.lint post 90_meta\/health\/2026-05-12\.md/);
  });

  it("PATCH supports new writeStrategy and gitPreCompileEnabled fields", async () => {
    const app = createWikiRoutes(makeDeps(db, dataDir));
    await app.request("/wiki/workspaces", { method: "POST" });
    const patchRes = await app.request("/wiki/workspaces/default", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        writeStrategy: "cli",
        gitPreCompileEnabled: false,
      }),
    });
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as {
      workspace: { writeStrategy: string; gitPreCompileEnabled: boolean };
    };
    expect(body.workspace.writeStrategy).toBe("cli");
    expect(body.workspace.gitPreCompileEnabled).toBe(false);
  });

  // ── P4.A — FTS5 search ──────────────────────────────────────────────────
  describe("P4.A FTS search", () => {
    it("indexes wiki writes and returns matches ranked by relevance", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/20_wiki/quantum.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ content: "# Quantum Computing\n\nQubits and superposition.\n" }),
      });
      await app.request("/wiki/default/files/20_wiki/classical.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ content: "# Classical Computing\n\nBinary logic.\n" }),
      });
      const search = await app.request("/wiki/default/search?q=quantum&kind=fts", {
        headers: { "x-process-key": "message.dm" },
      });
      expect(search.status).toBe(200);
      const body = (await search.json()) as {
        kind: string;
        results: Array<{ path: string; title: string }>;
      };
      expect(body.kind).toBe("fts");
      expect(body.results[0].path).toBe("20_wiki/quantum.md");
    });

    it("falls back to grep mode when the caller asks for it", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/20_wiki/foo.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ content: "# Foo\n\nNeedle in haystack.\n" }),
      });
      const search = await app.request("/wiki/default/search?q=needle&kind=grep", {
        headers: { "x-process-key": "message.dm" },
      });
      const body = (await search.json()) as { kind: string; results: unknown[] };
      expect(body.kind).toBe("grep");
      expect(body.results.length).toBeGreaterThan(0);
    });

    it("PATCH refreshes the FTS row (delete-then-insert)", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/20_wiki/page.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ content: "# Page\n\nfirstword content.\n" }),
      });
      await app.request("/wiki/default/files/20_wiki/page.md", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ mode: "append", content: "\nsecondword content.\n" }),
      });
      const firstResult = await app.request("/wiki/default/search?q=firstword", {
        headers: { "x-process-key": "message.dm" },
      });
      const secondResult = await app.request("/wiki/default/search?q=secondword", {
        headers: { "x-process-key": "message.dm" },
      });
      const firstBody = (await firstResult.json()) as { results: unknown[] };
      const secondBody = (await secondResult.json()) as { results: unknown[] };
      // Both terms must hit because PATCH = append; the upsert replaces
      // the row with the concatenated body.
      expect(firstBody.results.length).toBeGreaterThan(0);
      expect(secondBody.results.length).toBeGreaterThan(0);
    });

    it("archiving a workspace clears its FTS rows", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/20_wiki/page.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ content: "# Page\n\nbody.\n" }),
      });
      const count = (
        db.prepare(`SELECT COUNT(*) AS n FROM fts_wiki`).get() as { n: number }
      ).n;
      expect(count).toBeGreaterThan(0);
      await app.request("/wiki/workspaces/default/archive", { method: "POST" });
      const after = (
        db.prepare(`SELECT COUNT(*) AS n FROM fts_wiki`).get() as { n: number }
      ).n;
      expect(after).toBe(0);
    });

    it("POST /wiki/:ws/reindex rebuilds the FTS from disk", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/20_wiki/x.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.compile" },
        body: JSON.stringify({ content: "# X\n\nbody.\n" }),
      });
      db.prepare(`DELETE FROM fts_wiki`).run();
      const reindex = await app.request("/wiki/default/reindex", {
        method: "POST",
        headers: { "x-process-key": "wiki.compile" },
      });
      expect(reindex.status).toBe(200);
      const body = (await reindex.json()) as { indexed: number };
      expect(body.indexed).toBeGreaterThanOrEqual(1);
      const count = (
        db.prepare(`SELECT COUNT(*) AS n FROM fts_wiki`).get() as { n: number }
      ).n;
      expect(count).toBeGreaterThan(0);
    });

    it("rejects /reindex from DM-tier callers", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      const res = await app.request("/wiki/default/reindex", {
        method: "POST",
        headers: { "x-process-key": "message.dm" },
      });
      expect(res.status).toBe(403);
    });
  });

  // ── P4.B — compile diff preview ─────────────────────────────────────────
  describe("P4.B compile preview", () => {
    it("exposes the touch set, cost estimate, and duration", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/10_raw/seed.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.ingest_url" },
        body: JSON.stringify({ content: "# Seed\n\nbody about something.\n" }),
      });
      const res = await app.request("/wiki/default/compile/preview?mode=full", {
        headers: { "x-process-key": "wiki.compile" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        preview: {
          added: string[];
          modified: string[];
          unchanged: string[];
          estimate: { rawCount: number; expectedUsd: number };
          estimatedDurationSeconds: number;
        };
      };
      expect(body.preview.added).toContain("20_wiki/seed.md");
      expect(body.preview.estimate.rawCount).toBe(1);
      expect(body.preview.estimatedDurationSeconds).toBeGreaterThanOrEqual(0);
    });

    it("rejects /compile/preview without a wiki process key", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      const res = await app.request("/wiki/default/compile/preview");
      expect(res.status).toBe(403);
    });
  });

  // ── P4.C — token-level estimate ─────────────────────────────────────────
  describe("P4.C estimate strategies", () => {
    it("defaults to per-file-chars and reports the method on the response", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/default/files/10_raw/a.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "wiki.ingest_url" },
        body: JSON.stringify({ content: "a".repeat(2_000) }),
      });
      const res = await app.request("/wiki/default/estimate", {
        headers: { "x-process-key": "wiki.compile" },
      });
      const body = (await res.json()) as {
        estimate: { method: string; perFile: Array<{ path: string }> };
      };
      expect(body.estimate.method).toBe("per-file-chars");
      expect(body.estimate.perFile.map((f) => f.path)).toContain("10_raw/a.md");
    });

    it("?strategy=flat returns the legacy flat-heuristic estimate", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      const res = await app.request("/wiki/default/estimate?strategy=flat", {
        headers: { "x-process-key": "wiki.compile" },
      });
      const body = (await res.json()) as {
        estimate: { method: string; perFile: unknown[] };
      };
      expect(body.estimate.method).toBe("flat-heuristic");
      expect(body.estimate.perFile).toEqual([]);
    });
  });

  // ── Phase 5 — bridge + multi-workspace ────────────────────────────
  describe("P5 bridge endpoint", () => {
    async function enableAndConfigureBridge(
      app: ReturnType<typeof createWikiRoutes>,
      patch: Record<string, unknown> = {},
    ) {
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/workspaces/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dmAgentWriteEnabled: true,
          bridgeEnabled: true,
          bridgeMeasurementOnly: false,
          ...patch,
        }),
      });
    }

    function bridgeBody() {
      return {
        trigger: "explicit" as const,
        summary: "Cross-conversation insight A",
        excerpt: "Verbatim excerpt A — distinct content.",
        sourceKind: "dm",
        sourceRef: "session-A:msg-1",
      };
    }

    it("rejects bridge POST when dm_agent_write_enabled is off", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      // bridgeEnabled true, but dmAgentWriteEnabled stays false (default)
      await app.request("/wiki/workspaces/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bridgeEnabled: true, bridgeMeasurementOnly: false }),
      });
      const res = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify(bridgeBody()),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("dm_write_disabled");
    });

    it("rejects bridge POST when bridge_enabled is off", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/workspaces/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dmAgentWriteEnabled: true }),
      });
      const res = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify(bridgeBody()),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("bridge_feature_disabled");
    });

    it("rejects bridge POST without x-process-key", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      const res = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bridgeBody()),
      });
      expect(res.status).toBe(403);
    });

    it("rejects bridge POST from non-DM/non-wiki process keys", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      const res = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "routine.morning_routine" },
        body: JSON.stringify(bridgeBody()),
      });
      expect(res.status).toBe(403);
    });

    it("writes a bridge file when both toggles + DM process key + measurement-off", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      const res = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify(bridgeBody()),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        result: { outcome: string; path: string | null; contentHash: string };
      };
      expect(body.result.outcome).toBe("written");
      expect(body.result.path).toMatch(/^10_raw\/bridge-.*\.md$/);
      expect(existsSync(join(dataDir, "wiki", body.result.path!))).toBe(true);
    });

    it("dedups a repeat proposal back to the same content_hash", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      const first = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify(bridgeBody()),
      });
      const firstBody = (await first.json()) as { result: { path: string | null } };
      const second = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        // Same summary/excerpt, different source provenance.
        body: JSON.stringify({ ...bridgeBody(), sourceRef: "session-B:msg-9" }),
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as {
        result: { outcome: string; existingPath: string };
      };
      expect(body.result.outcome).toBe("deduplicated");
      expect(body.result.existingPath).toBe(firstBody.result.path);
    });

    it("measurement-only mode logs candidate and does not write the file", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      await app.request("/wiki/workspaces/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dmAgentWriteEnabled: true,
          bridgeEnabled: true,
          bridgeMeasurementOnly: true,
        }),
      });
      const res = await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify(bridgeBody()),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { outcome: string; measurementOnly: boolean; path: string | null };
      };
      expect(body.result.outcome).toBe("candidate_logged");
      expect(body.result.measurementOnly).toBe(true);
      expect(body.result.path).toBeNull();

      // Bridge listing exposes the candidate row.
      const list = await app.request("/wiki/default/bridge", {
        headers: { "x-process-key": "message.dm" },
      });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as {
        entries: Array<{ actionType: string; outcome: string }>;
      };
      expect(listed.entries[0]?.actionType).toBe("wiki.bridge.candidate");
    });

    it("rejects DM-agent POST /files/10_raw/bridge-*.md when bridge_enabled is off (two-key)", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await app.request("/wiki/workspaces", { method: "POST" });
      // dmAgentWriteEnabled ON, bridgeEnabled OFF
      await app.request("/wiki/workspaces/default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dmAgentWriteEnabled: true }),
      });
      const res = await app.request(
        "/wiki/default/files/10_raw/bridge-2026-05-12-101530-x.md",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
          body: JSON.stringify({ content: "# bridge" }),
        },
      );
      expect(res.status).toBe(403);
    });

    it("accepts DM-agent POST /files/10_raw/bridge-*.md when BOTH toggles are on", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      const res = await app.request(
        "/wiki/default/files/10_raw/bridge-2026-05-12-101530-x.md",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
          body: JSON.stringify({ content: "# bridge\n" }),
        },
      );
      expect(res.status).toBe(200);
    });

    it("still rejects DM-agent POST to non-bridge raw paths even with both toggles on", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      const res = await app.request("/wiki/default/files/10_raw/non-bridge.md", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify({ content: "# raw\n" }),
      });
      expect(res.status).toBe(403);
    });

    it("serialises bridgeStats with written + candidate counts", async () => {
      const app = createWikiRoutes(makeDeps(db, dataDir));
      await enableAndConfigureBridge(app);
      await app.request("/wiki/default/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-process-key": "message.dm" },
        body: JSON.stringify(bridgeBody()),
      });
      const res = await app.request("/wiki/workspaces");
      const body = (await res.json()) as {
        workspaces: Array<{ bridgeStats: { written: number; candidates: number } }>;
      };
      expect(body.workspaces[0]?.bridgeStats.written).toBe(1);
      expect(body.workspaces[0]?.bridgeStats.candidates).toBe(0);
    });
  });

  describe("P5 multi-workspace", () => {
    it("creates two active workspaces side-by-side (no single-active constraint)", async () => {
      const externalRoot = mkdtempSync(join(tmpdir(), "pa-wiki-multi-"));
      try {
        const app = createWikiRoutes(makeDeps(db, dataDir));
        // Default (internal) first.
        await app.request("/wiki/workspaces", { method: "POST" });
        // Then a named external workspace.
        const res = await app.request("/wiki/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "external",
            rootPath: externalRoot,
            name: "research",
          }),
        });
        expect(res.status).toBe(201);

        const list = await app.request("/wiki/workspaces");
        const body = (await list.json()) as {
          workspaces: Array<{ name: string; active: boolean }>;
        };
        const active = body.workspaces.filter((row) => row.active);
        expect(active.length).toBe(2);
        expect(active.map((row) => row.name).sort()).toEqual(["default", "research"]);
      } finally {
        rmSync(externalRoot, { recursive: true, force: true });
      }
    });

    it("PATCH ?active=false archives one workspace without affecting the other", async () => {
      const externalRoot = mkdtempSync(join(tmpdir(), "pa-wiki-archive-"));
      try {
        const app = createWikiRoutes(makeDeps(db, dataDir));
        await app.request("/wiki/workspaces", { method: "POST" });
        await app.request("/wiki/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "external", rootPath: externalRoot, name: "ops" }),
        });
        await app.request("/wiki/workspaces/ops", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: false }),
        });
        const list = await app.request("/wiki/workspaces");
        const body = (await list.json()) as {
          workspaces: Array<{ name: string; active: boolean }>;
        };
        const defaultRow = body.workspaces.find((row) => row.name === "default");
        const opsRow = body.workspaces.find((row) => row.name === "ops");
        expect(defaultRow?.active).toBe(true);
        expect(opsRow?.active).toBe(false);
      } finally {
        rmSync(externalRoot, { recursive: true, force: true });
      }
    });
  });
});
