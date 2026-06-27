import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { IntegrationState } from "@aitne/shared";
import type { DelegatedToolCost } from "../core/agent-core.js";
import { applySchema } from "../db/schema.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { writeRuntimeState } from "../db/runtime-state.js";
import type { DelegatedBackendInvoker, InvokeResult } from "../services/delegated-backend-invoker.js";
import {
  DELEGATED_SYNC_OBSERVER_NAME,
  DELEGATED_SYNC_PROCESS_KEY,
  DelegatedSyncWorker,
  __delegatedSyncWorkerTestExports,
  hasActiveDelegatedSyncIntegration,
  type DelegatedSyncCadenceDefinition,
} from "./delegated-sync-worker.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

const { CALENDAR_24H_CADENCE } = __delegatedSyncWorkerTestExports;

// The unit-test calendar cadence reuses the production tool-call resolver
// + extractor (so a refactor in those touches one place) and just shrinks
// the cadence interval / soft floor for fast deterministic ticks.
const TEST_CADENCE: DelegatedSyncCadenceDefinition = {
  ...CALENDAR_24H_CADENCE,
  defaultIntervalSeconds: 10,
  softFloorSeconds: 1,
  buildWindow: (now) => ({
    windowMin: now.toISOString(),
    windowMax: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }),
};

function zeroCost(): DelegatedToolCost {
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

function failResult(message = "auth expired"): InvokeResult {
  return {
    ok: false,
    errorClass: "auth_error",
    message,
    cost: zeroCost(),
    backendId: "claude",
    modelId: "claude-haiku-test",
  };
}

function makeCalendarEvent(id: string, start: string): Record<string, unknown> {
  return {
    id,
    summary: "Planning",
    start: { dateTime: start },
    end: { dateTime: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString() },
    location: "Zoom",
    attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
  };
}

type InvokeParams = Parameters<DelegatedBackendInvoker["invoke"]>[0];
type ExposedWorkerState = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedAt: string | null;
  failureCount: number;
  lastError: string | null;
};
type ExposedWorkerInternals = {
  states: Map<string, ExposedWorkerState>;
};

function makeInvoker(
  impl: (params: InvokeParams) => Promise<InvokeResult>,
): DelegatedBackendInvoker {
  return { invoke: vi.fn(impl) } as unknown as DelegatedBackendInvoker;
}

