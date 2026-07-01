import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createRecurringScheduleRoutes } from "./recurring-schedules.js";
import { createRecurringSchedule } from "../../db/recurring-schedules.js";
import { createTrigger } from "../../db/automation-triggers.js";
import { upsertAgent } from "../../db/agents-store.js";
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

/** Make an `imported-<id>` user Agent claim a dm_session row as its satellite. */
function claimByAgent(db: Database.Database, rsId: number, slug = `imported-${rsId}`): void {
  upsertAgent(db, {
    slug,
    name: "Evening daily summary",
    source: "user",
    definitionPath: `agents/${slug}/agent.md`,
    definitionHash: "hash",
    enabled: true,
    scheduleKind: "cron",
    scheduleExpression: "0 19 * * *",
    scheduleTimezone: "America/New_York",
    recurringScheduleId: rsId,
  });
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

  // audit A3 — auto mode (empty config zone) must OMIT the baked `timezone`
  // key so the rule tracks the live OS zone at fire time; an explicit per-rule
  // zone or a set operator config zone is still stamped and stays pinned.
  describe("timezone stamping (A3)", () => {
    const persistedTz = (scheduleId: number): string | null =>
      (
        db
          .prepare(
            "SELECT json_extract(recurrence_rule, '$.timezone') AS tz FROM recurring_schedules WHERE id = ?",
          )
          .get(scheduleId) as { tz: string | null }
      ).tz;

    const autoApp = () =>
      createRecurringScheduleRoutes({
        db,
        config: makeConfig(""),
      } as unknown as ApiDependencies);

    const createOn = (
      target: ReturnType<typeof createRecurringScheduleRoutes>,
      body: unknown,
    ) =>
      target.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // A generic user reminder — NOT the morning briefing — to prove the fix
    // generalises to every dm_session row, not only the seeded briefing.
    const genericAutoBody = {
      taskType: "dm_session",
      description: "Daily 9am reminder — generic user reminder, no baked zone",
      recurrenceRule: { frequency: "daily", time: "09:00" },
      taskContext: { sub_flow: "custom_reminder" },
    };

    it("OMITS the timezone key on create in auto mode (empty config zone)", async () => {
      const res = await createOn(autoApp(), genericAutoBody);
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { item: { id: number } }).item.id;
      expect(persistedTz(id)).toBeNull();
    });

    it("STAMPS an explicit per-rule zone even in auto mode", async () => {
      const res = await createOn(autoApp(), {
        ...genericAutoBody,
        recurrenceRule: { frequency: "daily", time: "09:00", timezone: "Asia/Tokyo" },
      });
      const id = ((await res.json()) as { item: { id: number } }).item.id;
      expect(persistedTz(id)).toBe("Asia/Tokyo");
    });

    it("STAMPS the operator config zone when set and no per-rule zone", async () => {
      // `post` uses the default app whose config zone is America/New_York.
      const res = await post({
        ...genericAutoBody,
        recurrenceRule: { frequency: "daily", time: "09:00" },
      });
      const id = ((await res.json()) as { item: { id: number } }).item.id;
      expect(persistedTz(id)).toBe("America/New_York");
    });

    it("OMITS the timezone key on a recurrenceRule PATCH in auto mode", async () => {
      const app2 = autoApp();
      const id = (
        (await (await createOn(app2, genericAutoBody)).json()) as {
          item: { id: number };
        }
      ).item.id;
      expect(persistedTz(id)).toBeNull();
      const patch = await app2.request(`/recurring-schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurrenceRule: { frequency: "daily", time: "10:00" },
        }),
      });
      expect(patch.status).toBe(200);
      expect(persistedTz(id)).toBeNull();
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

    it("hides a dm_session row an Agent already owns (no /schedule double-listing)", async () => {
      // Legacy artifact: an `imported-<id>` user Agent references a dm_session row.
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      claimByAgent(db, id);
      const res = await app.request("/recurring-schedules");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(0);
    });

    it("?includeClaimed=true returns the claimed row annotated with its owning Agent", async () => {
      // The schedule skill's dedup pre-check must SEE covered cadences, or it
      // re-creates them → duplicate DMs at fire time.
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      claimByAgent(db, id);
      const res = await app.request("/recurring-schedules?enabled=true&includeClaimed=true");
      expect(res.status).toBe(200);
      const items = ((await res.json()) as {
        items: Array<{ id: number; claimedByAgentSlug?: string }>;
      }).items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(id);
      expect(items[0].claimedByAgentSlug).toBe(`imported-${id}`);
    });

    it("hides a trigger-owned agent.task row (managed as trigger:<id> on the board)", async () => {
      const trigger = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: "Sweep stale branches",
        time: "09:00",
        configTimezone: "America/New_York",
      });
      const res = await app.request("/recurring-schedules");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(0);

      // The dedup pre-check still SEES the covered cadence, annotated.
      const claimed = await app.request("/recurring-schedules?includeClaimed=true");
      const items = ((await claimed.json()) as {
        items: Array<{ claimedByTriggerId?: number }>;
      }).items;
      expect(items).toHaveLength(1);
      expect(items[0].claimedByTriggerId).toBe(trigger.id);
    });

    it("GET /:id surfaces the owning trigger on its paired row", async () => {
      const trigger = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: "Sweep stale branches",
        time: "09:00",
        configTimezone: "America/New_York",
      });
      const res = await app.request(`/recurring-schedules/${trigger.recurringScheduleId}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { claimedByTriggerId?: number }).claimedByTriggerId).toBe(
        trigger.id,
      );
    });

    it("GET /:id surfaces the owning Agent on a claimed row", async () => {
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      claimByAgent(db, id);
      const res = await app.request(`/recurring-schedules/${id}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { claimedByAgentSlug?: string }).claimedByAgentSlug).toBe(
        `imported-${id}`,
      );
      // Unclaimed rows carry no annotation.
      const id2 = ((await (await post({ ...DM_BODY, taskContext: {} })).json()) as {
        item: { id: number };
      }).item.id;
      const res2 = await app.request(`/recurring-schedules/${id2}`);
      expect(
        ((await res2.json()) as { claimedByAgentSlug?: string }).claimedByAgentSlug,
      ).toBeUndefined();
    });
  });

  describe("canonical-owner write guard (claimed dm_session rows)", () => {
    it("409s a PATCH on a claimed row with a pointer to the owning Agent", async () => {
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      claimByAgent(db, id);
      const res = await app.request(`/recurring-schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string; hint: string };
      expect(data.error).toBe("recurring_schedule_claimed_by_agent");
      expect(data.hint).toContain(`PATCH /api/agents/imported-${id}`);
    });

    it("409s a DELETE on a claimed row (no SET-NULL orphaning of the Agent)", async () => {
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      claimByAgent(db, id);
      const res = await app.request(`/recurring-schedules/${id}`, { method: "DELETE" });
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string; hint: string };
      expect(data.error).toBe("recurring_schedule_claimed_by_agent");
      expect(data.hint).toContain(`DELETE /api/agents/imported-${id}`);
      // The row survives untouched.
      expect((await app.request(`/recurring-schedules/${id}`)).status).toBe(200);
    });

    it("leaves unclaimed dm_session rows freely editable and deletable", async () => {
      const id = ((await (await post(DM_BODY)).json()) as { item: { id: number } }).item.id;
      const patched = await app.request(`/recurring-schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patched.status).toBe(200);
      expect((await app.request(`/recurring-schedules/${id}`, { method: "DELETE" })).status).toBe(
        200,
      );
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
