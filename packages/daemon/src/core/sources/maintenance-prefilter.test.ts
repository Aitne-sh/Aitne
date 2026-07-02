import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { recordSignal } from "../skill-curation/signals.js";
import { evaluateSourceMaintenancePrefilter } from "./maintenance-prefilter.js";

interface Ctx {
  db: Database.Database;
  contextDir: string;
  cleanup: () => void;
}

function makeCtx(): Ctx {
  const contextDir = mkdtempSync(join(tmpdir(), "pa-prefilter-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return {
    db,
    contextDir,
    cleanup: () => {
      db.close();
      rmSync(contextDir, { recursive: true, force: true });
    },
  };
}

function insertSource(
  ctx: Ctx,
  id: string,
  status: string,
  cardPath: string | null = null,
): void {
  ctx.db
    .prepare(
      `INSERT INTO source_documents
       (id, sha256, path, original_filename, safe_filename, mime_type,
        size_bytes, status, card_path, provenance)
       VALUES (?, ?, '/p', 'a.pdf', 'a.pdf', 'application/pdf', 3, ?, ?, 'user_telegram')`,
    )
    .run(id, `hash-${id}`, status, cardPath);
}

function writeCard(ctx: Ctx, relPath: string, sourceId: string | null): void {
  const abs = join(ctx.contextDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  const frontmatter = sourceId
    ? `---\ntype: source\nowner: agent\nupdated: 2026-07-01\nsource_id: ${sourceId}\n---\n# Card\n`
    : `---\ntype: source\nowner: agent\nupdated: 2026-07-01\n---\n# Card\n`;
  writeFileSync(abs, frontmatter);
}

describe("evaluateSourceMaintenancePrefilter", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.cleanup());

  it("reports nothing to do on an empty library and vault", () => {
    const result = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(result).toEqual({
      unfiledCount: 0,
      inconsistencyCount: 0,
      driftSignalCount: 0,
      shouldRun: false,
    });
  });

  it("fires on unfiled sources", () => {
    insertSource(ctx, "src_1", "unfiled");
    insertSource(ctx, "src_2", "archived");
    const result = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(result.unfiledCount).toBe(1);
    expect(result.shouldRun).toBe(true);
  });

  it("counts filed rows whose card file is missing", () => {
    insertSource(ctx, "src_1", "filed", "knowledge/sources/acme/deck.md");
    const missing = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(missing.inconsistencyCount).toBe(1);
    expect(missing.shouldRun).toBe(true);

    writeCard(ctx, "knowledge/sources/acme/deck.md", "src_1");
    const healed = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(healed.inconsistencyCount).toBe(0);
    expect(healed.shouldRun).toBe(false);
  });

  it("counts on-disk cards with a dangling or absent source_id, skipping _index.md and dot entries", () => {
    writeCard(ctx, "knowledge/sources/acme/orphan.md", "src_ghost");
    writeCard(ctx, "knowledge/sources/flat-card.md", null);
    writeCard(ctx, "knowledge/sources/_index.md", null);
    // Hidden entries (e.g. .DS_Store, .obsidian) must be ignored by the walk.
    writeFileSync(join(ctx.contextDir, "knowledge/sources/.DS_Store"), "junk");
    const result = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(result.inconsistencyCount).toBe(2);
    expect(result.shouldRun).toBe(true);
  });

  it("fires on unconsumed drift signals for the sources skill only", () => {
    recordSignal(ctx.db, {
      skill_slug: "sources",
      section_id: "source-collections",
      signal_type: "structure_diff",
      payload: {},
    });
    recordSignal(ctx.db, {
      skill_slug: "project-doc",
      section_id: "project-shape",
      signal_type: "structure_diff",
      payload: {},
    });
    const result = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(result.driftSignalCount).toBe(1);
    expect(result.shouldRun).toBe(true);
  });

  it("fails open when the DB is unusable", () => {
    ctx.db.exec(`DROP TABLE source_documents`);
    const result = evaluateSourceMaintenancePrefilter(ctx.db, ctx.contextDir);
    expect(result.shouldRun).toBe(true);
    expect(result.unfiledCount).toBe(-1);
  });
});