describe("DelegatedSyncWorker", () => {
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
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "google_calendar:primary:24h": 10,
      },
      // Tests written before the opt-in default exercise scheduled-tick
      // semantics that pre-date the per-cadence enable flag. Enable the
      // four production cadence ids in setup so those tests keep passing
      // unchanged; the new default-off semantics are exercised by their
      // own dedicated test below.
      cadenceEnabled: {
        "google_calendar:primary:imminent": true,
        "google_calendar:primary:24h": true,
        "gmail:inbox:7d": true,
        "notion:recently_updated": true,
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  it("invokes the delegated connector, reconciles snapshots, and fires drift side effects", async () => {
    const eventStart = new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const batches = [
      { events: [] },
      { events: [makeCalendarEvent("evt-1", eventStart)] },
    ];
    const invoker = makeInvoker(async () => okResult(batches.shift() ?? { events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });
    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    expect((invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      integrationKey: "google_calendar",
      parentProcessKey: DELEGATED_SYNC_PROCESS_KEY,
    });

    const snapshot = db
      .prepare("SELECT item_id, window_key FROM integration_snapshots")
      .get() as { item_id: string; window_key: string };
    expect(snapshot).toEqual({ item_id: "evt-1", window_key: "primary:24h" });

    const observation = db
      .prepare("SELECT source, ref, change_type, actor FROM observations")
      .get() as {
        source: string;
        ref: string;
        change_type: string;
        actor: string;
      };
    expect(observation).toEqual({
      source: "calendar:primary",
      ref: "evt-1",
      change_type: "created",
      actor: "user",
    });

    const scheduled = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_schedule WHERE task_type = 'wake' AND json_extract(task_context, '$.routine') = 'today_refresh'",
      )
      .get() as { n: number };
    expect(scheduled.n).toBe(1);

    const syncRows = db
      .prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE action_type = 'delegated_sync' AND result = 'success'")
      .get() as { n: number };
    expect(syncRows.n).toBe(2);
  });

  it("pins the cadence to medium tier via modelOverride (Sonnet on Claude)", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    const firstCallParams = (invoker.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as InvokeParams;
    expect(firstCallParams.modelOverride).toBe("claude-sonnet-4-6");
  });

  it("starts idempotently, reports running status, and stops cleanly", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      tickIntervalSeconds: 3600,
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    try {
      expect(worker.name).toBe(DELEGATED_SYNC_OBSERVER_NAME);

      await worker.start();
      await worker.start();

      expect(invoker.invoke).toHaveBeenCalledTimes(1);
      expect(worker.getStatus(NOW).workerRunning).toBe(true);
    } finally {
      await worker.stop();
      await worker.stop();
    }

    expect(worker.getStatus(NOW).workerRunning).toBe(false);
  });

  it("can report status with default runtime options before the first tick", () => {
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
    });

    const status = worker.getStatus();

    expect(status.workerRunning).toBe(false);
    expect(Object.keys(status.cadences)).toEqual([
      "google_calendar:primary:imminent",
      "google_calendar:primary:24h",
      "gmail:inbox:7d",
      "notion:recently_updated",
    ]);
  });

  it("skips an overlapping tick while a delegated invocation is still running", async () => {
    let resolveInvoke!: (result: InvokeResult) => void;
    const pendingInvoke = new Promise<InvokeResult>((resolve) => {
      resolveInvoke = resolve;
    });
    const invoker = makeInvoker(async () => pendingInvoke);
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    const first = worker.tick({ force: true });
    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(1);

    resolveInvoke(okResult({ events: [] }));
    await first;
  });

  it("uses the default calendar cadences with bounded windows and read-only connector tools", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => NOW,
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    const calls = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls.map(
      ([params]) => params,
    );
    expect(calls[0]).toMatchObject({
      integrationKey: "google_calendar",
      toolName: "mcp__claude_ai_Google_Calendar__list_events",
      parentProcessKey: DELEGATED_SYNC_PROCESS_KEY,
      toolArgs: {
        calendarId: "primary",
        maxResults: 50,
        timeMin: "2026-04-29T11:45:00.000Z",
        timeMax: "2026-04-29T13:00:00.000Z",
      },
    });
    expect(calls[1]).toMatchObject({
      integrationKey: "google_calendar",
      toolName: "mcp__claude_ai_Google_Calendar__list_events",
      parentProcessKey: DELEGATED_SYNC_PROCESS_KEY,
      toolArgs: {
        calendarId: "primary",
        maxResults: 250,
        timeMin: "2026-04-29T12:00:00.000Z",
        timeMax: "2026-04-30T12:00:00.000Z",
      },
    });
  });

  it("backs off after five failures and resumes normal cadence after a success", async () => {
    let nowMs = NOW.getTime();
    const invoker = makeInvoker(async () => failResult());
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date(nowMs),
      cadences: [TEST_CADENCE],
    });

    for (let i = 0; i < 5; i += 1) {
      await worker.tick({ force: true });
      nowMs += 1000;
    }

    let status = worker.getStatus(new Date(nowMs));
    expect(status.circuitState).toBe("tripped");
    expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(5);
    expect(status.cadences["google_calendar:primary:24h"].effectiveIntervalSeconds).toBe(40);
    expect(invoker.invoke).toHaveBeenCalledTimes(5);

    nowMs += 20_000;
    await worker.tick();
    expect(invoker.invoke).toHaveBeenCalledTimes(5);

    (invoker.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async () => okResult({ events: [] }),
    );
    nowMs += 21_000;
    await worker.tick();

    expect(invoker.invoke).toHaveBeenCalledTimes(6);
    status = worker.getStatus(new Date(nowMs));
    expect(status.circuitState).toBe("ok");
    expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(0);
  });

  it("runs a due cadence on a non-forced first tick", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick();

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("treats malformed in-memory cadence timestamps as immediately due", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      // Pin TZ so `nextRunAt`'s active-hours projection (12:00 UTC inside
      // the default [4, 24) window) is deterministic regardless of the
      // host's local timezone.
      timezone: "UTC",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    (worker as unknown as ExposedWorkerInternals).states.set(
      "google_calendar:primary:24h",
      {
        lastAttemptAt: "not-a-date",
        lastSuccessAt: null,
        lastCompletedAt: null,
        failureCount: 0,
        lastError: null,
      },
    );

    expect(
      worker.getStatus(NOW).cadences["google_calendar:primary:24h"].nextRunAt,
    ).toBe(NOW.toISOString());

    await worker.tick();

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("reports the newest success across cadence statuses", () => {
    const secondaryCadence: DelegatedSyncCadenceDefinition = {
      ...TEST_CADENCE,
      windowKey: "primary:imminent",
    };
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE, secondaryCadence],
    });
    (worker as unknown as ExposedWorkerInternals).states.set(
      "google_calendar:primary:24h",
      {
        lastAttemptAt: "2026-04-29T11:00:00.000Z",
        lastSuccessAt: "2026-04-29T11:00:00.000Z",
        lastCompletedAt: "2026-04-29T11:00:00.000Z",
        failureCount: 0,
        lastError: null,
      },
    );
    (worker as unknown as ExposedWorkerInternals).states.set(
      "google_calendar:primary:imminent",
      {
        lastAttemptAt: "2026-04-29T11:01:00.000Z",
        lastSuccessAt: "2026-04-29T11:01:00.000Z",
        lastCompletedAt: "2026-04-29T11:01:00.000Z",
        failureCount: 0,
        lastError: null,
      },
    );

    expect(worker.getStatus(NOW).lastSuccessAt).toBe(
      "2026-04-29T11:01:00.000Z",
    );
  });

  it("skips delegated integrations when their sync kill switch is disabled", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        delegatedSyncEnabled: false,
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  // docs/design/appendices/native-integration-mode.md §"Polling,
  // observers, and the activity-scan threshold" — the cadence worker
  // only iterates delegated rows. Native observations land via the
  // in-turn routine.fetch_window pre-pass, not this worker. Calling
  // the invoker on a native row would be rejected by §3.3 anyway
  // ("native MUST NOT call the daemon proxy") and would produce a
  // failed `integration_drift_sync` audit row every hourly tick.
  it("skips native integrations in the regular tick regardless of kill switch", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        // Kill switch on (default) — worker still skips.
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    await worker.tick({ force: true });
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("detects delegated sync availability with persisted state and lifecycle overrides", () => {
    expect(hasActiveDelegatedSyncIntegration(db)).toBe(true);

    const disabledState = {
      mode: "disabled",
      deniedTools: [],
      lastChangedAt: NOW.toISOString(),
    } satisfies IntegrationState;
    expect(
      hasActiveDelegatedSyncIntegration(db, {
        key: "google_calendar",
        state: disabledState,
      }),
    ).toBe(false);

    // Native rows do NOT count toward the worker stand-up predicate —
    // the worker has no role in native mode (see appendix §"Polling,
    // observers, and the activity-scan threshold"). The seeded fixture
    // has only `google_calendar` as delegated; flipping that one to
    // native via the override leaves no delegated integration, so the
    // predicate must report false.
    const nativeState = {
      mode: "native",
      nativeBackend: "claude",
      deniedTools: [],
      lastChangedAt: NOW.toISOString(),
    } satisfies IntegrationState;
    expect(
      hasActiveDelegatedSyncIntegration(db, {
        key: "google_calendar",
        state: nativeState,
      }),
    ).toBe(false);
  });

  it("runs the production gmail cadence end-to-end (search_threads → reconcile → mail observation)", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const gmailMessage = {
      id: "msg-1",
      threadId: "thr-1",
      internalDate: 1714392000000, // 2024-04-29T12:00:00Z
      labelIds: ["INBOX"],
      snippet: "preview",
      payload: {
        headers: [
          { name: "Subject", value: "Hi" },
          { name: "From", value: "alice@example.com" },
        ],
      },
    };
    const batches = [
      { threads: [] }, // initial snapshot — no observation
      { threads: [{ threadId: "thr-1", messages: [gmailMessage] }] },
    ];
    const invoker = makeInvoker(async () =>
      okResult(batches.shift() ?? { threads: [] }),
    );
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => new Date("2024-04-29T12:30:00Z"),
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await worker.tick({ force: true });
    await worker.tick({ force: true });

    const call = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      integrationKey: "gmail",
      toolName: "mcp__claude_ai_Gmail__search_threads",
      toolArgs: { query: "newer_than:7d", pageSize: 25 },
    });

    const snapshot = db
      .prepare("SELECT item_id, window_key FROM integration_snapshots")
      .get() as { item_id: string; window_key: string };
    expect(snapshot).toEqual({ item_id: "thr-1", window_key: "inbox:7d" });

    const observation = db
      .prepare("SELECT source, ref, change_type FROM observations")
      .get() as { source: string; ref: string; change_type: string };
    expect(observation).toEqual({
      source: "mail:lifecycle",
      ref: "thr-1",
      change_type: "created",
    });
  });

  it("runs the production notion cadence end-to-end (notion-search → reconcile → notion:<db> observation)", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const page = {
      id: "page-1",
      url: "https://notion.so/page-1",
      last_edited_time: "2024-04-29T11:00:00Z",
      parent: { type: "database_id", database_id: "db-tasks" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Ship" }] },
        Status: { type: "status", status: { name: "In progress" } },
      },
    };
    const batches = [
      { results: [] },
      { results: [page] },
    ];
    const invoker = makeInvoker(async () =>
      okResult(batches.shift() ?? { results: [] }),
    );
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => new Date("2024-04-29T12:30:00Z"),
      cadences: [__delegatedSyncWorkerTestExports.NOTION_RECENTLY_UPDATED_CADENCE],
    });

    await worker.tick({ force: true });
    await worker.tick({ force: true });

    const call = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      integrationKey: "notion",
      toolName: "mcp__claude_ai_Notion__notion-search",
      toolArgs: {
        query: "updated",
        page_size: 25,
        filters: { created_date_range: { start_date: "2024-04-22" } },
      },
    });

    const snapshot = db
      .prepare("SELECT item_id, window_key FROM integration_snapshots")
      .get() as { item_id: string; window_key: string };
    expect(snapshot).toEqual({ item_id: "page-1", window_key: "recently_updated" });

    const observation = db
      .prepare("SELECT source, ref, change_type FROM observations")
      .get() as { source: string; ref: string; change_type: string };
    expect(observation).toEqual({
      source: "notion:db-tasks",
      ref: "page-1",
      change_type: "created",
    });
  });

  it("records failed delegated sync actions when the invoker throws", async () => {
    const invoker = makeInvoker(async () => {
      throw new Error("subprocess died");
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    const status = worker.getStatus(NOW);
    expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(1);
    expect(status.cadences["google_calendar:primary:24h"].lastError).toBe(
      "subprocess died",
    );
    const row = db
      .prepare(
        "SELECT result, error, model_used, backend, cost_usd FROM agent_actions WHERE action_type = 'delegated_sync'",
      )
      .get() as {
        result: string;
        error: string;
        model_used: string | null;
        backend: string | null;
        cost_usd: number;
      };
    expect(row).toEqual({
      result: "failed",
      error: "subprocess died",
      model_used: null,
      backend: null,
      cost_usd: 0,
    });
  });

  it("records failed delegated sync actions when the invoker throws a non-Error value", async () => {
    const invoker = makeInvoker(async () => {
      throw "transport-lost";
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    const row = db
      .prepare("SELECT result, error FROM agent_actions WHERE action_type = 'delegated_sync'")
      .get() as { result: string; error: string };
    expect(row).toEqual({ result: "failed", error: "transport-lost" });
  });

  describe("invoker wall-clock timeout", () => {
    it("aborts and records timeout when the invoker hangs past invokerTimeoutMs", async () => {
      let abortReason: unknown = null;
      // Invoker that never resolves on its own but observes the abort signal
      // so the test can confirm the worker plumbed cancellation through.
      const invoker: DelegatedBackendInvoker = {
        invoke: vi.fn(async (params: InvokeParams) => {
          return new Promise<InvokeResult>((_resolve, reject) => {
            params.abortSignal?.addEventListener("abort", () => {
              abortReason = params.abortSignal?.reason;
              reject(new Error("aborted-late"));
            });
          });
        }),
      } as unknown as DelegatedBackendInvoker;
      const worker = new DelegatedSyncWorker({
        db,
        invoker,
        calendarId: "primary",
        now: () => NOW,
        cadences: [TEST_CADENCE],
        invokerTimeoutMs: 80,
      });

      const startedAt = Date.now();
      await worker.tick({ force: true });
      const elapsed = Date.now() - startedAt;

      // The retry loop catches `errorClass: "timeout"` and retries once
      // (1.5 s RETRY_DELAY_MS + a second 80 ms timeout), so the upper
      // bound is ~2 s plus generous CI noise.
      expect(elapsed).toBeLessThan(4000);
      expect(abortReason).toBeInstanceOf(Error);

      const status = worker.getStatus(NOW);
      expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(1);
      expect(status.cadences["google_calendar:primary:24h"].lastError).toContain(
        "did not return within 80 ms",
      );

      const row = db
        .prepare(
          "SELECT result, error FROM agent_actions WHERE action_type = 'delegated_sync'",
        )
        .get() as { result: string; error: string };
      expect(row.result).toBe("failed");
      expect(row.error).toContain("did not return within 80 ms");
    });

    it("retries once through the existing transient-error path (errorClass='timeout')", async () => {
      const invokeFn = vi
        .fn<(params: InvokeParams) => Promise<InvokeResult>>()
        // First attempt hangs.
        .mockImplementationOnce(async (params) => {
          return new Promise<InvokeResult>((_resolve, reject) => {
            params.abortSignal?.addEventListener("abort", () =>
              reject(new Error("aborted-1")),
            );
          });
        })
        // Second attempt succeeds.
        .mockImplementationOnce(async () => okResult({ events: [] }));
      const worker = new DelegatedSyncWorker({
        db,
        invoker: { invoke: invokeFn } as unknown as DelegatedBackendInvoker,
        calendarId: "primary",
        now: () => NOW,
        cadences: [TEST_CADENCE],
        invokerTimeoutMs: 60,
      });

      await worker.tick({ force: true });

      expect(invokeFn).toHaveBeenCalledTimes(2);
      const status = worker.getStatus(NOW);
      expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(0);
      expect(status.cadences["google_calendar:primary:24h"].lastSuccessAt).toBeTruthy();
    });

    it("releases the tickRunning mutex even when the invoker resolves long after timeout", async () => {
      let resolveInvoke!: (result: InvokeResult) => void;
      const invokeFn = vi
        .fn<(params: InvokeParams) => Promise<InvokeResult>>()
        // First call hangs; we control its resolution.
        .mockImplementationOnce(async () => {
          return new Promise<InvokeResult>((resolve) => {
            resolveInvoke = resolve;
          });
        })
        .mockImplementation(async () => okResult({ events: [] }));
      const worker = new DelegatedSyncWorker({
        db,
        invoker: { invoke: invokeFn } as unknown as DelegatedBackendInvoker,
        calendarId: "primary",
        now: () => NOW,
        cadences: [TEST_CADENCE],
        invokerTimeoutMs: 50,
      });

      await worker.tick({ force: true });

      // tickRunning was released — a second tick proceeds (would have
      // been skipped if the mutex were still held).
      const secondCallsBefore = invokeFn.mock.calls.length;
      await worker.tick({ force: true });
      expect(invokeFn.mock.calls.length).toBeGreaterThan(secondCallsBefore);

      // Resolving the orphaned invoke must not throw or trip an
      // unhandledRejection (the worker pre-attached a catch).
      resolveInvoke({
        ok: false,
        errorClass: "timeout",
        message: "late",
      });
      // Yield once so the late resolution's microtask drains.
      await new Promise((r) => setTimeout(r, 10));
    });

    it("clamps a runtime_state value below the floor up to MIN_INVOKER_TIMEOUT_MS", async () => {
      const __test = (DelegatedSyncWorker as unknown as {
        prototype: {
          resolveInvokerTimeoutMs: (cfg: { invokerTimeoutSeconds?: number }) => number;
        };
      }).prototype.resolveInvokerTimeoutMs;
      const worker = new DelegatedSyncWorker({
        db,
        invoker: makeInvoker(async () => okResult({ events: [] })),
        calendarId: "primary",
        now: () => NOW,
        cadences: [TEST_CADENCE],
        // No constructor override — exercise the runtime_state branch.
      });

      // 1 s requested → clamped to 30 s floor.
      const clamped = __test.call(worker, { invokerTimeoutSeconds: 1 });
      expect(clamped).toBe(30_000);

      // Healthy value passes through.
      const healthy = __test.call(worker, { invokerTimeoutSeconds: 60 });
      expect(healthy).toBe(60_000);

      // No runtime override → default.
      const fallback = __test.call(worker, {});
      expect(fallback).toBe(5 * 60 * 1000);
    });

    it("ignores a non-positive invokerTimeoutMs constructor override and falls back to the default", () => {
      const __test = (DelegatedSyncWorker as unknown as {
        prototype: {
          resolveInvokerTimeoutMs: (cfg: { invokerTimeoutSeconds?: number }) => number;
        };
      }).prototype.resolveInvokerTimeoutMs;

      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const worker = new DelegatedSyncWorker({
          db,
          invoker: makeInvoker(async () => okResult({ events: [] })),
          calendarId: "primary",
          now: () => NOW,
          cadences: [TEST_CADENCE],
          invokerTimeoutMs: bad,
        });
        // Bad override is rejected → runtime_state is empty → default.
        expect(__test.call(worker, {})).toBe(5 * 60 * 1000);
      }
    });
  });

  it("falls back to zero cost when a failed invocation returns no partial cost", async () => {
    const invoker = makeInvoker(async () => ({
      ok: false,
      errorClass: "auth_error",
      message: "no usable auth",
      backendId: "claude",
      modelId: "claude-haiku-test",
    }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    const row = db
      .prepare(
        "SELECT result, error, backend, model_used, cost_usd FROM agent_actions WHERE action_type = 'delegated_sync'",
      )
      .get() as {
        result: string;
        error: string;
        backend: string;
        model_used: string;
        cost_usd: number;
      };
    expect(row).toEqual({
      result: "failed",
      error: "no usable auth",
      backend: "claude",
      model_used: "claude-haiku-test",
      cost_usd: 0,
    });
  });

  it("retries once on a transient timeout and records the eventual success with retryAttempts", async () => {
    let calls = 0;
    const invoker = makeInvoker(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          errorClass: "timeout" as const,
          message: "delegated proxy timed out (wall-clock)",
          cost: zeroCost(),
          backendId: "claude" as const,
          modelId: "claude-haiku-test",
        };
      }
      return okResult({ events: [] });
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    const status = worker.getStatus(NOW);
    expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(0);
    expect(status.cadences["google_calendar:primary:24h"].lastSuccessAt).toBe(
      NOW.toISOString(),
    );
    const row = db
      .prepare(
        "SELECT result, json_extract(detail, '$.retryAttempts') AS retryAttempts FROM agent_actions WHERE action_type = 'delegated_sync'",
      )
      .get() as { result: string; retryAttempts: number };
    expect(row.result).toBe("success");
    expect(row.retryAttempts).toBe(1);
  });

  it("retries once on subprocess_crashed", async () => {
    let calls = 0;
    const invoker = makeInvoker(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          errorClass: "subprocess_crashed" as const,
          message: "codex exec exited 137",
          cost: zeroCost(),
          backendId: "codex" as const,
          modelId: "codex-test",
        };
      }
      return okResult({ events: [] });
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    const row = db
      .prepare("SELECT result FROM agent_actions WHERE action_type = 'delegated_sync'")
      .get() as { result: string };
    expect(row.result).toBe("success");
  });

  it("retries once on tool_not_registered (Gemini MCP registry warmup race)", async () => {
    // First-tick race: cadence fires <10s after `delegated` enabled, the
    // host google-workspace MCP extension hasn't completed its handshake
    // yet, Gemini CLI returns `Tool "X" not found`. Reclassified upstream
    // by `gemini-cli-core.runDelegatedTool` as `tool_not_registered` so
    // this retry policy can bounce once with a 1.5s delay; the second
    // attempt finds the tool registered.
    let calls = 0;
    const invoker = makeInvoker(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          errorClass: "tool_not_registered" as const,
          message:
            'Tool "mcp_google-workspace_calendar.listEvents" not found.'
            + ' Did you mean one of: "google_web_search", "grep_search"?',
          cost: zeroCost(),
          backendId: "gemini" as const,
          modelId: "gemini-2.5-flash",
        };
      }
      return okResult({ events: [] });
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    const row = db
      .prepare(
        "SELECT result, json_extract(detail, '$.retryAttempts') AS retryAttempts FROM agent_actions WHERE action_type = 'delegated_sync'",
      )
      .get() as { result: string; retryAttempts: number };
    expect(row.result).toBe("success");
    expect(row.retryAttempts).toBe(1);
  });

  it("does not retry on auth_error or other deterministic failures", async () => {
    const invoker = makeInvoker(async () => failResult("expired token"));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    const row = db
      .prepare(
        "SELECT result, json_extract(detail, '$.retryAttempts') AS retryAttempts FROM agent_actions WHERE action_type = 'delegated_sync'",
      )
      .get() as { result: string; retryAttempts: number | null };
    expect(row.result).toBe("failed");
    // retryAttempts is omitted from detail when 0 — keeps the audit row tight
    expect(row.retryAttempts).toBeNull();
  });

  it("records failed when both attempts time out, with retryAttempts=1", async () => {
    const invoker = makeInvoker(async () => ({
      ok: false,
      errorClass: "timeout" as const,
      message: "delegated proxy timed out (wall-clock)",
      cost: zeroCost(),
      backendId: "gemini" as const,
      modelId: "gemini-flash-lite-test",
    }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    // 1 initial + 1 retry = 2 total calls
    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    const status = worker.getStatus(NOW);
    expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(1);
    const row = db
      .prepare(
        "SELECT result, json_extract(detail, '$.retryAttempts') AS retryAttempts FROM agent_actions WHERE action_type = 'delegated_sync'",
      )
      .get() as { result: string; retryAttempts: number };
    expect(row.result).toBe("failed");
    expect(row.retryAttempts).toBe(1);
  });

  it("records failed delegated sync actions when the tool result has no item array", async () => {
    const invoker = makeInvoker(async () => okResult("not-json"));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    const row = db
      .prepare("SELECT result, error FROM agent_actions WHERE action_type = 'delegated_sync'")
      .get() as { result: string; error: string };
    expect(row.result).toBe("failed");
    expect(row.error).toMatch(/did not contain an item array/);
    expect(row.error).toMatch(/events/);
  });

  it("keeps cadence state intact if delegated_sync action logging fails", async () => {
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    db.prepare("DROP TABLE agent_actions").run();

    await worker.tick({ force: true });

    const status = worker.getStatus(NOW);
    expect(status.cadences["google_calendar:primary:24h"].failureCount).toBe(0);
    expect(status.cadences["google_calendar:primary:24h"].lastSuccessAt).toBe(
      NOW.toISOString(),
    );
  });

  it("applies runtime interval aliases and ignores malformed runtime config", () => {
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "google_calendar.primary:24h": 12,
      },
    });
    let worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(
      worker.getStatus(NOW).cadences["google_calendar:primary:24h"]
        .intervalSeconds,
    ).toBe(12);

    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "primary:24h": 13,
      },
    });
    worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(
      worker.getStatus(NOW).cadences["google_calendar:primary:24h"]
        .intervalSeconds,
    ).toBe(13);

    writeRuntimeState(db, "delegatedSync", "bad");
    worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(
      worker.getStatus(NOW).cadences["google_calendar:primary:24h"]
        .intervalSeconds,
    ).toBe(60);
  });

  it("maps backend-specific calendar list tools and extracts items defensively across integrations", () => {
    const {
      calendarListBareTool,
      namespacedTool,
      extractItemsByKeys,
      gmailSearchToolCall,
      notionSearchToolCall,
      isoDate,
      CALENDAR_ITEM_KEYS,
      GMAIL_ITEM_KEYS,
      NOTION_ITEM_KEYS,
    } = __delegatedSyncWorkerTestExports;
    const event = { id: "evt-1" };

    // Calendar tool names per backend.
    expect(
      namespacedTool("google_calendar", "claude", calendarListBareTool("claude")),
    ).toBe("mcp__claude_ai_Google_Calendar__list_events");
    expect(
      namespacedTool("google_calendar", "codex", calendarListBareTool("codex")),
    ).toBe("mcp__codex_apps__google_calendar._search_events");
    expect(
      namespacedTool("google_calendar", "gemini", calendarListBareTool("gemini")),
    ).toBe("mcp_google-workspace_calendar.listEvents");

    // The generalised extractor walks per-integration item keys + the
    // shared wrapper keys (`toolResult` / `data` / `result`), and rejects
    // shapes that go too deep (>4 levels) — guards against a connector
    // returning a circular wrapper without an item array.
    expect(extractItemsByKeys([event], CALENDAR_ITEM_KEYS)).toEqual([event]);
    expect(extractItemsByKeys("", CALENDAR_ITEM_KEYS)).toEqual([]);
    expect(
      extractItemsByKeys(JSON.stringify([event]), CALENDAR_ITEM_KEYS),
    ).toEqual([event]);

    for (const key of CALENDAR_ITEM_KEYS) {
      expect(extractItemsByKeys({ [key]: [event] }, CALENDAR_ITEM_KEYS)).toEqual(
        [event],
      );
    }
    expect(
      extractItemsByKeys({ data: { items: [event] } }, CALENDAR_ITEM_KEYS),
    ).toEqual([event]);

    // Gmail-specific keys.
    for (const key of GMAIL_ITEM_KEYS) {
      expect(
        extractItemsByKeys({ [key]: [{ threadId: "t" }] }, GMAIL_ITEM_KEYS),
      ).toEqual([{ threadId: "t" }]);
    }

    // Notion-specific keys.
    for (const key of NOTION_ITEM_KEYS) {
      expect(
        extractItemsByKeys({ [key]: [{ id: "p" }] }, NOTION_ITEM_KEYS),
      ).toEqual([{ id: "p" }]);
    }

    // Defensive paths.
    expect(() => extractItemsByKeys("not-json", CALENDAR_ITEM_KEYS)).toThrow(
      /did not contain an item array/,
    );
    expect(() => extractItemsByKeys("{", CALENDAR_ITEM_KEYS)).toThrow(
      /did not contain an item array/,
    );
    expect(() => extractItemsByKeys(null, CALENDAR_ITEM_KEYS)).toThrow(
      /did not contain an item array/,
    );
    expect(() =>
      extractItemsByKeys({ unknown: [event] }, CALENDAR_ITEM_KEYS),
    ).toThrow(/did not contain an item array/);
    // Depth cap: 5-level nest under recognised keys still throws.
    expect(() =>
      extractItemsByKeys(
        { data: { result: { toolResult: { data: { items: [event] } } } } },
        CALENDAR_ITEM_KEYS,
      ),
    ).toThrow(/did not contain an item array/);

    // Gmail per-backend tool call shape.
    const ctx = {
      windowMin: "2024-04-22T12:00:00.000Z",
      windowMax: "2024-04-29T12:01:00.000Z",
      now: new Date("2024-04-29T12:00:00Z"),
      calendarId: "primary",
      maxResults: 25,
    };
    expect(gmailSearchToolCall("claude", ctx)).toEqual({
      toolName: "mcp__claude_ai_Gmail__search_threads",
      toolArgs: { query: "newer_than:7d", pageSize: 25 },
    });
    expect(gmailSearchToolCall("codex", ctx)).toEqual({
      toolName: "mcp__codex_apps__gmail._search_emails",
      toolArgs: { query: "newer_than:7d", max_results: 25 },
    });
    expect(gmailSearchToolCall("gemini", ctx)).toEqual({
      toolName: "mcp_google-workspace_gmail.search",
      toolArgs: { query: "newer_than:7d", maxResults: 25 },
    });

    // Notion per-backend tool call shape.
    expect(notionSearchToolCall("claude", ctx)).toEqual({
      toolName: "mcp__claude_ai_Notion__notion-search",
      toolArgs: {
        query: "updated",
        filters: { created_date_range: { start_date: "2024-04-22" } },
        page_size: 25,
      },
    });
    expect(notionSearchToolCall("codex", ctx)).toEqual({
      toolName: "mcp__codex_apps__notion._search",
      toolArgs: {
        query: "updated",
        filters: { created_date_range: { start_date: "2024-04-22" } },
        page_size: 25,
      },
    });
    expect(notionSearchToolCall("gemini", ctx)).toEqual({
      toolName: "mcp_notion_notion-search",
      toolArgs: {
        query: "updated",
        filters: { created_date_range: { start_date: "2024-04-22" } },
        page_size: 25,
      },
    });

    // isoDate slices ISO instants down to YYYY-MM-DD.
    expect(isoDate("2024-04-22T12:00:00.000Z")).toBe("2024-04-22");
  });

  it("Phase 7 (h): hydrates per-cadence state from agent_actions before the first tick — recent success skips the redundant subprocess spawn", async () => {
    // Pre-seed a recent successful delegated_sync row for this cadence —
    // simulates a daemon restart shortly after the worker last ran.
    const recentlyAt = new Date(NOW.getTime() - 2 * 1000); // 2s ago, well inside the 10s test cadence
    db.prepare(
      `INSERT INTO agent_actions (
         event_id, action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source, source_kind
       ) VALUES (
         NULL, 'delegated_sync', ?, NULL,
         0, 0, 0, 0, 0,
         0, 0, 'success', ?,
         datetime(?), datetime(?), NULL, 'claude', 'sdk', 'cron'
       )`,
    ).run(
      DELEGATED_SYNC_PROCESS_KEY,
      JSON.stringify({
        integration: "google_calendar",
        windowKey: "primary:24h",
      }),
      recentlyAt.toISOString(),
      recentlyAt.toISOString(),
    );

    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      tickIntervalSeconds: 3600,
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    try {
      await worker.start();
      // Pre-seeded success means cadenceDue is false on the initial tick.
      expect(invoker.invoke).toHaveBeenCalledTimes(0);
      const status = worker.getStatus(NOW);
      const cadence = status.cadences["google_calendar:primary:24h"];
      expect(cadence.lastSuccessAt).toBe(recentlyAt.toISOString());
      expect(cadence.lastAttemptAt).toBe(recentlyAt.toISOString());
    } finally {
      await worker.stop();
    }
  });

  it("Phase 7 (h): hydrates with no history — first tick still runs every cadence", async () => {
    // No agent_actions rows seeded → hydration leaves states empty →
    // cadenceDue returns true on the first tick (legacy force-on-start
    // behaviour preserved for fresh installs).
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      tickIntervalSeconds: 3600,
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    try {
      await worker.start();
      expect(invoker.invoke).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
    }
  });

  it("Phase 7 (g): surfaces unrecognised runtime intervals keys via getStatus()", async () => {
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "gmail:imminent": 60, // bogus key — gmail has inbox:7d, not imminent
        "primary:24h": 30, // valid integration-local form
        "rogue.key": 99, // arbitrary garbage
      },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    expect(worker.getStatus(NOW).unrecognizedIntervalKeys).toEqual([
      "gmail:imminent",
      "rogue.key",
    ]);
  });

  it("Phase 7 (c): reports TTL contract violations when an effective cadence exceeds the per-integration TTL × 1.5", async () => {
    const { TTL_CONTRACT_RATIO } = __delegatedSyncWorkerTestExports;
    // Push the cadence above 90 min × (1 / 1.5) = 60 min so the contract
    // (cadence × 1.5 ≤ 90 min) breaks.
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "google_calendar:primary:24h": 90 * 60, // 90 min — at the boundary
      },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(TTL_CONTRACT_RATIO).toBe(1.5);
    const violations = worker.getStatus(NOW).ttlContractViolations;
    expect(violations).toEqual([
      {
        cadenceId: "google_calendar:primary:24h",
        intervalSeconds: 90 * 60,
        ttlSeconds: 90 * 60,
      },
    ]);
  });

  it("Phase 7 (g): start() emits the unrecognized-intervals warn log when typo'd keys exist", async () => {
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "gmail:imminent": 60, // typo'd cadence id
        "rogue.key": 99,
      },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    try {
      await worker.start();
    } finally {
      await worker.stop();
    }
    expect(worker.getStatus(NOW).unrecognizedIntervalKeys).toEqual([
      "gmail:imminent",
      "rogue.key",
    ]);
  });

  it("logs and swallows an initial-tick failure during start() so cadence retries can proceed", async () => {
    // start() wraps the initial tick in try/catch; when something below
    // `await this.tick()` throws, start() logs and continues (timer still
    // registers). Per-cadence errors are caught inside runCadence, so to
    // hit the start()-level catch we make `now()` throw on the second
    // call (first call: hydrateStateFromHistory → succeeds; second call:
    // runTick → throws).
    let nowCalls = 0;
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => {
        nowCalls += 1;
        if (nowCalls > 2) throw new Error("clock exploded");
        return NOW;
      },
      cadences: [TEST_CADENCE],
    });
    try {
      await expect(worker.start()).resolves.toBeUndefined();
    } finally {
      await worker.stop();
    }
    expect(nowCalls).toBeGreaterThan(2);
  });

  it("Phase 7 (c): start() pushes violations and emits the TTL warn log when a cadence breaks the contract", async () => {
    // Configure a cadence above the TTL × 1.5 contract so the violations
    // array is populated and the warn-log branch in warnOnConfigViolations
    // fires. start() drains it through hydrateStateFromHistory + the initial
    // tick; we don't care about the tick result, only that the violations
    // log fires before the first invoke.
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      intervals: {
        "google_calendar:primary:24h": 90 * 60,
      },
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    try {
      await worker.start();
    } finally {
      await worker.stop();
    }
    // getStatus surfaces the same violation the warn log emitted.
    expect(worker.getStatus(NOW).ttlContractViolations).toEqual([
      {
        cadenceId: "google_calendar:primary:24h",
        intervalSeconds: 90 * 60,
        ttlSeconds: 90 * 60,
      },
    ]);
  });

  it("Phase 7 helpers: collectUnrecognizedIntervalKeys + sqliteDatetimeToIso", () => {
    const { collectUnrecognizedIntervalKeys, sqliteDatetimeToIso, CALENDAR_24H_CADENCE } =
      __delegatedSyncWorkerTestExports;

    expect(
      collectUnrecognizedIntervalKeys([CALENDAR_24H_CADENCE], {
        intervals: {
          "google_calendar:primary:24h": 1,
          "google_calendar.primary:24h": 1,
          "primary:24h": 1,
          "bogus:key": 1,
        },
      }),
    ).toEqual(["bogus:key"]);

    // Empty config returns empty list.
    expect(collectUnrecognizedIntervalKeys([CALENDAR_24H_CADENCE], {})).toEqual([]);

    // Datetime conversion accepts SQLite + ISO + zoned ISO formats.
    expect(sqliteDatetimeToIso("2026-04-29 12:00:00")).toBe("2026-04-29T12:00:00.000Z");
    expect(sqliteDatetimeToIso("2026-04-29T12:00:00Z")).toBe("2026-04-29T12:00:00.000Z");
    expect(sqliteDatetimeToIso("2026-04-29T21:00:00+09:00")).toBe(
      "2026-04-29T12:00:00.000Z",
    );
    expect(sqliteDatetimeToIso("not-a-date")).toBeNull();
    expect(sqliteDatetimeToIso(null)).toBeNull();
    expect(sqliteDatetimeToIso("")).toBeNull();
  });
});

