import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import {
  materializeMcpForSession,
  renderMcpSection,
  resolvePlaceholdersDeep,
} from "./session-materializer.js";
import { insertMcpServer, saveMcpProbeResult, setMcpSecret } from "./registry.js";

class MemoryBlobStore implements EncryptedBlobStore {
  readonly blobs = new Map<string, string>();
  async exists(n: BlobName) {
    return this.blobs.has(n);
  }
  async readUtf8(n: BlobName) {
    return this.blobs.get(n) ?? null;
  }
  async writeUtf8(n: BlobName, plaintext: string) {
    this.blobs.set(n, plaintext);
  }
  async remove(n: BlobName) {
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
  `);
}

describe("materializeMcpForSession", () => {
  let db: Database.Database;
  let blob: MemoryBlobStore;
  let sessionDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    blob = new MemoryBlobStore();
    sessionDir = mkdtempSync(join(tmpdir(), "pa-mcp-mat-"));
    // Pre-create the CLAUDE.md the compiler would normally have written so
    // the materializer has a target for the MCP-section append.
    writeFileSync(join(sessionDir, "CLAUDE.md"), "# Stub\n", "utf-8");
  });

  afterEach(() => {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns an empty result and strips any existing MCP section when no servers target the backend", async () => {
    writeFileSync(
      join(sessionDir, "CLAUDE.md"),
      `# Stub\n\n<!-- pa:mcp-section:begin -->\n\n## MCP tools available\nstale\n\n<!-- pa:mcp-section:end -->\n`,
      "utf-8",
    );
    const out = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    expect(out.servers).toEqual([]);
    expect(out.configPath).toBeNull();
    expect(out.claudeMcpServers).toBeNull();
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.includes("pa:mcp-section:begin")).toBe(false);
    expect(claudeMd.includes("stale")).toBe(false);
  });

  it("removes the stale on-disk config file when no servers target the backend", async () => {
    // Simulate a prior materialize that left a .mcp.json on disk.
    writeFileSync(
      join(sessionDir, ".mcp.json"),
      `{"mcpServers":{"ghost":{"type":"http","url":"https://x","headers":{"Authorization":"\${MCP_GHOST_AUTHORIZATION}"}}}}\n`,
      "utf-8",
    );
    const out = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    expect(out.servers).toEqual([]);
    // Without this cleanup, Claude SDK would still load .mcp.json from cwd,
    // attempt to connect to "ghost", and silently 401 because the
    // MCP_GHOST_AUTHORIZATION env var is no longer exported.
    const { existsSync: exists } = await import("node:fs");
    expect(exists(join(sessionDir, ".mcp.json"))).toBe(false);
  });

  it("removes the stale .codex/config.toml when no servers target codex", async () => {
    // AGENTS.md may not exist in this harness; the stub only writes
    // CLAUDE.md. That's fine — stripMcpSection silently skips a missing
    // instruction file, so this test focuses on the config-file cleanup.
    const codexConfig = join(sessionDir, ".codex", "config.toml");
    writeFileSync(join(sessionDir, "AGENTS.md"), "# Stub\n", "utf-8");
    mkdirSync(join(sessionDir, ".codex"), { recursive: true });
    writeFileSync(
      codexConfig,
      `[mcp_servers.ghost]\ncommand = "npx"\nargs = ["-y", "ha-mcp"]\nenv = { HA_TOKEN = "old-secret-value" }\n`,
      "utf-8",
    );
    await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "codex",
      autonomous: false,
    });
    const { existsSync: exists } = await import("node:fs");
    expect(exists(codexConfig)).toBe(false);
  });

  it("writes .mcp.json with placeholders, exports secrets via env, and inlines the tools section", async () => {
    insertMcpServer(db, {
      id: "monday",
      name: "Monday",
      transport: "http",
      url: "https://mcp.monday.com/mcp",
      headerKeys: ["Authorization"],
      backends: ["claude"],
      enabled: true,
      riskTier: "read",
    });
    await setMcpSecret(blob, "monday", "Authorization", "Bearer XYZ");
    saveMcpProbeResult(db, "monday", {
      ok: true,
      toolCount: 2,
      tools: [
        { name: "create-task", description: "Create a task" },
        { name: "list-tasks" },
      ],
      durationMs: 5,
    });

    const out = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });

    expect(out.servers.map((s) => s.id)).toEqual(["monday"]);
    expect(out.configPath).toBe(join(sessionDir, ".mcp.json"));

    const fileContents = readFileSync(out.configPath!, "utf-8");
    // Placeholder reference, not the raw secret.
    expect(fileContents.includes("Bearer XYZ")).toBe(false);
    expect(fileContents.includes("${MCP_MONDAY_AUTHORIZATION}")).toBe(true);

    // Env carries the resolved secret under the scoped name.
    expect(out.env.MCP_MONDAY_AUTHORIZATION).toBe("Bearer XYZ");

    // Claude SDK object shape is parsed back from the file AND headers are
    // resolved in place — the SDK does not expand env vars in the in-memory
    // `mcpServers` object, so we must hand it already-substituted values.
    expect(out.claudeMcpServers).not.toBeNull();
    const mondayEntry = (out.claudeMcpServers as Record<
      string,
      { type?: string; url?: string; headers?: Record<string, string> }
    >).monday;
    expect(mondayEntry).toMatchObject({
      type: "http",
      url: "https://mcp.monday.com/mcp",
    });
    expect(mondayEntry.headers?.Authorization).toBe("Bearer XYZ");
    expect(mondayEntry.headers?.Authorization?.includes("$")).toBe(false);

    // Instruction file section inlines the probed tools.
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.includes("## MCP tools available")).toBe(true);
    expect(claudeMd.includes("`create-task`")).toBe(true);
    expect(claudeMd.includes("`list-tasks`")).toBe(true);
    expect(claudeMd.includes("<!-- pa:mcp-section:begin -->")).toBe(true);
    expect(claudeMd.includes("<!-- pa:mcp-section:end -->")).toBe(true);
  });

  it("strips approve-tier tools from autonomous sessions but not reactive ones", async () => {
    insertMcpServer(db, {
      id: "finance",
      name: "Finance",
      transport: "http",
      url: "https://example.com/mcp",
      headerKeys: ["Authorization"],
      backends: ["claude"],
      enabled: true,
      riskTier: "approve",
    });
    saveMcpProbeResult(db, "finance", {
      ok: true,
      toolCount: 1,
      tools: [{ name: "transfer" }],
      durationMs: 5,
    });

    const autonomous = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: true,
    });
    expect(autonomous.disallowedTools).toContain("mcp__finance__transfer");

    const reactive = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    expect(reactive.disallowedTools).toEqual([]);
  });

  it("re-running materialization replaces the MCP section in place (no duplicates)", async () => {
    insertMcpServer(db, {
      id: "weather",
      name: "Weather",
      transport: "http",
      url: "https://w.example.com/mcp",
      backends: ["claude"],
      enabled: true,
      riskTier: "read",
    });
    saveMcpProbeResult(db, "weather", {
      ok: true,
      toolCount: 1,
      tools: [{ name: "forecast" }],
      durationMs: 3,
    });
    await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    const begins = claudeMd.match(/pa:mcp-section:begin/g) ?? [];
    const ends = claudeMd.match(/pa:mcp-section:end/g) ?? [];
    expect(begins.length).toBe(1);
    expect(ends.length).toBe(1);
  });

  it("renderMcpSection handles servers with no probe results gracefully", () => {
    const out = renderMcpSection([
      {
        id: "fresh",
        name: "Fresh",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://f.example.com/mcp",
        envKeys: [],
        headerKeys: [],
        backends: ["claude"],
        enabled: true,
        riskTier: "read",
        toolAllowlist: null,
        lastProbeAt: null,
        lastProbeStatus: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(out.includes("No probe results recorded")).toBe(true);
  });

  it("renderMcpSection surfaces toolAllowlist when set", () => {
    const out = renderMcpSection([
      {
        id: "srv",
        name: "S",
        transport: "http",
        command: null,
        args: null,
        cwd: null,
        url: "https://x",
        envKeys: [],
        headerKeys: [],
        backends: ["claude"],
        enabled: true,
        riskTier: "read",
        toolAllowlist: ["allowed_a", "allowed_b"],
        lastProbeAt: 1,
        lastProbeStatus: {
          ok: true,
          toolCount: 1,
          tools: [{ name: "allowed_a", description: "works" }],
          durationMs: 1,
        },
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(out).toContain("Allowed tools: `allowed_a`, `allowed_b`");
    expect(out).toContain("`allowed_a` — works");
  });

  it("leaves the instruction file alone when it does not exist", async () => {
    insertMcpServer(db, {
      id: "srv",
      name: "S",
      transport: "http",
      url: "https://x",
      backends: ["claude"],
      enabled: true,
    });
    // Remove the stub CLAUDE.md before materialization — the body should not
    // be written, and no error surfaces.
    rmSync(join(sessionDir, "CLAUDE.md"), { force: true });
    const out = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    expect(out.servers).toHaveLength(1);
    // Config file still written; just the instruction file skipped.
    expect(out.configPath).toBe(join(sessionDir, ".mcp.json"));
  });

  it("appending MCP section to a file without existing markers inserts at the end", async () => {
    // The default stub CLAUDE.md has no markers; verify the section appends
    // rather than replacing.
    writeFileSync(join(sessionDir, "CLAUDE.md"), "existing body\n", "utf-8");
    insertMcpServer(db, {
      id: "srv2",
      name: "S2",
      transport: "http",
      url: "https://x",
      backends: ["claude"],
      enabled: true,
    });
    await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.startsWith("existing body")).toBe(true);
    expect(claudeMd.includes("pa:mcp-section:begin")).toBe(true);
  });

  it("stripping MCP section with no existing markers leaves the file untouched", async () => {
    // No servers enabled, so materialize tries to strip. With no markers, it
    // exercises the early-return branch in replaceOrAppendSection.
    writeFileSync(join(sessionDir, "CLAUDE.md"), "plain body\n", "utf-8");
    const out = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    expect(out.servers).toEqual([]);
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toBe("plain body\n");
  });

  it("replaces the section in place when content follows it", async () => {
    writeFileSync(
      join(sessionDir, "CLAUDE.md"),
      `# Top\n\n<!-- pa:mcp-section:begin -->\nstale\n<!-- pa:mcp-section:end -->\n\n## Trailing\nkept\n`,
      "utf-8",
    );
    insertMcpServer(db, {
      id: "trail",
      name: "T",
      transport: "http",
      url: "https://x",
      backends: ["claude"],
      enabled: true,
    });
    await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain("stale");
    expect(claudeMd).toContain("## Trailing");
    expect(claudeMd).toContain("kept");
    expect(claudeMd).toContain("pa:mcp-section:begin");
  });

  it("strips the section and preserves any content that followed it", async () => {
    writeFileSync(
      join(sessionDir, "CLAUDE.md"),
      `# Top\n\n<!-- pa:mcp-section:begin -->\nstale\n<!-- pa:mcp-section:end -->\n\n## After\nkept\n`,
      "utf-8",
    );
    const out = await materializeMcpForSession({
      db,
      blobStore: blob,
      sessionDir,
      backendId: "claude",
      autonomous: false,
    });
    expect(out.servers).toEqual([]);
    const claudeMd = readFileSync(join(sessionDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("## After");
    expect(claudeMd).toContain("kept");
    expect(claudeMd).not.toContain("pa:mcp-section:begin");
  });

  describe("resolvePlaceholdersDeep", () => {
    it("substitutes ${VAR} in nested strings, arrays, and object values", () => {
      const env = { A: "alpha", B: "beta" };
      const out = resolvePlaceholdersDeep(
        {
          top: "prefix ${A}",
          list: ["${B}", "noop"],
          nested: { key: "${A}-${B}" },
        },
        env,
      );
      expect(out).toEqual({
        top: "prefix alpha",
        list: ["beta", "noop"],
        nested: { key: "alpha-beta" },
      });
    });

    it("leaves unresolved placeholders and non-string primitives alone", () => {
      const out = resolvePlaceholdersDeep(
        { n: 42, b: true, z: null, u: undefined, str: "${MISSING}" },
        {},
      );
      expect(out).toEqual({
        n: 42,
        b: true,
        z: null,
        u: undefined,
        str: "${MISSING}",
      });
    });
  });
});

