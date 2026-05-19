import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { ObserverManager, type Observer } from "../observers/manager.js";
import {
  applyIntegrationModeChange,
} from "./integration-lifecycle.js";
import {
  bootstrapManagementMd,
  getManagementMdPath,
} from "./management-md.js";
import { readIntegrations } from "../db/integrations-store.js";
import { createIntegrationRoutes } from "../api/routes/integrations/index.js";
import {
  delegatedIntegrationsForProcessKey,
  backendHasIntegrationConnector,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";
import {
  readProbe,
  writeProbe,
} from "../db/integration-probe-store.js";

/**
 * End-to-end lifecycle test for the Integration Delegation Framework
 * (§Phase 6 of GOOGLE_AUTH_DELEGATION_DESIGN.md).
 *
 * Flow: fresh install → delegated (Claude) → direct → delegated (Codex).
 * Exercises §4.10 mode-change lifecycle and §4.12 setup/migration. The
 * observable contract at each step:
 *
 *   1. DB row updated with the new mode + delegatedBackend.
 *   2. `integrations.md` re-rendered through the self-write chokepoint.
 *   3. Observer side-effects applied exactly on direct-boundary crossings
 *      (start when entering direct, stop when leaving). Delegated→delegated
 *      swaps do not restart observers.
 *   4. Probe cache invalidated on mode or backend change.
 *   5. Mode-change callback runs before the audit row lands.
 *   6. `agent_actions` row written for every flip.
 *
 * The post-flip registry state also exercises Phase 4 router gating: the
 * fallback must be nulled when the delegated backend has no connector for
 * the touched integration.
 */
describe("integration-e2e lifecycle", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    // Probe cache + integration_probes table.
    applySchema(db);
    dir = mkdtempSync(join(tmpdir(), "pa-int-e2e-"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeObserverHarness() {
    const observerManager = new ObserverManager();
    const started: string[] = [];
    const stopped: string[] = [];
    const buildObserver = vi.fn((name: string): Observer => ({
      name,
      start: vi.fn(async () => {
        started.push(name);
      }),
      stop: vi.fn(async () => {
        stopped.push(name);
      }),
    }));
    return { observerManager, buildObserver, started, stopped };
  }

  function routes(
    harness: ReturnType<typeof makeObserverHarness>,
    rematerializeDmSessions?: (reason: string) => void,
  ) {
    return createIntegrationRoutes({
      db,
      // workspaceDir points at the repo root so real variant files resolve
      // for the delegated flips.
      config: { dataDir: dir, workspaceDir: process.cwd() },
      onIntegrationModeChange: async (
        key: IntegrationKey,
        prev: IntegrationState,
        next: IntegrationState,
      ) => {
        await applyIntegrationModeChange(
          {
            db,
            observerManager: harness.observerManager,
            buildObserver: harness.buildObserver,
            rematerializeDmSessions,
          },
          key,
          prev,
          next,
        );
      },
    } as never);
  }

  function countAudits(): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_actions WHERE action_type = 'integration.mode_change'",
        )
        .get() as { n: number }
    ).n;
  }

  it("walks fresh install → delegated Claude → direct → delegated Codex with correct side effects", async () => {
    // ── Step 0: fresh install. No integrations.md, no observers running. ──
    const bootstrap = await bootstrapManagementMd(dir, db);
    expect(bootstrap.created).toBe(true);
    expect(bootstrap.integrations.google_calendar.mode).toBe("disabled");

    const harness = makeObserverHarness();
    const app = routes(harness);

    // ── Step 1: disabled → delegated (Claude). google_calendar has a
    //   real observersTouched list (["calendar"]). Because we're leaving
    //   the disabled → delegated edge (neither side is direct), NO
    //   observer start/stop should fire. Pre-seed the probe cache so we
    //   can observe §4.11 invalidation after the mode change. ──
    writeProbe(db, {
      integration: "google_calendar",
      backend: "claude",
      presentTools: ["mcp__claude_ai_Google_Calendar__list_events"],
      capabilities: [],
      missingRequired: [],
      present: true,
      probedAt: "2026-04-19T10:00:00.000Z",
    });
    expect(readProbe(db, "google_calendar", "claude")).not.toBeNull();

    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "delegated",
          delegatedBackend: "claude",
        }),
      });
      expect(res.status).toBe(200);
    }

    // §4.11 — PATCH invalidates any cached probe row for the integration.
    expect(readProbe(db, "google_calendar", "claude")).toBeNull();

    let state = readIntegrations(db).google_calendar;
    expect(state.mode).toBe("delegated");
    expect(state.delegatedBackend).toBe("claude");
    expect(harness.started).toEqual([]);
    expect(harness.stopped).toEqual([]);
    expect(countAudits()).toBe(1);

    // File rewrite went through the self-write chokepoint.
    let body = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(body).toContain("| google_calendar | delegated | claude |");

    // ── Step 2: delegated (Claude) → direct. The observer should start
    //   now that the integration has crossed into direct. ──
    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "direct" }),
      });
      expect(res.status).toBe(200);
    }

    state = readIntegrations(db).google_calendar;
    expect(state.mode).toBe("direct");
    expect(state.delegatedBackend).toBeUndefined();
    expect(harness.started).toEqual(["calendar"]);
    expect(harness.stopped).toEqual([]);
    expect(harness.observerManager.has("calendar")).toBe(true);
    expect(countAudits()).toBe(2);

    body = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(body).toContain("| google_calendar | direct | — | — |");

    // ── Step 3: direct → delegated (Codex). The observer should stop,
    //   matching the §4.10 observer-gating contract. ──
    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "delegated",
          delegatedBackend: "codex",
        }),
      });
      expect(res.status).toBe(200);
    }

    state = readIntegrations(db).google_calendar;
    expect(state.mode).toBe("delegated");
    expect(state.delegatedBackend).toBe("codex");
    expect(harness.started).toEqual(["calendar"]);
    expect(harness.stopped).toEqual(["calendar"]);
    expect(harness.observerManager.has("calendar")).toBe(false);
    expect(countAudits()).toBe(3);

    body = readFileSync(getManagementMdPath(dir), "utf-8");
    expect(body).toContain("| google_calendar | delegated | codex |");

    // ── Step 4: verify the post-Phase-D registry state.
    //   `google_calendar.taskFlowsTouched` retains "routine.hourly_check"
    //   (so `selectTaskFlowVariantSuffix` picks the variant when
    //   CalendarPoller stops), but `delegatedIntegrationsForProcessKey`
    //   excludes calendar via `PROXY_DRIVEN_INTEGRATIONS`, so the
    //   router's fallback-gate is a no-op for proxied integrations. The
    //   daemon proxy (`POST /api/integrations/:key/exec`; the legacy
    //   `/invoke` RPC was retired 2026-05-01) handles cross-backend
    //   connector access; the fallback agent backend never invokes the
    //   connector itself. We still pin connector presence so
    //   a future regression that loses calendar's Codex connector is
    //   caught. ──
    const delegatedForMorning = delegatedIntegrationsForProcessKey(
      "routine.morning_routine",
      readIntegrations(db),
    );
    expect(delegatedForMorning).not.toContain("google_calendar");

    expect(backendHasIntegrationConnector("google_calendar", "codex")).toBe(true);
    // Gemini's `google-workspace` extension now provides the Calendar
    // connector — `backendConnectors.gemini` is populated for all three
    // proxy-driven integrations. Pin presence so a regression that drops
    // it is caught.
    expect(backendHasIntegrationConnector("google_calendar", "gemini")).toBe(true);
  });

  // DELEGATED-PROXY-API-DESIGN.md Phase F (§4.8) — every PATCH that
  // changes mode or backend must invoke the rematerialize hook so the
  // active DM workdirs pick up the new skill body / accounts.md /
  // per-backend instruction file on the next turn.
  it("invokes rematerializeDmSessions on every PATCH that changes mode or backend", async () => {
    await bootstrapManagementMd(dir, db);
    const harness = makeObserverHarness();
    const rematerialize = vi.fn();
    const app = routes(harness, rematerialize);

    // disabled → delegated (Claude). Mode flip → callback fires.
    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "delegated", delegatedBackend: "claude" }),
      });
      expect(res.status).toBe(200);
    }
    // The PATCH route schedules the lifecycle callback via
    // `Promise.resolve().then(...)`, so let the microtask queue drain.
    await new Promise((r) => setImmediate(r));
    expect(rematerialize).toHaveBeenCalledTimes(1);
    expect(rematerialize).toHaveBeenLastCalledWith(
      "integration_mode_change:google_calendar",
    );

    // delegated (Claude) → delegated (Codex). Backend swap with no
    // direct-boundary flip — pre-Phase-F this case was silently dropped.
    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "delegated", delegatedBackend: "codex" }),
      });
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setImmediate(r));
    expect(rematerialize).toHaveBeenCalledTimes(2);

    // Same-state PATCH (delegated/codex → delegated/codex). modeChanged
    // is false, so the route handler doesn't fire onIntegrationModeChange
    // at all — the hook count stays at 2.
    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "delegated", delegatedBackend: "codex" }),
      });
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setImmediate(r));
    expect(rematerialize).toHaveBeenCalledTimes(2);

    // delegated → direct. Crosses the direct boundary AND fires the
    // rematerialize hook — both observer start AND workdir refresh.
    {
      const res = await app.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "direct" }),
      });
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setImmediate(r));
    expect(rematerialize).toHaveBeenCalledTimes(3);
    expect(harness.started).toEqual(["calendar"]);
  });
});
