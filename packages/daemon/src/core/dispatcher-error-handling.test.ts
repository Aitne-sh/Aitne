import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, EventPriority } from "@aitne/shared";
import type { Event, MessageEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { DispatcherErrorRouter } from "./dispatcher-error-handling.js";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
} from "./agent-core.js";
import { BackendRouterHandledError } from "./backends/backend-router.js";
import type { AgentConfig } from "../config.js";
import type {
  IDashboardStream,
  INotificationManager,
  IMessageRecorder,
} from "./dispatcher-types.js";

function fakeConfig(dataDir: string, timezone = "UTC"): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone,
    dayBoundaryHour: 4,
  } as unknown as AgentConfig;
}

function makeRouter(opts: {
  db: Database.Database;
  dataDir: string;
  notificationMgr?: INotificationManager;
  messageRecorder?: IMessageRecorder;
  dashboardStream?: IDashboardStream | null;
  isShutdown?: () => boolean;
  notifiedEvents?: Set<string>;
  shutdownAwaiters?: Set<() => void>;
  onRetemplateFinalize?: (e: Event, opts: { errored: boolean }) => void;
  onManagementScanFinalize?: (e: Event, opts: { errored: boolean }) => void;
  timezone?: string;
}): {
  router: DispatcherErrorRouter;
  notifiedEvents: Set<string>;
  shutdownAwaiters: Set<() => void>;
  notificationMgr: INotificationManager;
  messageRecorder: IMessageRecorder;
  dashboardStream: IDashboardStream | null;
} {
  const notifiedEvents = opts.notifiedEvents ?? new Set<string>();
  const shutdownAwaiters = opts.shutdownAwaiters ?? new Set<() => void>();
  const notificationMgr =
    opts.notificationMgr ?? ({
      send: vi.fn().mockResolvedValue(undefined),
      beginReplyActivity: vi.fn(),
    } as unknown as INotificationManager);
  const messageRecorder =
    opts.messageRecorder ?? ({
      recordMessage: vi.fn().mockReturnValue(true),
    } as unknown as IMessageRecorder);
  const dashboardStream =
    opts.dashboardStream === undefined
      ? ({ sendStreamChunk: vi.fn(), sendStreamEnd: vi.fn(), sendError: vi.fn() } as unknown as IDashboardStream)
      : opts.dashboardStream;
  const router = new DispatcherErrorRouter({
    db: opts.db,
    config: fakeConfig(opts.dataDir, opts.timezone ?? "UTC"),
    notificationMgr,
    messageRecorder,
    notifiedEvents,
    shutdownAwaiters,
    getDashboardStream: () => dashboardStream,
    isShutdown: opts.isShutdown ?? (() => false),
    onRetemplateFinalize: opts.onRetemplateFinalize ?? (() => {}),
    onManagementScanFinalize: opts.onManagementScanFinalize ?? (() => {}),
  });
  return {
    router,
    notifiedEvents,
    shutdownAwaiters,
    notificationMgr,
    messageRecorder,
    dashboardStream,
  };
}

function makeMessageEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    ...createEvent({
      type: "message.received",
      source: "dashboard",
      priority: EventPriority.HIGH,
    }),
    sender: "user",
    channel: "ch-1",
    content: "hi",
    platform: "dashboard",
    threadId: null,
    isDm: true,
    isMention: false,
    ...overrides,
  };
}

describe("DispatcherErrorRouter — isRetryable", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns false for BackendQuotaError", () => {
    const { router } = makeRouter({ db, dataDir });
    const err = new BackendQuotaError("claude", "rate_limit", null, "limit");
    expect(router.isRetryable(err)).toBe(false);
  });

  it("returns false for BackendDecisiveFailure", () => {
    const { router } = makeRouter({ db, dataDir });
    const err = new BackendDecisiveFailure("claude", "auth", new Error("auth failed"));
    expect(router.isRetryable(err)).toBe(false);
  });

  it("returns false for BackendRouterHandledError", () => {
    const { router } = makeRouter({ db, dataDir });
    const cause = new BackendDecisiveFailure("claude", "other_non_retryable", new Error("boom"));
    const err = new BackendRouterHandledError("router handled", cause, cause);
    expect(router.isRetryable(err)).toBe(false);
  });

  it("returns true for raw 5xx HTTP errors", () => {
    const { router } = makeRouter({ db, dataDir });
    expect(router.isRetryable({ status: 500, message: "server" })).toBe(true);
    expect(router.isRetryable({ status: 503 })).toBe(true);
  });

  it("returns false for 4xx and missing status", () => {
    const { router } = makeRouter({ db, dataDir });
    expect(router.isRetryable({ status: 404 })).toBe(false);
    expect(router.isRetryable(new Error("no status"))).toBe(false);
    expect(router.isRetryable(null)).toBe(false);
  });
});

