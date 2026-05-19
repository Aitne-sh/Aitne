import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createActivitySourcesRoutes } from "./activity-sources.js";
import {
  createRecurringSchedule,
} from "../../db/recurring-schedules.js";
import {
  allocateNextManagedTaskId,
  insertManagedTask,
} from "../../db/managed-tasks-store.js";

interface TestEnv {
  db: Database.Database;
  cleanup: () => void;
}

function setupEnv(): TestEnv {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return { db, cleanup: () => db.close() };
}

const VALID_RULE = {
  frequency: "daily" as const,
  time: "10:00",
  timezone: "Asia/Tokyo",
};

function createActiveTask(db: Database.Database, app: string): string {
  const id = allocateNextManagedTaskId(db);
  const schedule = createRecurringSchedule(db, {
    taskType: "scheduled.task",
    description: `[${id}] fetch — daily 10:00`,
    recurrenceRule: VALID_RULE,
    taskContext: { mt_id: id, app, cadence: "daily 10:00" },
  });
  insertManagedTask(db, {
    id,
    intent: "fetch",
    app,
    cadence: "daily 10:00",
    outputPath: "work/meetings/",
    scheduleId: schedule.id,
  });
  return id;
}

function recordRenameAudit(
  db: Database.Database,
  oldApp: string,
  newApp: string,
): void {
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, trigger, result, detail, started_at, completed_at)
     VALUES (?, 'management_task.app_renamed', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
  ).run(
    `rename:${Date.now()}`,
    JSON.stringify({
      mt_id: "mt_1",
      from: oldApp,
      to: newApp,
      app: newApp,
      app_normalized: newApp.toLowerCase(),
      old_app: oldApp,
      old_app_normalized: oldApp.toLowerCase(),
    }),
  );
}

describe("GET /api/activity-sources", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(() => env.cleanup());

  it("returns an empty list when no sources exist", async () => {
    const app = createActivitySourcesRoutes({ db: env.db });
    const res = await app.request("/activity-sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      windowDays: number;
      cutoffDate: string;
    };
    expect(body.items).toEqual([]);
    expect(body.windowDays).toBe(90);
    expect(body.cutoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("flags an active managed task with status: active", async () => {
    createActiveTask(env.db, "Zoom");
    const app = createActivitySourcesRoutes({ db: env.db });
    const res = await app.request("/activity-sources");
    const body = (await res.json()) as {
      items: { label: string; normalized: string; status: string }[];
    };
    expect(body.items).toEqual([
      { label: "Zoom", normalized: "zoom", status: "active" },
    ]);
  });

  it("surfaces a stopped source via the agent_actions audit projection", async () => {
    // Simulate: a task was created (audit row), then deleted. The
    // managed_tasks row is gone but the audit history still references
    // the old label.
    env.db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('m1', 'management_task.deleted', 'reactive', 'success', ?, datetime('now'), datetime('now'))`,
      )
      .run(
        JSON.stringify({
          mt_id: "mt_42",
          app: "Old App",
          app_normalized: "old app",
          original_row: {},
        }),
      );

    const app = createActivitySourcesRoutes({ db: env.db });
    const res = await app.request("/activity-sources");
    const body = (await res.json()) as {
      items: { normalized: string; status: string }[];
    };
    const stopped = body.items.find((i) => i.normalized === "old app");
    expect(stopped).toBeDefined();
    expect(stopped?.status).toBe("stopped");
  });

  it("includes both labels of a renamed source so the OLD activity file stays reachable", async () => {
    // The new label might also have an active task; either way both
    // need to surface so the user can find each `_activity/<X>.md`.
    recordRenameAudit(env.db, "Zoom", "Zoom Workplace");
    const app = createActivitySourcesRoutes({ db: env.db });
    const res = await app.request("/activity-sources");
    const body = (await res.json()) as {
      items: { normalized: string; status: string }[];
    };
    const normalized = body.items.map((i) => i.normalized).sort();
    expect(normalized).toContain("zoom");
    expect(normalized).toContain("zoom workplace");
    // Neither has an active managed_tasks row in this fixture.
    expect(body.items.every((i) => i.status === "stopped")).toBe(true);
  });

  it("active wins over stopped when a normalized form has both projections", async () => {
    createActiveTask(env.db, "Zoom");
    recordRenameAudit(env.db, "Zoom", "Zoom Workplace");
    const app = createActivitySourcesRoutes({ db: env.db });
    const res = await app.request("/activity-sources");
    const body = (await res.json()) as {
      items: { normalized: string; status: string }[];
    };
    const zoom = body.items.find((i) => i.normalized === "zoom");
    expect(zoom?.status).toBe("active");
    const renamed = body.items.find((i) => i.normalized === "zoom workplace");
    expect(renamed?.status).toBe("stopped");
  });
});
