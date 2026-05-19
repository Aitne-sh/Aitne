import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeRoutes } from "./knowledge.js";
import type { ApiDependencies } from "../server.js";
import type { Event } from "@aitne/shared";
import { isKnowledgeImportEvent } from "@aitne/shared";

interface FakeBus {
  put: (event: Event) => Promise<void>;
  events: Event[];
}

function makeFakeBus(): FakeBus {
  const events: Event[] = [];
  return {
    events,
    put: async (event: Event) => {
      events.push(event);
    },
  };
}

function createTestDb(opts: { setupCompleted?: boolean } = {}): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agent_actions (
      id INTEGER PRIMARY KEY,
      action_type TEXT NOT NULL,
      trigger TEXT,
      result TEXT,
      detail TEXT,
      backend TEXT,
      started_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE runtime_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // The route gates on isSetupCompleted(db), which JSON-decodes the
  // value_json column. Default to "complete" for tests that don't care
  // about the gate; the dedicated 409 case overrides this.
  if (opts.setupCompleted !== false) {
    db.prepare(
      "INSERT INTO runtime_state (key, value_json) VALUES (?, ?)",
    ).run("management_mode.setup_completed", JSON.stringify(true));
  }
  return db;
}

function makeDeps(opts: {
  dataDir: string;
  db: Database.Database;
  bus: FakeBus;
}): ApiDependencies {
  return {
    db: opts.db,
    config: {
      dataDir: opts.dataDir,
      vaultMode: "plain",
      primaryVaultPath: null,
    },
    eventBus: opts.bus as unknown as ApiDependencies["eventBus"],
  } as unknown as ApiDependencies;
}

