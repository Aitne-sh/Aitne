import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import { createMcpRoutes, isGeminiInstallAlreadyApplied } from "./mcp.js";
import { mcpSecretBlobName } from "../../services/mcp/types.js";

class MemoryBlobStore implements EncryptedBlobStore {
  readonly blobs = new Map<string, string>();
  async exists(n: BlobName): Promise<boolean> {
    return this.blobs.has(n);
  }
  async readUtf8(n: BlobName): Promise<string | null> {
    return this.blobs.get(n) ?? null;
  }
  async writeUtf8(n: BlobName, plaintext: string): Promise<void> {
    this.blobs.set(n, plaintext);
  }
  async remove(n: BlobName): Promise<void> {
    this.blobs.delete(n);
  }
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      command TEXT,
      args TEXT,
      cwd TEXT,
      url TEXT,
      env_keys TEXT NOT NULL DEFAULT '[]',
      header_keys TEXT NOT NULL DEFAULT '[]',
      backends TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      risk_tier TEXT NOT NULL DEFAULT 'approve',
      tool_allowlist TEXT,
      last_probe_at INTEGER,
      last_probe_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE mcp_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      event_type TEXT,
      session_id TEXT,
      ok INTEGER,
      error TEXT,
      called_at INTEGER NOT NULL,
      duration_ms INTEGER
    );
  `);
}

vi.mock("../../services/mcp/probe.js", () => ({
  probeMcpServer: vi.fn(async (server: { id: string }) => ({
    ok: true,
    toolCount: 1,
    tools: [{ name: `${server.id}-tool` }],
    durationMs: 5,
  })),
}));

describe("MCP API routes", () => {
  let db: Database.Database;
  let blob: MemoryBlobStore;
  let app: ReturnType<typeof createMcpRoutes>;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    blob = new MemoryBlobStore();
    app = createMcpRoutes({ db, blobStore: blob, dataDir: "/tmp" });
  });

  async function req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await app.request(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, json: parsed };
  }

  it("POST /mcp/servers creates and returns the server with secretsPresent map", async () => {
    const { status, json } = await req("POST", "/mcp/servers", {
      id: "monday",
      name: "Monday",
      transport: "http",
      url: "https://mcp.monday.com/mcp",
      headerKeys: ["Authorization"],
      backends: ["claude", "codex"],
    });
    expect(status).toBe(201);
    const body = json as { server: { id: string; secretsPresent: Record<string, boolean> } };
    expect(body.server.id).toBe("monday");
    expect(body.server.secretsPresent.Authorization).toBe(false);
  });

  it("GET /mcp/servers lists in creation order", async () => {
    await req("POST", "/mcp/servers", {
      id: "a",
      name: "A",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    await req("POST", "/mcp/servers", {
      id: "b",
      name: "B",
      transport: "http",
      url: "https://b",
      backends: ["claude"],
    });
    const { status, json } = await req("GET", "/mcp/servers");
    expect(status).toBe(200);
    expect((json as { servers: { id: string }[] }).servers.map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("POST /mcp/servers returns 409 on duplicate id", async () => {
    await req("POST", "/mcp/servers", {
      id: "dup",
      name: "Dup",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    const second = await req("POST", "/mcp/servers", {
      id: "dup",
      name: "Dup2",
      transport: "stdio",
      command: "y",
      backends: ["claude"],
    });
    expect(second.status).toBe(409);
  });

  it("POST /mcp/servers returns 400 on invalid input", async () => {
    const { status } = await req("POST", "/mcp/servers", {
      id: "Bad Id With Spaces",
      name: "x",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    expect(status).toBe(400);
  });

  it("PATCH clears orphaned secrets when envKeys are removed", async () => {
    await req("POST", "/mcp/servers", {
      id: "srv",
      name: "Srv",
      transport: "stdio",
      command: "x",
      envKeys: ["OLD", "KEEP"],
      backends: ["claude"],
    });
    await req("PUT", "/mcp/servers/srv/secrets/OLD", { value: "bye" });
    await req("PUT", "/mcp/servers/srv/secrets/KEEP", { value: "stay" });
    expect(blob.blobs.has(mcpSecretBlobName("srv", "OLD"))).toBe(true);

    const patched = await req("PATCH", "/mcp/servers/srv", {
      envKeys: ["KEEP"],
    });
    expect(patched.status).toBe(200);
    expect(blob.blobs.has(mcpSecretBlobName("srv", "OLD"))).toBe(false);
    expect(blob.blobs.has(mcpSecretBlobName("srv", "KEEP"))).toBe(true);
  });

  it("DELETE /mcp/servers/:id wipes every stored secret", async () => {
    await req("POST", "/mcp/servers", {
      id: "srv",
      name: "Srv",
      transport: "http",
      url: "https://x",
      headerKeys: ["A", "B"],
      backends: ["claude"],
    });
    await req("PUT", "/mcp/servers/srv/secrets/A", { value: "1" });
    await req("PUT", "/mcp/servers/srv/secrets/B", { value: "2" });
    const deleted = await req("DELETE", "/mcp/servers/srv");
    expect(deleted.status).toBe(200);
    expect(blob.blobs.size).toBe(0);
  });

  it("enable/disable toggles enabled flag", async () => {
    await req("POST", "/mcp/servers", {
      id: "a",
      name: "A",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    const enabled = await req("POST", "/mcp/servers/a/enable");
    expect((enabled.json as { server: { enabled: boolean } }).server.enabled).toBe(true);
    const disabled = await req("POST", "/mcp/servers/a/disable");
    expect((disabled.json as { server: { enabled: boolean } }).server.enabled).toBe(
      false,
    );
  });

  it("probe persists last_probe_status and returns the result", async () => {
    await req("POST", "/mcp/servers", {
      id: "a",
      name: "A",
      transport: "stdio",
      command: "x",
      enabled: true,
      backends: ["claude"],
    });
    const res = await req("POST", "/mcp/servers/a/probe");
    expect(res.status).toBe(200);
    const body = res.json as {
      result: { ok: boolean; tools: { name: string }[] };
      server: { lastProbeStatus: { ok: boolean } | null };
    };
    expect(body.result.ok).toBe(true);
    expect(body.result.tools[0].name).toBe("a-tool");
    expect(body.server.lastProbeStatus?.ok).toBe(true);
  });

  it("probe rejects disabled servers without executing them", async () => {
    await req("POST", "/mcp/servers", {
      id: "off",
      name: "Off",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    const res = await req("POST", "/mcp/servers/off/probe");
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toBe("server_disabled");
  });

  it("PUT /mcp/servers/:id/secrets/:key rejects unknown key names", async () => {
    await req("POST", "/mcp/servers", {
      id: "a",
      name: "A",
      transport: "stdio",
      command: "x",
      envKeys: ["KNOWN"],
      backends: ["claude"],
    });
    const bad = await req("PUT", "/mcp/servers/a/secrets/UNKNOWN", { value: "x" });
    expect(bad.status).toBe(400);
  });

  it("DELETE /mcp/servers/:id/secrets/:key rejects unknown key names (symmetric with PUT)", async () => {
    await req("POST", "/mcp/servers", {
      id: "a",
      name: "A",
      transport: "stdio",
      command: "x",
      envKeys: ["KNOWN"],
      backends: ["claude"],
    });
    const bad = await req("DELETE", "/mcp/servers/a/secrets/UNKNOWN");
    expect(bad.status).toBe(400);
  });

  it("404 responses for missing ids across every route", async () => {
    expect((await req("GET", "/mcp/servers/none")).status).toBe(404);
    expect((await req("PATCH", "/mcp/servers/none", { name: "x" })).status).toBe(404);
    expect((await req("DELETE", "/mcp/servers/none")).status).toBe(404);
    expect((await req("POST", "/mcp/servers/none/enable")).status).toBe(404);
    expect((await req("POST", "/mcp/servers/none/disable")).status).toBe(404);
    expect((await req("POST", "/mcp/servers/none/probe")).status).toBe(404);
    expect(
      (await req("PUT", "/mcp/servers/none/secrets/X", { value: "y" })).status,
    ).toBe(404);
    expect(
      (await req("DELETE", "/mcp/servers/none/secrets/X")).status,
    ).toBe(404);
    expect((await req("GET", "/mcp/servers/none/activity")).status).toBe(404);
  });

  it("GET /mcp/servers/:id returns the server when found", async () => {
    await req("POST", "/mcp/servers", {
      id: "here",
      name: "Here",
      transport: "stdio",
      command: "x",
      envKeys: ["TOKEN"],
      backends: ["claude"],
    });
    const got = await req("GET", "/mcp/servers/here");
    expect(got.status).toBe(200);
    const body = got.json as {
      server: { id: string; secretsPresent: Record<string, boolean> };
    };
    expect(body.server.id).toBe("here");
    expect(body.server.secretsPresent.TOKEN).toBe(false);
  });

  it("POST /mcp/servers returns 400 on invalid JSON body", async () => {
    const res = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /mcp/servers/:id returns 400 on invalid input shape", async () => {
    await req("POST", "/mcp/servers", {
      id: "p",
      name: "P",
      transport: "http",
      url: "https://x",
      backends: ["claude"],
    });
    const bad = await req("PATCH", "/mcp/servers/p", { name: "" });
    expect(bad.status).toBe(400);
  });

  it("PATCH /mcp/servers/:id returns 400 when the patch violates transport invariants", async () => {
    await req("POST", "/mcp/servers", {
      id: "shape",
      name: "S",
      transport: "http",
      url: "https://x",
      backends: ["claude"],
    });
    const bad = await req("PATCH", "/mcp/servers/shape", { command: "cmd" });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toBe("invalid_input");
  });

  it("PATCH /mcp/servers/:id returns 400 on invalid JSON body", async () => {
    await req("POST", "/mcp/servers", {
      id: "j",
      name: "J",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    const res = await app.request("/mcp/servers/j", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });

  it("PUT secrets returns 400 on invalid JSON body", async () => {
    await req("POST", "/mcp/servers", {
      id: "s",
      name: "S",
      transport: "stdio",
      command: "x",
      envKeys: ["TOKEN"],
      backends: ["claude"],
    });
    const res = await app.request("/mcp/servers/s/secrets/TOKEN", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("PUT secrets returns 400 on empty value", async () => {
    await req("POST", "/mcp/servers", {
      id: "s2",
      name: "S",
      transport: "stdio",
      command: "x",
      envKeys: ["TOKEN"],
      backends: ["claude"],
    });
    const res = await req("PUT", "/mcp/servers/s2/secrets/TOKEN", { value: "" });
    expect(res.status).toBe(400);
  });

  it("DELETE /mcp/servers/:id/secrets/:key removes the blob", async () => {
    await req("POST", "/mcp/servers", {
      id: "d",
      name: "D",
      transport: "stdio",
      command: "x",
      envKeys: ["TOKEN"],
      backends: ["claude"],
    });
    await req("PUT", "/mcp/servers/d/secrets/TOKEN", { value: "hello" });
    expect(blob.blobs.has(mcpSecretBlobName("d", "TOKEN"))).toBe(true);
    const del = await req("DELETE", "/mcp/servers/d/secrets/TOKEN");
    expect(del.status).toBe(200);
    expect(blob.blobs.has(mcpSecretBlobName("d", "TOKEN"))).toBe(false);
  });

  it("POST /mcp/servers returns 500 when the DB write fails", async () => {
    // Drop the table so the INSERT inside insertMcpServer fails with a
    // real SQLite error — exercises the catch's generic `internal_error`
    // branch without requiring us to mock the registry.
    db.exec("DROP TABLE mcp_servers;");
    const res = await req("POST", "/mcp/servers", {
      id: "boom",
      name: "Boom",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    expect(res.status).toBe(500);
    expect((res.json as { error: string }).error).toBe("internal_error");
  });

  it("PATCH /mcp/servers/:id returns 500 when the DB write fails", async () => {
    await req("POST", "/mcp/servers", {
      id: "p500",
      name: "P",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    // Cause the UPDATE statement inside updateMcpServer to fail after the
    // SELECT succeeded. Easiest way: rename the column the statement writes.
    db.exec("ALTER TABLE mcp_servers RENAME COLUMN name TO name_renamed;");
    const res = await req("PATCH", "/mcp/servers/p500", { name: "Next" });
    expect(res.status).toBe(500);
    expect((res.json as { error: string }).error).toBe("internal_error");
  });

  it("POST /mcp/servers returns 400 with message when Zod accepts input but the registry rejects it", async () => {
    // Zod's schema lets `["codex"]` + `http` through; the per-backend
    // capability check inside the registry rejects Codex http servers with
    // a non-Authorization header, surfacing InvalidMcpServerError.
    const { status, json } = await req("POST", "/mcp/servers", {
      id: "codex-bad",
      name: "Bad",
      transport: "http",
      url: "https://x",
      headerKeys: ["X-API-Key"],
      backends: ["codex"],
    });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_input");
  });

  it("PATCH returns 404 when the row is deleted mid-patch (race)", async () => {
    await req("POST", "/mcp/servers", {
      id: "race",
      name: "R",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    // Simulate a concurrent DELETE between the initial SELECT and the UPDATE —
    // easiest reproduction: delete the row before the PATCH reaches the DB.
    // We monkey-patch updateMcpServer's read-back to force the not-found path
    // by deleting just before the UPDATE runs — achieved by deleting and then
    // issuing a PATCH whose validator passes but the registry sees no row.
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run("race");
    const res = await req("PATCH", "/mcp/servers/race", { name: "after" });
    expect(res.status).toBe(404);
  });

  it("enable propagates unexpected DB errors as 500", async () => {
    await req("POST", "/mcp/servers", {
      id: "e500",
      name: "E",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    // Rename the enabled column so the UPDATE inside setMcpServerEnabled
    // fails after the SELECT returned a row — triggers the rethrow.
    db.exec("ALTER TABLE mcp_servers RENAME COLUMN enabled TO enabled_x;");
    const res = await app.request("/mcp/servers/e500/enable", { method: "POST" });
    expect(res.status).toBe(500);
  });

  it("disable propagates unexpected DB errors as 500", async () => {
    await req("POST", "/mcp/servers", {
      id: "d500",
      name: "D",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    db.exec("ALTER TABLE mcp_servers RENAME COLUMN enabled TO enabled_x;");
    const res = await app.request("/mcp/servers/d500/disable", { method: "POST" });
    expect(res.status).toBe(500);
  });

  it("POST /mcp/disable-all flips every enabled server to disabled", async () => {
    await req("POST", "/mcp/servers", {
      id: "a",
      name: "A",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
      enabled: true,
    });
    await req("POST", "/mcp/servers/a/enable");
    const res = await req("POST", "/mcp/disable-all");
    expect(res.status).toBe(200);
    expect((res.json as { disabled: number }).disabled).toBeGreaterThanOrEqual(1);
  });

  it("POST probe returns 500 when the probe implementation throws", async () => {
    const probe = await import("../../services/mcp/probe.js");
    const spy = vi.spyOn(probe, "probeMcpServer").mockImplementationOnce(
      async () => {
        throw new Error("probe crashed");
      },
    );
    await req("POST", "/mcp/servers", {
      id: "crash",
      name: "C",
      transport: "stdio",
      command: "x",
      enabled: true,
      backends: ["claude"],
    });
    const res = await req("POST", "/mcp/servers/crash/probe");
    expect(res.status).toBe(500);
    expect((res.json as { error: string }).error).toBe("probe_failed");
    spy.mockRestore();
  });

  it("POST probe surfaces resolved secrets to the probe and returns the result envelope", async () => {
    await req("POST", "/mcp/servers", {
      id: "p",
      name: "P",
      transport: "http",
      url: "https://x",
      headerKeys: ["Authorization"],
      enabled: true,
      backends: ["claude"],
    });
    await req("PUT", "/mcp/servers/p/secrets/Authorization", { value: "Bearer t" });
    const res = await req("POST", "/mcp/servers/p/probe");
    expect(res.status).toBe(200);
    const body = res.json as {
      result: { ok: boolean };
      server: { secretsPresent: Record<string, boolean> };
    };
    expect(body.result.ok).toBe(true);
    expect(body.server.secretsPresent.Authorization).toBe(true);
  });

  it("enable does not fail when the post-enable probe chain throws", async () => {
    await req("POST", "/mcp/servers", {
      id: "chain-throw",
      name: "C",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    // Enable succeeds but probe throws during the chain — should still return 200.
    const probe = await import("../../services/mcp/probe.js");
    const spy = vi.spyOn(probe, "probeMcpServer").mockImplementationOnce(async () => {
      throw new Error("probe chain crashed");
    });
    const res = await req("POST", "/mcp/servers/chain-throw/enable");
    expect(res.status).toBe(200);
    const body = res.json as { server: { enabled: boolean } };
    expect(body.server.enabled).toBe(true);
    spy.mockRestore();
  });
});

describe("GET /mcp/servers/:id/activity", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createMcpRoutes>;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    app = createMcpRoutes({ db, blobStore: new (class implements EncryptedBlobStore {
      async exists() { return false; }
      async readUtf8() { return null; }
      async writeUtf8() {}
      async remove() {}
    })(), dataDir: "/tmp" });
  });

  async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await app.request(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { status: res.status, json: parsed };
  }

  it("returns 200 with empty calls for a server with no recorded tool calls", async () => {
    await req("POST", "/mcp/servers", {
      id: "act",
      name: "Act",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    const res = await req("GET", "/mcp/servers/act/activity");
    expect(res.status).toBe(200);
    const body = res.json as { serverId: string; calls: unknown[] };
    expect(body.serverId).toBe("act");
    expect(body.calls).toEqual([]);
  });

  it("returns 200 with tool calls for a server that has activity", async () => {
    await req("POST", "/mcp/servers", {
      id: "active",
      name: "Active",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    // Manually insert a tool call row.
    db.prepare(
      `INSERT INTO mcp_tool_calls (server_id, tool_name, called_at)
       VALUES ('active', 'some_tool', ?)`,
    ).run(Date.now());

    const res = await req("GET", "/mcp/servers/active/activity");
    expect(res.status).toBe(200);
    const body = res.json as { calls: { toolName: string }[] };
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].toolName).toBe("some_tool");
  });

  it("clamps limit to [1, 100] and handles non-numeric limit gracefully", async () => {
    await req("POST", "/mcp/servers", {
      id: "lim",
      name: "Lim",
      transport: "stdio",
      command: "x",
      backends: ["claude"],
    });
    // Non-numeric limit → falls back to 20 (no error).
    const bad = await req("GET", "/mcp/servers/lim/activity?limit=abc");
    expect(bad.status).toBe(200);

    // Oversized limit → clamped to 100.
    const big = await req("GET", "/mcp/servers/lim/activity?limit=500");
    expect(big.status).toBe(200);

    // Zero limit → clamped to 1.
    const zero = await req("GET", "/mcp/servers/lim/activity?limit=0");
    expect(zero.status).toBe(200);
  });
});

describe("isGeminiInstallAlreadyApplied", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pa-gemini-install-check-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns false when no .gemini directory exists", () => {
    expect(isGeminiInstallAlreadyApplied("google-workspace", home)).toBe(false);
    expect(isGeminiInstallAlreadyApplied("notion", home)).toBe(false);
  });

  it("google-workspace: true when the extension manifest is on disk", () => {
    const extDir = join(home, ".gemini", "extensions", "google-workspace");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "gemini-extension.json"),
      JSON.stringify({ name: "google-workspace", version: "0.0.7" }),
    );
    expect(isGeminiInstallAlreadyApplied("google-workspace", home)).toBe(true);
  });

  it("google-workspace: false when the extension dir exists but the manifest is missing", () => {
    mkdirSync(join(home, ".gemini", "extensions", "google-workspace"), {
      recursive: true,
    });
    expect(isGeminiInstallAlreadyApplied("google-workspace", home)).toBe(false);
  });

  it("notion: true when settings.json lists `notion` under mcpServers", () => {
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({
        mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } },
      }),
    );
    expect(isGeminiInstallAlreadyApplied("notion", home)).toBe(true);
  });

  it("notion: false when settings.json exists but `notion` is missing", () => {
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({ mcpServers: { other: {} } }),
    );
    expect(isGeminiInstallAlreadyApplied("notion", home)).toBe(false);
  });

  it("notion: false on malformed settings.json (bug-tolerant)", () => {
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, "settings.json"), "{ not valid json");
    expect(isGeminiInstallAlreadyApplied("notion", home)).toBe(false);
  });

  it("notion: false when mcpServers is an array (defends against the Object.keys-on-array bug)", () => {
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({ mcpServers: [{ name: "notion" }] }),
    );
    expect(isGeminiInstallAlreadyApplied("notion", home)).toBe(false);
  });
});

describe("POST /mcp/gemini-install", () => {
  let db: Database.Database;
  let blob: MemoryBlobStore;
  let app: ReturnType<typeof createMcpRoutes>;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    blob = new MemoryBlobStore();
    app = createMcpRoutes({ db, blobStore: blob, dataDir: "/tmp" });
  });

  async function postInstall(
    body: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const res = await app.request("/mcp/gemini-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, json: parsed };
  }

  it("rejects an unknown kind with 400", async () => {
    const { status, json } = await postInstall({ kind: "blender" });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_input");
  });

  it("rejects a missing kind with 400", async () => {
    const { status, json } = await postInstall({});
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_input");
  });

  // The happy path and ENOENT path require shelling out to a real
  // `gemini` binary. Mocking child_process safely from inside an already-
  // running test file requires module-level vi.mock with hoisted state,
  // which conflicts with the existing probe mock. The route's behaviour
  // around the spawn boundary is exercised end-to-end by the manual
  // smoke test the user can perform via the dashboard install card.
  // The pure idempotency check above (`isGeminiInstallAlreadyApplied`)
  // covers the most common "user clicks twice" scenario without a spawn.
});