// ── Opt-in cadence behaviour (delegated-sync-opt-in.md) ─────────────────

describe("DelegatedSyncWorker — opt-in cadence", () => {
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

  it("default-off: a fresh runtime_state row keeps every cadence dormant on a non-forced tick", async () => {
    // No `runtime_state.delegatedSync` row at all — the worker should
    // treat every cadence as disabled until the operator opts in.
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick();

    expect(invoker.invoke).not.toHaveBeenCalled();
    expect(
      worker.getStatus(NOW).cadences["google_calendar:primary:24h"].enabled,
    ).toBe(false);
  });

  it("force=true bypasses cadenceEnabled so test fixtures + future batch paths still fire", async () => {
    // The integration master switch is honoured; only the per-cadence
    // schedule flag is bypassed.
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick({ force: true });

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("cadence becomes due once the operator flips cadenceEnabled to true", async () => {
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      cadenceEnabled: { "google_calendar:primary:24h": true },
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    await worker.tick();

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("active-hours: outside the window the entire tick short-circuits without touching cadenceDue", async () => {
    // Window 09–17 UTC; tick at 03:00 UTC → out of window → skip.
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      cadenceEnabled: { "google_calendar:primary:24h": true },
      activeStartHour: 9,
      activeEndHour: 17,
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date("2026-04-29T03:00:00.000Z"),
      cadences: [TEST_CADENCE],
    });

    await worker.tick();

    expect(invoker.invoke).not.toHaveBeenCalled();
    expect(worker.getStatus(new Date("2026-04-29T03:00:00.000Z")).withinActiveHours).toBe(
      false,
    );
  });

  it("active-hours: inside the window the cadence runs as before", async () => {
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      cadenceEnabled: { "google_calendar:primary:24h": true },
      activeStartHour: 9,
      activeEndHour: 17,
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date("2026-04-29T12:00:00.000Z"),
      cadences: [TEST_CADENCE],
    });

    await worker.tick();

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(worker.getStatus(new Date("2026-04-29T12:00:00.000Z")).withinActiveHours).toBe(
      true,
    );
  });

  it("nextRunAt projects past out-of-window candidates to the next active-hours start", () => {
    // Window 09–17 UTC; cadence ran at 02:00, interval 30 min → naive
    // candidate = 02:30 (still outside window) → must shift to today's 09:00.
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      cadenceEnabled: { "google_calendar:primary:24h": true },
      activeStartHour: 9,
      activeEndHour: 17,
      intervals: { "google_calendar:primary:24h": 30 * 60 },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date("2026-04-29T02:30:00.000Z"),
      cadences: [TEST_CADENCE],
    });
    (worker as unknown as ExposedWorkerInternals).states.set(
      "google_calendar:primary:24h",
      {
        lastAttemptAt: "2026-04-29T02:00:00.000Z",
        lastSuccessAt: "2026-04-29T02:00:00.000Z",
        lastCompletedAt: "2026-04-29T02:00:00.000Z",
        failureCount: 0,
        lastError: null,
      },
    );

    expect(
      worker.getStatus(new Date("2026-04-29T02:30:00.000Z")).cadences[
        "google_calendar:primary:24h"
      ].nextRunAt,
    ).toBe("2026-04-29T09:00:00.000Z");
  });

  it("nextRunAt projects past-end-of-window candidates to tomorrow's active-hours start", () => {
    // Window 09–17 UTC; cadence ran at 16:50, interval 30 min → naive
    // candidate = 17:20 (past end of window) → must shift to tomorrow 09:00.
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      cadenceEnabled: { "google_calendar:primary:24h": true },
      activeStartHour: 9,
      activeEndHour: 17,
      intervals: { "google_calendar:primary:24h": 30 * 60 },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date("2026-04-29T17:20:00.000Z"),
      cadences: [TEST_CADENCE],
    });
    (worker as unknown as ExposedWorkerInternals).states.set(
      "google_calendar:primary:24h",
      {
        lastAttemptAt: "2026-04-29T16:50:00.000Z",
        lastSuccessAt: "2026-04-29T16:50:00.000Z",
        lastCompletedAt: "2026-04-29T16:50:00.000Z",
        failureCount: 0,
        lastError: null,
      },
    );

    expect(
      worker.getStatus(new Date("2026-04-29T17:20:00.000Z")).cadences[
        "google_calendar:primary:24h"
      ].nextRunAt,
    ).toBe("2026-04-30T09:00:00.000Z");
  });

  it("nextRunAt floors to `now` instead of returning a past instant", () => {
    // Cadence ran an hour ago, interval 10 s → naive candidate is in the
    // past. Reporter should clamp to `now`, not show a stale ISO string.
    writeRuntimeState(db, "delegatedSync", {
      minIntervalSeconds: 1,
      cadenceEnabled: { "google_calendar:primary:24h": true },
      intervals: { "google_calendar:primary:24h": 10 },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      timezone: "UTC",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    (worker as unknown as ExposedWorkerInternals).states.set(
      "google_calendar:primary:24h",
      {
        lastAttemptAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        lastSuccessAt: null,
        lastCompletedAt: null,
        failureCount: 0,
        lastError: null,
      },
    );

    expect(
      worker.getStatus(NOW).cadences["google_calendar:primary:24h"].nextRunAt,
    ).toBe(NOW.toISOString());
  });

  it("active-hours: malformed window (start >= end) falls back to the default 4–24", () => {
    writeRuntimeState(db, "delegatedSync", {
      activeStartHour: 20,
      activeEndHour: 8,
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(worker.getStatus(NOW).activeHours).toEqual({ startHour: 4, endHour: 24 });
  });

  it("getStatus reports each cadence's catalog metadata + enabled flag", () => {
    writeRuntimeState(db, "delegatedSync", {
      cadenceEnabled: { "google_calendar:primary:24h": true },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [CALENDAR_24H_CADENCE],
    });
    const row = worker.getStatus(NOW).cadences["google_calendar:primary:24h"];
    expect(row.enabled).toBe(true);
    expect(row.displayName).toBe("Calendar — day-ahead (next 24 h)");
    expect(row.defaultIntervalSeconds).toBe(60 * 60);
    expect(row.softFloorSeconds).toBe(30 * 60);
  });

  // `getStatus` surfaces the integration's mode + the backend the
  // worker would invoke. Native rows show `mode='native'` for dashboard
  // visibility but `backend=null` because the worker never invokes for
  // them — observations come from the in-turn `routine.fetch_window`
  // pre-pass instead.
  it("getStatus surfaces the resolved mode + backend per cadence", () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [
        CALENDAR_24H_CADENCE,
        __delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE,
      ],
    });
    const status = worker.getStatus(NOW);
    expect(status.cadences["google_calendar:primary:24h"].mode).toBe("native");
    expect(status.cadences["google_calendar:primary:24h"].backend).toBeNull();
    expect(status.cadences["gmail:inbox:7d"].mode).toBe("delegated");
    expect(status.cadences["gmail:inbox:7d"].backend).toBe("claude");
  });

  it("getStatus reports a null mode/backend when the integration is direct/disabled", () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "disabled",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      } as IntegrationState,
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [CALENDAR_24H_CADENCE],
    });
    const row = worker.getStatus(NOW).cadences["google_calendar:primary:24h"];
    expect(row.mode).toBeNull();
    expect(row.backend).toBeNull();
  });
});

