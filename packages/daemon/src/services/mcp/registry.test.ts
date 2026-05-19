import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import {
  anyMcpServerEnabled,
  deleteAllMcpSecrets,
  deleteMcpServer,
  disableAllMcpServers,
  DuplicateMcpServerError,
  getMcpServer,
  insertMcpServer,
  InvalidMcpServerError,
  listMcpServers,
  McpServerNotFoundError,
  resolveMcpSecrets,
  saveMcpProbeResult,
  setMcpServerEnabled,
  setMcpSecret,
  updateMcpServer,
} from "./registry.js";
import { mcpSecretBlobName } from "./types.js";

class MemoryBlobStore implements EncryptedBlobStore {
  readonly blobs = new Map<string, string>();
  async exists(name: BlobName): Promise<boolean> {
    return this.blobs.has(name);
  }
  async readUtf8(name: BlobName): Promise<string | null> {
    return this.blobs.get(name) ?? null;
  }
  async writeUtf8(name: BlobName, plaintext: string): Promise<void> {
    this.blobs.set(name, plaintext);
  }
  async remove(name: BlobName): Promise<void> {
    this.blobs.delete(name);
  }
}

function createMcpSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
      command TEXT,
      args TEXT,
      cwd TEXT,
      url TEXT,
      env_keys TEXT NOT NULL DEFAULT '[]',
      header_keys TEXT NOT NULL DEFAULT '[]',
      backends TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      risk_tier TEXT NOT NULL DEFAULT 'approve' CHECK (risk_tier IN ('read', 'notify', 'approve')),
      tool_allowlist TEXT,
      last_probe_at INTEGER,
      last_probe_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

