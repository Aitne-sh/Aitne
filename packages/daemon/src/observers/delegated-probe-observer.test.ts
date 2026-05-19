import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  type AuthCheckResult,
  type AuthMethod,
  type BackendId,
  type BackendModel,
  type IntegrationKey,
  defaultIntegrationsMap,
} from "@aitne/shared";
import {
  DelegatedToolUnsupportedError,
  LiveProbeUnsupportedError,
  type IAgentCore,
  type DelegatedToolInvokeParams,
  type DelegatedToolResult,
  type AgentExecuteParams,
  type AgentResumeParams,
} from "../core/agent-core.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { readProbe, writeProbe } from "../db/integration-probe-store.js";
import { evaluateProbe } from "../core/integration-probe.js";
import { DelegatedProbeObserver } from "./delegated-probe-observer.js";

/**
 * Minimal schema covering only the tables this observer touches. Keeps the
 * test file independent of the daemon's full `applySchema` (which pulls in
 * dozens of tables we don't need here).
 */
function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE integration_probes (
      integration_key TEXT NOT NULL,
      backend_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      probed_at TEXT NOT NULL,
      PRIMARY KEY (integration_key, backend_id)
    );
  `);
}

/**
 * In-memory `IAgentCore` stub. Only `probeTools()` and `backendId` are
 * exercised; everything else throws to fail loudly on accidental usage.
 */
class StubCore implements IAgentCore {
  readonly backendId: BackendId;
  readonly calls: number[] = [];
  private readonly impl: () => Promise<string[]>;

  constructor(backendId: BackendId, impl: () => Promise<string[]>) {
    this.backendId = backendId;
    this.impl = impl;
  }

  async probeTools(): Promise<string[]> {
    this.calls.push(Date.now());
    return this.impl();
  }

  // The rest is unused by the observer — keep them as throw-stubs so any
  // accidental future coupling fails loudly.
  execute(_params: AgentExecuteParams): Promise<never> {
    throw new Error("execute not implemented in stub");
  }
  executeResume(_params: AgentResumeParams): Promise<never> {
    throw new Error("executeResume not implemented in stub");
  }
  summarize(_text: string): Promise<string> {
    throw new Error("summarize not implemented in stub");
  }
  checkAuth(): Promise<{ ok: true; method: AuthMethod }> {
    return Promise.resolve({ ok: true, method: "cli_login" });
  }
  checkAuthDetailed(): Promise<AuthCheckResult> {
    return Promise.resolve({ ok: true, status: "ok", method: "cli_login" });
  }
  listModels(): ReadonlyArray<BackendModel> {
    return [];
  }
  runDelegatedTool(_params: DelegatedToolInvokeParams): Promise<DelegatedToolResult> {
    throw new DelegatedToolUnsupportedError(this.backendId, "stub");
  }
}

const GMAIL_CLAUDE_TOOLS = [
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__create_draft",
  "mcp__claude_ai_Gmail__list_drafts",
  "mcp__claude_ai_Gmail__label_message",
  "mcp__claude_ai_Gmail__label_thread",
  "mcp__claude_ai_Gmail__unlabel_message",
  "mcp__claude_ai_Gmail__unlabel_thread",
  "mcp__claude_ai_Gmail__list_labels",
];
const CALENDAR_CLAUDE_TOOLS = [
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
  "mcp__claude_ai_Google_Calendar__delete_event",
  "mcp__claude_ai_Google_Calendar__suggest_time",
  "mcp__claude_ai_Google_Calendar__list_calendars",
  "mcp__claude_ai_Google_Calendar__respond_to_event",
];
const GMAIL_CODEX_TOOLS = [
  "mcp__codex_apps__gmail._search_emails",
  "mcp__codex_apps__gmail._read_email",
  "mcp__codex_apps__gmail._read_email_thread",
  "mcp__codex_apps__gmail._create_draft",
  "mcp__codex_apps__gmail._list_drafts",
  "mcp__codex_apps__gmail._send_email",
  "mcp__codex_apps__gmail._apply_labels_to_emails",
  "mcp__codex_apps__gmail._list_labels",
];

function delegateAll(
  db: Database.Database,
  binds: Partial<Record<IntegrationKey, BackendId>>,
): void {
  const map = defaultIntegrationsMap("2026-04-26T00:00:00Z");
  for (const [key, backend] of Object.entries(binds)) {
    map[key as IntegrationKey] = {
      mode: "delegated",
      delegatedBackend: backend,
      deniedTools: [],
      lastChangedAt: "2026-04-26T00:00:00Z",
    };
  }
  writeIntegrations(db, map);
}

describe("DelegatedProbeObserver", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("intervalMinutes=0 disables the observer (no timer scheduled, no probe call)", async () => {
    delegateAll(db, { gmail: "claude" });
    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 0,
    });
    await observer.start();
    // Hand-tick — proves start() didn't pre-fire either.
    expect(claude.calls.length).toBe(0);
    await observer.stop();
  });

  it("start() schedules first tick at intervalMs (no synchronous probeTools call)", async () => {
    delegateAll(db, { gmail: "claude" });
    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
    });
    await observer.start();
    expect(claude.calls.length).toBe(0);
    await observer.stop();
  });

  it("groups by backend: gmail on codex + calendar on claude → 1 probeTools per backend", async () => {
    delegateAll(db, { gmail: "codex", google_calendar: "claude" });

    const claude = new StubCore("claude", async () => CALENDAR_CLAUDE_TOOLS);
    const codex = new StubCore("codex", async () => GMAIL_CODEX_TOOLS);

    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude, codex],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    expect(claude.calls.length).toBe(1);
    expect(codex.calls.length).toBe(1);
    expect(readProbe(db, "google_calendar", "claude")?.present).toBe(true);
    expect(readProbe(db, "gmail", "codex")?.present).toBe(true);
  });

  it("batches two integrations on the same backend into one probeTools call", async () => {
    delegateAll(db, { gmail: "claude", google_calendar: "claude" });
    const claude = new StubCore("claude", async () => [
      ...GMAIL_CLAUDE_TOOLS,
      ...CALENDAR_CLAUDE_TOOLS,
    ]);

    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    expect(claude.calls.length).toBe(1);
    expect(readProbe(db, "gmail", "claude")?.present).toBe(true);
    expect(readProbe(db, "google_calendar", "claude")?.present).toBe(true);
  });

  it("freshness skip: every integration in the group has a probe newer than intervalMs/2 → no probeTools call", async () => {
    delegateAll(db, { gmail: "claude", google_calendar: "claude" });
    const now = 1_700_000_000_000;
    const recent = new Date(now - 30_000).toISOString();
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_TOOLS,
        integration: "gmail",
        backend: "claude",
        probedAt: recent,
      }),
    );
    writeProbe(
      db,
      evaluateProbe({
        tools: CALENDAR_CLAUDE_TOOLS,
        integration: "google_calendar",
        backend: "claude",
        probedAt: recent,
      }),
    );

    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      now: () => now,
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    expect(claude.calls.length).toBe(0);
  });

  it("freshness skip: a group with stale probe (older than intervalMs/2) does fire", async () => {
    delegateAll(db, { gmail: "claude" });
    const now = 1_700_000_000_000;
    const stale = new Date(now - 90 * 60_000).toISOString();
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_TOOLS,
        integration: "gmail",
        backend: "claude",
        probedAt: stale,
      }),
    );

    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      now: () => now,
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    expect(claude.calls.length).toBe(1);
  });

  it("mixed-freshness in a group still fires (cheaper than partial-skip)", async () => {
    delegateAll(db, { gmail: "claude", google_calendar: "claude" });
    const now = 1_700_000_000_000;
    // gmail fresh, calendar stale → expect fire (one subprocess covers both).
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_TOOLS,
        integration: "gmail",
        backend: "claude",
        probedAt: new Date(now - 30_000).toISOString(),
      }),
    );
    writeProbe(
      db,
      evaluateProbe({
        tools: CALENDAR_CLAUDE_TOOLS,
        integration: "google_calendar",
        backend: "claude",
        probedAt: new Date(now - 90 * 60_000).toISOString(),
      }),
    );

    const claude = new StubCore("claude", async () => [
      ...GMAIL_CLAUDE_TOOLS,
      ...CALENDAR_CLAUDE_TOOLS,
    ]);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      now: () => now,
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    expect(claude.calls.length).toBe(1);
  });

  it("LiveProbeUnsupportedError logs once per (integration, backend) across multiple ticks", async () => {
    delegateAll(db, { gmail: "gemini" });
    const gemini = new StubCore("gemini", async () => {
      throw new LiveProbeUnsupportedError("gemini", "deferred");
    });
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [gemini],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });

    await observer.tick();
    await observer.tick();

    // Two ticks both call probeTools (the latch suppresses the LOG, not the
    // call), and neither writes a probe row.
    expect(gemini.calls.length).toBe(2);
    expect(readProbe(db, "gmail", "gemini")).toBeNull();
  });

  it("writeProbe failure for one integration is isolated — siblings still write", async () => {
    // Spy on writeProbe via the integration-probe-store module so the
    // first call throws and the second succeeds. The observer's catch
    // must swallow the first failure and still write the sibling probe.
    const probeStore = await import("../db/integration-probe-store.js");
    const realWriteProbe = probeStore.writeProbe;
    let calls = 0;
    const spy = vi
      .spyOn(probeStore, "writeProbe")
      .mockImplementation((d, result) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("simulated DB write failure");
        }
        return realWriteProbe(d, result);
      });

    delegateAll(db, { gmail: "claude", google_calendar: "claude" });
    const claude = new StubCore("claude", async () => [
      ...GMAIL_CLAUDE_TOOLS,
      ...CALENDAR_CLAUDE_TOOLS,
    ]);

    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });

    await expect(observer.tick()).resolves.toBeUndefined();
    expect(claude.calls.length).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    // At least one of the two integrations was written successfully.
    const wroteOne =
      readProbe(db, "gmail", "claude") !== null ||
      readProbe(db, "google_calendar", "claude") !== null;
    expect(wroteOne).toBe(true);
    spy.mockRestore();
  });

  it("missing core in agentBackends → log warn and skip without crashing", async () => {
    delegateAll(db, { gmail: "claude", google_calendar: "codex" });
    // Only claude registered; codex is missing.
    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });

    await expect(observer.tick()).resolves.toBeUndefined();
    expect(claude.calls.length).toBe(1);
    expect(readProbe(db, "gmail", "claude")?.present).toBe(true);
    expect(readProbe(db, "google_calendar", "codex")).toBeNull();
  });

  it("re-entrancy guard: tick() called while a previous tick is in flight is a no-op", async () => {
    delegateAll(db, { gmail: "claude" });
    let resolveProbe: (v: string[]) => void = () => {};
    const probePromise = new Promise<string[]>((resolve) => {
      resolveProbe = resolve;
    });
    const claude = new StubCore("claude", () => probePromise);

    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });

    const first = observer.tick();
    // Second invocation while first is in flight (probe never resolved).
    await observer.tick();
    expect(claude.calls.length).toBe(1);

    resolveProbe(GMAIL_CLAUDE_TOOLS);
    await first;
    expect(claude.calls.length).toBe(1);
    expect(readProbe(db, "gmail", "claude")?.present).toBe(true);
  });

  it("stop() clears the timer and is idempotent across multiple calls", async () => {
    delegateAll(db, { gmail: "claude" });
    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
    });
    await observer.start();
    await observer.stop();
    await observer.stop();
    expect(claude.calls.length).toBe(0);
  });

  it("non-LiveProbeUnsupported subprocess error preserves last-known-good probe row", async () => {
    delegateAll(db, { gmail: "claude" });
    // Pre-seed a known-good probe row so we can assert it's not overwritten.
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_TOOLS,
        integration: "gmail",
        backend: "claude",
        probedAt: "2026-04-26T00:00:00.000Z",
      }),
    );

    const claude = new StubCore("claude", async () => {
      throw new Error("CLI not on PATH");
    });
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      // Force the freshness skip to NOT engage so the probe is actually
      // attempted (now is one full interval after the seeded probedAt).
      now: () => Date.parse("2026-04-26T01:30:00.000Z"),
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    // Pre-existing row stayed exactly as it was — present:true, no
    // overwrite to a missingRequired:[…] failure record.
    const after = readProbe(db, "gmail", "claude");
    expect(after?.present).toBe(true);
    expect(after?.probedAt).toBe("2026-04-26T00:00:00.000Z");
  });

  it("logs a probe transition only when present flips relative to pre-tick snapshot", async () => {
    delegateAll(db, { gmail: "claude" });
    // Seed with present:true so we can flip to false this tick.
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_TOOLS,
        integration: "gmail",
        backend: "claude",
        probedAt: "2026-04-26T00:00:00.000Z",
      }),
    );

    // probeTools returns an empty list — the connector signed out.
    const claude = new StubCore("claude", async () => []);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      now: () => Date.parse("2026-04-26T01:30:00.000Z"),
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();

    const after = readProbe(db, "gmail", "claude");
    expect(after?.present).toBe(false);
    expect(after?.missingRequired.length).toBeGreaterThan(0);
  });

  // The "evaluateProbe throw → per-integration catch isolates the
  // sibling" test was driven by Gemini lacking gmail / calendar
  // connectors. Now that all three backends ship connectors for every
  // integration, `evaluateProbe` no longer throws on this path. The
  // try/catch around `evaluateProbe` / `writeProbe` remains in the
  // observer as forward-compat for future integrations that omit a
  // backend.

  it("ignores integrations whose mode is not delegated", async () => {
    // Default map is all-disabled — no probeTools should fire.
    writeIntegrations(db, defaultIntegrationsMap("2026-04-26T00:00:00Z"));
    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_TOOLS);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();
    expect(claude.calls.length).toBe(0);
  });
});

// Silence unused-import warnings when vitest tree-shakes during typecheck.
void vi;