// ── runCadenceNow (Run Now button) ────────────────────────────────────────

describe("DelegatedSyncWorker.runCadenceNow", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("runs the cadence regardless of cadenceEnabled, due time, or active hours", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    // No cadenceEnabled, narrow active-hours that exclude `now`, no
    // intervals — Run Now should still fire exactly once.
    writeRuntimeState(db, "delegatedSync", {
      activeStartHour: 9,
      activeEndHour: 17,
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date("2026-04-29T03:00:00.000Z"),
      cadences: [TEST_CADENCE],
    });

    const result = await worker.runCadenceNow("google_calendar:primary:24h");
    expect(result).toEqual({ ok: true });
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects with unknown_cadence for an unrecognised id", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(await worker.runCadenceNow("not:a:cadence")).toEqual({
      ok: false,
      error: "unknown_cadence",
    });
  });

  it("rejects with integration_not_synchronizable when the integration is in direct mode", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      } as IntegrationState,
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    // `integration_not_synchronizable` covers every mode the worker
    // does not run for: `direct`, `disabled`, `native`, and a malformed
    // delegated row with no `delegatedBackend`.
    expect(await worker.runCadenceNow("google_calendar:primary:24h")).toEqual({
      ok: false,
      error: "integration_not_synchronizable",
    });
  });

  it("rejects with integration_disabled when the master switch is off", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        delegatedSyncEnabled: false,
        lastChangedAt: NOW.toISOString(),
      },
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker: makeInvoker(async () => okResult({ events: [] })),
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    expect(await worker.runCadenceNow("google_calendar:primary:24h")).toEqual({
      ok: false,
      error: "integration_disabled",
    });
  });

  it("rejects with tick_in_progress when a scheduled tick is mid-flight", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    let resolveInvoke!: (result: InvokeResult) => void;
    const pendingInvoke = new Promise<InvokeResult>((resolve) => {
      resolveInvoke = resolve;
    });
    const invoker = makeInvoker(async () => pendingInvoke);
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });

    const inflight = worker.tick({ force: true });
    // Yield once so tick() can grab the mutex before runCadenceNow asks.
    await Promise.resolve();
    expect(await worker.runCadenceNow("google_calendar:primary:24h")).toEqual({
      ok: false,
      error: "tick_in_progress",
    });

    resolveInvoke(okResult({ events: [] }));
    await inflight;
  });

  // Run Now on a native row rejects with `integration_not_synchronizable`
  // — the cadence worker has no role in native mode (appendix §"Polling,
  // observers, and the activity-scan threshold"). The dashboard renders
  // this as an inert chip; the user must rely on the in-turn
  // `routine.fetch_window` pre-pass for native observations.
  it("rejects native rows with integration_not_synchronizable", async () => {
    writeIntegrations(db, {
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async () => okResult({ events: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [TEST_CADENCE],
    });
    const result = await worker.runCadenceNow("google_calendar:primary:24h");
    expect(result).toEqual({ ok: false, error: "integration_not_synchronizable" });
    expect(invoker.invoke).not.toHaveBeenCalled();
  });
});

