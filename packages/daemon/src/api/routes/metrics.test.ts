import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
  MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
  MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT,
} from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  recordActivityViewRebuildDuration,
  recordEntityMirrorLag,
  recordManagementMdRenderDuration,
  resetManagementTelemetry,
} from "../../core/management-telemetry.js";
import { AuthTelemetry } from "../../core/backends/auth-telemetry.js";
import { createMetricsRoutes } from "./metrics.js";
import type { ApiDependencies } from "../server.js";

/**
 * P8 — `/metrics/managed-tasks` route integration test.
 *
 * The route is a thin shim over `MetricsCollector.collectManagementMetrics`
 * (covered separately in `core/metrics.test.ts`). These tests focus on
 * the route layer: query-param parsing, default-tunable plumbing, and
 * end-to-end JSON shape.
 */

function makeDeps(db: Database.Database): ApiDependencies {
  return {
    db,
    config: {
      timezone: "UTC",
      dayBoundaryHour: 0,
    },
  } as unknown as ApiDependencies;
}

function insertManagedTask(
  db: Database.Database,
  id: string,
  overrides: Partial<{
    app: string;
    consecutiveFailures: number;
  }> = {},
): void {
  const app = overrides.app ?? "zoom";
  const failures = overrides.consecutiveFailures ?? 0;
  const scheduleId = Number(id.replace(/^mt_/, ""));
  db.prepare(
    `INSERT INTO recurring_schedules (id, task_type, recurrence_rule, task_description, created_at, updated_at)
     VALUES (?, 'scheduled.task', ?, ?, datetime('now'), datetime('now'))`,
  ).run(scheduleId, "FREQ=DAILY;BYHOUR=10;BYMINUTE=0", `mt:${id}`);
  db.prepare(
    `INSERT INTO managed_tasks
       (id, intent, app, app_normalized, cadence, schedule_id,
        consecutive_failures, created_at, updated_at)
     VALUES (?, 'test', ?, ?, 'daily', ?, ?, datetime('now'), datetime('now'))`,
  ).run(id, app, app.toLowerCase(), scheduleId, failures);
}