describe("DispatcherErrorRouter — extractQuotaError", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the quota error directly when given one", () => {
    const { router } = makeRouter({ db, dataDir });
    const q = new BackendQuotaError("claude", "rate_limit", null, "lim");
    expect(router.extractQuotaError(q)).toBe(q);
  });

  it("unwraps a quota error inside a BackendDecisiveFailure of kind=quota", () => {
    const { router } = makeRouter({ db, dataDir });
    const q = new BackendQuotaError("codex", "rate_limit", null, "lim");
    const wrapped = new BackendDecisiveFailure("codex", "quota", q);
    expect(router.extractQuotaError(wrapped)).toBe(q);
  });

  it("returns null when given an unrelated error", () => {
    const { router } = makeRouter({ db, dataDir });
    expect(router.extractQuotaError(new Error("nope"))).toBeNull();
    expect(router.extractQuotaError(null)).toBeNull();
  });
});

describe("DispatcherErrorRouter — formatBackendLabel + formatQuotaMessage", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("renders friendly labels for known backends", () => {
    const { router } = makeRouter({ db, dataDir });
    expect(router.formatBackendLabel("claude")).toBe("Claude Code");
    expect(router.formatBackendLabel("codex")).toBe("Codex");
    expect(router.formatBackendLabel("gemini")).toBe("Gemini CLI");
    expect(router.formatBackendLabel("opencode")).toBe("OpenCode");
  });

  it("formats max-budget errors as a per-turn budget hint", () => {
    const { router } = makeRouter({ db, dataDir });
    const q = new BackendQuotaError("claude", "max_budget_usd", null, "budget");
    const msg = router.formatQuotaMessage(q);
    expect(msg).toContain("Claude Code");
    expect(msg).toContain("per-turn budget limit");
  });

  it("falls back to a generic message when no resetHint is present", () => {
    const { router } = makeRouter({ db, dataDir });
    const q = new BackendQuotaError("claude", "rate_limit", null, "limit");
    expect(router.formatQuotaMessage(q)).toBe(
      "Claude Code has reached its usage limit. Please wait and try again later.",
    );
  });

  it("renders a friendly reset message when resetHint resolves", () => {
    const { router } = makeRouter({ db, dataDir });
    const q = new BackendQuotaError(
      "claude",
      "rate_limit",
      { hour: 0, minute: 0, rawLabel: "midnight UTC", timeZone: "UTC" },
      "limit",
    );
    const msg = router.formatQuotaMessage(q);
    expect(msg).toContain("Claude Code has reached its usage limit");
    expect(msg).toContain("Resets at");
    expect(msg).toContain("(UTC)");
  });

  it("falls back to rawLabel when the timezone is invalid", () => {
    const { router } = makeRouter({ db, dataDir });
    const q = new BackendQuotaError(
      "claude",
      "rate_limit",
      { hour: 0, minute: 0, rawLabel: "tomorrow", timeZone: "Not/A_Zone" },
      "limit",
    );
    const msg = router.formatQuotaMessage(q);
    expect(msg).toContain("tomorrow");
  });
});