// ── runDisabledCadencesForActivityScan (activity-scan-driven refresh) ───────

describe("DelegatedSyncWorker.runDisabledCadencesForActivityScan", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("fires opted-OUT cadences once even outside active hours", async () => {
    // Mirrors the production scenario: gmail / notion delegated, every
    // cadence left default-OFF, cadence-side active hours [9, 17) — but
    // the activity scan fired at 03:00, which proves the activity-scan-
    // driven refresh ignores cadence active-hours.
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    writeRuntimeState(db, "delegatedSync", {
      activeStartHour: 9,
      activeEndHour: 17,
      // No cadenceEnabled key for gmail:inbox:7d → opted-OUT.
    });
    const invoker = makeInvoker(async () => okResult({ threads: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => new Date("2026-04-29T03:00:00.000Z"),
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("skips opted-IN cadences (the worker's own timer covers them)", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    writeRuntimeState(db, "delegatedSync", {
      cadenceEnabled: { "gmail:inbox:7d": true },
    });
    const invoker = makeInvoker(async () => okResult({ threads: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      timezone: "UTC",
      now: () => NOW,
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("skips integrations not in delegated mode", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      } as IntegrationState,
    });
    const invoker = makeInvoker(async () => okResult({ threads: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("honours the integration master switch (delegatedSyncEnabled=false)", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        delegatedSyncEnabled: false,
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async () => okResult({ threads: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  // Regression for the bug where every activity scan produced a failed
  // `integration_drift_sync` audit row for native integrations: the
  // pre-fix code resolved a native backend through `backendForCadence`
  // and then `DelegatedBackendInvoker.resolvePreconditions` rejected it
  // ("native MUST NOT call the daemon proxy", appendix §3.3). Native
  // observations come from the in-turn `routine.fetch_window` pre-pass,
  // not from this worker.
  it("skips native integrations entirely (no invoker call, no audit row)", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async () => okResult({ threads: [] }));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).not.toHaveBeenCalled();
    const auditRows = db
      .prepare("SELECT result, error FROM agent_actions WHERE action_type = 'delegated_sync'")
      .all();
    expect(auditRows).toEqual([]);
  });

  it("skips a mixed mode loop's native rows but still runs delegated ones", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async (params) =>
      params.integrationKey === "notion"
        ? okResult({ results: [] })
        : okResult({ threads: [] }),
    );
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [
        __delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE,
        __delegatedSyncWorkerTestExports.NOTION_RECENTLY_UPDATED_CADENCE,
      ],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    const call = (invoker.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.integrationKey).toBe("notion");
  });

  it("runs multiple disabled cadences in parallel", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
      notion: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    let inflight = 0;
    let maxInflight = 0;
    const invoker = makeInvoker(async (params) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // Yield so the second cadence can also enter.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight -= 1;
      return params.integrationKey === "gmail"
        ? okResult({ threads: [] })
        : okResult({ results: [] });
    });
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [
        __delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE,
        __delegatedSyncWorkerTestExports.NOTION_RECENTLY_UPDATED_CADENCE,
      ],
    });

    await worker.runDisabledCadencesForActivityScan();

    expect(invoker.invoke).toHaveBeenCalledTimes(2);
    expect(maxInflight).toBe(2);
  });

  it("returns silently when a regular tick is already mid-flight", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    let resolveInvoke!: (r: InvokeResult) => void;
    const pendingInvoke = new Promise<InvokeResult>((resolve) => {
      resolveInvoke = resolve;
    });
    const invoker = makeInvoker(async () => pendingInvoke);
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    const inflight = worker.tick({ force: true });
    await Promise.resolve(); // Yield so tick() grabs the mutex.

    await worker.runDisabledCadencesForActivityScan();

    // Only the first invoke (from tick) should have fired; the activity-scan
    // refresh saw `tickRunning=true` and bailed.
    expect(invoker.invoke).toHaveBeenCalledTimes(1);

    resolveInvoke(okResult({ threads: [] }));
    await inflight;
  });

  it("does not throw when a cadence fails — failureCount is recorded instead", async () => {
    writeIntegrations(db, {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: NOW.toISOString(),
      },
    });
    const invoker = makeInvoker(async () => failResult("gmail offline"));
    const worker = new DelegatedSyncWorker({
      db,
      invoker,
      calendarId: "primary",
      now: () => NOW,
      cadences: [__delegatedSyncWorkerTestExports.GMAIL_INBOX_7D_CADENCE],
    });

    await expect(worker.runDisabledCadencesForActivityScan()).resolves.toBeUndefined();
    const status = worker.getStatus(NOW);
    expect(status.cadences["gmail:inbox:7d"].failureCount).toBe(1);
    expect(status.cadences["gmail:inbox:7d"].lastError).toContain("gmail offline");
  });
});