describe("GET /metrics/managed-tasks", () => {
  let db: Database.Database;

  beforeEach(() => {
    resetManagementTelemetry();
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    resetManagementTelemetry();
  });

  it("returns the §14.3 metric envelope on a fresh DB", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/managed-tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      windowDays: 30,
      active: 0,
      failingNow: 0,
      softWarningThreshold: MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
      hardCap: MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT,
      failureNotifyThreshold: MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
      runs: { ok: 0, failed: 0, skipped: 0, unknown: 0 },
      consecutiveFailures: [],
      activityViewRebuildMs: [],
      entityMirrorLag: { lastMs: null, observedAt: null },
    });
    // collectedAt is an ISO timestamp — assert shape, not exact value.
    expect(typeof body.collectedAt).toBe("string");
    expect((body.managementMdRenderMs as { count: number }).count).toBe(0);
  });

  it("threads telemetry samples into the response", async () => {
    recordManagementMdRenderDuration(12);
    recordManagementMdRenderDuration(48);
    recordActivityViewRebuildDuration("zoom", 80);
    recordEntityMirrorLag(150, new Date("2026-05-03T12:00:00.000Z"));

    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/managed-tasks");
    const body = (await res.json()) as {
      managementMdRenderMs: { count: number; avg: number };
      activityViewRebuildMs: { source: string; histogram: { count: number } }[];
      entityMirrorLag: { lastMs: number | null; observedAt: string | null };
    };

    expect(body.managementMdRenderMs.count).toBe(2);
    expect(body.managementMdRenderMs.avg).toBe(30);
    expect(body.activityViewRebuildMs).toHaveLength(1);
    expect(body.activityViewRebuildMs[0]?.source).toBe("zoom");
    expect(body.activityViewRebuildMs[0]?.histogram.count).toBe(1);
    expect(body.entityMirrorLag).toEqual({
      lastMs: 150,
      observedAt: "2026-05-03T12:00:00.000Z",
    });
  });

  it("counts active tasks and per-mt_id consecutive-failure buckets", async () => {
    insertManagedTask(db, "mt_1", { consecutiveFailures: 0 });
    insertManagedTask(db, "mt_2", {
      app: "gmail",
      consecutiveFailures: 4,
    });

    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/managed-tasks");
    const body = (await res.json()) as {
      active: number;
      failingNow: number;
      consecutiveFailures: { mtId: string; app: string; count: number }[];
    };

    expect(body.active).toBe(2);
    expect(body.failingNow).toBe(1);
    expect(body.consecutiveFailures).toEqual([
      { mtId: "mt_2", app: "gmail", count: 4 },
    ]);
  });

  it("clamps the days query parameter to [1, 90]", async () => {
    const app = createMetricsRoutes(makeDeps(db));

    let res = await app.request("/metrics/managed-tasks?days=0");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(1);

    res = await app.request("/metrics/managed-tasks?days=1000");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(90);

    res = await app.request("/metrics/managed-tasks?days=invalid");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(30);

    res = await app.request("/metrics/managed-tasks?days=14");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(14);
  });

  it("mirrors config.managementMaxActiveTasks into hardCap", async () => {
    const deps = makeDeps(db);
    (deps.config as Record<string, unknown>).managementMaxActiveTasks = 25;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/managed-tasks");
    const body = (await res.json()) as { hardCap: number };
    // Operator-configured cap takes precedence over the shared default
    // so the dashboard reflects the same number that 409s a register.
    expect(body.hardCap).toBe(25);
  });

  it("falls back to the shared default when config override is invalid", async () => {
    const deps = makeDeps(db);
    (deps.config as Record<string, unknown>).managementMaxActiveTasks = 0;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/managed-tasks");
    const body = (await res.json()) as { hardCap: number };
    expect(body.hardCap).toBe(MANAGEMENT_MAX_ACTIVE_TASKS_DEFAULT);
  });
});

describe("GET /metrics", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    resetManagementTelemetry();
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    resetManagementTelemetry();
    vi.useRealTimers();
  });

  it("returns 200 with a stats envelope from collect()", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The full collect() response includes at least these keys
    expect(typeof body).toBe("object");
    // Various fields from the collector — confirm it is not empty
    expect(body).toBeDefined();
  });
});

describe("GET /metrics/timeseries", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("defaults to 30 days when no param supplied", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/timeseries");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(30);
  });

  it("clamps days=0 to 0 (min 0 for timeseries)", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/timeseries?days=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(0);
  });

  it("clamps days=9999 to 90", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/timeseries?days=9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(90);
  });

  it("defaults to 30 when days=invalid", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/timeseries?days=invalid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(30);
  });

  it("returns 14 when days=14", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/timeseries?days=14");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(14);
  });
});

