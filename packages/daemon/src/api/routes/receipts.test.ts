import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createReceiptRoutes } from "./receipts.js";
import type { ApiDependencies } from "../server.js";
import { createServiceRegistry } from "../../services/service-registry.js";
import { applySchema } from "../../db/schema.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedTestData(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, size_bytes, category, obsidian_path, saved_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  stmt.run("msg-r1", "att-1", "receipt.pdf", "application/pdf", 45000, "document", null, null, "gmail-primary");
  stmt.run("msg-r2", "att-2", "invoice.pdf", "application/pdf", 32000, "document", "receipts/2026/04/netflix.pdf", "2026-04-10T12:00:00Z", "gmail-primary");
  stmt.run("msg-r3", "att-3", "boarding-pass.png", "image/png", 120000, "travel", null, null, "gmail-primary");
  stmt.run("msg-r4", "att-4", "receipt-2.pdf", "application/pdf", 28000, "document", null, null, "gmail-primary");
}

interface FakeMailProvider {
  kind: "gmail" | "outlook" | "yahoo" | "icloud";
  getAttachment?: (
    messageId: string,
    attachmentId: string,
  ) => Promise<{ data: Buffer | Uint8Array; mimeType?: string } | null>;
}

function makeDeps(
  db: Database.Database,
  provider?: FakeMailProvider,
): ApiDependencies {
  const services = createServiceRegistry();
  if (provider !== undefined) {
    (services as unknown as Record<string, unknown>).mail = {
      getProvider: async (_accountId: string) => provider,
    };
  }
  return { db, services } as unknown as ApiDependencies;
}

