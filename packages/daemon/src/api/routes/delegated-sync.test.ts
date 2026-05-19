import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { IntegrationState } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { writeIntegrations } from "../../db/integrations-store.js";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../../db/runtime-state.js";
import { createDelegatedSyncRoutes } from "./delegated-sync.js";
import {
  DelegatedSyncWorker,
  type DelegatedSyncRunCadenceResult,
} from "../../observers/delegated-sync-worker.js";
import type { DelegatedBackendInvoker, InvokeResult } from "../../services/delegated-backend-invoker.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function zeroCost() {
  return {
    tokensInput: 0,
    tokensOutput: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
  };
}

function okResult(toolResult: unknown): InvokeResult {
  return {
    ok: true,
    toolResult,
    cost: zeroCost(),
    backendId: "claude",
    modelId: "claude-haiku-test",
  };
}

function makeInvoker(
  impl: (params: Parameters<DelegatedBackendInvoker["invoke"]>[0]) => Promise<InvokeResult>,
): DelegatedBackendInvoker {
  return { invoke: vi.fn(impl) } as unknown as DelegatedBackendInvoker;
}

/**
 * Build a worker with a single calendar:24h cadence wired to a stub
 * invoker. The route layer only consults `getStatus()` + `runCadenceNow()`
 * so the production cadence catalog is what matters for the validation
 * tests below; we reuse the production `CALENDAR_24H_CADENCE` indirectly
 * via the default cadence list when no override is passed.
 */
function makeWorker(
  db: Database.Database,
  invoker: DelegatedBackendInvoker = makeInvoker(async () => okResult({ events: [] })),
): DelegatedSyncWorker {
  return new DelegatedSyncWorker({
    db,
    invoker,
    calendarId: "primary",
    timezone: "UTC",
    now: () => NOW,
  });
}

function makeApp(deps: Partial<{ db: Database.Database; delegatedSyncWorker: DelegatedSyncWorker | undefined }>) {
  return createDelegatedSyncRoutes(deps as Parameters<typeof createDelegatedSyncRoutes>[0]);
}