function fileForm(file: { name: string; content: string }, fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.append("file", new File([file.content], file.name, { type: "text/markdown" }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

describe("POST /knowledge/import", () => {
  let dataDir: string;
  let contextDir: string;
  let db: Database.Database;
  let bus: FakeBus;
  let app: ReturnType<typeof createKnowledgeRoutes>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-knowledge-import-"));
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    db = createTestDb();
    bus = makeFakeBus();
    app = createKnowledgeRoutes(makeDeps({ dataDir, db, bus }));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts a small Markdown upload, persists scratch, emits event, audits", async () => {
    const fd = fileForm(
      { name: "profile.md", content: "# Me\n- Lives in Tokyo.\n- Works at Acme.\n" },
      { source: "self-written" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; traceId: string; scratchPath: string };
    expect(body.status).toBe("accepted");
    expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.scratchPath).toMatch(/^agent\/scratch\/import-\d{4}-\d{2}-\d{2}-profile-[0-9a-f]+\.md$/);

    // Scratch file landed under context/agent/scratch/.
    const absPath = join(contextDir, body.scratchPath);
    expect(existsSync(absPath)).toBe(true);
    expect(readFileSync(absPath, "utf-8")).toContain("Lives in Tokyo");

    // Event emitted with the right shape.
    expect(bus.events).toHaveLength(1);
    const ev = bus.events[0];
    expect(isKnowledgeImportEvent(ev)).toBe(true);
    if (isKnowledgeImportEvent(ev)) {
      expect(ev.platform).toBe("dashboard");
      expect(ev.scratchPath).toBe(body.scratchPath);
      expect(ev.filename).toBe("profile.md");
      expect(ev.importSource).toBe("self-written");
      // `Event.source` (the adapter-origin label) must NOT be overwritten
      // by the upload's source. Audit trails depend on this distinction.
      expect(ev.source).toBe("dashboard_knowledge_upload");
      // `event_data[source]` flows from `Event.source` via
      // extractEventData's initial `data.source = event.source` write,
      // and `event.data.importSource` is the upload label.
      expect((ev.data as { importSource?: string }).importSource).toBe("self-written");
      expect((ev.data as { source?: string }).source).toBeUndefined();
      expect(ev.requestedBackendId).toBeUndefined();
      expect(ev.requestedModelId).toBeUndefined();
    }

    // Audit row written.
    const row = db.prepare("SELECT action_type, result FROM agent_actions").get() as
      | { action_type: string; result: string }
      | undefined;
    expect(row?.action_type).toBe("knowledge_import_started");
    expect(row?.result).toBe("success");
  });

  it("honors backend/model picker fields", async () => {
    const fd = fileForm(
      { name: "facts.md", content: "- Born in Sapporo.\n" },
      {
        source: "self-written",
        requestedBackendId: "claude",
        requestedModelId: "claude-opus-4-7",
      },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(202);

    expect(bus.events).toHaveLength(1);
    const ev = bus.events[0];
    if (isKnowledgeImportEvent(ev)) {
      expect(ev.requestedBackendId).toBe("claude");
      expect(ev.requestedModelId).toBe("claude-opus-4-7");
    }
  });

  it("rejects unsupported extensions with 415", async () => {
    const fd = new FormData();
    fd.append("file", new File(["whatever"], "thing.pdf", { type: "application/pdf" }));
    fd.append("source", "self-written");
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_extension");
    expect(bus.events).toHaveLength(0);
  });

  it("rejects oversize uploads with 413", async () => {
    const big = "a".repeat(70 * 1024); // 70 KB > 64 KB cap
    const fd = fileForm({ name: "big.md", content: big }, { source: "self-written" });
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("file_too_large");
    expect(bus.events).toHaveLength(0);
  });

  it("rejects content with secret-shaped lines", async () => {
    const secret =
      "- normal fact\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n";
    const fd = fileForm({ name: "creds.md", content: secret }, { source: "self-written" });
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("secret_shape_detected");
    expect(bus.events).toHaveLength(0);
  });

  it("rejects an unknown source value", async () => {
    const fd = fileForm({ name: "f.md", content: "hi" }, { source: "linkedin-export" });
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_source");
    expect(bus.events).toHaveLength(0);
  });

  it("rejects a backend pick without a model", async () => {
    const fd = fileForm(
      { name: "f.md", content: "hi" },
      { source: "self-written", requestedBackendId: "claude" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_model");
  });

  it("rejects an unknown backend id", async () => {
    const fd = fileForm(
      { name: "f.md", content: "hi" },
      {
        source: "self-written",
        requestedBackendId: "openai",
        requestedModelId: "gpt-4",
      },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_backend");
  });

  it("rejects empty bodies", async () => {
    const fd = fileForm({ name: "blank.md", content: "    \n  \n" }, { source: "self-written" });
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_file");
  });

  it("returns 400 when no file is sent", async () => {
    const fd = new FormData();
    fd.append("source", "self-written");
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_file");
  });

  it("returns 503 when the event bus is unavailable", async () => {
    // Build deps without an eventBus.
    const noBusApp = createKnowledgeRoutes({
      db,
      config: { dataDir, vaultMode: "plain", primaryVaultPath: null },
    } as unknown as ApiDependencies);
    const fd = fileForm({ name: "x.md", content: "hi" }, { source: "self-written" });
    const res = await noBusApp.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(503);
  });

  it("returns 409 setup_incomplete before initial setup is finished", async () => {
    // Pre-setup uploads must be rejected — user/*.md files are seeded
    // by ensureSkeletonFiles only after rules/management.md is saved.
    // Without this gate the route would emit a heavy-tier event whose
    // every PATCH 404s.
    const preSetupDb = createTestDb({ setupCompleted: false });
    const preSetupApp = createKnowledgeRoutes(
      makeDeps({ dataDir, db: preSetupDb, bus }),
    );
    const fd = fileForm({ name: "p.md", content: "- Lives in Tokyo." }, { source: "self-written" });
    const res = await preSetupApp.request("/knowledge/import", {
      method: "POST",
      body: fd,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("setup_incomplete");
    expect(bus.events).toHaveLength(0);
  });

  it("accepts .txt extension with 202", async () => {
    const fd = fileForm(
      { name: "notes.txt", content: "- Likes hiking.\n" },
      { source: "self-written" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("accepted");
  });

  it("accepts .markdown extension with 202", async () => {
    const fd = fileForm(
      { name: "bio.markdown", content: "- Born in Hokkaido.\n" },
      { source: "self-written" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("accepted");
  });

  it("rejects a filename with no extension with 415 unsupported_extension", async () => {
    // fileExtension("README") returns "" (dot < 0 branch), which is not in ACCEPTED_EXTENSIONS
    const fd = new FormData();
    fd.append("file", new File(["some content"], "README", { type: "text/plain" }));
    fd.append("source", "self-written");
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_extension");
  });

  it("uses 'upload' slug fallback when filename collapses to empty after sanitisation", async () => {
    // "---" → base "---" → slug "" → fallback "upload"; the route should still succeed
    const fd = fileForm(
      { name: "---.md", content: "- A fact.\n" },
      { source: "self-written" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { scratchPath: string };
    expect(body.scratchPath).toContain("upload");
  });

  it("returns 500 scratch_write_failed when the scratch directory cannot be created", async () => {
    // Place a regular FILE at contextDir/agent — mkdirSync cannot create
    // a directory where a file already exists, so the write will throw.
    writeFileSync(join(contextDir, "agent"), "I am a file, not a dir");
    const fd = fileForm(
      { name: "crash.md", content: "- This will fail.\n" },
      { source: "self-written" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/scratch_write_failed|ENOTDIR/);
  });

  it("returns 500 enqueue_failed when the event bus put() throws", async () => {
    const throwingBus = {
      events: [] as Event[],
      put: async (_event: Event) => {
        throw new Error("bus down");
      },
    };
    const throwingApp = createKnowledgeRoutes(
      makeDeps({ dataDir, db, bus: throwingBus }),
    );
    const fd = fileForm(
      { name: "ok.md", content: "- A fact.\n" },
      { source: "self-written" },
    );
    const res = await throwingApp.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/enqueue_failed|bus down/);
  });

  it("still returns 202 when the audit INSERT fails (non-fatal)", async () => {
    // Drop the audit table so the INSERT throws; the route catches it silently.
    const auditlessDb = createTestDb();
    auditlessDb.exec("DROP TABLE agent_actions");
    const auditlessApp = createKnowledgeRoutes(
      makeDeps({ dataDir, db: auditlessDb, bus }),
    );
    const fd = fileForm(
      { name: "noaudit.md", content: "- Audit table gone.\n" },
      { source: "self-written" },
    );
    const res = await auditlessApp.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("accepted");
  });

  it("returns 400 invalid_source when source is absent from FormData (ternary false branch at line 164)", async () => {
    // When the 'source' field is not appended, body["source"] is undefined.
    // typeof undefined === "string" is false → ternary returns "" →
    // !VALID_SOURCES.has("") → 400 invalid_source.
    const fd = new FormData();
    fd.append("file", new File(["- fact\n"], "notes.md", { type: "text/markdown" }));
    // Intentionally omit source
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_source");
  });

  it("returns 400 invalid_backend when only requestedModelId is provided without requestedBackendId", async () => {
    // backendRaw="" fails isBackendId(""), triggering invalid_backend
    const fd = fileForm(
      { name: "f.md", content: "- A fact.\n" },
      { source: "self-written", requestedModelId: "claude-sonnet-4-6" },
    );
    const res = await app.request("/knowledge/import", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_backend");
  });

  it("returns 400 invalid_multipart_body when the request body stream errors during parseBody", async () => {
    // A ReadableStream that immediately signals an error causes Request.formData()
    // to reject, which propagates to the catch block at lines 111-116 in knowledge.ts.
    const erroringStream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("simulated stream read error"));
      },
    });
    const req = new Request("http://localhost/knowledge/import", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=----FormBoundary7MA4YWxkTrZu0gW",
      },
      body: erroringStream,
      // @ts-ignore — undici requires `duplex` when body is a ReadableStream
      duplex: "half",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid_multipart_body|simulated/);
  });
});