describe("mcp registry", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createMcpSchema(db);
  });

  describe("insertMcpServer", () => {
    it("round-trips an http server with header secrets", () => {
      const saved = insertMcpServer(db, {
        id: "monday",
        name: "Monday",
        transport: "http",
        url: "https://mcp.monday.com/mcp",
        headerKeys: ["Authorization"],
        backends: ["claude", "codex"],
        enabled: true,
        riskTier: "read",
      });
      expect(saved.id).toBe("monday");
      expect(saved.transport).toBe("http");
      expect(saved.url).toBe("https://mcp.monday.com/mcp");
      expect(saved.headerKeys).toEqual(["Authorization"]);
      expect(saved.envKeys).toEqual([]);
      expect(saved.backends).toEqual(["claude", "codex"]);
      expect(saved.enabled).toBe(true);
      expect(saved.riskTier).toBe("read");
      expect(saved.toolAllowlist).toBeNull();
      expect(saved.lastProbeAt).toBeNull();
      expect(saved.createdAt).toBeGreaterThan(0);
    });

    it("round-trips a stdio server with env secrets and allowlist", () => {
      const saved = insertMcpServer(db, {
        id: "home-assistant",
        name: "Home Assistant",
        transport: "stdio",
        command: "npx",
        args: ["-y", "ha-mcp-server"],
        envKeys: ["HA_URL", "HA_TOKEN"],
        backends: ["claude"],
        toolAllowlist: ["read_state", "list_entities"],
      });
      expect(saved.command).toBe("npx");
      expect(saved.args).toEqual(["-y", "ha-mcp-server"]);
      expect(saved.envKeys).toEqual(["HA_URL", "HA_TOKEN"]);
      expect(saved.toolAllowlist).toEqual(["read_state", "list_entities"]);
      expect(saved.enabled).toBe(false);
    });

    it("rejects stdio without command", () => {
      expect(() =>
        insertMcpServer(db, {
          id: "broken",
          name: "Broken",
          transport: "stdio",
          backends: ["claude"],
        }),
      ).toThrow(InvalidMcpServerError);
    });

    it("rejects http without url", () => {
      expect(() =>
        insertMcpServer(db, {
          id: "broken",
          name: "Broken",
          transport: "http",
          backends: ["claude"],
        }),
      ).toThrow(InvalidMcpServerError);
    });

    it("rejects http with a command set", () => {
      expect(() =>
        insertMcpServer(db, {
          id: "broken",
          name: "Broken",
          transport: "http",
          url: "https://x",
          command: "npx",
          backends: ["claude"],
        }),
      ).toThrow(InvalidMcpServerError);
    });

    it("rejects empty backends", () => {
      expect(() =>
        insertMcpServer(db, {
          id: "x",
          name: "X",
          transport: "stdio",
          command: "a",
          backends: [],
        }),
      ).toThrow(InvalidMcpServerError);
    });

    it("deduplicates backends and rejects unknown ids", () => {
      const saved = insertMcpServer(db, {
        id: "x",
        name: "X",
        transport: "stdio",
        command: "a",
        // @ts-expect-error — runtime filters unknown ids
        backends: ["claude", "claude", "bogus"],
      });
      expect(saved.backends).toEqual(["claude"]);
    });

    it("rejects Codex HTTP servers with non-Authorization headers", () => {
      expect(() =>
        insertMcpServer(db, {
          id: "srv",
          name: "Srv",
          transport: "http",
          url: "https://x",
          headerKeys: ["X-API-Key"],
          backends: ["codex"],
        }),
      ).toThrow(InvalidMcpServerError);
    });

    it("accepts Codex HTTP servers with Authorization header (case-insensitive)", () => {
      const saved = insertMcpServer(db, {
        id: "srv",
        name: "Srv",
        transport: "http",
        url: "https://x",
        headerKeys: ["authorization"],
        backends: ["codex", "claude"],
      });
      expect(saved.headerKeys).toEqual(["authorization"]);
    });

    it("rejects duplicate ids", () => {
      insertMcpServer(db, {
        id: "dup",
        name: "Dup",
        transport: "stdio",
        command: "a",
        backends: ["claude"],
      });
      expect(() =>
        insertMcpServer(db, {
          id: "dup",
          name: "Dup 2",
          transport: "stdio",
          command: "b",
          backends: ["claude"],
        }),
      ).toThrow(DuplicateMcpServerError);
    });
  });

  describe("listMcpServers + getMcpServer + anyMcpServerEnabled", () => {
    it("anyMcpServerEnabled returns false on a DB without mcp_servers table", () => {
      const bareDb = new Database(":memory:");
      expect(anyMcpServerEnabled(bareDb)).toBe(false);
      bareDb.close();
    });

    it("lists in creation order and reflects enabled state", () => {
      insertMcpServer(db, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
      });
      insertMcpServer(db, {
        id: "b",
        name: "B",
        transport: "http",
        url: "https://b",
        backends: ["claude"],
        enabled: true,
      });
      const all = listMcpServers(db);
      expect(all.map((s) => s.id)).toEqual(["a", "b"]);
      expect(anyMcpServerEnabled(db)).toBe(true);

      setMcpServerEnabled(db, "b", false);
      expect(anyMcpServerEnabled(db)).toBe(false);
    });

    it("getMcpServer returns null for missing ids", () => {
      expect(getMcpServer(db, "nope")).toBeNull();
    });
  });

  describe("updateMcpServer", () => {
    beforeEach(() => {
      insertMcpServer(db, {
        id: "srv",
        name: "Server",
        transport: "http",
        url: "https://x",
        headerKeys: ["Authorization"],
        backends: ["claude"],
      });
    });

    it("patches name and backends, preserves other fields", () => {
      const updated = updateMcpServer(db, "srv", {
        name: "Server v2",
        backends: ["claude", "codex"],
      });
      expect(updated.name).toBe("Server v2");
      expect(updated.backends).toEqual(["claude", "codex"]);
      expect(updated.url).toBe("https://x");
      expect(updated.headerKeys).toEqual(["Authorization"]);
    });

    it("can clear toolAllowlist with null", () => {
      updateMcpServer(db, "srv", { toolAllowlist: ["x"] });
      const cleared = updateMcpServer(db, "srv", { toolAllowlist: null });
      expect(cleared.toolAllowlist).toBeNull();
    });

    it("rejects invalid transport shape after patch", () => {
      expect(() =>
        updateMcpServer(db, "srv", { command: "oops" }),
      ).toThrow(InvalidMcpServerError);
    });

    it("throws for missing id", () => {
      expect(() => updateMcpServer(db, "nope", { name: "x" })).toThrow(
        McpServerNotFoundError,
      );
    });
  });

  describe("setMcpServerEnabled + deleteMcpServer", () => {
    it("toggles enabled flag and updated_at", async () => {
      const before = insertMcpServer(db, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
      });
      await new Promise((r) => setTimeout(r, 2));
      const after = setMcpServerEnabled(db, "a", true);
      expect(after.enabled).toBe(true);
      expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    });

    it("delete removes the row and returns true", () => {
      insertMcpServer(db, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
      });
      expect(deleteMcpServer(db, "a")).toBe(true);
      expect(getMcpServer(db, "a")).toBeNull();
      expect(deleteMcpServer(db, "a")).toBe(false);
    });

    it("setMcpServerEnabled throws for missing id", () => {
      expect(() => setMcpServerEnabled(db, "nope", true)).toThrow(
        McpServerNotFoundError,
      );
    });
  });

  describe("saveMcpProbeResult", () => {
    it("persists probe result and bumps last_probe_at", () => {
      insertMcpServer(db, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
      });
      const saved = saveMcpProbeResult(db, "a", {
        ok: true,
        toolCount: 2,
        tools: [{ name: "t1" }, { name: "t2", description: "two" }],
        durationMs: 42,
      });
      expect(saved.lastProbeAt).toBeGreaterThan(0);
      expect(saved.lastProbeStatus?.ok).toBe(true);
      expect(saved.lastProbeStatus?.tools).toHaveLength(2);
    });

    it("throws for missing id", () => {
      expect(() =>
        saveMcpProbeResult(db, "nope", {
          ok: true,
          toolCount: 0,
          tools: [],
          durationMs: 1,
        }),
      ).toThrow(McpServerNotFoundError);
    });
  });

  describe("secret helpers", () => {
    it("resolves declared env + header secrets, missing ones as null", async () => {
      const blob = new MemoryBlobStore();
      await blob.writeUtf8(mcpSecretBlobName("srv", "HA_URL"), "http://x");
      const server = {
        id: "srv",
        envKeys: ["HA_URL", "HA_TOKEN"],
        headerKeys: ["Authorization"],
      };
      const resolved = await resolveMcpSecrets(blob, server);
      expect(resolved.HA_URL).toBe("http://x");
      expect(resolved.HA_TOKEN).toBeNull();
      expect(resolved.Authorization).toBeNull();
    });

    it("resolveMcpSecrets handles a server with no declared keys", async () => {
      const blob = new MemoryBlobStore();
      const resolved = await resolveMcpSecrets(blob, {
        id: "srv",
        envKeys: [],
        headerKeys: [],
      });
      expect(resolved).toEqual({});
    });

    it("resolveMcpSecrets accepts a server missing envKeys/headerKeys entirely", async () => {
      const blob = new MemoryBlobStore();
      const resolved = await resolveMcpSecrets(blob, {
        id: "srv",
      } as Parameters<typeof resolveMcpSecrets>[1]);
      expect(resolved).toEqual({});
    });

    it("deleteAllMcpSecrets removes every named blob", async () => {
      const blob = new MemoryBlobStore();
      await blob.writeUtf8(mcpSecretBlobName("srv", "A"), "1");
      await blob.writeUtf8(mcpSecretBlobName("srv", "B"), "2");
      await blob.writeUtf8(mcpSecretBlobName("other", "A"), "keep");
      await deleteAllMcpSecrets(blob, "srv", ["A", "B"]);
      expect(blob.blobs.size).toBe(1);
      expect(blob.blobs.has(mcpSecretBlobName("other", "A"))).toBe(true);
    });
  });

  /* Corrupt-row parsing — rows written by a buggy migration or a hand-edited
   * DB should degrade gracefully instead of blowing up the registry. */
  describe("corrupt row tolerance", () => {
    function rawInsert(row: {
      id: string;
      args?: string | null;
      env_keys?: string;
      header_keys?: string;
      backends: string;
      last_probe_status?: string | null;
      tool_allowlist?: string | null;
    }): void {
      db.prepare(
        `INSERT INTO mcp_servers (
           id, name, transport, command, args, cwd, url,
           env_keys, header_keys, backends, enabled, risk_tier,
           tool_allowlist, last_probe_at, last_probe_status,
           created_at, updated_at
         ) VALUES (
           @id, 'X', 'stdio', 'cmd', @args, NULL, NULL,
           @env_keys, @header_keys, @backends, 0, 'approve',
           @tool_allowlist, NULL, @last_probe_status,
           1, 1
         )`,
      ).run({
        id: row.id,
        args: row.args ?? null,
        env_keys: row.env_keys ?? "[]",
        header_keys: row.header_keys ?? "[]",
        backends: row.backends,
        tool_allowlist: row.tool_allowlist ?? null,
        last_probe_status: row.last_probe_status ?? null,
      });
    }

    it("returns [] when env_keys / header_keys / args JSON is malformed", () => {
      rawInsert({
        id: "bad",
        args: "{not json",
        env_keys: "{not json",
        header_keys: "{not json",
        backends: '["claude"]',
      });
      const server = getMcpServer(db, "bad");
      expect(server?.envKeys).toEqual([]);
      expect(server?.headerKeys).toEqual([]);
      expect(server?.args).toEqual([]);
    });

    it("ignores non-array JSON in env_keys", () => {
      rawInsert({
        id: "bad",
        env_keys: '"not-an-array"',
        backends: '["claude"]',
      });
      const server = getMcpServer(db, "bad");
      expect(server?.envKeys).toEqual([]);
    });

    it("filters non-string entries from env_keys", () => {
      rawInsert({
        id: "bad",
        env_keys: '["OK", 42, null]',
        backends: '["claude"]',
      });
      const server = getMcpServer(db, "bad");
      expect(server?.envKeys).toEqual(["OK"]);
    });

    it("returns [] backends when backends JSON is malformed or non-array", () => {
      rawInsert({ id: "bad-json", backends: "{not json" });
      rawInsert({ id: "bad-shape", backends: '"claude"' });
      expect(getMcpServer(db, "bad-json")?.backends).toEqual([]);
      expect(getMcpServer(db, "bad-shape")?.backends).toEqual([]);
    });

    it("returns null probe status when the JSON fails zod validation or parse", () => {
      rawInsert({
        id: "bad-probe",
        backends: '["claude"]',
        last_probe_status: "{not json",
      });
      expect(getMcpServer(db, "bad-probe")?.lastProbeStatus).toBeNull();
      rawInsert({
        id: "wrong-shape",
        backends: '["claude"]',
        last_probe_status: '{"ok": "yes"}',
      });
      expect(getMcpServer(db, "wrong-shape")?.lastProbeStatus).toBeNull();
    });
  });

  describe("updateMcpServer — probe invalidation and edge cases", () => {
    beforeEach(() => {
      insertMcpServer(db, {
        id: "srv",
        name: "Server",
        transport: "http",
        url: "https://x",
        headerKeys: ["Authorization"],
        backends: ["claude"],
      });
      saveMcpProbeResult(db, "srv", {
        ok: true,
        toolCount: 1,
        tools: [{ name: "t" }],
        durationMs: 1,
      });
    });

    it("clears cached probe status when the transport shape changes", () => {
      const before = getMcpServer(db, "srv");
      expect(before?.lastProbeStatus).toBeTruthy();
      const updated = updateMcpServer(db, "srv", { url: "https://y" });
      expect(updated.lastProbeStatus).toBeNull();
      expect(updated.lastProbeAt).toBeNull();
    });

    it("keeps cached probe status when only cosmetic fields change", () => {
      const updated = updateMcpServer(db, "srv", { name: "Server v2" });
      expect(updated.lastProbeStatus?.ok).toBe(true);
      expect(updated.lastProbeAt).not.toBeNull();
    });

    it("clears probe status when args change (stdio)", () => {
      insertMcpServer(db, {
        id: "stdio",
        name: "S",
        transport: "stdio",
        command: "a",
        args: ["-v"],
        backends: ["claude"],
      });
      saveMcpProbeResult(db, "stdio", {
        ok: true,
        toolCount: 0,
        tools: [],
        durationMs: 1,
      });
      const updated = updateMcpServer(db, "stdio", { args: ["-v", "--verbose"] });
      expect(updated.lastProbeStatus).toBeNull();
    });

    it("clears probe status when cwd changes", () => {
      insertMcpServer(db, {
        id: "cwd-test",
        name: "C",
        transport: "stdio",
        command: "a",
        cwd: "/one",
        backends: ["claude"],
      });
      saveMcpProbeResult(db, "cwd-test", {
        ok: true,
        toolCount: 0,
        tools: [],
        durationMs: 1,
      });
      const updated = updateMcpServer(db, "cwd-test", { cwd: "/two" });
      expect(updated.lastProbeStatus).toBeNull();
    });

    it("rejects when normalized backends list becomes empty", () => {
      expect(() =>
        // @ts-expect-error — runtime filters unknown ids
        updateMcpServer(db, "srv", { backends: ["bogus-only"] }),
      ).toThrow(InvalidMcpServerError);
    });

    it("rejects Codex http patches with non-Authorization headers", () => {
      expect(() =>
        updateMcpServer(db, "srv", {
          backends: ["claude", "codex"],
          headerKeys: ["X-API-Key"],
        }),
      ).toThrow(InvalidMcpServerError);
    });

    it("keeps cached probe status when args are merely reordered to the same value", () => {
      insertMcpServer(db, {
        id: "eq-args",
        name: "E",
        transport: "stdio",
        command: "a",
        args: ["x", "y"],
        backends: ["claude"],
      });
      saveMcpProbeResult(db, "eq-args", {
        ok: true,
        toolCount: 0,
        tools: [],
        durationMs: 1,
      });
      const updated = updateMcpServer(db, "eq-args", {
        args: ["x", "y"],
      });
      expect(updated.lastProbeStatus?.ok).toBe(true);
    });

    it("clears probe status when args have the same length but different content", () => {
      insertMcpServer(db, {
        id: "diff-args",
        name: "D",
        transport: "stdio",
        command: "a",
        args: ["x", "y"],
        backends: ["claude"],
      });
      saveMcpProbeResult(db, "diff-args", {
        ok: true,
        toolCount: 0,
        tools: [],
        durationMs: 1,
      });
      const updated = updateMcpServer(db, "diff-args", {
        args: ["x", "z"],
      });
      expect(updated.lastProbeStatus).toBeNull();
    });
  });

  describe("insertMcpServer branch coverage", () => {
    it("accepts Codex http servers that declare no headers (anonymous MCP)", () => {
      const saved = insertMcpServer(db, {
        id: "anon",
        name: "Anon",
        transport: "http",
        url: "https://example.com/mcp",
        backends: ["codex"],
      });
      expect(saved.headerKeys).toEqual([]);
    });
  });

  describe("disableAllMcpServers (kill switch)", () => {
    it("flips every enabled=1 row to 0 and returns the change count", () => {
      insertMcpServer(db, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
        enabled: true,
      });
      insertMcpServer(db, {
        id: "b",
        name: "B",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
        enabled: true,
      });
      insertMcpServer(db, {
        id: "c",
        name: "C",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
        enabled: false,
      });
      expect(disableAllMcpServers(db)).toBe(2);
      expect(listMcpServers(db).every((s) => !s.enabled)).toBe(true);
    });

    it("returns 0 when nothing is enabled", () => {
      insertMcpServer(db, {
        id: "a",
        name: "A",
        transport: "stdio",
        command: "x",
        backends: ["claude"],
      });
      expect(disableAllMcpServers(db)).toBe(0);
    });
  });

  describe("setMcpSecret direct helper", () => {
    it("writes the named blob under mcp:<id>:<key>", async () => {
      const blob = new MemoryBlobStore();
      await setMcpSecret(blob, "srv", "TOKEN", "value");
      expect(blob.blobs.get(mcpSecretBlobName("srv", "TOKEN"))).toBe("value");
    });
  });
});