describe("DispatcherErrorRouter — handleError", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("removes the event from notifiedEvents on entry", async () => {
    const event = makeMessageEvent();
    const notifiedEvents = new Set<string>([event.correlationId]);
    const { router } = makeRouter({ db, dataDir, notifiedEvents });
    await router.handleError(event, new Error("boom"));
    expect(notifiedEvents.has(event.correlationId)).toBe(false);
  });

  it("sends a quota DM and notifies the dashboard for a quota error on a message event", async () => {
    const event = makeMessageEvent();
    const sendError = vi.fn();
    const dashboard: IDashboardStream = {
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendError,
    };
    const { router, notificationMgr } = makeRouter({ db, dataDir, dashboardStream: dashboard });
    const quota = new BackendQuotaError("claude", "rate_limit", null, "limit");
    await router.handleError(event, quota);
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(notificationMgr.send).toHaveBeenCalledTimes(1);
  });

  it("does not double-notify when the router already handled the failure", async () => {
    const event = makeMessageEvent();
    const cause = new BackendQuotaError("claude", "rate_limit", null, "limit");
    const handled = new BackendRouterHandledError("router handled", cause, cause);
    const sendError = vi.fn();
    const dashboard: IDashboardStream = {
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendError,
    };
    const { router, notificationMgr } = makeRouter({ db, dataDir, dashboardStream: dashboard });
    await router.handleError(event, handled);
    // Inline dashboard sendError still fires; outbound notificationMgr.send does NOT,
    // because the router already surfaced the failure to the user.
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(notificationMgr.send).not.toHaveBeenCalled();
  });

  it("records post-hoc budget spend to agent_actions when a quota error carries usage data", async () => {
    const event = makeMessageEvent();
    const { router } = makeRouter({ db, dataDir });
    const quota = new BackendQuotaError(
      "codex",
      "max_budget_usd",
      null,
      "Codex estimated cost $2.2627 exceeded the per-turn budget limit $1.00 for gpt-5.4.",
      {
        usage: {
          inputTokens: 60_000,
          outputTokens: 25_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        costUsd: 2.2627,
        modelId: "gpt-5.4",
        numTurns: 12,
        durationMs: 514_000,
        costSource: "litellm",
      },
    );
    await router.handleError(event, quota);
    const row = db
      .prepare(
        `SELECT result, backend, model_used, cost_usd, tokens_input, tokens_output, num_turns, duration_ms, error
         FROM agent_actions
         WHERE event_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(event.correlationId) as {
        result: string;
        backend: string;
        model_used: string;
        cost_usd: number;
        tokens_input: number;
        tokens_output: number;
        num_turns: number;
        duration_ms: number;
        error: string;
      } | undefined;
    expect(row).toBeDefined();
    expect(row?.result).toBe("failed");
    expect(row?.backend).toBe("codex");
    expect(row?.model_used).toBe("gpt-5.4");
    expect(row?.cost_usd).toBeCloseTo(2.2627, 4);
    expect(row?.tokens_input).toBe(60_000);
    expect(row?.tokens_output).toBe(25_000);
    expect(row?.num_turns).toBe(12);
    expect(row?.error).toContain("per-turn budget limit");
  });

  it("does not record an agent_actions row for quota errors without spend data", async () => {
    const event = makeMessageEvent();
    const { router } = makeRouter({ db, dataDir });
    const quota = new BackendQuotaError("claude", "rate_limit", null, "limit");
    await router.handleError(event, quota);
    const cnt = (db
      .prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE event_id = ?")
      .get(event.correlationId) as { n: number }).n;
    expect(cnt).toBe(0);
  });

  it("invokes the retemplate + management-scan finalize callbacks for scheduled events", async () => {
    const onRetemplateFinalize = vi.fn();
    const onManagementScanFinalize = vi.fn();
    const { router } = makeRouter({
      db,
      dataDir,
      onRetemplateFinalize,
      onManagementScanFinalize,
    });
    const scheduledEvent = {
      ...createEvent({ type: "scheduled.task", source: "wake", priority: EventPriority.NORMAL }),
      scheduleId: 7,
      taskType: "x",
      taskContext: {},
    } as unknown as Event;
    await router.handleError(scheduledEvent, new Error("boom"));
    expect(onRetemplateFinalize).toHaveBeenCalledWith(scheduledEvent, { errored: true });
    expect(onManagementScanFinalize).toHaveBeenCalledWith(scheduledEvent, { errored: true });
  });
});

describe("DispatcherErrorRouter — notifyDashboardError", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("forwards to the dashboard stream for dashboard-platform message events", () => {
    const sendError = vi.fn();
    const dashboard: IDashboardStream = {
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendError,
    };
    const { router } = makeRouter({ db, dataDir, dashboardStream: dashboard });
    router.notifyDashboardError(makeMessageEvent({ channel: "ch-x" }), "oops");
    expect(sendError).toHaveBeenCalledWith("ch-x", "oops");
  });

  it("does nothing for non-dashboard platforms", () => {
    const sendError = vi.fn();
    const dashboard: IDashboardStream = {
      sendStreamChunk: vi.fn(),
      sendStreamEnd: vi.fn(),
      sendError,
    };
    const { router } = makeRouter({ db, dataDir, dashboardStream: dashboard });
    router.notifyDashboardError(makeMessageEvent({ platform: "slack" }), "oops");
    expect(sendError).not.toHaveBeenCalled();
  });

  it("is a no-op when the dashboard stream is unwired", () => {
    const { router } = makeRouter({ db, dataDir, dashboardStream: null });
    expect(() =>
      router.notifyDashboardError(makeMessageEvent(), "oops"),
    ).not.toThrow();
  });
});

describe("DispatcherErrorRouter — executeWithRetry", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    // Stub setTimeout so the 5-min retry sleep resolves immediately.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the fn result on the first try when no error is thrown", async () => {
    const { router } = makeRouter({ db, dataDir });
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = router.executeWithRetry(fn, makeMessageEvent());
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 5xx error and returns the second-try result", async () => {
    const { router } = makeRouter({ db, dataDir });
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 500, message: "transient" })
      .mockResolvedValueOnce("recovered");
    const promise = router.executeWithRetry(fn, makeMessageEvent());
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a quota error", async () => {
    const { router } = makeRouter({ db, dataDir });
    const quota = new BackendQuotaError("claude", "rate_limit", null, "limit");
    const fn = vi.fn().mockRejectedValue(quota);
    const promise = router.executeWithRetry(fn, makeMessageEvent());
    promise.catch(() => {}); // suppress unhandled rejection
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(quota);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("DispatcherErrorRouter — consultDelegatedConnectorWarnings", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-err-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns [] when no delegated probe rows exist", () => {
    const { router } = makeRouter({ db, dataDir });
    expect(router.consultDelegatedConnectorWarnings("claude")).toEqual([]);
  });
});
