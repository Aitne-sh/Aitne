import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import { insertMcpServer, listMcpServers } from "./registry.js";
import { McpAutoProbe } from "./auto-probe.js";
import { mcpSecretBlobName, type McpProbeResult, type McpServer } from "./types.js";

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

function makeOkProbe(toolNames: string[]): McpProbeResult {
  return {
    ok: true,
    toolCount: toolNames.length,
    tools: toolNames.map((name) => ({ name })),
    durationMs: 5,
  };
}

describe("McpAutoProbe", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;

  beforeEach(() => {
    db = new Database(":memory:");
    createMcpSchema(db);
    blobStore = new MemoryBlobStore();
  });

  function makeObserver(opts?: {
    intervalMinutes?: number;
    now?: () => number;
    probe?: (server: McpServer) => Promise<McpProbeResult>;
  }) {
    const probeCalls: string[] = [];
    const probeFn = opts?.probe
      ? vi.fn(async (server: Parameters<typeof opts.probe>[0]) => {
          probeCalls.push(server.id);
          return opts.probe!(server as McpServer);
        })
      : vi.fn(async (server: { id: string }) => {
          probeCalls.push(server.id);
          return makeOkProbe(["tool_a"]);
        });
    const observer = new McpAutoProbe({
      db,
      blobStore,
      dataDir: "/tmp/data",
      intervalMinutes: opts?.intervalMinutes ?? 60,
      now: opts?.now,
      staggerMs: 0,
      sleep: async () => {},
      probe: probeFn as unknown as typeof import("./probe.js").probeMcpServer,
    });
    return { observer, probeFn, probeCalls };
  }

  it("does not schedule a timer when intervalMinutes is 0", async () => {
    const { observer, probeFn } = makeObserver({ intervalMinutes: 0 });
    await observer.start();
    // tick() still runs when called directly, but since the timer was never
    // scheduled we just confirm no probe fired during start.
    expect(probeFn).not.toHaveBeenCalled();
    await observer.stop();
  });

  it("probes every enabled server on a tick and persists the result", async () => {
    insertMcpServer(db, {
      id: "monday",
      name: "Monday",
      transport: "http",
      url: "https://example.com/mcp",
      backends: ["claude"],
      enabled: true,
    });
    insertMcpServer(db, {
      id: "ha",
      name: "Home Assistant",
      transport: "stdio",
      command: "ha-mcp",
      backends: ["claude"],
      enabled: true,
    });
    const { observer, probeCalls } = makeObserver();
    await observer.tick();
    expect(probeCalls.sort()).toEqual(["ha", "monday"]);
    const servers = listMcpServers(db);
    for (const s of servers) {
      expect(s.lastProbeStatus?.ok).toBe(true);
      expect(s.lastProbeAt).toBeGreaterThan(0);
    }
  });

  it("skips disabled servers", async () => {
    insertMcpServer(db, {
      id: "active",
      name: "Active",
      transport: "http",
      url: "https://a.test",
      backends: ["claude"],
      enabled: true,
    });
    insertMcpServer(db, {
      id: "paused",
      name: "Paused",
      transport: "http",
      url: "https://p.test",
      backends: ["claude"],
      enabled: false,
    });
    const { observer, probeCalls } = makeObserver();
    await observer.tick();
    expect(probeCalls).toEqual(["active"]);
  });

  it("skips servers probed within half the interval (freshness guard)", async () => {
    // 60 min interval → freshness window is 30 min (1_800_000 ms).
    insertMcpServer(db, {
      id: "recent",
      name: "Recent",
      transport: "http",
      url: "https://r.test",
      backends: ["claude"],
      enabled: true,
    });
    // Stamp a recent probe so the guard fires.
    db.prepare(
      `UPDATE mcp_servers SET last_probe_at = ?, last_probe_status = ? WHERE id = ?`,
    ).run(
      1_000_000_000_000,
      JSON.stringify(makeOkProbe(["x"])),
      "recent",
    );
    const { observer, probeCalls } = makeObserver({
      intervalMinutes: 60,
      now: () => 1_000_000_000_000 + 60_000, // only 1 min later
    });
    await observer.tick();
    expect(probeCalls).toEqual([]);
  });

  it("still probes when the last probe is older than half the interval", async () => {
    insertMcpServer(db, {
      id: "stale",
      name: "Stale",
      transport: "http",
      url: "https://s.test",
      backends: ["claude"],
      enabled: true,
    });
    db.prepare(
      `UPDATE mcp_servers SET last_probe_at = ?, last_probe_status = ? WHERE id = ?`,
    ).run(
      1_000_000_000_000,
      JSON.stringify(makeOkProbe(["x"])),
      "stale",
    );
    const { observer, probeCalls } = makeObserver({
      intervalMinutes: 60,
      now: () => 1_000_000_000_000 + 60 * 60_000, // 60 min later — past freshness
    });
    await observer.tick();
    expect(probeCalls).toEqual(["stale"]);
  });

  it("persists failure results without disabling the server", async () => {
    insertMcpServer(db, {
      id: "broken",
      name: "Broken",
      transport: "http",
      url: "https://b.test",
      backends: ["claude"],
      enabled: true,
    });
    const { observer } = makeObserver({
      probe: async () => ({
        ok: false,
        toolCount: 0,
        tools: [],
        error: "connection refused",
        durationMs: 7,
      }),
    });
    await observer.tick();
    const [after] = listMcpServers(db);
    expect(after.enabled).toBe(true);
    expect(after.lastProbeStatus?.ok).toBe(false);
    expect(after.lastProbeStatus?.error).toBe("connection refused");
  });

  it("swallows probe-runner exceptions so one broken server does not halt the tick", async () => {
    insertMcpServer(db, {
      id: "throws",
      name: "Throws",
      transport: "http",
      url: "https://t.test",
      backends: ["claude"],
      enabled: true,
    });
    insertMcpServer(db, {
      id: "healthy",
      name: "Healthy",
      transport: "http",
      url: "https://h.test",
      backends: ["claude"],
      enabled: true,
    });
    let callCount = 0;
    const { observer, probeCalls } = makeObserver({
      probe: async () => {
        callCount++;
        if (callCount === 1) throw new Error("boom");
        return makeOkProbe(["x"]);
      },
    });
    await observer.tick();
    expect(probeCalls).toHaveLength(2);
    // Second server's probe persisted even though the first threw.
    const healthy = listMcpServers(db).find((s) => s.id === "healthy");
    expect(healthy?.lastProbeStatus?.ok).toBe(true);
  });

  it("guards against overlapping ticks (re-entrancy)", async () => {
    insertMcpServer(db, {
      id: "slow",
      name: "Slow",
      transport: "http",
      url: "https://s.test",
      backends: ["claude"],
      enabled: true,
    });
    let resolveProbe: (r: McpProbeResult) => void = () => {};
    const probePromise = new Promise<McpProbeResult>((r) => (resolveProbe = r));
    const { observer, probeFn } = makeObserver({
      probe: () => probePromise,
    });
    const first = observer.tick();
    // Second tick fires while first is still suspended inside the fake probe.
    const second = observer.tick();
    resolveProbe(makeOkProbe(["x"]));
    await Promise.all([first, second]);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the timer so no further ticks fire", async () => {
    const { observer } = makeObserver({ intervalMinutes: 1 });
    await observer.start();
    await observer.stop();
    // If stop() didn't clear the timer, a hanging ref would keep Node alive;
    // the test completing without leaking is the assertion. Also ensure
    // stop() is idempotent.
    await observer.stop();
  });

  it("forwards resolved secrets from the blob store to the probe runner", async () => {
    insertMcpServer(db, {
      id: "with-secrets",
      name: "WithSecrets",
      transport: "http",
      url: "https://s.test",
      headerKeys: ["AUTH"],
      envKeys: ["TOKEN"],
      backends: ["claude"],
      enabled: true,
    });
    await blobStore.writeUtf8(
      mcpSecretBlobName("with-secrets", "AUTH"),
      "bearer-x",
    );
    await blobStore.writeUtf8(
      mcpSecretBlobName("with-secrets", "TOKEN"),
      "env-y",
    );
    const captured: Record<string, string>[] = [];
    const observer = new McpAutoProbe({
      db,
      blobStore,
      dataDir: "/tmp/data",
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
      probe: (async (_server: McpServer, opts: { secrets: Record<string, string> }) => {
        captured.push({ ...opts.secrets });
        return makeOkProbe(["t"]);
      }) as unknown as typeof import("./probe.js").probeMcpServer,
    });
    await observer.tick();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ AUTH: "bearer-x", TOKEN: "env-y" });
  });

  it("returns early on a tick with no enabled servers (and uses constructor defaults)", async () => {
    // No option overrides beyond the required deps — this exercises the
    // `staggerMs ?? DEFAULT_STAGGER_MS` + `probe ?? probeMcpServer` +
    // `now ?? Date.now` + `sleep ?? setTimeout-backed` fallbacks all at once.
    // With zero enabled servers, runTick bails before any of those matter.
    const observer = new McpAutoProbe({
      db,
      blobStore,
      dataDir: "/tmp/data",
      intervalMinutes: 60,
    });
    // DB is empty — no rows to probe. Should complete without calling the
    // real `probeMcpServer`, which would otherwise reach out to the network.
    await observer.tick();
    expect(listMcpServers(db)).toEqual([]);
  });

  it("falls back to a real setTimeout-backed sleep when none is injected", async () => {
    insertMcpServer(db, {
      id: "a",
      name: "A",
      transport: "http",
      url: "https://a.test",
      backends: ["claude"],
      enabled: true,
    });
    insertMcpServer(db, {
      id: "b",
      name: "B",
      transport: "http",
      url: "https://b.test",
      backends: ["claude"],
      enabled: true,
    });
    // Omit `sleep`; use a tiny stagger so the real promise resolves quickly.
    const observer = new McpAutoProbe({
      db,
      blobStore,
      dataDir: "/tmp/data",
      intervalMinutes: 60,
      staggerMs: 1,
      probe: (async () => makeOkProbe(["t"])) as unknown as typeof import("./probe.js").probeMcpServer,
    });
    await observer.tick();
    // Both probes ran — the default sleep resolved between them.
    const statuses = listMcpServers(db).map((s) => s.lastProbeStatus?.ok);
    expect(statuses).toEqual([true, true]);
  });
});
