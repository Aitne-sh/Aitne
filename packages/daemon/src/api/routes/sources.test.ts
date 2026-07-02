import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { applySchema } from "../../db/schema.js";
import { AttachmentStore } from "../../services/attachments/store.js";
import { SourceLibrary } from "../../services/sources/store.js";
import { createSourceRoutes } from "./sources.js";

function pdfBytes(marker = "route-test"): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Marker (${marker}) >>\nendobj\ntrailer\n<< >>\n%%EOF\n`,
    "ascii",
  );
}

function pngBytes(): Buffer {
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000d49444154789c626000000000050001b6a87db60000000049454e44ae426082",
    "hex",
  );
}

interface Ctx {
  db: Database.Database;
  dataDir: string;
  app: Hono;
  store: AttachmentStore;
  library: SourceLibrary;
  cleanup: () => void;
}

function makeApp(): Ctx {
  const dataDir = mkdtempSync(join(tmpdir(), "pa-sources-routes-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  const store = new AttachmentStore(db, dataDir);
  const library = new SourceLibrary(db, dataDir);
  store.setSourceLibrary(library);
  const app = new Hono();
  app.route(
    "/api",
    createSourceRoutes({ sourceLibrary: library, attachmentStore: store }),
  );
  return {
    db,
    dataDir,
    app,
    store,
    library,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function ingest(
  ctx: Ctx,
  bytes: Buffer,
  mime: string,
  filename: string,
): Promise<{ id: string; sourceId: string | null }> {
  const result = await ctx.store.ingestStream({
    stream: Readable.from(bytes),
    declaredMimeType: mime,
    originalFilename: filename,
    direction: "inbound",
    provenance: "user_telegram",
    maxSizeBytes: 25 * 1024 * 1024,
  });
  return { id: result.id, sourceId: result.sourceId };
}

describe("/api/sources routes", () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = makeApp();
  });
  afterEach(() => ctx.cleanup());

  it("GET /sources lists with a status filter and rejects unknown statuses", async () => {
    const empty = await ctx.app.request("/api/sources");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ sources: [] });

    await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");

    const unfiled = await ctx.app.request("/api/sources?status=unfiled");
    const body = (await unfiled.json()) as { sources: Array<Record<string, unknown>> };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].originalFilename).toBe("deck.pdf");
    // The absolute on-disk path must never leak onto the wire.
    expect(body.sources[0]).not.toHaveProperty("path");

    const bad = await ctx.app.request("/api/sources?status=lost");
    expect(bad.status).toBe(400);
  });

  it("GET /sources/:id returns metadata; unknown ids 404", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");
    const ok = await ctx.app.request(`/api/sources/${sourceId}`);
    expect(ok.status).toBe(200);
    const row = (await ok.json()) as Record<string, unknown>;
    expect(row.id).toBe(sourceId);
    expect(row.status).toBe("unfiled");

    const missing = await ctx.app.request("/api/sources/src_missing");
    expect(missing.status).toBe(404);
  });

  it("GET /sources/:id/file streams bytes; 410 when the binary is gone", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes("bytes"), "application/pdf", "deck.pdf");
    const ok = await ctx.app.request(`/api/sources/${sourceId}/file`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await ok.arrayBuffer());
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    rmSync(ctx.library.dirFor(sourceId!), { recursive: true, force: true });
    const gone = await ctx.app.request(`/api/sources/${sourceId}/file`);
    expect(gone.status).toBe(410);
  });

  it("POST /sources/promote captures a non-document attachment and dedups repeats", async () => {
    const { id, sourceId } = await ingest(ctx, pngBytes(), "image/png", "shot.png");
    expect(sourceId).toBeNull(); // images are not auto-captured

    const res = await ctx.app.request("/api/sources/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentId: id, caption: "keep this" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toMatch(/^src_/);
    expect(body.deduped).toBe(false);
    expect(body.caption).toBe("keep this");
    expect(ctx.store.get(id)?.sourceId).toBe(body.id);

    const repeat = await ctx.app.request("/api/sources/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentId: id }),
    });
    expect(((await repeat.json()) as Record<string, unknown>).deduped).toBe(true);

    const missing = await ctx.app.request("/api/sources/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentId: "att-none" }),
    });
    expect(missing.status).toBe(404);

    const noId = await ctx.app.request("/api/sources/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noId.status).toBe(400);
  });

  it("PATCH /sources/:id validates status and card paths", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");

    const filed = await ctx.app.request(`/api/sources/${sourceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardPath: "knowledge/sources/acme-launch/deck.md" }),
    });
    expect(filed.status).toBe(200);
    const filedBody = (await filed.json()) as Record<string, unknown>;
    expect(filedBody.status).toBe("filed");
    expect(filedBody.cardPath).toBe("knowledge/sources/acme-launch/deck.md");

    const badStatus = await ctx.app.request(`/api/sources/${sourceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "gone" }),
    });
    expect(badStatus.status).toBe(400);

    for (const cardPath of [
      "knowledge/sources/../../identity/profile.md",
      "plans/projects/x.md",
      "knowledge/sources/UPPER.md",
      "knowledge/sources/x.txt",
    ]) {
      const bad = await ctx.app.request(`/api/sources/${sourceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardPath }),
      });
      expect(bad.status, cardPath).toBe(400);
    }

    const unknown = await ctx.app.request("/api/sources/src_missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("POST /sources/:id/export rejects non-obsidian targets and 409s without a vault", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");
    const notion = await ctx.app.request(`/api/sources/${sourceId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "notion" }),
    });
    expect(notion.status).toBe(400);

    const noVault = await ctx.app.request(`/api/sources/${sourceId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "obsidian" }),
    });
    expect(noVault.status).toBe(409);
  });

  it("DELETE /sources/:id requires archived status unless forced", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");

    const blocked = await ctx.app.request(`/api/sources/${sourceId}`, {
      method: "DELETE",
    });
    expect(blocked.status).toBe(409);

    await ctx.library.patch(sourceId!, { status: "archived" });
    const ok = await ctx.app.request(`/api/sources/${sourceId}`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    expect(ctx.library.get(sourceId!)).toBeNull();

    const again = await ctx.app.request(`/api/sources/${sourceId}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);

    const { sourceId: second } = await ingest(
      ctx,
      pdfBytes("second"),
      "application/pdf",
      "deck2.pdf",
    );
    const forced = await ctx.app.request(`/api/sources/${second}?force=true`, {
      method: "DELETE",
    });
    expect(forced.status).toBe(200);
  });
});

describe("/api/sources export → external Obsidian vault", () => {
  let ctx: Ctx;
  let vaultDir: string;
  let contextDir: string;
  let created: Array<{ name: string; content: string }>;
  let marked: string[];
  let running: boolean;
  let app: Hono;

  beforeEach(() => {
    ctx = makeApp();
    vaultDir = mkdtempSync(join(tmpdir(), "pa-obsidian-vault-"));
    contextDir = mkdtempSync(join(tmpdir(), "pa-context-"));
    created = [];
    marked = [];
    running = true;
    const obsidianService = {
      available: true,
      absoluteVaultPath: vaultDir,
      isRunning: async () => running,
      createNote: async (name: string, content: string) => {
        if (created.some((n) => n.name === name)) throw new Error("exists");
        created.push({ name, content });
      },
      resolveNotePath: (name: string) => join(vaultDir, `${name}.md`),
    };
    app = new Hono();
    app.route(
      "/api",
      createSourceRoutes({
        sourceLibrary: ctx.library,
        attachmentStore: ctx.store,
        getContextDir: () => contextDir,
        obsidianService,
        writeTracker: { markWriting: (p: string) => marked.push(p) },
      }),
    );
  });

  afterEach(() => {
    ctx.cleanup();
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(contextDir, { recursive: true, force: true });
  });

  async function exportSource(sourceId: string, body: Record<string, unknown> = {}) {
    return await app.request(`/api/sources/${sourceId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "obsidian", ...body }),
    });
  }

  it("copies the binary and creates a companion note embedding it (card body when filed)", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");
    const cardRel = "knowledge/sources/acme/deck.md";
    mkdirSync(join(contextDir, "knowledge/sources/acme"), { recursive: true });
    writeFileSync(join(contextDir, cardRel), "---\ntype: source\n---\n# Acme deck\n\nSummary.\n");
    ctx.library.patch(sourceId!, { cardPath: cardRel });

    const res = await exportSource(sourceId!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("exported");
    expect(body.file).toBe("sources/deck.pdf");
    expect(body.noteCreated).toBe(true);

    const copied = readFileSync(join(vaultDir, "sources/deck.pdf"));
    expect(copied.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe("sources/deck");
    expect(created[0].content).toContain("# Acme deck");
    expect(created[0].content).toContain("![[deck.pdf]]");
    expect(marked).toEqual([join(vaultDir, "sources/deck.md")]);
  });

  it("falls back to the id-prefixed filename on collision and skips the note when asked", async () => {
    mkdirSync(join(vaultDir, "sources"), { recursive: true });
    writeFileSync(join(vaultDir, "sources/deck.pdf"), "occupied");
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");

    const res = await exportSource(sourceId!, { note: false });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.file).toBe(`sources/${sourceId}-deck.pdf`);
    expect(body.noteCreated).toBe(false);
    expect(body.noteSkippedReason).toBe("disabled_by_request");
    expect(created).toHaveLength(0);
  });

  it("re-export reuses the identical vault file instead of duplicating it", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");
    const first = (await (await exportSource(sourceId!, { note: false })).json()) as Record<string, unknown>;
    expect(first.file).toBe("sources/deck.pdf");
    const second = (await (await exportSource(sourceId!, { note: false })).json()) as Record<string, unknown>;
    expect(second.file).toBe("sources/deck.pdf");
    expect(readdirSync(join(vaultDir, "sources"))).toEqual(["deck.pdf"]);
  });

  it("still copies the binary when Obsidian is not running (note skipped)", async () => {
    running = false;
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");
    const res = await exportSource(sourceId!);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("exported");
    expect(body.noteCreated).toBe(false);
    expect(body.noteSkippedReason).toBe("obsidian_not_running");
    expect(readFileSync(join(vaultDir, "sources/deck.pdf")).length).toBeGreaterThan(0);
  });

  it("reports note_create_failed when the note already exists but keeps the copy", async () => {
    const { sourceId } = await ingest(ctx, pdfBytes(), "application/pdf", "deck.pdf");
    created.push({ name: "sources/deck", content: "existing" });
    const res = await exportSource(sourceId!);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("exported");
    expect(body.noteCreated).toBe(false);
    expect(body.noteSkippedReason).toBe("note_create_failed");
  });
});
