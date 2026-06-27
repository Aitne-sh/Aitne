import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../db/schema.js";
import {
  createBackgroundTask,
  getBackgroundTask,
  markRunning,
  markAwaitingUser,
  markTerminal,
  setBackendSessionId,
} from "../../db/background-task-store.js";
import { createClarification } from "../../db/background-task-clarifications-store.js";
import type { DriverRunResult } from "./background-task-driver.js";

// ── Driver module mock — lets each test dictate the driver outcome (and
//    simulate the worker's finish/ask_user store writes) without an SDK. ──
const runDriverImpl = vi.fn<(db: Database.Database, taskId: string) => Promise<DriverRunResult>>();
const resumeDriverImpl = vi.fn<(db: Database.Database, taskId: string) => Promise<DriverRunResult>>();
const resumeFromBootImpl = vi.fn<(db: Database.Database, taskId: string) => Promise<DriverRunResult>>();

vi.mock("./background-task-driver.js", () => ({
  prepareDriverHandle: vi.fn(async () => ({
    ok: true,
    handle: {
      abortController: new AbortController(),
      cwd: "/tmp/bg",
      runtime: {},
      sdkSessionId: "sess-1",
      binding: { modelId: "claude-sonnet-4-6", maxTurns: 40, maxBudgetUsd: 2, executeTimeoutMinutes: 30 },
    },
  })),
  runDriver: vi.fn((deps: { db: Database.Database }, row: { id: string }) =>
    runDriverImpl(deps.db, row.id),
  ),
  resumeDriver: vi.fn((deps: { db: Database.Database }, row: { id: string }) =>
    resumeDriverImpl(deps.db, row.id),
  ),
  resumeFromBootDriver: vi.fn((deps: { db: Database.Database }, row: { id: string }) =>
    resumeFromBootImpl(deps.db, row.id),
  ),
  releaseDriverHandle: vi.fn(async () => {}),
}));

// Imported AFTER the mock is declared (vi.mock is hoisted).
const { createBackgroundTaskRunner, createBackgroundTaskSlotStateRef } = await import(
  "./background-task-runner.js"
);

interface ResultEnqueue {
  taskId: string;
  originatingChannel: string | null;
  title: string;
  draft: string;
  report: string;
}
interface ClarificationEnqueue {
  taskId: string;
  originatingChannel: string | null;
  title: string;
  clarificationId: string;
  question: string;
  contextSummary: string | null;
}

function makeRunner(db: Database.Database) {
  const enqueueResult = vi.fn(async (_input: ResultEnqueue) => {});
  const enqueueClarification = vi.fn(async (_input: ClarificationEnqueue) => {});
  const runner = createBackgroundTaskRunner({
    db,
    slotStateRef: createBackgroundTaskSlotStateRef(3),
    deliveryEnqueuer: { enqueueResult, enqueueClarification },
    driver: { db } as never,
    nowFn: () => 5000,
  });
  return { runner, enqueueResult, enqueueClarification };
}

function seedPending(db: Database.Database, id: string, policy: "always" | "silent" = "always"): void {
  createBackgroundTask(db, {
    id,
    brief: `brief ${id}`,
    title: `title ${id}`,
    notificationPolicy: policy,
    originatingChannel: "slack:C1",
    correlationId: null,
    scheduleRowId: null,
    tier: "medium",
    maxBudgetUsd: null,
    createdAt: 1000,
  });
}

