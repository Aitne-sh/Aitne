/**
 * Unit tests for the setup-routes subset that doesn't require the full
 * ApiDependencies wiring (dashboard adapter, integration registry, etc).
 *
 * Covered here:
 *   - POST /setup/mode — execution-mode setup step. Verifies the UI→internal
 *     translation, per-backend override layering, and validation. See
 *     EXECUTION-MODE-DESIGN.md §5.3 / §10.
 *   - POST /setup/save-rules — Active Policies preservation
 *     (MANAGEMENT-POLICY-CAPTURE-PLAN §5.7).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSetupRoutes } from "./setup.js";
import { applySchema } from "../../db/schema.js";
import { createSettingsStore } from "../../settings/settings-store.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";
import { CONTEXT_RELATIVE_PATHS } from "../../core/context-paths.js";

function makeConfig(): AgentConfig {
  return {
    claudeExecutionPermissionMode: "strict",
    codexExecutionPermissionMode: "strict",
    geminiExecutionPermissionMode: "strict",
    opencodeExecutionPermissionMode: "strict",
  } as unknown as AgentConfig;
}

function makeDeps(db: Database.Database, config: AgentConfig): ApiDependencies {
  return { db, config } as unknown as ApiDependencies;
}

async function postMode(
  app: ReturnType<typeof createSetupRoutes>,
  body: unknown,
): Promise<Response> {
  return app.request("/setup/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/setup/mode", () => {
  let db: Database.Database;
  let config: AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    config = makeConfig();
  });

  afterEach(() => {
    db.close();
  });

  it("applies top-level 'safe' to all backends as 'strict'", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, { mode: "safe" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      resolved: Record<string, string>;
    };
    expect(body.status).toBe("applied");
    expect(body.resolved).toEqual({
      claude: "safe",
      codex: "safe",
      gemini: "safe",
      opencode: "safe",
    });

    const store = createSettingsStore(db);
    expect(store.get("claudeExecutionPermissionMode")).toBe("strict");
    expect(store.get("codexExecutionPermissionMode")).toBe("strict");
    expect(store.get("geminiExecutionPermissionMode")).toBe("strict");
    expect(store.get("opencodeExecutionPermissionMode")).toBe("strict");

    // Config object is mutated in place so the running daemon doesn't need
    // a reload for the cores to see the new value on the next execute.
    expect(config.claudeExecutionPermissionMode).toBe("strict");
    expect(config.codexExecutionPermissionMode).toBe("strict");
    expect(config.geminiExecutionPermissionMode).toBe("strict");
    expect(config.opencodeExecutionPermissionMode).toBe("strict");
  });

  it("applies top-level 'allow' to all backends", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, { mode: "allow" });
    expect(res.status).toBe(200);

    const store = createSettingsStore(db);
    expect(store.get("claudeExecutionPermissionMode")).toBe("allow");
    expect(store.get("codexExecutionPermissionMode")).toBe("allow");
    expect(store.get("geminiExecutionPermissionMode")).toBe("allow");
    expect(store.get("opencodeExecutionPermissionMode")).toBe("allow");
  });

  it("per-backend overrides win over the top-level mode", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, {
      mode: "safe",
      perBackend: { codex: "allow" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: Record<string, string> };
    expect(body.resolved).toEqual({
      claude: "safe",
      codex: "allow",
      gemini: "safe",
      opencode: "safe",
    });

    const store = createSettingsStore(db);
    expect(store.get("claudeExecutionPermissionMode")).toBe("strict");
    expect(store.get("codexExecutionPermissionMode")).toBe("allow");
    expect(store.get("geminiExecutionPermissionMode")).toBe("strict");
    expect(store.get("opencodeExecutionPermissionMode")).toBe("strict");
  });

  it("allows per-backend safe when top-level is allow", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, {
      mode: "allow",
      perBackend: { claude: "safe" },
    });
    expect(res.status).toBe(200);

    const store = createSettingsStore(db);
    expect(store.get("claudeExecutionPermissionMode")).toBe("strict");
    expect(store.get("codexExecutionPermissionMode")).toBe("allow");
    expect(store.get("geminiExecutionPermissionMode")).toBe("allow");
    expect(store.get("opencodeExecutionPermissionMode")).toBe("allow");
  });

  it("rejects an unknown top-level mode with 400", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, { mode: "yolo" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing top-level mode with 400", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, {});
    expect(res.status).toBe(400);
  });

  it("rejects an unknown backend key in perBackend with 400", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, {
      mode: "safe",
      perBackend: { bedrock: "allow" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid per-backend value with 400", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, {
      mode: "safe",
      perBackend: { codex: "maybe" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-object perBackend with 400", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postMode(app, {
      mode: "safe",
      perBackend: ["allow"],
    });
    expect(res.status).toBe(400);
  });

  it("overwrites prior rows on subsequent calls", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    await postMode(app, { mode: "allow" });
    await postMode(app, { mode: "safe" });

    const store = createSettingsStore(db);
    expect(store.get("claudeExecutionPermissionMode")).toBe("strict");
    expect(store.get("codexExecutionPermissionMode")).toBe("strict");
    expect(store.get("geminiExecutionPermissionMode")).toBe("strict");
    expect(store.get("opencodeExecutionPermissionMode")).toBe("strict");
  });

  it("emits one execution_mode_changed audit row per backend that moved", async () => {
    // Setup config starts strict/strict/strict. A top-level 'allow' call
    // shifts every backend, so all should get a row. A subsequent
    // call with one override should only emit one row — the backend that
    // moved between the two calls.
    const app = createSetupRoutes(makeDeps(db, config));
    await postMode(app, { mode: "allow" });

    const firstRows = db
      .prepare(
        `SELECT backend, detail FROM agent_actions
          WHERE action_type = 'execution_mode_changed'
          ORDER BY id`,
      )
      .all() as Array<{ backend: string; detail: string }>;
    expect(firstRows).toHaveLength(4);
    const backendsChanged = new Set(firstRows.map((r) => r.backend));
    expect(backendsChanged).toEqual(new Set(["claude", "codex", "gemini", "opencode"]));
    for (const row of firstRows) {
      const detail = JSON.parse(row.detail) as {
        before: string;
        after: string;
      };
      expect(detail.before).toBe("strict");
      expect(detail.after).toBe("allow");
    }

    // Now flip codex back to safe; only codex should emit a new row.
    const res = await postMode(app, {
      mode: "allow",
      perBackend: { codex: "safe" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changedRows: number };
    expect(body.changedRows).toBe(1);

    const allRows = db
      .prepare(
        `SELECT backend, detail FROM agent_actions
          WHERE action_type = 'execution_mode_changed'
          ORDER BY id`,
      )
      .all() as Array<{ backend: string; detail: string }>;
    expect(allRows).toHaveLength(5);
    const latest = allRows[4];
    expect(latest.backend).toBe("codex");
    const latestDetail = JSON.parse(latest.detail) as {
      before: string;
      after: string;
    };
    expect(latestDetail.before).toBe("allow");
    expect(latestDetail.after).toBe("strict");
  });

  it("emits no audit row when the call is a no-op", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    // Current config starts strict; posting 'safe' leaves every row
    // unchanged (safe → strict). Should emit zero rows.
    const res = await postMode(app, { mode: "safe" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changedRows: number };
    expect(body.changedRows).toBe(0);

    const count = db
      .prepare(
        `SELECT COUNT(*) as n FROM agent_actions
          WHERE action_type = 'execution_mode_changed'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("POST /api/setup/save-rules — Active Policies preservation", () => {
  let db: Database.Database;
  let dataDir: string;
  let app: ReturnType<typeof createSetupRoutes>;

  function makeSaveRulesConfig(): AgentConfig {
    return {
      dataDir,
      vaultMode: "plain",
      primaryVaultPath: null,
      workspaceDir: dataDir,
      agentDisplayName: "Agent",
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "strict",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    } as unknown as AgentConfig;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-saverules-"));
    const config = makeSaveRulesConfig();
    app = createSetupRoutes(makeDeps(db, config));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function rulesPath(): string {
    return join(dataDir, "context", CONTEXT_RELATIVE_PATHS.rules.management);
  }

  async function postSaveRules(body: unknown): Promise<Response> {
    return app.request("/setup/save-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const WIZARD_PAYLOAD = `---
type: rule
slug: management
owner: shared
updated: 2026-04-25
template_version: 2
---
# Management rules

## Source of Truth

| Category | Canonical store | Writer |
|---|---|---|
| Tasks | Notion | external |

## Notes

- wizard-managed
`;

  const PRESERVED_SECTION = `## Active Policies

Auto-maintained by the daemon (do not edit). Source: rules/policies/*.

| Slug | Status | Cadence | Why |
|---|---|---|---|
| morning-finance | active | \`0 7 * * *\` | Daily Moneytree snapshot. |`;

  it("preserves the Active Policies section across an update", async () => {
    // Seed: rules/management.md exists with the auto-section already
    // present (as the policy-index reconciler would have produced).
    mkdirSync(join(dataDir, "context", "policies"), { recursive: true });
    const seeded = `${WIZARD_PAYLOAD.trim()}\n\n${PRESERVED_SECTION}\n`;
    writeFileSync(rulesPath(), seeded, "utf-8");

    // Wizard payload omits the section (it doesn't know about policies).
    const res = await postSaveRules({ content: WIZARD_PAYLOAD });
    expect(res.status).toBe(200);

    const after = readFileSync(rulesPath(), "utf-8");
    expect(after).toContain("## Active Policies");
    expect(after).toContain("morning-finance");
    expect(after).toContain("Daily Moneytree snapshot.");
    // Wizard sections preserved
    expect(after).toContain("## Source of Truth");
    expect(after).toContain("Notion");
  });

  it("does not invent a section when none was present on disk", async () => {
    // Initial install — no rules/management.md yet.
    expect(existsSync(rulesPath())).toBe(false);
    const res = await postSaveRules({ content: WIZARD_PAYLOAD });
    expect(res.status).toBe(200);
    const after = readFileSync(rulesPath(), "utf-8");
    expect(after).not.toContain("## Active Policies");
    expect(after).toContain("## Source of Truth");
  });

  it("round-trips byte-for-byte when wizard re-saves identical content", async () => {
    mkdirSync(join(dataDir, "context", "policies"), { recursive: true });
    const seeded = `${WIZARD_PAYLOAD.trim()}\n\n${PRESERVED_SECTION}\n`;
    writeFileSync(rulesPath(), seeded, "utf-8");

    await postSaveRules({ content: WIZARD_PAYLOAD });
    const first = readFileSync(rulesPath(), "utf-8");
    await postSaveRules({ content: WIZARD_PAYLOAD });
    const second = readFileSync(rulesPath(), "utf-8");
    expect(second).toBe(first);
  });

  it("seeds a morning briefing recurring schedule and renders Default Schedules", async () => {
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §6.6 — first save-rules
    // creates the morning_briefing dm_session row idempotently and
    // mirrors it into `## Default Schedules` in the same write.
    expect(existsSync(rulesPath())).toBe(false);
    const res = await postSaveRules({ content: WIZARD_PAYLOAD });
    expect(res.status).toBe(200);

    const rows = db
      .prepare(
        `SELECT task_type,
                json_extract(task_context, '$.sub_flow') AS sub_flow,
                json_extract(recurrence_rule, '$.timezone') AS tz
         FROM recurring_schedules`,
      )
      .all() as { task_type: string; sub_flow: string | null; tz: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].task_type).toBe("dm_session");
    expect(rows[0].sub_flow).toBe("morning_briefing");
    // Auto mode (config.timezone unset) → the rule must NOT bake a concrete
    // zone, so the briefing follows the live system zone (and OS changes).
    expect(rows[0].tz).toBeNull();

    const after = readFileSync(rulesPath(), "utf-8");
    expect(after).toContain("## Default Schedules");
    expect(after).toContain("Morning briefing");
    expect(after).toContain("pinned to quiet_hours_end");
  });

  it("bakes an explicit operator timezone into the briefing rule", async () => {
    // A pinned zone is the operator's deliberate choice and must persist on
    // the rule (it should NOT follow the OS).
    const pinnedConfig = {
      ...makeSaveRulesConfig(),
      timezone: "America/New_York",
    } as unknown as AgentConfig;
    const pinnedApp = createSetupRoutes(makeDeps(db, pinnedConfig));
    const res = await pinnedApp.request("/setup/save-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: WIZARD_PAYLOAD }),
    });
    expect(res.status).toBe(200);

    const row = db
      .prepare(
        `SELECT json_extract(recurrence_rule, '$.timezone') AS tz
           FROM recurring_schedules
          WHERE json_extract(task_context, '$.sub_flow') = 'morning_briefing'`,
      )
      .get() as { tz: string | null };
    expect(row.tz).toBe("America/New_York");
  });

  it("does not duplicate the morning briefing recurring on a second save-rules", async () => {
    await postSaveRules({ content: WIZARD_PAYLOAD });
    await postSaveRules({ content: WIZARD_PAYLOAD });
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM recurring_schedules
         WHERE task_type = 'dm_session'
           AND json_extract(task_context, '$.sub_flow') = 'morning_briefing'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

// SETUP-FLOW-REDESIGN-PLAN §5.8 / §11.2 — `/setup/start` no longer
// synthesizes a greeting from the legacy `selections` payload. Initial
// mode always sends the same opening line; the agent's task flow does
// the integration-state derivation. The test asserts both the greeting
// shape and the backwards-tolerant ignore of the deleted `selections`
// field so older dashboard clients don't break the wizard mid-cutover.
describe("POST /api/setup/start — greeting (SETUP-FLOW-REDESIGN-PLAN §5.8)", () => {
  let db: Database.Database;
  let dataDir: string;
  let app: ReturnType<typeof createSetupRoutes>;
  const captured: { channelId: string; message: string; metadata: Record<string, unknown> }[] = [];

  function makeStartConfig(): AgentConfig {
    return {
      dataDir,
      vaultMode: "plain",
      primaryVaultPath: null,
      workspaceDir: dataDir,
      agentDisplayName: "Agent",
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "strict",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    } as unknown as AgentConfig;
  }

  function makeDepsWithAdapter(
    db: Database.Database,
    config: AgentConfig,
  ): ApiDependencies {
    const dashboardAdapter = {
      isConnected: (_channelId: string) => true,
      handleIncomingMessage: (
        channelId: string,
        message: string,
        opts: { metadata?: Record<string, unknown> },
      ) => {
        captured.push({
          channelId,
          message,
          metadata: opts.metadata ?? {},
        });
      },
    };
    return { db, config, dashboardAdapter } as unknown as ApiDependencies;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-setup-start-"));
    captured.length = 0;
    const config = makeStartConfig();
    app = createSetupRoutes(makeDepsWithAdapter(db, config));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function postStart(body: unknown): Promise<Response> {
    return app.request("/setup/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("emits the canonical initial-mode greeting regardless of legacy selections", async () => {
    const res = await postStart({
      channelId: "dashboard:1",
      mode: "initial",
      // Legacy payload: an older dashboard build still sends `selections`.
      // The endpoint must tolerate-and-ignore it; the greeting must NOT
      // splice any of these values into the opening line.
      selections: {
        schedule: "Google Calendar",
        tasks: "Notion",
        notes: "Obsidian",
        projects: "Notion",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mode: string };
    expect(body).toEqual({ status: "started", mode: "initial" });

    // The greeting that lands on the dashboard adapter is the one the
    // task flow expects to see at turn-zero. If a future refactor
    // re-introduces `selections`-derived synthesis, this string changes
    // and the test fires.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.message).toBe("Please start the setup process.");
    expect(captured[0]!.message).not.toContain("Google Calendar");
    expect(captured[0]!.message).not.toContain("Notion");
    expect(captured[0]!.message).not.toContain("Obsidian");
  });

  it("emits the same greeting when no selections payload is supplied (post-cutover)", async () => {
    const res = await postStart({
      channelId: "dashboard:1",
      mode: "initial",
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.message).toBe("Please start the setup process.");
  });
});

// ── GET /setup/status ───────────────────────────────────────────────────────

describe("GET /setup/status", () => {
  let db: Database.Database;
  let dataDir: string;

  function makeStatusConfig(dir: string): AgentConfig {
    return {
      dataDir: dir,
      vaultMode: "plain",
      primaryVaultPath: null,
      workspaceDir: dir,
      agentDisplayName: "Agent",
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "strict",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    } as unknown as AgentConfig;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-status-"));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns {needsSetup:true, completedAt:null} when rules file does not exist", async () => {
    const config = makeStatusConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await app.request("/setup/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needsSetup: boolean; completedAt: string | null };
    expect(body.needsSetup).toBe(true);
    expect(body.completedAt).toBeNull();
  });

  it("returns {needsSetup:false, completedAt:<ISO>} when rules file exists", async () => {
    const config = makeStatusConfig(dataDir);
    // Create the rules file so the status check finds it
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "# Management", "utf-8");

    const app = createSetupRoutes(makeDeps(db, config));
    const res = await app.request("/setup/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needsSetup: boolean; completedAt: string | null };
    expect(body.needsSetup).toBe(false);
    expect(body.completedAt).not.toBeNull();
    // ISO string format
    expect(new Date(body.completedAt!).getTime()).toBeGreaterThan(0);
  });
});

// ── POST /setup/start — additional branches ─────────────────────────────────

describe("POST /setup/start — additional branches", () => {
  let db: Database.Database;
  let dataDir: string;
  const captured: { channelId: string; message: string; metadata: Record<string, unknown> }[] = [];
  const onSetupStartCalls: string[] = [];

  function makeStartConfig(dir: string): AgentConfig {
    return {
      dataDir: dir,
      vaultMode: "plain",
      primaryVaultPath: null,
      workspaceDir: dir,
      agentDisplayName: "Agent",
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "strict",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    } as unknown as AgentConfig;
  }

  function makeDepsWithAdapter(
    db: Database.Database,
    config: AgentConfig,
    overrides: Record<string, unknown> = {},
  ): ApiDependencies {
    const dashboardAdapter = {
      isConnected: (_channelId: string) => true,
      handleIncomingMessage: (
        channelId: string,
        message: string,
        opts: { metadata?: Record<string, unknown> },
      ) => {
        captured.push({ channelId, message, metadata: opts.metadata ?? {} });
      },
    };
    return {
      db,
      config,
      dashboardAdapter,
      onSetupStart: (mode: string) => onSetupStartCalls.push(mode),
      ...overrides,
    } as unknown as ApiDependencies;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-start-extra-"));
    captured.length = 0;
    onSetupStartCalls.length = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function postStart(
    app: ReturnType<typeof createSetupRoutes>,
    body: unknown,
  ): Promise<Response> {
    return app.request("/setup/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 503 when dashboardAdapter is undefined", async () => {
    const config = makeStartConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "initial" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Dashboard adapter not available");
  });

  it("returns 400 when body is invalid JSON", async () => {
    const config = makeStartConfig(dataDir);
    const deps = makeDepsWithAdapter(db, config);
    const app = createSetupRoutes(deps);
    const res = await app.request("/setup/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when channelId is missing", async () => {
    const config = makeStartConfig(dataDir);
    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { mode: "initial" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channelId is required");
  });

  it("returns 400 when mode is invalid", async () => {
    const config = makeStartConfig(dataDir);
    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "wizard" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mode must be 'initial' or 'update'");
  });

  it("returns 404 when channel is not connected", async () => {
    const config = makeStartConfig(dataDir);
    const deps = {
      db,
      config,
      dashboardAdapter: {
        isConnected: () => false,
        handleIncomingMessage: () => {},
      },
    } as unknown as ApiDependencies;
    const app = createSetupRoutes(deps);
    const res = await postStart(app, { channelId: "dash:1", mode: "initial" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel not connected");
  });

  it("returns 409 {error:'already_setup'} for initial mode when rules file exists", async () => {
    const config = makeStartConfig(dataDir);
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "# Management", "utf-8");

    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "initial" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("already_setup");
  });

  it("returns 409 {error:'not_setup'} for update mode when rules file does not exist", async () => {
    const config = makeStartConfig(dataDir);
    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "update" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_setup");
  });

  it("sends update greeting for update mode", async () => {
    const config = makeStartConfig(dataDir);
    // Create the rules file so update mode precondition passes
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "# Management", "utf-8");

    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "update" });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.message).toContain("policies/management.md");
  });

  it("normalizes and passes agentDisplayName in metadata", async () => {
    const config = makeStartConfig(dataDir);
    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, {
      channelId: "dash:1",
      mode: "initial",
      agentDisplayName: "  My  Bot  ",
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.metadata.agentDisplayName).toBe("My Bot");
  });

  it("calls onSetupStart callback with the mode", async () => {
    const config = makeStartConfig(dataDir);
    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "initial" });
    expect(res.status).toBe(200);
    expect(onSetupStartCalls).toEqual(["initial"]);
  });

  it("closes stale active dashboard_chat sessions before setup starts", async () => {
    const config = makeStartConfig(dataDir);
    // Insert an active dashboard_chat session
    db.prepare(
      `INSERT INTO conversation_sessions (platform, channel_id, scope, status)
       VALUES ('dashboard', 'dash:1', 'dashboard_chat', 'active')`,
    ).run();

    const app = createSetupRoutes(makeDepsWithAdapter(db, config));
    const res = await postStart(app, { channelId: "dash:1", mode: "initial" });
    expect(res.status).toBe(200);

    const sessions = db
      .prepare(
        `SELECT status FROM conversation_sessions WHERE scope = 'dashboard_chat'`,
      )
      .all() as { status: string }[];
    // All sessions should now be closed
    expect(sessions.every((s) => s.status === "closed")).toBe(true);
  });
});

// ── POST /setup/save-rules — additional branches ────────────────────────────

describe("POST /setup/save-rules — additional branches", () => {
  let db: Database.Database;
  let dataDir: string;

  function makeSaveConfig(dir: string): AgentConfig {
    return {
      dataDir: dir,
      vaultMode: "plain",
      primaryVaultPath: null,
      workspaceDir: dir,
      agentDisplayName: "Agent",
      claudeExecutionPermissionMode: "strict",
      codexExecutionPermissionMode: "strict",
      geminiExecutionPermissionMode: "strict",
      opencodeExecutionPermissionMode: "strict",
    } as unknown as AgentConfig;
  }

  function rulesPath(dir: string): string {
    return join(dir, "context", CONTEXT_RELATIVE_PATHS.rules.management);
  }

  const VALID_CONTENT = `---
type: rule
slug: management
owner: shared
updated: 2026-04-25
template_version: 2
---
# Management rules

## Source of Truth

| Category | Canonical store | Writer |
|---|---|---|
| Tasks | Notion | external |
`;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-saverules-extra-"));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function postSaveRules(
    app: ReturnType<typeof createSetupRoutes>,
    body: unknown,
  ): Promise<Response> {
    return app.request("/setup/save-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 when content is missing", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postSaveRules(app, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("content is required");
  });

  it("returns 400 when content is empty string", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postSaveRules(app, { content: "   " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("content is required");
  });

  it("returns 400 when content exceeds 100KB", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const hugeContent = "x".repeat(100_001);
    const res = await postSaveRules(app, { content: hugeContent });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("too large");
  });

  it("returns 400 when vaultMode=obsidian and no primaryVaultPath", async () => {
    const config = {
      ...makeSaveConfig(dataDir),
      vaultMode: "obsidian",
      primaryVaultPath: null,
    } as unknown as AgentConfig;
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postSaveRules(app, { content: VALID_CONTENT });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("primary_vault_path_required");
  });

  it("returns 400 when agentDisplayName is invalid (too long)", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const longName = "A".repeat(41);
    const res = await postSaveRules(app, { content: VALID_CONTENT, agentDisplayName: longName });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("40 characters");
  });

  it("returns 422 when frontmatter validation fails (no frontmatter)", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postSaveRules(app, { content: "# No frontmatter here\n\nJust text." });
    expect(res.status).toBe(422);
  });

  it("persists agentDisplayName change and mutates config", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await postSaveRules(app, {
      content: VALID_CONTENT,
      agentDisplayName: "NewBot",
    });
    expect(res.status).toBe(200);
    // Config should be mutated
    expect(config.agentDisplayName).toBe("NewBot");
  });

  it("calls onSetupComplete callback after successful save", async () => {
    const onSetupCompleteCalls: number[] = [];
    const config = makeSaveConfig(dataDir);
    const deps = {
      ...makeDeps(db, config),
      onSetupComplete: () => onSetupCompleteCalls.push(1),
    } as unknown as ApiDependencies;
    const app = createSetupRoutes(deps);
    const res = await postSaveRules(app, { content: VALID_CONTENT });
    expect(res.status).toBe(200);
    expect(onSetupCompleteCalls).toHaveLength(1);
  });

  it("calls onPromptContextChanged callback with correct args", async () => {
    const onPromptContextChangedCalls: unknown[] = [];
    const config = makeSaveConfig(dataDir);
    const deps = {
      ...makeDeps(db, config),
      onPromptContextChanged: (...args: unknown[]) => {
        onPromptContextChangedCalls.push(args);
      },
    } as unknown as ApiDependencies;
    const app = createSetupRoutes(deps);
    const res = await postSaveRules(app, { content: VALID_CONTENT });
    expect(res.status).toBe(200);
    expect(onPromptContextChangedCalls).toHaveLength(1);
    const [key, trigger] = onPromptContextChangedCalls[0] as [string, string];
    expect(key).toContain("management");
    expect(trigger).toBe("setup_initial");
  });

  it("deletes the setup session when sessionId is provided", async () => {
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));

    // Insert a dashboard_chat session
    db.prepare(
      `INSERT INTO conversation_sessions (platform, channel_id, scope, status)
       VALUES ('dashboard', 'dash:1', 'dashboard_chat', 'active')`,
    ).run();
    const row = db
      .prepare("SELECT last_insert_rowid() as id")
      .get() as { id: number };
    const sessionId = row.id;

    const res = await postSaveRules(app, { content: VALID_CONTENT, sessionId });
    expect(res.status).toBe(200);

    // Session should be deleted
    const remaining = db
      .prepare(
        `SELECT id FROM conversation_sessions WHERE id = ? AND scope = 'dashboard_chat'`,
      )
      .get(sessionId);
    expect(remaining).toBeUndefined();
  });

  it("returns 500 and rolls back agentDisplayName on write failure", async () => {
    // ESM node:fs exports are non-configurable, so vi.spyOn won't work.
    // Instead, make the target directory read-only to force a real EACCES error
    // when writeFileSync tries to create the rules file.
    const config = makeSaveConfig(dataDir);
    const app = createSetupRoutes(makeDeps(db, config));

    // Create the context/policies dir and make it read-only so writes fail
    const rulesDir = join(dataDir, "context", "policies");
    mkdirSync(rulesDir, { recursive: true });
    chmodSync(rulesDir, 0o555); // r-xr-xr-x — no write permission

    try {
      const res = await postSaveRules(app, {
        content: VALID_CONTENT,
        agentDisplayName: "FailBot",
      });
      expect(res.status).toBe(500);
      // agentDisplayName should NOT have been persisted (rollback)
      expect(config.agentDisplayName).toBe("Agent");
    } finally {
      // Restore write permissions so afterEach rmSync can clean up
      chmodSync(rulesDir, 0o755);
    }
  });
});

// ── /setup/vault-restructure-* — CONTEXT_VAULT_REDESIGN_PLAN V16 ────────────

describe("GET /setup/vault-restructure-status & POST /setup/vault-restructure-ack", () => {
  let db: Database.Database;
  let config: AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    config = makeConfig();
  });
  afterEach(() => db.close());

  it("status returns null/null on a fresh DB", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await app.request("/setup/vault-restructure-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pendingConsent: null,
      acknowledgement: null,
    });
  });

  it("status surfaces the pending-consent state when the bootstrap deferred", async () => {
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('context_vault_restructure_pending_consent', ?, CURRENT_TIMESTAMP)`,
    ).run(
      JSON.stringify({
        since: "2026-05-25T00:00:00Z",
        reason: "obsidian_consent_required",
        contextDir: "/Users/x/MyObsidianVault",
      }),
    );

    const app = createSetupRoutes(makeDeps(db, config));
    const res = await app.request("/setup/vault-restructure-status");
    const body = (await res.json()) as { pendingConsent: { reason: string } };
    expect(body.pendingConsent.reason).toBe("obsidian_consent_required");
  });

  it("ack endpoint records the dashboard ack on first POST", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    const res = await app.request("/setup/vault-restructure-ack", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      alreadyAcknowledged: boolean;
      restartRequired: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.alreadyAcknowledged).toBe(false);
    expect(body.restartRequired).toBe(true);

    const ack = db
      .prepare(
        "SELECT value_json FROM runtime_state WHERE key = 'context_vault_restructure_acknowledged_at'",
      )
      .get() as { value_json: string } | undefined;
    expect(ack).toBeDefined();
    const parsed = JSON.parse(ack!.value_json);
    expect(parsed.source).toBe("dashboard");
    expect(typeof parsed.at).toBe("string");
  });

  it("ack endpoint is idempotent — second POST reports alreadyAcknowledged", async () => {
    const app = createSetupRoutes(makeDeps(db, config));
    await app.request("/setup/vault-restructure-ack", { method: "POST" });
    const res = await app.request("/setup/vault-restructure-ack", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyAcknowledged: boolean; restartRequired: boolean };
    expect(body.alreadyAcknowledged).toBe(true);
    expect(body.restartRequired).toBe(false);
  });
});