describe("GET /metrics/auth", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("returns 503 when authTelemetry is undefined", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/auth");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_telemetry_unavailable");
  });

  it("returns 200 with telemetry snapshot when authTelemetry is provided", async () => {
    const telemetry = new AuthTelemetry(db);
    telemetry.recordProbeResult("claude", "ok");
    const deps = { ...makeDeps(db), authTelemetry: telemetry } as unknown as ApiDependencies;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/auth");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hours: number;
      counters: Record<string, unknown>;
      bySource: Record<string, unknown>;
    };
    expect(body.hours).toBe(72);
    expect(typeof body.counters).toBe("object");
    expect(typeof body.bySource).toBe("object");
  });

  it("clamps hours=0 to 1", async () => {
    const telemetry = new AuthTelemetry(db);
    const deps = { ...makeDeps(db), authTelemetry: telemetry } as unknown as ApiDependencies;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/auth?hours=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hours: number };
    expect(body.hours).toBe(1);
  });

  it("clamps hours=9999 to 720", async () => {
    const telemetry = new AuthTelemetry(db);
    const deps = { ...makeDeps(db), authTelemetry: telemetry } as unknown as ApiDependencies;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/auth?hours=9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hours: number };
    expect(body.hours).toBe(720);
  });

  it("defaults to 72 when hours=invalid", async () => {
    const telemetry = new AuthTelemetry(db);
    const deps = { ...makeDeps(db), authTelemetry: telemetry } as unknown as ApiDependencies;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/auth?hours=invalid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hours: number };
    expect(body.hours).toBe(72);
  });

  it("uses 48 when hours=48", async () => {
    const telemetry = new AuthTelemetry(db);
    const deps = { ...makeDeps(db), authTelemetry: telemetry } as unknown as ApiDependencies;
    const app = createMetricsRoutes(deps);
    const res = await app.request("/metrics/auth?hours=48");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hours: number };
    expect(body.hours).toBe(48);
  });
});

describe("GET /metrics/delegated-task", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("clamps days=0 to 1", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/delegated-task?days=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(1);
  });

  it("clamps days=9999 to 90", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/delegated-task?days=9999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(90);
  });

  it("defaults to 30 when days=invalid", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/delegated-task?days=invalid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(30);
  });

  it("uses 14 when days=14", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/delegated-task?days=14");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(14);
  });

  it("returns default 30 when no param supplied", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/delegated-task");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowDays: number };
    expect(body.windowDays).toBe(30);
  });
});