describe("background-task runner — delivery decision", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    runDriverImpl.mockReset();
    resumeDriverImpl.mockReset();
    resumeFromBootImpl.mockReset();
  });

  it("completed + notify=true ⇒ enqueues a result delivery", async () => {
    seedPending(db, "t1");
    runDriverImpl.mockImplementation(async (d, id) => {
      // simulate the finish tool writing the artifact
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 4000, report: "full", draft: "summary", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-1", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeRunner(db);
    const r = await runner.runFromPost("t1");
    expect(r.reason).toBe("completed");
    expect(enqueueResult).toHaveBeenCalledTimes(1);
    expect(enqueueResult.mock.calls[0][0]).toMatchObject({ taskId: "t1", draft: "summary", report: "full" });
  });

  it("completed + notify=false ⇒ files only, no delivery", async () => {
    seedPending(db, "t1", "silent");
    runDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 4000, report: "r", draft: "d", notify: false });
      return { outcome: "completed", sdkSessionId: "sess-1", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeRunner(db);
    await runner.runFromPost("t1");
    expect(enqueueResult).not.toHaveBeenCalled();
    expect(getBackgroundTask(db, "t1")?.state).toBe("completed");
  });

  it("worker death (timeout) ⇒ fail-loud synthesized artifact + notify + delivery", async () => {
    seedPending(db, "t1", "silent"); // even a silent policy notifies on unexpected death
    runDriverImpl.mockResolvedValue({
      outcome: "timeout",
      sdkSessionId: "sess-1",
      detail: "executeTimeoutMinutes=30",
      costUsd: 0,
      numTurns: 5,
      durationMs: 9,
    });
    const { runner, enqueueResult } = makeRunner(db);
    const r = await runner.runFromPost("t1");
    expect(r.reason).toBe("timeout");
    const row = getBackgroundTask(db, "t1");
    expect(row?.state).toBe("timeout");
    expect(row?.notify).toBe(true);
    expect(row?.draft).toContain("couldn't finish");
    expect(enqueueResult).toHaveBeenCalledTimes(1);
  });

  it("yielded_for_clarification ⇒ parks + enqueues the clarification", async () => {
    seedPending(db, "t1");
    runDriverImpl.mockImplementation(async (d, id) => {
      // simulate ask_user: awaiting_user + a clarification row
      d.prepare("UPDATE background_task SET state='awaiting_user' WHERE id=?").run(id);
      createClarification(d, { id: "c1", taskId: id, question: "web or api?", contextSummary: null, askedAt: 3000, ttlMs: 60000 });
      return { outcome: "yielded_for_clarification", sdkSessionId: "sess-1", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueClarification, enqueueResult } = makeRunner(db);
    const r = await runner.runFromPost("t1");
    expect(r.reason).toBe("parked_awaiting_user");
    expect(runner.__peekParkedIds()).toContain("t1");
    expect(enqueueClarification).toHaveBeenCalledTimes(1);
    expect(enqueueClarification.mock.calls[0][0]).toMatchObject({ taskId: "t1", clarificationId: "c1", question: "web or api?" });
    expect(enqueueResult).not.toHaveBeenCalled();
  });

  it("cancel of a parked task ⇒ cancelled, no fail-loud delivery", async () => {
    seedPending(db, "t1");
    runDriverImpl.mockImplementation(async (d, id) => {
      d.prepare("UPDATE background_task SET state='awaiting_user' WHERE id=?").run(id);
      createClarification(d, { id: "c1", taskId: id, question: "q", contextSummary: null, askedAt: 3000, ttlMs: 60000 });
      return { outcome: "yielded_for_clarification", sdkSessionId: "sess-1", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeRunner(db);
    await runner.runFromPost("t1");
    enqueueResult.mockClear();
    const ok = await runner.cancel("t1", "user_cancel");
    expect(ok).toBe(true);
    expect(getBackgroundTask(db, "t1")?.state).toBe("cancelled");
    expect(enqueueResult).not.toHaveBeenCalled();
    expect(runner.__peekParkedIds()).not.toContain("t1");
  });

  it("cancel of a queued (pending) task ⇒ cancelled, removed from the FIFO", async () => {
    // cap = 1: task A parks holding the only slot, task B queues pending.
    const enqueueResult = vi.fn(async (_i: ResultEnqueue) => {});
    const runner = createBackgroundTaskRunner({
      db,
      slotStateRef: createBackgroundTaskSlotStateRef(1),
      deliveryEnqueuer: { enqueueResult, enqueueClarification: vi.fn(async (_i: ClarificationEnqueue) => {}) },
      driver: { db } as never,
      nowFn: () => 5000,
    });
    seedPending(db, "A");
    seedPending(db, "B");
    runDriverImpl.mockImplementation(async (d, id) => {
      d.prepare("UPDATE background_task SET state='awaiting_user' WHERE id=?").run(id);
      createClarification(d, { id: `clar-${id}`, taskId: id, question: "q", contextSummary: null, askedAt: 3000, ttlMs: 60000 });
      return { outcome: "yielded_for_clarification", sdkSessionId: "s", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    await runner.runFromPost("A");
    const bResult = await runner.runFromPost("B");
    expect(bResult.reason).toBe("queued");
    expect(getBackgroundTask(db, "B")?.state).toBe("pending");

    const ok = await runner.cancel("B", "user_cancel");
    expect(ok).toBe(true);
    expect(getBackgroundTask(db, "B")?.state).toBe("cancelled");
    expect(getBackgroundTask(db, "B")?.outcomeDetail).toContain("cancelled_in_queue");
    expect(enqueueResult).not.toHaveBeenCalled();
  });

  it("no driver wired ⇒ fail-loud failed(runner_unavailable) + delivery", async () => {
    seedPending(db, "t1");
    const enqueueResult = vi.fn(async (_input: ResultEnqueue) => {});
    const runner = createBackgroundTaskRunner({
      db,
      slotStateRef: createBackgroundTaskSlotStateRef(3),
      deliveryEnqueuer: {
        enqueueResult,
        enqueueClarification: vi.fn(async (_input: ClarificationEnqueue) => {}),
      },
      nowFn: () => 5000,
    });
    const r = await runner.runFromPost("t1");
    expect(r.reason).toBe("no_driver");
    expect(getBackgroundTask(db, "t1")?.outcomeDetail).toBe("runner_unavailable");
    expect(getBackgroundTask(db, "t1")?.notify).toBe(true);
    expect(enqueueResult).toHaveBeenCalledTimes(1);
  });
});

describe("background-task runner — resume across restart (§10.2 Phase 4)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    runDriverImpl.mockReset();
    resumeDriverImpl.mockReset();
    resumeFromBootImpl.mockReset();
  });

  function makeResumeRunner(db: Database.Database) {
    const enqueueResult = vi.fn(async (_i: ResultEnqueue) => {});
    const runner = createBackgroundTaskRunner({
      db,
      slotStateRef: createBackgroundTaskSlotStateRef(3),
      deliveryEnqueuer: {
        enqueueResult,
        enqueueClarification: vi.fn(async (_i: ClarificationEnqueue) => {}),
      },
      driver: { db } as never,
      resumeAcrossRestart: true,
      nowFn: () => 5000,
    });
    return { runner, enqueueResult };
  }

  /** Put a row in the post-restart 'running' state with a captured session. */
  function seedRunningWithSession(db: Database.Database, id: string): void {
    seedPending(db, id);
    markRunning(db, id, 1100);
    setBackendSessionId(db, id, "sess-prev");
  }

  it("resumes a running task with a captured session via resumeFromBootDriver", async () => {
    seedRunningWithSession(db, "t1");
    resumeFromBootImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 6000, report: "resumed full", draft: "resumed", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-prev", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeResumeRunner(db);
    const r = await runner.resumeFromBoot("t1");
    expect(r.reason).toBe("completed");
    expect(resumeFromBootImpl).toHaveBeenCalledTimes(1);
    expect(runDriverImpl).not.toHaveBeenCalled(); // no fresh re-dispatch
    expect(enqueueResult.mock.calls[0][0]).toMatchObject({ draft: "resumed" });
  });

  it("falls back to re-dispatch-from-brief when the session can't be loaded", async () => {
    seedRunningWithSession(db, "t1");
    resumeFromBootImpl.mockResolvedValue({
      outcome: "resume_unavailable",
      sdkSessionId: "sess-prev",
      detail: "no init",
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
    });
    // the fresh re-dispatch (runDriver) then completes the task
    runDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 7000, report: "fresh full", draft: "fresh", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-new", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeResumeRunner(db);
    const r = await runner.resumeFromBoot("t1");
    expect(r.reason).toBe("completed");
    expect(resumeFromBootImpl).toHaveBeenCalledTimes(1);
    expect(runDriverImpl).toHaveBeenCalledTimes(1); // re-dispatched fresh
    expect(getBackgroundTask(db, "t1")?.state).toBe("completed");
    expect(enqueueResult.mock.calls.at(-1)?.[0]).toMatchObject({ draft: "fresh" });
  });

  it("re-dispatches (does not resume) a running task that never captured a session", async () => {
    seedPending(db, "t1");
    markRunning(db, "t1", 1100); // running, but backend_session_id is NULL
    runDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 7000, report: "f", draft: "f", notify: true });
      return { outcome: "completed", sdkSessionId: "s", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner } = makeResumeRunner(db);
    await runner.resumeFromBoot("t1");
    expect(resumeFromBootImpl).not.toHaveBeenCalled();
    expect(runDriverImpl).toHaveBeenCalledTimes(1);
  });

  it("re-dispatches when resume is disabled even with a captured session", async () => {
    seedRunningWithSession(db, "t1");
    runDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 7000, report: "f", draft: "f", notify: true });
      return { outcome: "completed", sdkSessionId: "s", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const enqueueResult = vi.fn(async (_i: ResultEnqueue) => {});
    const runner = createBackgroundTaskRunner({
      db,
      slotStateRef: createBackgroundTaskSlotStateRef(3),
      deliveryEnqueuer: { enqueueResult, enqueueClarification: vi.fn(async (_i: ClarificationEnqueue) => {}) },
      driver: { db } as never,
      resumeAcrossRestart: false,
      nowFn: () => 5000,
    });
    await runner.resumeFromBoot("t1");
    expect(resumeFromBootImpl).not.toHaveBeenCalled();
    expect(runDriverImpl).toHaveBeenCalledTimes(1);
  });

  it("clarify with a WARM in-memory handle (same process) resumes the live session", async () => {
    // The common case: the worker parked this process, so the handle is in
    // memory — resume it directly (no reconstruct, no re-dispatch).
    seedPending(db, "t1");
    runDriverImpl.mockImplementation(async (d, id) => {
      d.prepare("UPDATE background_task SET state='awaiting_user' WHERE id=?").run(id);
      createClarification(d, { id: "c1", taskId: id, question: "web or api?", contextSummary: null, askedAt: 3000, ttlMs: 600000 });
      return { outcome: "yielded_for_clarification", sdkSessionId: "sess-1", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeRunner(db);
    await runner.runFromPost("t1");
    expect(runner.__peekParkedIds()).toContain("t1");
    resumeDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 8000, report: "answered full", draft: "answered", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-1", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const r = await runner.resumeAfterClarification({ taskId: "t1", clarificationId: "c1", answer: "api" });
    expect(r.reason).toBe("completed");
    expect(resumeDriverImpl).toHaveBeenCalledTimes(1); // warm resume
    expect(runDriverImpl).toHaveBeenCalledTimes(1); // only the original run, no re-dispatch
    expect(runner.__peekParkedIds()).not.toContain("t1"); // handle consumed
    expect(getBackgroundTask(db, "t1")?.state).toBe("completed");
    expect(enqueueResult.mock.calls.at(-1)?.[0]).toMatchObject({ draft: "answered" });
  });

  it("clarify-after-restart reconstructs the handle and resumes with the answer", async () => {
    // A parked task with a captured session but NO in-memory handle (the
    // runner never saw it park this process — i.e. across a restart).
    seedPending(db, "t1");
    markRunning(db, "t1", 1100);
    markAwaitingUser(db, "t1");
    setBackendSessionId(db, "t1", "sess-prev");
    createClarification(db, { id: "c1", taskId: "t1", question: "web or api?", contextSummary: null, askedAt: 3000, ttlMs: 600000 });
    resumeDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 8000, report: "answered full", draft: "answered", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-prev", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeResumeRunner(db);
    const r = await runner.resumeAfterClarification({ taskId: "t1", clarificationId: "c1", answer: "api" });
    expect(r.reason).toBe("completed");
    expect(resumeDriverImpl).toHaveBeenCalledTimes(1);
    expect(getBackgroundTask(db, "t1")?.state).toBe("completed");
    expect(enqueueResult.mock.calls.at(-1)?.[0]).toMatchObject({ draft: "answered" });
  });

  it("clarify-after-restart re-dispatches WITH the answer (not fail-loud) when resume is disabled", async () => {
    // §10.2 zero-regression floor: with resume off there's no warm session to
    // reconstruct, so the task must re-run cold from the brief — and the
    // owner's answer must survive (folded into the brief), NOT be lost while
    // the owner is told "couldn't finish". Mirrors resumeFromBoot's
    // flag-off behaviour.
    seedPending(db, "t1");
    markRunning(db, "t1", 1100);
    markAwaitingUser(db, "t1");
    setBackendSessionId(db, "t1", "sess-prev");
    createClarification(db, { id: "c1", taskId: "t1", question: "web or api?", contextSummary: null, askedAt: 3000, ttlMs: 600000 });
    runDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 8000, report: "fresh full", draft: "fresh", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-new", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const enqueueResult = vi.fn(async (_i: ResultEnqueue) => {});
    const runner = createBackgroundTaskRunner({
      db,
      slotStateRef: createBackgroundTaskSlotStateRef(3),
      deliveryEnqueuer: { enqueueResult, enqueueClarification: vi.fn(async (_i: ClarificationEnqueue) => {}) },
      driver: { db } as never,
      resumeAcrossRestart: false,
      nowFn: () => 5000,
    });
    const r = await runner.resumeAfterClarification({ taskId: "t1", clarificationId: "c1", answer: "api" });
    expect(r.reason).toBe("completed");
    expect(resumeDriverImpl).not.toHaveBeenCalled(); // no resume — disabled
    expect(runDriverImpl).toHaveBeenCalledTimes(1); // re-dispatched cold
    const after = getBackgroundTask(db, "t1");
    expect(after?.state).toBe("completed");
    expect(after?.brief).toContain("web or api?"); // question folded in
    expect(after?.brief).toContain("api"); // owner's answer preserved
    expect(enqueueResult.mock.calls.at(-1)?.[0]).toMatchObject({ draft: "fresh" });
  });

  it("clarify-after-restart falls back to re-dispatch-with-answer when the reconstructed session can't reload", async () => {
    // D1/D2: the warm-session reconstruct succeeds but the SDK can no longer
    // load it (resume_unavailable). The task must degrade to a cold
    // re-dispatch carrying the answer — NOT fail-loud (the prior bug routed
    // resume_unavailable straight into reconcileDriverOutcome's fail-loud).
    seedPending(db, "t1");
    markRunning(db, "t1", 1100);
    markAwaitingUser(db, "t1");
    setBackendSessionId(db, "t1", "sess-prev");
    createClarification(db, { id: "c1", taskId: "t1", question: "web or api?", contextSummary: null, askedAt: 3000, ttlMs: 600000 });
    resumeDriverImpl.mockResolvedValue({
      outcome: "resume_unavailable",
      sdkSessionId: "sess-prev",
      detail: "no init",
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
    });
    runDriverImpl.mockImplementation(async (d, id) => {
      markTerminal(d, { id, state: "completed", outcomeDetail: null, finishedAt: 9000, report: "fresh full", draft: "fresh", notify: true });
      return { outcome: "completed", sdkSessionId: "sess-new", costUsd: 0, numTurns: 1, durationMs: 1 };
    });
    const { runner, enqueueResult } = makeResumeRunner(db);
    const r = await runner.resumeAfterClarification({ taskId: "t1", clarificationId: "c1", answer: "api" });
    expect(r.reason).toBe("completed");
    expect(resumeDriverImpl).toHaveBeenCalledTimes(1); // tried the warm resume
    expect(runDriverImpl).toHaveBeenCalledTimes(1); // then re-dispatched cold
    const after = getBackgroundTask(db, "t1");
    expect(after?.state).toBe("completed");
    expect(after?.brief).toContain("api"); // answer folded into the re-dispatch
    expect(enqueueResult.mock.calls.at(-1)?.[0]).toMatchObject({ draft: "fresh" });
  });
});