describe("receipts routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  describe("GET /receipts", () => {
    it("returns all receipts", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts");
      const data = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(data.total).toBe(4);
      expect(data.receipts).toHaveLength(4);
    });

    it("filters by category", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts?category=document");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(3);
    });

    it("filters by saved status (true)", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts?saved=true");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(1);
      expect(data.receipts[0].filename).toBe("invoice.pdf");
    });

    it("filters by saved status (false)", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts?saved=false");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(3);
    });

    it("respects limit", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts?limit=2");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(4);
      expect(data.receipts).toHaveLength(2);
    });
  });

  describe("GET /receipts/summary", () => {
    it("returns correct summary", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/summary");
      const data = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(data.total).toBe(4);
      expect(data.saved).toBe(1);
      expect(data.unsaved).toBe(3);
      expect(data.byCategory).toHaveLength(2);
    });

    it("labels rows with NULL category as 'uncategorized'", async () => {
      // Insert a receipt with no category to exercise the
      // `r.category ?? "uncategorized"` fallback in the byCategory map.
      db.prepare(
        `INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, size_bytes, category, obsidian_path, saved_at, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("msg-r5", "att-5", "unknown.pdf", "application/pdf", 1000, null, null, null, "gmail-primary");
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/summary");
      const data = (await res.json()) as Record<string, any>;
      expect(res.status).toBe(200);
      const labels = (data.byCategory as Array<{ category: string; count: number }>).map(
        (r) => r.category,
      );
      expect(labels).toContain("uncategorized");
    });
  });

  describe("PATCH /receipts/:id", () => {
    it("updates receipt category", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/4", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "travel" }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare("SELECT category FROM receipts WHERE id = 4").get() as { category: string };
      expect(row.category).toBe("travel");
    });

    it("marks receipt as saved to Obsidian", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ obsidianPath: "receipts/2026/04/amazon-receipt.pdf" }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare("SELECT obsidian_path, saved_at FROM receipts WHERE id = 1").get() as { obsidian_path: string; saved_at: string };
      expect(row.obsidian_path).toBe("receipts/2026/04/amazon-receipt.pdf");
      expect(row.saved_at).not.toBeNull();
    });

    it("returns 404 for non-existent receipt", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "document" }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 for empty update", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /receipts/:id/download", () => {
    it("returns 503 when Gmail not configured", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/1/download", { method: "POST" });

      expect(res.status).toBe(503);
    });

    it("returns 404 for non-existent receipt", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/999/download", { method: "POST" });

      expect(res.status).toBe(404);
    });

    it("returns 413 when attachment exceeds 100MB limit", async () => {
      const db2 = createTestDb();
      db2.prepare(
        `INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, size_bytes, account_id)
         VALUES ('msg-big', 'att-big', 'huge.pdf', 'application/pdf', ?, 'gmail-primary')`,
      ).run(101 * 1024 * 1024); // 101 MB
      // Provider stubbed so the mail_not_configured guard passes.
      const provider: FakeMailProvider = { kind: "gmail", getAttachment: async () => null };
      const app = createReceiptRoutes(makeDeps(db2, provider));
      const res = await app.request("/receipts/1/download", { method: "POST" });
      db2.close();

      expect(res.status).toBe(413);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("attachment_too_large");
    });

    it("returns 503 when mail registry is not configured", async () => {
      const app = createReceiptRoutes(makeDeps(db)); // no provider
      const res = await app.request("/receipts/1/download", { method: "POST" });
      expect(res.status).toBe(503);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("mail_not_configured");
    });

    it("returns 409 orphaned_receipt when account_id is NULL", async () => {
      const db2 = createTestDb();
      db2.prepare(
        `INSERT INTO receipts (provider_msg_id, attachment_id, filename, mime_type, size_bytes, account_id)
         VALUES ('msg-orphan', 'att-o', 'stray.pdf', 'application/pdf', 1024, NULL)`,
      ).run();
      const provider: FakeMailProvider = { kind: "gmail", getAttachment: async () => null };
      const app = createReceiptRoutes(makeDeps(db2, provider));
      const res = await app.request("/receipts/1/download", { method: "POST" });
      db2.close();
      expect(res.status).toBe(409);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("orphaned_receipt");
    });

    it("returns 501 attachment_download_not_supported when provider lacks getAttachment", async () => {
      const provider: FakeMailProvider = { kind: "outlook" };
      const app = createReceiptRoutes(makeDeps(db, provider));
      const res = await app.request("/receipts/1/download", { method: "POST" });
      expect(res.status).toBe(501);
      const data = await res.json() as { error: string; provider: string };
      expect(data.error).toBe("attachment_download_not_supported");
      expect(data.provider).toBe("outlook");
    });

    it("returns 404 when getAttachment returns null", async () => {
      const provider: FakeMailProvider = { kind: "gmail", getAttachment: async () => null };
      const app = createReceiptRoutes(makeDeps(db, provider));
      const res = await app.request("/receipts/1/download", { method: "POST" });

      expect(res.status).toBe(404);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("attachment_not_found");
    });

    it("returns attachment bytes when getAttachment succeeds", async () => {
      const content = new Uint8Array([37, 80, 68, 70]); // %PDF header bytes
      const provider: FakeMailProvider = {
        kind: "gmail",
        getAttachment: async () => ({ data: content }),
      };
      const app = createReceiptRoutes(makeDeps(db, provider));
      const res = await app.request("/receipts/1/download", { method: "POST" });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toContain("receipt.pdf");
    });
  });

  describe("PATCH /receipts/:id — error paths", () => {
    it("returns 400 with invalid_json_body when body is malformed", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json",
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });
  });

  describe("PATCH /receipts/:id — invalid id", () => {
    it("returns 400 with invalid_id for non-numeric id", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "travel" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("invalid_id");
    });
  });

  describe("POST /receipts/:id/download — additional cases", () => {
    it("returns 400 with invalid_id for non-numeric id", async () => {
      const app = createReceiptRoutes(makeDeps(db));
      const res = await app.request("/receipts/xyz/download", { method: "POST" });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("invalid_id");
    });

    it("returns 404 with account_not_found when getProvider returns null for a valid account_id", async () => {
      const nullProvider = null as unknown as FakeMailProvider;
      const app = createReceiptRoutes(makeDeps(db, nullProvider));
      const res = await app.request("/receipts/1/download", { method: "POST" });
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe("account_not_found");
    });
  });
});