// docs/design/appendices/pre-pass-fan-out.md §7.3 — `/metrics/pre-pass` route
// integration test. The aggregation kernel is covered in
// `core/metrics.test.ts`; these tests focus on the route layer
// (query-param plumbing, JSON envelope shape, end-to-end smoke).
describe("GET /metrics/pre-pass", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertPrePassRow(
    detail: Record<string, unknown>,
    opts: {
      costUsd?: number;
      durationMs?: number;
      backend?: string;
      tokensInput?: number;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         'routine.fetch_window', 'autonomous', 'claude-haiku-4-5',
         @cost_usd, @tokens_input, 0, 0, 0,
         @duration_ms, 1, 'success', @detail,
         datetime('now'), datetime('now'), NULL, @backend, 'sdk'
       )`,
    ).run({
      cost_usd: opts.costUsd ?? 0.05,
      duration_ms: opts.durationMs ?? 1000,
      tokens_input: opts.tokensInput ?? 0,
      detail: JSON.stringify({ prePass: detail }),
      backend: opts.backend ?? "claude",
    });
  }

  it("returns the §7.3 envelope on a fresh DB", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/pre-pass");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      windowDays: 30,
      totalChains: 0,
      totalAttempts: 0,
      chainsByStatus: [],
      attemptsPerChain: [],
      costUsdByRoutine: [],
      durationMsByIntegration: [],
      fallbacks: [],
      // docs/design/appendices/fetch-window-cost-reduction.md §10.1 Phase 1.5 — the
      // per-backend buckets must be present (as empty arrays) in the
      // envelope so dashboard consumers can iterate without a null
      // guard. The cache_create / cache_read histograms must also
      // surface their zero-count shape.
      inputTokensByBackend: [],
      costUsdByBackend: [],
    });
    expect(typeof body.collectedAt).toBe("string");
    expect(body.cacheCreationTokensPerAttempt).toMatchObject({ count: 0, p50: null });
    expect(body.cacheReadTokensPerAttempt).toMatchObject({ count: 0, p50: null });
  });

  it("aggregates seeded fan-out rows into chain-level counts", async () => {
    insertPrePassRow({
      parentCorrelationId: "p1",
      parentRoutine: "routine.morning_routine",
      integrationKey: "gmail",
      attempt: 1,
      maxAttempts: 1,
      retriedFromAttempt: null,
      status: "success",
      fetched: 5,
      posted: 5,
      duplicates: 0,
      errors: [],
      willRetry: false,
      retryReason: "success",
      requestedBackend: "claude",
    });
    insertPrePassRow({
      parentCorrelationId: "p1",
      parentRoutine: "routine.morning_routine",
      integrationKey: "google_calendar",
      attempt: 1,
      maxAttempts: 1,
      retriedFromAttempt: null,
      status: "failed",
      fetched: 0,
      posted: 0,
      duplicates: 0,
      errors: [],
      willRetry: false,
      retryReason: "max-attempts-reached",
      fallbackTriggered: true,
      requestedBackend: "claude",
    }, { backend: "codex" });

    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/pre-pass");
    const body = (await res.json()) as {
      totalChains: number;
      chainsByStatus: { routine: string; integrationKey: string; status: string; count: number }[];
      fallbacks: { routine: string; requestedBackend: string; actualBackend: string; count: number }[];
    };
    expect(body.totalChains).toBe(2);
    expect(body.chainsByStatus).toEqual([
      { routine: "routine.morning_routine", integrationKey: "gmail", status: "success", count: 1 },
      { routine: "routine.morning_routine", integrationKey: "google_calendar", status: "failed", count: 1 },
    ]);
    expect(body.fallbacks).toEqual([
      { routine: "routine.morning_routine", requestedBackend: "claude", actualBackend: "codex", count: 1 },
    ]);
  });

  // docs/design/appendices/fetch-window-cost-reduction.md §10.1 Phase 1.5 — the
  // per-backend buckets are the dashboard's verification surface for
  // CLI-backend savings. The route must serialize them with
  // backend-keyed buckets sorted alphabetically so consumers can
  // iterate deterministically.
  it("surfaces inputTokensByBackend / costUsdByBackend per-backend buckets via the route", async () => {
    insertPrePassRow(
      {
        parentCorrelationId: "p1",
        parentRoutine: "routine.morning_routine",
        integrationKey: "gmail",
        attempt: 1,
        status: "success",
      },
      { backend: "claude", tokensInput: 30_000, costUsd: 0.13 },
    );
    insertPrePassRow(
      {
        parentCorrelationId: "p2",
        parentRoutine: "routine.activity_scan",
        integrationKey: "gmail",
        attempt: 1,
        status: "success",
      },
      { backend: "codex", tokensInput: 12_000, costUsd: 0.04 },
    );
    insertPrePassRow(
      {
        parentCorrelationId: "p3",
        parentRoutine: "routine.activity_scan",
        integrationKey: "google_calendar",
        attempt: 1,
        status: "success",
      },
      { backend: "gemini", tokensInput: 14_000, costUsd: 0.02 },
    );

    const app = createMetricsRoutes(makeDeps(db));
    const res = await app.request("/metrics/pre-pass");
    const body = (await res.json()) as {
      inputTokensByBackend: { actualBackend: string; histogram: { sum: number; count: number } }[];
      costUsdByBackend: { actualBackend: string; histogram: { sum: number; count: number } }[];
    };
    expect(body.inputTokensByBackend.map((b) => b.actualBackend)).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);
    expect(body.inputTokensByBackend.find((b) => b.actualBackend === "codex")?.histogram.sum)
      .toBe(12_000);
    expect(body.costUsdByBackend.find((b) => b.actualBackend === "gemini")?.histogram.sum)
      .toBeCloseTo(0.02, 5);
  });

  it("clamps the days query parameter to [1, 90]", async () => {
    const app = createMetricsRoutes(makeDeps(db));
    let res = await app.request("/metrics/pre-pass?days=0");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(1);
    res = await app.request("/metrics/pre-pass?days=1000");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(90);
    res = await app.request("/metrics/pre-pass?days=invalid");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(30);
    res = await app.request("/metrics/pre-pass?days=7");
    expect(((await res.json()) as { windowDays: number }).windowDays).toBe(7);
  });
});
