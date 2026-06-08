import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  backfillWikiFulltext,
  classifyWikiPathForFts,
  deleteWikiFulltextRow,
  deleteWikiFulltextWorkspace,
  reindexWikiWorkspace,
  searchWikiFulltext,
  upsertWikiFulltextRow,
} from "./wiki-fts.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

function makeRow(id: number, rootPath: string, name = "default"): WikiWorkspaceRow {
  return {
    id,
    name,
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
    last_ingest_at: null,
    last_compile_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe("wiki-fts", () => {
  let db: Database.Database;
  let rootPath: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-fts-"));
    mkdirSync(join(rootPath, "10_raw"), { recursive: true });
    mkdirSync(join(rootPath, "20_wiki"), { recursive: true });
    mkdirSync(join(rootPath, "30_outputs"), { recursive: true });
    mkdirSync(join(rootPath, "90_meta"), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(rootPath, { recursive: true, force: true });
  });

  describe("upsertWikiFulltextRow", () => {
    it("inserts a row with extracted title and body", () => {
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/foo.md",
        layer: "wiki",
        content: "---\ntype: concept\n---\n# Foo\n\nBody about quantum mechanics.\n",
      });
      const row = db
        .prepare(`SELECT title, body, layer FROM fts_wiki WHERE workspace_id = ? AND path = ?`)
        .get(1, "20_wiki/foo.md") as { title: string; body: string; layer: string };
      expect(row.title).toBe("Foo");
      expect(row.body).toContain("quantum mechanics");
      expect(row.body).not.toContain("type: concept");
      expect(row.layer).toBe("wiki");
    });

    it("uses frontmatter title as fallback when no H1 is present", () => {
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/notitle.md",
        layer: "wiki",
        content: "---\ntitle: Frontmatter Title\n---\nJust body text.\n",
      });
      const row = db
        .prepare(`SELECT title FROM fts_wiki WHERE path = ?`)
        .get("20_wiki/notitle.md") as { title: string };
      expect(row.title).toBe("Frontmatter Title");
    });

    it("strips CRLF frontmatter and keeps the title fallback (Windows/autocrlf vaults)", () => {
      // Obsidian files authored/synced on Windows are CRLF; the LF-only
      // fence gate would otherwise index the whole `---\r\n…---\r\n` block
      // as body and never populate the title fallback.
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/crlf.md",
        layer: "wiki",
        content: "---\r\ntitle: Frontmatter Title\r\n---\r\nJust body text.\r\n",
      });
      const row = db
        .prepare(`SELECT title, body FROM fts_wiki WHERE path = ?`)
        .get("20_wiki/crlf.md") as { title: string; body: string };
      expect(row.title).toBe("Frontmatter Title");
      expect(row.body).toContain("Just body text");
      expect(row.body).not.toContain("title:");
    });

    it("acts as upsert: re-upserting the same path replaces the previous row", () => {
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/foo.md",
        layer: "wiki",
        content: "# Foo\n\nv1 body.",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/foo.md",
        layer: "wiki",
        content: "# Foo\n\nv2 body.",
      });
      const rows = db
        .prepare(`SELECT body FROM fts_wiki WHERE workspace_id = ? AND path = ?`)
        .all(1, "20_wiki/foo.md") as Array<{ body: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toContain("v2 body");
    });

    it("skips log.md and 00_inbox so noise stays out of search", () => {
      // Pre-seed a row to verify the layer guard also evicts existing rows.
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "log.md",
        layer: "wiki",
        content: "stale",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "log.md",
        layer: "log",
        content: "- new log entry",
      });
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM fts_wiki WHERE path = ?`)
        .get("log.md") as { n: number };
      expect(count.n).toBe(0);
    });
  });

  describe("searchWikiFulltext", () => {
    beforeEach(() => {
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/quantum.md",
        layer: "wiki",
        content: "# Quantum Computing\n\nQubits and superposition.",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/classical.md",
        layer: "wiki",
        content: "# Classical Computing\n\nBits and binary logic.",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "10_raw/seed.md",
        layer: "raw",
        content: "# Seed\n\nQuantum source citation.",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 2,
        path: "20_wiki/foreign.md",
        layer: "wiki",
        content: "# Quantum\n\nDifferent workspace.",
      });
    });

    it("returns matches ranked by bm25 with title weighted heavier than body", () => {
      const results = searchWikiFulltext(db, 1, "quantum");
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Title match should rank above body-only match.
      expect(results[0].path).toBe("20_wiki/quantum.md");
    });

    it("ranks a title-only match above a body-only match (boost is actually applied)", () => {
      // Regression test for a misaligned bm25() weight vector: the original
      // `bm25(fts_wiki, 3.0, 1.0)` shorthand was applying weights to
      // UNINDEXED columns (workspace_id, path), leaving title at the
      // default 1.0 and silently dropping the boost. The two probes have
      // a single "rust" occurrence each — one in title, one in body — so
      // the only differentiator between them is the BM25 column weight.
      // Decoy documents keep BM25's IDF positive (with only 2 docs both
      // containing the term, IDF flips negative and inverts ordering).
      const ws = 99;
      upsertWikiFulltextRow(db, {
        workspaceId: ws,
        path: "20_wiki/title-only.md",
        layer: "wiki",
        content: "# rust\n\nthe body talks about something else entirely here.",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: ws,
        path: "20_wiki/body-only.md",
        layer: "wiki",
        content: "# Topic\n\nthe body mentions rust just once and moves on here.",
      });
      for (let i = 0; i < 5; i += 1) {
        upsertWikiFulltextRow(db, {
          workspaceId: ws,
          path: `20_wiki/decoy-${i}.md`,
          layer: "wiki",
          content: `# Decoy ${i}\n\nUnrelated filler keeps the IDF positive.`,
        });
      }
      const results = searchWikiFulltext(db, ws, "rust");
      expect(results.map((r) => r.path)).toEqual([
        "20_wiki/title-only.md",
        "20_wiki/body-only.md",
      ]);
    });

    it("scopes by workspace_id", () => {
      const results = searchWikiFulltext(db, 2, "quantum");
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("20_wiki/foreign.md");
    });

    it("filters by layer when requested", () => {
      const results = searchWikiFulltext(db, 1, "quantum", { layer: "raw" });
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("10_raw/seed.md");
    });

    it("treats reserved FTS5 operator tokens as literal terms", () => {
      // Without quoting these would parse as boolean operators and either
      // throw or change semantics. The route must not crash on user input.
      const ok = () => searchWikiFulltext(db, 1, "AND OR NOT");
      expect(ok).not.toThrow();
    });

    it("returns empty for empty/whitespace queries (FTS5 rejects empty MATCH)", () => {
      expect(searchWikiFulltext(db, 1, "")).toEqual([]);
      expect(searchWikiFulltext(db, 1, "   ")).toEqual([]);
    });

    it("respects the limit option", () => {
      const results = searchWikiFulltext(db, 1, "computing", { limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  describe("deletion paths", () => {
    beforeEach(() => {
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/a.md",
        layer: "wiki",
        content: "# A\n\nbody",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 1,
        path: "20_wiki/b.md",
        layer: "wiki",
        content: "# B\n\nbody",
      });
      upsertWikiFulltextRow(db, {
        workspaceId: 2,
        path: "20_wiki/c.md",
        layer: "wiki",
        content: "# C\n\nbody",
      });
    });

    it("deleteWikiFulltextRow removes a single row by path", () => {
      deleteWikiFulltextRow(db, 1, "20_wiki/a.md");
      const remaining = db
        .prepare(`SELECT path FROM fts_wiki WHERE workspace_id = 1 ORDER BY path`)
        .all() as Array<{ path: string }>;
      expect(remaining.map((r) => r.path)).toEqual(["20_wiki/b.md"]);
    });

    it("deleteWikiFulltextWorkspace removes all rows for one workspace only", () => {
      deleteWikiFulltextWorkspace(db, 1);
      const left = db.prepare(`SELECT path FROM fts_wiki`).all() as Array<{ path: string }>;
      expect(left.map((r) => r.path)).toEqual(["20_wiki/c.md"]);
    });
  });

  describe("reindexWikiWorkspace", () => {
    it("walks the on-disk tree and rebuilds the index for one workspace", () => {
      writeFileSync(join(rootPath, "10_raw/source.md"), "# Source\n\nraw note.");
      writeFileSync(join(rootPath, "20_wiki/page.md"), "# Page\n\nwiki page.");
      writeFileSync(join(rootPath, "log.md"), "log entry");
      const workspace = makeRow(1, rootPath);
      const outcome = reindexWikiWorkspace(db, workspace);
      expect(outcome.indexed).toBe(2); // log.md is skipped
      expect(outcome.skipped).toBeGreaterThanOrEqual(1);

      const ftsCount = db
        .prepare(`SELECT COUNT(*) AS n FROM fts_wiki WHERE workspace_id = 1`)
        .get() as { n: number };
      expect(ftsCount.n).toBe(2);
    });

    it("excludes .snapshots/ from indexing", () => {
      mkdirSync(join(rootPath, ".snapshots/2026-05-12"), { recursive: true });
      writeFileSync(join(rootPath, ".snapshots/2026-05-12/old.md"), "# Old");
      writeFileSync(join(rootPath, "20_wiki/page.md"), "# Page");
      const workspace = makeRow(1, rootPath);
      reindexWikiWorkspace(db, workspace);
      const results = db
        .prepare(`SELECT path FROM fts_wiki WHERE workspace_id = 1`)
        .all() as Array<{ path: string }>;
      expect(results.map((r) => r.path).sort()).toEqual(["20_wiki/page.md"]);
    });

    it("is idempotent — calling twice produces the same row count", () => {
      writeFileSync(join(rootPath, "20_wiki/page.md"), "# Page\n\nbody.");
      const workspace = makeRow(1, rootPath);
      reindexWikiWorkspace(db, workspace);
      reindexWikiWorkspace(db, workspace);
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM fts_wiki`)
        .get() as { n: number };
      expect(count.n).toBe(1);
    });
  });

  describe("backfillWikiFulltext", () => {
    it("only seeds workspaces with empty FTS rows", () => {
      writeFileSync(join(rootPath, "20_wiki/page.md"), "# Page");
      const workspace = makeRow(1, rootPath);
      backfillWikiFulltext(db, [workspace]);
      const first = db
        .prepare(`SELECT COUNT(*) AS n FROM fts_wiki WHERE workspace_id = 1`)
        .get() as { n: number };
      expect(first.n).toBe(1);

      // Touch the disk after backfill — the second call must not re-walk.
      writeFileSync(join(rootPath, "20_wiki/new.md"), "# New");
      backfillWikiFulltext(db, [workspace]);
      const second = db
        .prepare(`SELECT COUNT(*) AS n FROM fts_wiki WHERE workspace_id = 1`)
        .get() as { n: number };
      expect(second.n).toBe(1);
    });

    it("ignores archived (active=0) workspaces", () => {
      writeFileSync(join(rootPath, "20_wiki/page.md"), "# Page");
      const workspace = { ...makeRow(1, rootPath), active: 0 };
      backfillWikiFulltext(db, [workspace]);
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM fts_wiki`).get() as { n: number }).n;
      expect(n).toBe(0);
    });

    it("is a no-op on empty workspaces list", () => {
      backfillWikiFulltext(db, []);
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM fts_wiki`).get() as { n: number }).n;
      expect(n).toBe(0);
    });
  });

  describe("error paths", () => {
    it("reindexWikiWorkspace tolerates unreadable individual files", () => {
      writeFileSync(join(rootPath, "20_wiki/good.md"), "# Good\n\nfine.");
      const badPath = join(rootPath, "20_wiki/bad.md");
      writeFileSync(badPath, "# Bad");
      // Make the file unreadable. On Unix chmod 0 reliably denies read.
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(badPath, 0);
      try {
        const workspace = makeRow(1, rootPath);
        const outcome = reindexWikiWorkspace(db, workspace);
        // The good file still indexes; the bad one falls through the
        // catch and is counted as skipped.
        expect(outcome.indexed).toBeGreaterThanOrEqual(1);
        expect(outcome.skipped).toBeGreaterThanOrEqual(1);
      } finally {
        chmodSync(badPath, 0o600);
      }
    });

    it("walkWikiTree tolerates unreadable directories", () => {
      const denied = join(rootPath, "20_wiki/denied");
      mkdirSync(denied);
      writeFileSync(join(denied, "x.md"), "# X");
      writeFileSync(join(rootPath, "20_wiki/keep.md"), "# Keep");
      // Even though the inner directory is unreadable, the walk should
      // continue past it without throwing. The classifier rejects 20_wiki
      // subdirs (only root-level files index), so this is also a coverage
      // path for the catch in walkWikiTree.
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(denied, 0);
      try {
        const workspace = makeRow(1, rootPath);
        const outcome = reindexWikiWorkspace(db, workspace);
        expect(outcome.indexed).toBe(1);
      } finally {
        chmodSync(denied, 0o755);
      }
    });
  });

  describe("classifyWikiPathForFts", () => {
    it.each([
      ["10_raw/foo.md", "raw"],
      ["20_wiki/foo.md", "wiki"],
      ["20_wiki/_index.md", "wiki"],
      ["30_outputs/2026-05-12-answer-x.md", "output"],
      ["90_meta/taxonomy.md", "meta"],
      ["90_meta/health/2026-05-12.md", "meta"],
      ["log.md", "log"],
      ["00_inbox/note.md", "inbox"],
    ])("classifies %s as %s", (path, expected) => {
      expect(classifyWikiPathForFts(path)).toBe(expected);
    });

    it("rejects unknown roots", () => {
      expect(classifyWikiPathForFts("99_other/x.md")).toBeNull();
      expect(classifyWikiPathForFts("README.md")).toBeNull();
    });
  });
});
