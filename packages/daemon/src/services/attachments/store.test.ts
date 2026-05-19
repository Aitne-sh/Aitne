import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { applySchema } from "../../db/schema.js";
import { AttachmentStore, IngestRejectedError } from "./store.js";
import { hardLinkOrCopy, resetHardLinkLogCache } from "./hardlink.js";

function pngBytes(): Buffer {
  // 1x1 PNG - minimal viable with magic bytes file-type can recognize.
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000d49444154789c626000000000050001b6a87db60000000049454e44ae426082",
    "hex",
  );
}

function oggOpusBytes(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write("OggS", 0, "ascii");
  bytes.write("OpusHead", 28, "ascii");
  return bytes;
}

function streamOf(buf: Buffer): Readable {
  return Readable.from(buf);
}

async function makeStore(): Promise<{ db: Database.Database; dir: string; store: AttachmentStore; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "pa-attachments-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  const store = new AttachmentStore(db, dir);
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, dir, store, cleanup };
}

describe("AttachmentStore.ingestStream", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
  });

  afterEach(() => ctx.cleanup());

  it("accepts a PNG, writes the bytes, and persists a chat_attachments row", async () => {
    const bytes = pngBytes();
    const result = await ctx.store.ingestStream({
      stream: streamOf(bytes),
      declaredMimeType: "image/png",
      originalFilename: "dot.png",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 5 * 1024 * 1024,
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.sizeBytes).toBe(bytes.length);
    expect(existsSync(result.path)).toBe(true);
    const row = ctx.store.get(result.id);
    expect(row?.mimeType).toBe("image/png");
    expect(row?.direction).toBe("inbound");
    expect(row?.messageId).toBeNull();
  });

  it("rejects oversized streams with too_large", async () => {
    const bytes = Buffer.alloc(1024 * 10, 0x41); // 10 KB of A's
    await expect(
      ctx.store.ingestStream({
        stream: streamOf(bytes),
        declaredMimeType: "text/plain",
        originalFilename: "big.txt",
        direction: "inbound",
        provenance: "user_dashboard",
        maxSizeBytes: 1024, // 1 KB cap
      }),
    ).rejects.toBeInstanceOf(IngestRejectedError);
  });

  it("rejects empty bodies", async () => {
    await expect(
      ctx.store.ingestStream({
        stream: streamOf(Buffer.alloc(0)),
        declaredMimeType: "text/plain",
        originalFilename: "empty.txt",
        direction: "inbound",
        provenance: "user_dashboard",
        maxSizeBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "empty" });
  });

  it("rejects a binary body with no magic bytes and no declared text MIME", async () => {
    // Some arbitrary bytes that file-type can't identify.
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xfe, 0xed, 0xfa, 0xce]);
    await expect(
      ctx.store.ingestStream({
        stream: streamOf(bytes),
        declaredMimeType: "application/octet-stream",
        originalFilename: "mystery.bin",
        direction: "inbound",
        provenance: "user_dashboard",
        maxSizeBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: "undetected_mime" });
  });

  it("accepts plain text with declared text/plain MIME", async () => {
    const bytes = Buffer.from("hello world, this is a note\n", "utf-8");
    const result = await ctx.store.ingestStream({
      stream: streamOf(bytes),
      declaredMimeType: "text/plain",
      originalFilename: "note.txt",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024,
    });
    expect(result.mimeType).toBe("text/plain");
  });

  it("normalizes parameterized detected Ogg/Opus audio MIME", async () => {
    const result = await ctx.store.ingestStream({
      stream: streamOf(oggOpusBytes()),
      declaredMimeType: "audio/ogg; codecs=opus",
      originalFilename: "voice.ogg",
      direction: "inbound",
      provenance: "user_whatsapp",
      maxSizeBytes: 1024,
    });
    expect(result.mimeType).toBe("audio/ogg");
    expect(ctx.store.get(result.id)?.mimeType).toBe("audio/ogg");
  });

  it("normalizes parameterized declared text MIME", async () => {
    const result = await ctx.store.ingestStream({
      stream: streamOf(Buffer.from("hello\n", "utf-8")),
      declaredMimeType: "text/plain; charset=utf-8",
      originalFilename: "note.txt",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024,
    });
    expect(result.mimeType).toBe("text/plain");
  });
});

describe("AttachmentStore.bindInbound + listInboundForMessage", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
    // Seed a session + message via raw SQL so we have an FK target for
    // the `messages` table.
    ctx.db.exec(`
      INSERT INTO conversation_sessions
        (id, platform, channel_id, thread_id, scope, scope_key, status, is_dm)
      VALUES (42, 'dashboard', 'test', NULL, 'dashboard_chat', 'dashboard', 'active', 1);
      INSERT INTO messages (id, session_id, role, content, platform, timestamp)
      VALUES (7, 42, 'user', 'hi', 'dashboard', CURRENT_TIMESTAMP);
    `);
  });

  afterEach(() => ctx.cleanup());

  it("binds an unbound attachment and surfaces it via listInboundForMessage", async () => {
    const result = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "dot.png",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024 * 1024,
    });

    const bound = ctx.store.bindInbound({
      attachmentIds: [result.id],
      sessionId: 42,
      messageId: 7,
    });
    expect(bound).toHaveLength(1);
    expect(bound[0].messageId).toBe(7);

    const list = ctx.store.listInboundForMessage(7);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(result.id);
  });
});

