import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  AutonomousSpawnGate,
  BACKEND_API_HOSTS,
  type SpawnGateDecision,
} from "./spawn-gates.js";

function createBackendsSchema(db: Database.Database): void {
  // Minimal mirror of the production `backends` table — only the columns
  // `readCachedAuthStatus` reads. Same pattern as auth-health-monitor.test.ts.
  db.exec(`
    CREATE TABLE backends (
      id TEXT PRIMARY KEY,
      auth_status TEXT NOT NULL DEFAULT 'unknown',
      auth_last_verified_at TEXT
    );
  `);
  for (const id of ["claude", "codex", "gemini"]) {
    db.prepare("INSERT INTO backends (id) VALUES (?)").run(id);
  }
}

function setAuth(
  db: Database.Database,
  backendId: string,
  status: string,
  verifiedAt: string | null,
): void {
  db.prepare(
    "UPDATE backends SET auth_status = ?, auth_last_verified_at = ? WHERE id = ?",
  ).run(status, verifiedAt, backendId);
}

describe("AutonomousSpawnGate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createBackendsSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("passes when the host resolves and auth is ok", async () => {
    const lookup = vi.fn().mockResolvedValue({ address: "1.2.3.4" });
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude"]);
    expect(decision.skip).toBe(false);
    expect(decision.backends).toHaveLength(1);
    expect(decision.backends[0]).toMatchObject({
      backendId: "claude",
      host: "api.anthropic.com",
      offline: false,
      authShouldSkip: false,
      viable: true,
    });
    expect(lookup).toHaveBeenCalledWith("api.anthropic.com");
  });

  it("skips with reason 'offline' when every candidate's host fails DNS", async () => {
    const lookup = vi.fn().mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude", "codex"]);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("offline");
    expect(decision.backends.map((b) => b.offline)).toEqual([true, true]);
  });

  it("skips with reason 'auth_unhealthy' when hosts resolve but every candidate's auth cache says skip", async () => {
    const lookup = vi.fn().mockResolvedValue({});
    const now = new Date().toISOString();
    setAuth(db, "claude", "expired", now);
    setAuth(db, "codex", "missing", now);
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude", "codex"]);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("auth_unhealthy");
    expect(decision.backends.every((b) => b.authShouldSkip)).toBe(true);
  });

  it("does NOT skip when the main is auth-unhealthy but the fallback is viable", async () => {
    const lookup = vi.fn().mockResolvedValue({});
    setAuth(db, "claude", "expired", new Date().toISOString());
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude", "codex"]);
    expect(decision.skip).toBe(false);
    expect(decision.backends[0]?.viable).toBe(false);
    expect(decision.backends[1]?.viable).toBe(true);
  });

  it("does NOT skip when offline-main has an online fallback (mixed hosts)", async () => {
    const lookup = vi.fn(async (host: string) => {
      if (host === "api.anthropic.com") throw new Error("ENOTFOUND");
      return {};
    });
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude", "gemini"]);
    expect(decision.skip).toBe(false);
  });

  it("uses 'auth_unhealthy' when the blockers are mixed offline + auth", async () => {
    const lookup = vi.fn(async (host: string) => {
      if (host === "api.anthropic.com") throw new Error("ENOTFOUND");
      return {};
    });
    setAuth(db, "codex", "expired", new Date().toISOString());
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude", "codex"]);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("auth_unhealthy");
  });

  it("fails open for backends with no host mapping", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["opencode"]);
    expect(decision.skip).toBe(false);
    expect(decision.backends[0]).toMatchObject({
      host: null,
      offline: false,
      viable: true,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns skip:false for an empty candidate list", async () => {
    const gate = new AutonomousSpawnGate(db, { lookup: vi.fn() });
    const decision = await gate.evaluate([]);
    expect(decision).toEqual({ skip: false, backends: [] });
  });

  it("caches DNS verdicts within the TTL and re-probes after expiry", async () => {
    let nowMs = 1_000_000;
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const gate = new AutonomousSpawnGate(db, {
      lookup,
      now: () => nowMs,
      dnsCacheTtlMs: 60_000,
    });
    await gate.evaluate(["claude"]);
    await gate.evaluate(["claude"]);
    expect(lookup).toHaveBeenCalledTimes(1);

    nowMs += 60_001;
    lookup.mockResolvedValue({});
    const decision = await gate.evaluate(["claude"]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(decision.skip).toBe(false);
  });

  it("fails open when the lookup exceeds dnsLookupTimeoutMs, and caches the fail-open verdict", async () => {
    // A hung resolver: the lookup promise never settles, so only the
    // deadline can decide. Past it the gate treats the host as
    // resolvable (an answer we don't have is not an outage signal).
    const lookup = vi.fn(() => new Promise<never>(() => {}));
    const gate = new AutonomousSpawnGate(db, {
      lookup,
      dnsLookupTimeoutMs: 10,
    });

    const decision = await gate.evaluate(["claude"]);
    expect(decision.skip).toBe(false);
    expect(decision.backends[0]).toMatchObject({
      backendId: "claude",
      host: "api.anthropic.com",
      offline: false,
      viable: true,
    });
    expect(lookup).toHaveBeenCalledTimes(1);

    // The fail-open verdict is cached for the TTL — a second evaluation
    // within the window must not pay another deadline (or invoke the
    // injected lookup again).
    const second = await gate.evaluate(["claude"]);
    expect(second.skip).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("fails open on EAI_AGAIN — a transient resolver condition, not an outage verdict", async () => {
    const lookup = vi.fn().mockRejectedValue(
      Object.assign(new Error("try again"), { code: "EAI_AGAIN" }),
    );
    const gate = new AutonomousSpawnGate(db, { lookup });
    const decision = await gate.evaluate(["claude"]);
    expect(decision.skip).toBe(false);
    expect(decision.backends[0]).toMatchObject({
      backendId: "claude",
      offline: false,
      viable: true,
    });
    expect(lookup).toHaveBeenCalledWith("api.anthropic.com");
  });

  it("still treats a definitive ENOTFOUND rejection as offline (deadline path unchanged)", async () => {
    const lookup = vi.fn().mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    const gate = new AutonomousSpawnGate(db, {
      lookup,
      dnsLookupTimeoutMs: 10_000,
    });
    const decision = await gate.evaluate(["claude"]);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("offline");
    expect(decision.backends[0]).toMatchObject({ offline: true, viable: false });
  });

  it("shares the DNS cache across candidates probing the same host", async () => {
    const lookup = vi.fn().mockResolvedValue({});
    const gate = new AutonomousSpawnGate(db, { lookup });
    await gate.evaluate(["claude"]);
    await gate.evaluate(["claude", "claude"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("threads authFreshnessMs through to the cached auth read", async () => {
    const lookup = vi.fn().mockResolvedValue({});
    // Verified 5 minutes ago: skip under the default 10-min window, but
    // NOT under a 1-minute window (stale cache → don't trust).
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    setAuth(db, "claude", "expired", fiveMinAgo);

    const defaultGate = new AutonomousSpawnGate(db, { lookup });
    expect((await defaultGate.evaluate(["claude"])).skip).toBe(true);

    const tightGate = new AutonomousSpawnGate(db, {
      lookup,
      authFreshnessMs: 60_000,
    });
    expect((await tightGate.evaluate(["claude"])).skip).toBe(false);
  });

  it("fails open when the auth read throws (table missing)", async () => {
    const bare = new Database(":memory:");
    try {
      const lookup = vi.fn().mockResolvedValue({});
      const gate = new AutonomousSpawnGate(bare, { lookup });
      const decision = await gate.evaluate(["claude"]);
      expect(decision.skip).toBe(false);
      expect(decision.backends[0]?.authStatus).toBe("unknown");
    } finally {
      bare.close();
    }
  });

  it("fails open when gate evaluation itself throws", async () => {
    const lookup = vi.fn().mockResolvedValue({});
    const gate = new AutonomousSpawnGate(db, {
      lookup,
      // Force an internal throw past the per-backend guards.
      now: () => {
        throw new Error("clock exploded");
      },
    });
    const decision: SpawnGateDecision = await gate.evaluate(["claude"]);
    expect(decision).toEqual({ skip: false, backends: [] });
  });

  it("supports a host-mapping override", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const gate = new AutonomousSpawnGate(db, {
      lookup,
      backendApiHosts: { claude: "example.invalid" },
    });
    const decision = await gate.evaluate(["claude"]);
    expect(lookup).toHaveBeenCalledWith("example.invalid");
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("offline");
  });

  it("constructs with the production defaults (real dns.lookup arm) without probing", () => {
    // Covers the `options.lookup ?? (real dnsLookup)` default arm. The
    // default arrow is only CONSTRUCTED here — never invoked — so the
    // test stays hermetic (no real DNS).
    const gate = new AutonomousSpawnGate(db);
    expect(gate).toBeInstanceOf(AutonomousSpawnGate);
  });

  it("exports the production host mapping for the three CLI/SDK backends", () => {
    expect(BACKEND_API_HOSTS.claude).toBe("api.anthropic.com");
    expect(BACKEND_API_HOSTS.codex).toBe("chatgpt.com");
    expect(BACKEND_API_HOSTS.gemini).toBe("cloudcode-pa.googleapis.com");
  });
});