describe("delegated-sync API", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /delegated-sync", () => {
    it("returns the worker status snapshot when wired", async () => {
      const worker = makeWorker(db);
      const app = makeApp({ db, delegatedSyncWorker: worker });

      const res = await app.request("/delegated-sync");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workerRunning: boolean;
        activeHours: { startHour: number; endHour: number };
        cadences: Record<string, unknown>;
      };
      expect(body.activeHours).toEqual({ startHour: 4, endHour: 24 });
      // The four production cadences are in the default catalog.
      expect(Object.keys(body.cadences).sort()).toEqual([
        "gmail:inbox:7d",
        "google_calendar:primary:24h",
        "google_calendar:primary:imminent",
        "notion:recently_updated",
      ]);
    });

    it("returns an empty status payload when the worker is unavailable", async () => {
      const app = makeApp({ db, delegatedSyncWorker: undefined });
      const res = await app.request("/delegated-sync");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workerRunning: boolean;
        cadences: Record<string, unknown>;
      };
      expect(body.workerRunning).toBe(false);
      expect(body.cadences).toEqual({});
    });
  });

  describe("PATCH /delegated-sync/cadences/:cadenceId", () => {
    it("toggles enabled and persists to runtime_state", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);

      const stored = readRuntimeState<{ cadenceEnabled: Record<string, boolean> }>(
        db,
        "delegatedSync",
      );
      expect(stored?.cadenceEnabled).toEqual({
        "google_calendar:primary:24h": true,
      });
    });

    it("updates intervalSeconds within the cadence's soft floor and ceiling", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalSeconds: 45 * 60 }),
      });
      expect(res.status).toBe(200);
      const stored = readRuntimeState<{ intervals: Record<string, number> }>(
        db,
        "delegatedSync",
      );
      expect(stored?.intervals).toEqual({ "google_calendar:primary:24h": 45 * 60 });
    });

    it("rejects intervals below the cadence's soft floor", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      // calendar 24h soft floor is 30 min (1800 s).
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalSeconds: 900 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; softFloorSeconds: number };
      expect(body.error).toBe("below_soft_floor");
      expect(body.softFloorSeconds).toBe(30 * 60);
    });

    it("rejects intervals above the 24 h ceiling", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalSeconds: 25 * 60 * 60 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("above_max");
    });

    it("returns 404 for an unrecognised cadence id", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/cadences/not:a:cadence", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 503 when the worker is not registered", async () => {
      const app = makeApp({ db, delegatedSyncWorker: undefined });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(503);
    });

    it("rejects an empty patch body", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("empty_patch");
    });
  });

  describe("PATCH /delegated-sync/active-hours", () => {
    it("persists a valid window", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/active-hours", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startHour: 9, endHour: 22 }),
      });
      expect(res.status).toBe(200);
      const stored = readRuntimeState<{
        activeStartHour: number;
        activeEndHour: number;
      }>(db, "delegatedSync");
      expect(stored).toMatchObject({ activeStartHour: 9, activeEndHour: 22 });
    });

    it("rejects start >= end", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/active-hours", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startHour: 22, endHour: 9 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("start_must_be_before_end");
    });

    it("rejects out-of-range hours", async () => {
      const app = makeApp({ db, delegatedSyncWorker: makeWorker(db) });
      const res = await app.request("/delegated-sync/active-hours", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startHour: -1, endHour: 24 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_start");
    });

    it("preserves existing config when worker is unwired", async () => {
      writeRuntimeState(db, "delegatedSync", { intervals: { foo: 1 } });
      const app = makeApp({ db, delegatedSyncWorker: undefined });
      const res = await app.request("/delegated-sync/active-hours", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startHour: 0, endHour: 12 }),
      });
      expect(res.status).toBe(200);
      const stored = readRuntimeState<{
        intervals: Record<string, number>;
        activeStartHour: number;
        activeEndHour: number;
      }>(db, "delegatedSync");
      expect(stored).toMatchObject({
        activeStartHour: 0,
        activeEndHour: 12,
        intervals: { foo: 1 },
      });
    });
  });

  describe("POST /delegated-sync/cadences/:cadenceId/run", () => {
    it("invokes the worker's runCadenceNow and returns ok on success", async () => {
      const worker = makeWorker(db);
      const spy = vi
        .spyOn(worker, "runCadenceNow")
        .mockResolvedValue({ ok: true } satisfies DelegatedSyncRunCadenceResult);

      const app = makeApp({ db, delegatedSyncWorker: worker });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h/run", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith("google_calendar:primary:24h");
    });

    it("maps unknown_cadence to 404", async () => {
      const worker = makeWorker(db);
      vi.spyOn(worker, "runCadenceNow").mockResolvedValue({
        ok: false,
        error: "unknown_cadence",
      } satisfies DelegatedSyncRunCadenceResult);
      const app = makeApp({ db, delegatedSyncWorker: worker });
      const res = await app.request("/delegated-sync/cadences/x/run", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("maps the other failure modes to 409", async () => {
      const worker = makeWorker(db);
      vi.spyOn(worker, "runCadenceNow").mockResolvedValue({
        ok: false,
        error: "tick_in_progress",
      } satisfies DelegatedSyncRunCadenceResult);
      const app = makeApp({ db, delegatedSyncWorker: worker });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h/run", {
        method: "POST",
      });
      expect(res.status).toBe(409);
    });

    it("returns 503 when the worker is unwired", async () => {
      const app = makeApp({ db, delegatedSyncWorker: undefined });
      const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h/run", {
        method: "POST",
      });
      expect(res.status).toBe(503);
    });
  });

  it("end-to-end: PATCH enabled then POST run-now actually fires the cadence", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => NOW,
    });
    const app = makeApp({ db, delegatedSyncWorker: worker });

    const patch = await app.request("/delegated-sync/cadences/google_calendar:primary:24h", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(200);

    const run = await app.request("/delegated-sync/cadences/google_calendar:primary:24h/run", {
      method: "POST",
    });
    expect(run.status).toBe(200);
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores integrations that are not in a cadence-eligible mode for run-now", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      } as IntegrationState,
    });
    const worker = makeWorker(db);
    const app = makeApp({ db, delegatedSyncWorker: worker });
    const res = await app.request("/delegated-sync/cadences/google_calendar:primary:24h/run", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // `integration_not_synchronizable` covers every mode the worker
    // does not run for — `direct`, `disabled`, and `native`.
    expect(body.error).toBe("integration_not_synchronizable");
  });
});