describe("AttachmentStore outbound turn-token lifecycle", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
    ctx.db.exec(`
      INSERT INTO conversation_sessions
        (id, platform, channel_id, thread_id, scope, scope_key, status, is_dm)
      VALUES (99, 'dashboard', 'test', NULL, 'dashboard_chat', 'dashboard', 'active', 1);
    `);
  });

  afterEach(() => ctx.cleanup());

  it("collectOutboundForTurn only returns rows matching the token", async () => {
    const token = "turn-abc";
    const result = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "out.png",
      direction: "outbound",
      provenance: "agent",
      turnToken: token,
      maxSizeBytes: 1024 * 1024,
    });

    const other = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "other.png",
      direction: "outbound",
      provenance: "agent",
      turnToken: "turn-xyz",
      maxSizeBytes: 1024 * 1024,
    });

    const collected = ctx.store.collectOutboundForTurn({
      turnToken: token,
      sessionId: 99,
    });
    expect(collected.map((r) => r.id)).toEqual([result.id]);

    // Token cleared — second collect returns nothing.
    expect(
      ctx.store.collectOutboundForTurn({ turnToken: token, sessionId: 99 }),
    ).toEqual([]);

    // Other token's row still present.
    expect(ctx.store.get(other.id)?.turnToken).toBe("turn-xyz");
  });

  it("releaseTurnToken leaves rows unbound (orphans) for reaper", async () => {
    const token = "turn-leaked";
    const result = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "ghost.png",
      direction: "outbound",
      provenance: "agent",
      turnToken: token,
      maxSizeBytes: 1024 * 1024,
    });
    ctx.store.releaseTurnToken(token);
    const row = ctx.store.get(result.id);
    expect(row?.turnToken).toBeNull();
    expect(row?.messageId).toBeNull();
  });
});

describe("AttachmentStore.reapOrphans", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
  });

  afterEach(() => ctx.cleanup());

  it("deletes unbound rows older than the window and keeps fresh ones", async () => {
    const stale = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "stale.png",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024 * 1024,
    });
    const fresh = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "fresh.png",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024 * 1024,
    });

    // Age the stale row's created_at back 48 hours.
    ctx.db
      .prepare(
        `UPDATE chat_attachments
         SET created_at = datetime('now', '-48 hours') WHERE id = ?`,
      )
      .run(stale.id);

    const result = ctx.store.reapOrphans(24);
    expect(result.inbound).toBe(1);
    expect(ctx.store.get(stale.id)).toBeNull();
    expect(ctx.store.get(fresh.id)?.id).toBe(fresh.id);
  });
});

describe("AttachmentStore retention helpers", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
    ctx.db.exec(`
      INSERT INTO conversation_sessions
        (id, platform, channel_id, thread_id, scope, scope_key, status, is_dm)
      VALUES (77, 'dashboard', 'test', NULL, 'dashboard_chat', 'dashboard', 'active', 1);
      INSERT INTO messages (id, session_id, role, content, platform, timestamp)
      VALUES (70, 77, 'user', 'hi', 'dashboard', CURRENT_TIMESTAMP);
    `);
  });

  afterEach(() => ctx.cleanup());

  it("deletes rows and directories for dangling message references", async () => {
    const result = await ctx.store.ingestStream({
      stream: streamOf(pngBytes()),
      declaredMimeType: "image/png",
      originalFilename: "dangling.png",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024 * 1024,
    });
    ctx.store.bindInbound({
      attachmentIds: [result.id],
      sessionId: 77,
      messageId: 70,
    });

    ctx.db.pragma("foreign_keys = OFF");
    ctx.db.prepare("DELETE FROM messages WHERE id = 70").run();
    ctx.db.pragma("foreign_keys = ON");

    expect(ctx.store.reapDanglingMessageRefs()).toBe(1);
    expect(ctx.store.get(result.id)).toBeNull();
    expect(existsSync(ctx.store.dirFor(result.id))).toBe(false);
  });

  it("deletes stale physical directories without DB rows and skips fresh ones", () => {
    const stale = join(ctx.dir, "attachments", "stale-dir");
    const fresh = join(ctx.dir, "attachments", "fresh-dir");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, oldDate, oldDate);

    expect(ctx.store.reapUntrackedDirs({ minAgeHours: 1 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("AttachmentStore.stageIntoWorkdir + hardLinkOrCopy", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    ctx = await makeStore();
    resetHardLinkLogCache();
  });

  afterEach(() => ctx.cleanup());

  it("hard-links the canonical store file into the session workdir", async () => {
    const bytes = pngBytes();
    const result = await ctx.store.ingestStream({
      stream: streamOf(bytes),
      declaredMimeType: "image/png",
      originalFilename: "dot.png",
      direction: "inbound",
      provenance: "user_dashboard",
      maxSizeBytes: 1024 * 1024,
    });
    const row = ctx.store.get(result.id)!;

    const sessionDir = mkdtempSync(join(tmpdir(), "pa-session-"));
    try {
      const dst = ctx.store.stageIntoWorkdir({ row, sessionDir });
      expect(existsSync(dst)).toBe(true);
      const copied = readFileSync(dst);
      expect(copied.equals(bytes)).toBe(true);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("hardLinkOrCopy falls back to copy on missing hard-link semantics (smoke)", () => {
    // Can't force EXDEV in a test — just exercise the hot path.
    const dir = mkdtempSync(join(tmpdir(), "pa-hl-"));
    try {
      const src = join(dir, "src.txt");
      const dst = join(dir, "dst.txt");
      writeFileSync(src, "hello");
      hardLinkOrCopy(src, dst);
      expect(readFileSync(dst, "utf-8")).toBe("hello");
      // Idempotent — second call is a no-op.
      hardLinkOrCopy(src, dst);
      expect(readFileSync(dst, "utf-8")).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
