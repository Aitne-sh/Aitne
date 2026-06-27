import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../db/schema.js";
import {
  getBackgroundTask,
  markRunning,
  markAwaitingUser,
} from "../../db/background-task-store.js";
import { createClarification } from "../../db/background-task-clarifications-store.js";
import { createBackgroundTaskRoutes } from "./background-task.js";
import type { ApiDependencies } from "../server.js";

function fakeRunner() {
  return {
    runFromPost: vi.fn().mockResolvedValue({ ok: true, reason: "queued", state: "pending" }),
    runFromScheduleRow: vi.fn(),
    cancel: vi.fn().mockResolvedValue(true),
    resumeAfterClarification: vi.fn().mockResolvedValue({ ok: true, reason: "completed", state: "completed" }),
    expireForDeadline: vi.fn(),
    __peekParkedIds: () => [],
  };
}

function makeApp(
  db: Database.Database,
  runner: ReturnType<typeof fakeRunner> | null,
  config?: Record<string, unknown>,
) {
  return createBackgroundTaskRoutes({
    db,
    eventBroadcaster: null,
    backgroundTaskRunner: runner ?? undefined,
    ...(config ? { config } : {}),
  } as unknown as ApiDependencies);
}

async function postJson(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/background-task routes", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  it("POST spawns a row and fire-and-forgets the runner", async () => {
    const runner = fakeRunner();
    const res = await postJson(makeApp(db, runner), "/background-task", {
      brief: "audit all my repos for failing CI",
      title: "CI audit",
      notificationPolicy: "if_significant",
      tier: "high",
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { taskId: string; status: string };
    expect(json.taskId).toBeTruthy();
    const row = getBackgroundTask(db, json.taskId);
    expect(row?.brief).toBe("audit all my repos for failing CI");
    expect(row?.notificationPolicy).toBe("if_significant");
    expect(row?.tier).toBe("high");
    expect(runner.runFromPost).toHaveBeenCalledWith(json.taskId);
  });

  it("POST persists significanceCriteria and GET :id returns them", async () => {
    const res = await postJson(makeApp(db, fakeRunner()), "/background-task", {
      brief: "audit repos",
      notificationPolicy: "if_significant",
      significanceCriteria: ["any repo's main build is red", "spend > $100"],
    });
    const { taskId } = (await res.json()) as { taskId: string };
    expect(getBackgroundTask(db, taskId)?.significanceCriteria).toEqual([
      "any repo's main build is red",
      "spend > $100",
    ]);
    const detail = await makeApp(db, null).request(`/background-task/${taskId}`);
    const json = (await detail.json()) as { significanceCriteria: string[] | null };
    expect(json.significanceCriteria).toEqual([
      "any repo's main build is red",
      "spend > $100",
    ]);
  });

  it("POST rejects more than 12 criteria", async () => {
    const res = await postJson(makeApp(db, fakeRunner()), "/background-task", {
      brief: "x",
      notificationPolicy: "if_significant",
      significanceCriteria: Array.from({ length: 13 }, (_, i) => `c${i}`),
    });
    expect(res.status).toBe(400);
  });

  it("POST validates the brief", async () => {
    const res = await postJson(makeApp(db, fakeRunner()), "/background-task", { title: "no brief" });
    expect(res.status).toBe(400);
  });

  it("POST with no runner wired writes a synthetic terminal", async () => {
    const res = await postJson(makeApp(db, null), "/background-task", { brief: "x" });
    const json = (await res.json()) as { taskId: string };
    expect(getBackgroundTask(db, json.taskId)?.state).toBe("failed");
    expect(getBackgroundTask(db, json.taskId)?.outcomeDetail).toBe("runner_unavailable");
  });

  it("POST scheduleAt defers to an agent_schedule row", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await postJson(makeApp(db, fakeRunner()), "/background-task", {
      brief: "weekly summary",
      scheduleAt: future,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { status: string; scheduleRowId: number };
    expect(json.status).toBe("scheduled");
    const sched = db
      .prepare("SELECT task_type, task_prompt FROM agent_schedule WHERE id = ?")
      .get(json.scheduleRowId) as { task_type: string; task_prompt: string };
    expect(sched.task_type).toBe("background_task");
    expect(sched.task_prompt).toBe("weekly summary");
  });

  it("GET :id returns the artifact + clarifications", async () => {
    const post = await postJson(makeApp(db, null), "/background-task", { brief: "x" });
    const { taskId } = (await post.json()) as { taskId: string };
    const res = await makeApp(db, null).request(`/background-task/${taskId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; clarifications: unknown[] };
    expect(json.id).toBe(taskId);
    expect(Array.isArray(json.clarifications)).toBe(true);
  });

  it("clarify resolves the open clarification and resumes the runner", async () => {
    // seed a parked task + clarification directly
    const runner = fakeRunner();
    const app = makeApp(db, runner);
    db.prepare(
      `INSERT INTO background_task (id, brief, state, notification_policy, originating_channel, created_at)
       VALUES ('p1', 'b', 'pending', 'always', 'slack:C1', 1000)`,
    ).run();
    markRunning(db, "p1", 1100);
    markAwaitingUser(db, "p1");
    // deadline must be in the future relative to the route's Date.now()
    createClarification(db, { id: "c1", taskId: "p1", question: "web or api?", contextSummary: null, askedAt: Date.now(), ttlMs: 60 * 60 * 1000 });
    const res = await postJson(app, "/background-task/p1/clarify", { answer: "api" });
    expect(res.status).toBe(200);
    expect(runner.resumeAfterClarification).toHaveBeenCalledWith({
      taskId: "p1",
      clarificationId: "c1",
      answer: "api",
    });
  });

  it("cancel routes to the runner for a running task", async () => {
    const runner = fakeRunner();
    const app = makeApp(db, runner);
    db.prepare(
      `INSERT INTO background_task (id, brief, state, notification_policy, created_at)
       VALUES ('r1', 'b', 'running', 'always', 1000)`,
    ).run();
    const res = await postJson(app, "/background-task/r1/cancel", { reason: "stop" });
    expect(res.status).toBe(200);
    expect(runner.cancel).toHaveBeenCalledWith("r1", "stop");
  });

  it("POST dedups an identical brief inside the window onto the first task", async () => {
    const runner = fakeRunner();
    const app = makeApp(db, runner, { backgroundTaskDedupWindowMinutes: 10 });
    const first = await postJson(app, "/background-task", { brief: "audit all repos", tier: "medium" });
    const firstJson = (await first.json()) as { taskId: string; deduplicated?: boolean };
    expect(firstJson.deduplicated).toBeUndefined();

    const second = await postJson(app, "/background-task", { brief: "audit all repos", tier: "medium" });
    const secondJson = (await second.json()) as { taskId: string; deduplicated?: boolean };
    expect(second.status).toBe(202);
    expect(secondJson.deduplicated).toBe(true);
    expect(secondJson.taskId).toBe(firstJson.taskId);
    // the runner fired exactly once — the duplicate POST did not spawn a worker
    expect(runner.runFromPost).toHaveBeenCalledTimes(1);
  });

  it("POST does not dedup when the window is 0 (disabled) or the brief differs", async () => {
    const runner = fakeRunner();
    const off = makeApp(db, runner, { backgroundTaskDedupWindowMinutes: 0 });
    await postJson(off, "/background-task", { brief: "same", tier: "lite" });
    const again = await postJson(off, "/background-task", { brief: "same", tier: "lite" });
    expect(((await again.json()) as { deduplicated?: boolean }).deduplicated).toBeUndefined();
    expect(runner.runFromPost).toHaveBeenCalledTimes(2);

    const on = makeApp(db, runner, { backgroundTaskDedupWindowMinutes: 10 });
    await postJson(on, "/background-task", { brief: "alpha", tier: "lite" });
    const diff = await postJson(on, "/background-task", { brief: "beta", tier: "lite" });
    expect(((await diff.json()) as { deduplicated?: boolean }).deduplicated).toBeUndefined();
  });

  it("GET list filters by state", async () => {
    await postJson(makeApp(db, null), "/background-task", { brief: "a" });
    const res = await makeApp(db, null).request("/background-task?state=failed");
    const json = (await res.json()) as { tasks: unknown[]; total: number };
    expect(json.total).toBeGreaterThanOrEqual(1);
  });

  it("GET list notify=false + sinceHours scopes the §10.5 filed digest pull", async () => {
    const now = Date.now();
    // a filed (notify=false) result finished 1h ago, and a surfaced
    // (notify=true) result finished 1h ago.
    db.prepare(
      `INSERT INTO background_task
         (id, brief, title, state, notification_policy, report, draft, notify, significance, created_at, finished_at)
       VALUES ('f1', 'b', 'monitor', 'completed', 'silent', 'r', 'd', 0, 'no criteria met', ?, ?)`,
    ).run(now - 3_600_000, now - 3_600_000);
    db.prepare(
      `INSERT INTO background_task
         (id, brief, title, state, notification_policy, report, draft, notify, created_at, finished_at)
       VALUES ('n1', 'b', 'audit', 'completed', 'always', 'r', 'd', 1, ?, ?)`,
    ).run(now - 3_600_000, now - 3_600_000);

    const res = await makeApp(db, null).request(
      "/background-task?state=completed&notify=false&sinceHours=24",
    );
    const json = (await res.json()) as {
      tasks: { id: string; significance: string | null }[];
      total: number;
    };
    expect(json.tasks.map((t) => t.id)).toEqual(["f1"]);
    expect(json.total).toBe(1);
    expect(json.tasks[0].significance).toBe("no criteria met");

    // The window excludes a too-old filed row.
    const stale = await makeApp(db, null).request(
      "/background-task?state=completed&notify=false&sinceHours=0.1",
    );
    expect(((await stale.json()) as { total: number }).total).toBe(0);
  });
});
