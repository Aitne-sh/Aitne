import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  type BackendId,
  type BackendModel,
  defaultIntegrationsMap,
} from "@aitne/shared";
import {
  type IAgentCore,
  type AgentExecuteParams,
  type AgentResumeParams,
  type DelegatedToolInvokeParams,
  type DelegatedToolResult,
  type DelegatedTaskInvokeParams,
  type DelegatedTaskResultRaw,
  type AuthCheckResult,
  type AuthMethod,
  DelegatedToolUnsupportedError,
} from "../core/agent-core.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { readProbe, writeProbe } from "../db/integration-probe-store.js";
import { evaluateProbe } from "../core/integration-probe.js";
import {
  consultDelegatedConnectorHealth,
  markSignoutWarned,
  renderSignoutDm,
} from "../core/delegated-connector-health.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import { DelegatedProbeObserver } from "./delegated-probe-observer.js";

/**
 * §7.1 integration tests — exercise the cache transitions end-to-end so
 * the §10 risk row "user signed out hours ago" actually produces a DM via
 * `consultDelegatedConnectorHealth` (§4.5).
 *
 * Schema mirrors the relevant slice of `db/schema.ts`: `settings`,
 * `integration_probes`, `runtime_state`. Keeping these tests free of the
 * full `applySchema` makes the dependency graph between the observer and
 * the consult helper explicit.
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
    CREATE TABLE runtime_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

class StubCore implements IAgentCore {
  readonly backendId: BackendId;
  private readonly impl: () => Promise<string[]>;
  constructor(backendId: BackendId, impl: () => Promise<string[]>) {
    this.backendId = backendId;
    this.impl = impl;
  }
  probeTools(): Promise<string[]> {
    return this.impl();
  }
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
  runDelegatedTask(_params: DelegatedTaskInvokeParams): Promise<DelegatedTaskResultRaw> {
    throw new Error("runDelegatedTask not implemented in stub");
  }
}

const GMAIL_CLAUDE_FULL = [
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

function delegateGmailToClaude(db: Database.Database): void {
  const map = defaultIntegrationsMap("2026-04-26T00:00:00Z");
  map.gmail = {
    mode: "delegated",
    delegatedBackend: "claude",
    deniedTools: [],
    lastChangedAt: "2026-04-26T00:00:00Z",
  };
  writeIntegrations(db, map);
}

describe("DelegatedProbeObserver — integration with consultDelegatedConnectorHealth", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("§10 cache-flip: present:true → false fires consult-warning that renders the §4.5 sign-out DM", async () => {
    delegateGmailToClaude(db);
    // Pre-seed: present:true (wizard's initial probe).
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_FULL,
        integration: "gmail",
        backend: "claude",
        probedAt: "2026-04-26T00:00:00.000Z",
      }),
    );

    // Sign-out simulated: probe returns empty → required capabilities miss.
    const claude = new StubCore("claude", async () => []);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      // Force freshness skip to NOT engage so the probe is actually
      // attempted (now is 90 min after the seeded probedAt).
      now: () => Date.parse("2026-04-26T01:30:00.000Z"),
      staggerMs: 0,
      sleep: async () => {},
    });

    await observer.tick();

    // Cache should now report present:false with missing required caps.
    const after = readProbe(db, "gmail", "claude");
    expect(after?.present).toBe(false);
    expect(after?.missingRequired.length).toBeGreaterThan(0);

    // Consult on next DM-session init: one warning, intact DM body.
    const consult = consultDelegatedConnectorHealth(db, "claude");
    expect(consult.warnings.length).toBe(1);
    const warning = consult.warnings[0];
    expect(warning.integration).toBe("gmail");
    expect(warning.backend).toBe("claude");
    const dm = renderSignoutDm(warning);
    expect(dm).toContain("Gmail connector on claude");
    expect(dm).toContain("signed out");
    expect(dm).toContain("Re-authorize");
  });

  it("recovery: probe transitions back to present:true clears the runtime_state warning marker", async () => {
    delegateGmailToClaude(db);
    // Pre-seed broken probe + a runtime_state marker so the consult would
    // normally stay silent.
    writeProbe(
      db,
      evaluateProbe({
        tools: [],
        integration: "gmail",
        backend: "claude",
        probedAt: "2026-04-26T00:00:00.000Z",
      }),
    );
    const markerKey = "delegated_signout_warned:gmail:claude";
    writeRuntimeState(db, markerKey, {
      warnedAt: "2026-04-26T00:00:01.000Z",
      missingRequired: ["search", "read", "draft", "label"],
    });

    // Pre-tick consult: marker present → warning suppressed.
    const before = consultDelegatedConnectorHealth(db, "claude");
    expect(before.warnings.length).toBe(0);
    expect(before.recovered.length).toBe(0);

    // Connector signs back in — probe returns full tool list.
    const claude = new StubCore("claude", async () => GMAIL_CLAUDE_FULL);
    const observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claude],
      intervalMinutes: 60,
      now: () => Date.parse("2026-04-26T01:30:00.000Z"),
      staggerMs: 0,
      sleep: async () => {},
    });

    await observer.tick();

    expect(readProbe(db, "gmail", "claude")?.present).toBe(true);

    // Post-tick consult: probe is healthy, marker still present → consult
    // clears the marker and reports recovery.
    const after = consultDelegatedConnectorHealth(db, "claude");
    expect(after.warnings.length).toBe(0);
    expect(after.recovered).toContain("gmail");
    expect(readRuntimeState(db, markerKey)).toBeNull();
  });

  it("marker lifecycle: warn → markSignoutWarned → consult silent until recovery", async () => {
    delegateGmailToClaude(db);
    writeProbe(
      db,
      evaluateProbe({
        tools: GMAIL_CLAUDE_FULL,
        integration: "gmail",
        backend: "claude",
        probedAt: "2026-04-26T00:00:00.000Z",
      }),
    );

    // Tick #1: connector signs out → cache flips, consult yields warning.
    const claudeOut = new StubCore("claude", async () => []);
    let observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claudeOut],
      intervalMinutes: 60,
      now: () => Date.parse("2026-04-26T01:30:00.000Z"),
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();
    let consult = consultDelegatedConnectorHealth(db, "claude");
    expect(consult.warnings.length).toBe(1);
    markSignoutWarned(db, consult.warnings[0]);

    // Tick #2: still signed out → consult must stay silent because the
    // marker is set.
    observer = new DelegatedProbeObserver({
      db,
      agentBackends: [claudeOut],
      intervalMinutes: 60,
      now: () => Date.parse("2026-04-26T03:00:00.000Z"),
      staggerMs: 0,
      sleep: async () => {},
    });
    await observer.tick();
    consult = consultDelegatedConnectorHealth(db, "claude");
    expect(consult.warnings.length).toBe(0);
    expect(consult.recovered.length).toBe(0);
  });
});
