/**
 * Tests for POST /mcp/gemini-install — the route that shells out to the
 * `gemini` CLI to install the google-workspace extension or register the
 * Notion MCP server. These tests require mocking node:child_process to
 * avoid a real binary invocation, so they live in a separate file from
 * the main mcp.test.ts (which has a module-level probe mock that conflicts
 * with adding a child_process mock in the same file scope).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import { createMcpRoutes } from "./mcp.js";

// ── Module mocks ─────────────────────────────────────────────────────────────

// Mutable home dir controlled per-test.  The factory captures the variable
// by closure; when we change `_homeDir` in beforeEach the mock returns the
// updated value.
let _homeDir = tmpdir();

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => _homeDir),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock("../../services/mcp/probe.js", () => ({
  probeMcpServer: vi.fn().mockResolvedValue({ ok: true, toolCount: 0, tools: [], durationMs: 1 }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

class MemBlobStore implements EncryptedBlobStore {
  readonly blobs = new Map<string, string>();
  async exists(n: BlobName) { return this.blobs.has(n); }
  async readUtf8(n: BlobName) { return this.blobs.get(n) ?? null; }
  async writeUtf8(n: BlobName, v: string) { this.blobs.set(n, v); }
  async remove(n: BlobName) { this.blobs.delete(n); }
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

// ── Test suite ───────────────────────────────────────────────────────────────

describe("POST /mcp/gemini-install", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createMcpRoutes>;
  let home: string;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    home = mkdtempSync(join(tmpdir(), "pa-gemini-home-"));
    _homeDir = home; // update the closure so the mock returns our tmpdir
    vi.mocked(execFile).mockReset();
    app = createMcpRoutes({ db, blobStore: new MemBlobStore(), dataDir: "/tmp" });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    db.close();
  });

  async function post(body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await app.request("/mcp/gemini-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, json: parsed };
  }

  it("returns 400 for an unknown kind", async () => {
    const { status, json } = await post({ kind: "unknown-tool" });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toBe("invalid_input");
  });

  it("returns 400 for a missing kind", async () => {
    const { status } = await post({});
    expect(status).toBe(400);
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await app.request("/mcp/gemini-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
  });

  it("short-circuits for google-workspace when the manifest already exists", async () => {
    const extDir = join(home, ".gemini", "extensions", "google-workspace");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "gemini-extension.json"), JSON.stringify({ name: "google-workspace" }));

    const { status, json } = await post({ kind: "google-workspace" });
    expect(status).toBe(200);
    const body = json as { ok: boolean; alreadyInstalled: boolean };
    expect(body.ok).toBe(true);
    expect(body.alreadyInstalled).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("short-circuits for notion when settings.json already lists it", async () => {
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      join(geminiDir, "settings.json"),
      JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } } }),
    );

    const { status, json } = await post({ kind: "notion" });
    expect(status).toBe(200);
    const body = json as { ok: boolean; alreadyInstalled: boolean };
    expect(body.ok).toBe(true);
    expect(body.alreadyInstalled).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns ok:true when execFile succeeds for google-workspace", async () => {
    // The real execFile uses util.promisify.custom which returns {stdout, stderr}.
    // Our mock replaces execFile with a vi.fn(); promisify wraps it with the
    // standard callback contract.  Calling callback(null, {stdout, stderr})
    // passes a single value to the promisify wrapper → resolves with {stdout, stderr}.
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
      cb(null, { stdout: "Installed\n", stderr: "" });
      return {} as ReturnType<typeof execFile>;
    });

    const { status, json } = await post({ kind: "google-workspace" });
    expect(status).toBe(200);
    const body = json as { ok: boolean; alreadyInstalled: boolean; kind: string };
    expect(body.ok).toBe(true);
    expect(body.alreadyInstalled).toBe(false);
    expect(body.kind).toBe("google-workspace");
    expect(execFile).toHaveBeenCalled();
  });

  it("returns ok:true when execFile succeeds for notion", async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
      cb(null, { stdout: "Added notion\n", stderr: "" });
      return {} as ReturnType<typeof execFile>;
    });

    const { status, json } = await post({ kind: "notion" });
    expect(status).toBe(200);
    const body = json as { ok: boolean; kind: string };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("notion");
  });

  it("returns 503 with gemini_cli_not_found when execFile fails with ENOENT", async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error & { code: string; stdout: string; stderr: string }) => void;
      const err = Object.assign(new Error("spawn gemini ENOENT"), {
        code: "ENOENT",
        stdout: "",
        stderr: "gemini: not found",
      });
      cb(err);
      return {} as ReturnType<typeof execFile>;
    });

    const { status, json } = await post({ kind: "google-workspace" });
    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("gemini_cli_not_found");
  });

  it("returns 502 with install_failed when execFile fails with a numeric exit code", async () => {
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error & { code: number; stdout: string; stderr: string }) => void;
      const err = Object.assign(new Error("Command failed: gemini extensions install"), {
        code: 1,
        stdout: "partial\n",
        stderr: "Error: extension already exists",
      });
      cb(err);
      return {} as ReturnType<typeof execFile>;
    });

    const { status, json } = await post({ kind: "notion" });
    expect(status).toBe(502);
    const body = json as { ok: boolean; error: string; exitCode: number };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("install_failed");
    expect(body.exitCode).toBe(1);
  });
});
