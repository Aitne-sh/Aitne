import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { SourceLibrary } from "./store.js";

interface Ctx {
  db: Database.Database;
  dataDir: string;
  srcDir: string;
  library: SourceLibrary;
  cleanup: () => void;
}

function makeLibrary(): Ctx {
  const dataDir = mkdtempSync(join(tmpdir(), "pa-sources-"));
  const srcDir = mkdtempSync(join(tmpdir(), "pa-sources-input-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  const library = new SourceLibrary(db, dataDir);
  return {
    db,
    dataDir,
    srcDir,
    library,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    },
  };
}

function seedInput(ctx: Ctx, name: string, content: string): string {
  const p = join(ctx.srcDir, name);
  writeFileSync(p, content);
  return p;
}

function captureParams(ctx: Ctx, name = "report.pdf", content = "%PDF-1.4 test") {
  return {
    filePath: seedInput(ctx, name, content),
    originalFilename: name,
    safeFilename: name,
    mimeType: "application/pdf",
    sizeBytes: Buffer.byteLength(content),
    provenance: "user_telegram",
  };
}

describe("SourceLibrary.captureFromFile", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeLibrary();
  });
  afterEach(() => ctx.cleanup());

  it("stores the bytes under sources/<id>/ and inserts an unfiled row", () => {
    const result = ctx.library.captureFromFile(captureParams(ctx));
    expect(result.deduped).toBe(false);
    expect(result.id).toMatch(/^src_/);

    const row = ctx.library.get(result.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("unfiled");
    expect(row?.provenance).toBe("user_telegram");
    expect(row?.receiveCount).toBe(1);
    expect(row?.sha256).toBe(
      createHash("sha256").update("%PDF-1.4 test").digest("hex"),
    );
    expect(row?.path).toBe(join(ctx.dataDir, "sources", result.id, "report.pdf"));
    expect(readFileSync(row!.path, "utf-8")).toBe("%PDF-1.4 test");
  });

  it("dedups identical bytes by sha256 and bumps receive_count", () => {
    const first = ctx.library.captureFromFile(captureParams(ctx, "a.pdf"));
    const second = ctx.library.captureFromFile(captureParams(ctx, "b.pdf"));
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);

    const row = ctx.library.get(first.id);
    expect(row?.receiveCount).toBe(2);
    const count = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM source_documents`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("re-materializes a missing binary on dedup hit (self-heal)", () => {
    const first = ctx.library.captureFromFile(captureParams(ctx, "a.pdf"));
    const row = ctx.library.get(first.id);
    rmSync(ctx.library.dirFor(first.id), { recursive: true, force: true });
    expect(existsSync(row!.path)).toBe(false);

    const second = ctx.library.captureFromFile(captureParams(ctx, "b.pdf"));
    expect(second.deduped).toBe(true);
    expect(existsSync(row!.path)).toBe(true);
  });

  it("cleans up the directory and inserts no row when the input file is unreadable", () => {
    expect(() =>
      ctx.library.captureFromFile({
        ...captureParams(ctx),
        filePath: join(ctx.srcDir, "does-not-exist.pdf"),
      }),
    ).toThrow();
    const count = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM source_documents`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("SourceLibrary.list", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeLibrary();
  });
  afterEach(() => ctx.cleanup());

  it("filters by status and respects limit/offset", () => {
    const a = ctx.library.captureFromFile(captureParams(ctx, "a.pdf", "AAA"));
    const b = ctx.library.captureFromFile(captureParams(ctx, "b.pdf", "BBB"));
    ctx.library.patch(a.id, { status: "archived" });

    expect(ctx.library.list({ status: "unfiled" }).map((r) => r.id)).toEqual([
      b.id,
    ]);
    expect(ctx.library.list({ status: "archived" }).map((r) => r.id)).toEqual([
      a.id,
    ]);
    expect(ctx.library.list()).toHaveLength(2);
    expect(ctx.library.list({ limit: 1 })).toHaveLength(1);
    expect(ctx.library.list({ limit: 1, offset: 2 })).toHaveLength(0);
  });
});

describe("SourceLibrary.patch", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeLibrary();
  });
  afterEach(() => ctx.cleanup());

  it("setting cardPath implies filed; clearing it implies unfiled", () => {
    const { id } = ctx.library.captureFromFile(captureParams(ctx));
    const filed = ctx.library.patch(id, {
      cardPath: "knowledge/sources/projects/report.md",
    });
    expect(filed?.status).toBe("filed");
    expect(filed?.cardPath).toBe("knowledge/sources/projects/report.md");

    const unfiled = ctx.library.patch(id, { cardPath: null });
    expect(unfiled?.status).toBe("unfiled");
    expect(unfiled?.cardPath).toBeNull();
  });

  it("an explicit status wins over the cardPath implication", () => {
    const { id } = ctx.library.captureFromFile(captureParams(ctx));
    const row = ctx.library.patch(id, {
      status: "archived",
      cardPath: "knowledge/sources/projects/report.md",
    });
    expect(row?.status).toBe("archived");
  });

  it("patches caption alone without touching status", () => {
    const { id } = ctx.library.captureFromFile(captureParams(ctx));
    const row = ctx.library.patch(id, { caption: "Q3 deck" });
    expect(row?.caption).toBe("Q3 deck");
    expect(row?.status).toBe("unfiled");
  });

  it("returns null for an unknown id", () => {
    expect(ctx.library.patch("src_missing", { status: "archived" })).toBeNull();
  });
});

describe("SourceLibrary.hardDelete + findByAttachmentId", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeLibrary();
  });
  afterEach(() => ctx.cleanup());

  it("removes the row and the on-disk dir", () => {
    const { id } = ctx.library.captureFromFile(captureParams(ctx));
    expect(existsSync(ctx.library.dirFor(id))).toBe(true);
    expect(ctx.library.hardDelete(id)).toBe(true);
    expect(ctx.library.get(id)).toBeNull();
    expect(existsSync(ctx.library.dirFor(id))).toBe(false);
    expect(ctx.library.hardDelete(id)).toBe(false);
  });

  it("resolves a source via the chat_attachments.source_id breadcrumb", () => {
    const { id } = ctx.library.captureFromFile(captureParams(ctx));
    ctx.db
      .prepare(
        `INSERT INTO chat_attachments
         (id, direction, provenance, path, original_filename, safe_filename,
          mime_type, size_bytes, source_id)
         VALUES ('att1', 'inbound', 'user_telegram', '/x', 'a.pdf', 'a.pdf',
                 'application/pdf', 3, ?)`,
      )
      .run(id);

    expect(ctx.library.findByAttachmentId("att1")?.id).toBe(id);
    expect(ctx.library.findByAttachmentId("att-none")).toBeNull();
  });
});
