import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createRecurringScheduleRoutes } from "./recurring-schedules.js";
import { createRecurringSchedule } from "../../db/recurring-schedules.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";

/**
 * `/api/recurring-schedules` after the scheduling split: the home ONLY for
 * recurring scheduled DMs (`task_type = 'dm_session'`, e.g. the morning
 * briefing — retimed dynamically by quiet-hours-sync, so not an Agent). Every
 * other taskType (recurring `agent.task` LLM work) is 410 Gone → /api/agents.
 * GET stays open for read + the `/schedule` skill's dedup pre-check.
 */

function makeConfig(timezone = "America/New_York"): AgentConfig {
  return { timezone } as unknown as AgentConfig;
}

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeDeps(db: Database.Database): ApiDependencies {
  return { db, config: makeConfig() } as unknown as ApiDependencies;
}

/** A valid dm_session create body (the allowed shape). */
const DM_BODY = {
  taskType: "dm_session",
  description: "Morning briefing — daily summary sent as a DM at wake time",
  recurrenceRule: { frequency: "daily", time: "07:00", timezone: "America/New_York" },
  taskContext: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
};

function seedAgentTaskRow(db: Database.Database): number {
  return createRecurringSchedule(db, {
    taskType: "agent.task",
    description: "A recurring agent.task row (now Agent-owned territory)",
    recurrenceRule: { frequency: "daily", time: "09:00", timezone: "America/New_York" },
  }).id;
}

describe("recurring-schedules routes (dm_session-only after the split)", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createRecurringScheduleRoutes>;

  beforeEach(() => {
    db = makeTestDb();
    app = createRecurringScheduleRoutes(makeDeps(db));
  });
  afterEach(() => db.close());

  const post = (body: unknown) =>
    app.request("/recurring-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  describe("POST", () => {
    it("creates a dm_session recurring schedule (201)", async () => {
      const res = await post(DM_BODY);
      expect(res.status).toBe(201);
      const data = (await res.json()) as { status: string; item: { id: number; taskType: string } };
      expect(data.status).toBe("created");
      expect(data.item.taskType).toBe("dm_session");
    });

    it("410s a non-dm_session (agent.task) create with an /agents pointer", async () => {
      const res = await post({ ...DM_BODY, taskType: "agent.task" });
      expect(res.status).toBe(410);
      const data = (await res.json()) as { error: string; hint: string };
      expect(data.error).toBe("recurring_agent_task_moved_to_agents");
      expect(data.hint).toContain("POST /api/agents");
    });

    it("410s a 'custom' (LLM-work) create", async () => {
      expect((await post({ ...DM_BODY, taskType: "custom" })).status).toBe(410);
    });
  });

  describe("GET", () => {
    it("lists rows", async () => {
      await post(DM_BODY);
      const res = await app.request("/recurring-schedules");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    });

    it("returns 404 for a missing id and 400 for a bad id", async () => {
      expect((await app.request("/recurring-schedules/999")).status).toBe(404);
      expect((await app.request("/recurring-schedules/abc")).status).toBe(400);
    });
  });

  describe("PATCH / DELETE gated by taskType", () => {
    it("edits a dm_session row (200) and deletes it (200)", async () => {
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      const patch = await app.request(`/recurring-schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patch.status).toBe(200);
      const del = await app.request(`/recurring-schedules/${id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
    });

    it("410s PATCH on an agent.task row (Agent-owned → /agents)", async () => {
      const id = seedAgentTaskRow(db);
      const res = await app.request(`/recurring-schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: string }).error).toBe("recurring_agent_task_moved_to_agents");
    });

    it("410s DELETE on an agent.task row", async () => {
      const id = seedAgentTaskRow(db);
      const res = await app.request(`/recurring-schedules/${id}`, { method: "DELETE" });
      expect(res.status).toBe(410);
    });

    it("404s PATCH on a missing row", async () => {
      const res = await app.request("/recurring-schedules/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
    });
  });
});
