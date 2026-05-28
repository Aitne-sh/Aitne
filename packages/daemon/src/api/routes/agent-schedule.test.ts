import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { registerAgentScheduleRoutes } from "./agent-schedule.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";

// SCHEDULE_API_REDESIGN_PLAN §10 — route↔DB integration coverage for
// POST /schedule, POST /schedule/batch, and PATCH /schedule/:id. The
// resolver itself is unit-tested in `schedule-model-resolver.test.ts`
// and the registry shape in `schedule-validation.test.ts`. These tests
// pin down the route's persistence contract: that an accepted token
// lands as (model, tier_override, backend_id) on the row, an alias
// rewrites to tier_override, and the §5.0.5 warnings channel + 4xx
// envelopes round-trip via the response.

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeApp(db: Database.Database): Hono {
  const app = new Hono();
  registerAgentScheduleRoutes(app, {
    db,
    config: { timezone: "Asia/Tokyo" } as unknown as AgentConfig,
    triggerRoadmapRefresh: undefined,
  } as unknown as ApiDependencies);
  return app;
}

interface AgentScheduleRow {
  id: number;
  model: string | null;
  tier_override: string | null;
  backend_id: string | null;
  task_type: string;
  task_description: string;
  task_prompt: string | null;
}

function selectRow(db: Database.Database, id: number): AgentScheduleRow {
  return db
    .prepare(
      "SELECT id, model, tier_override, backend_id, task_type, task_description, task_prompt FROM agent_schedule WHERE id = ?",
    )
    .get(id) as AgentScheduleRow;
}

const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const LONG_DESCRIPTION = "A description carrying enough context for the future session to act";

const BATCH_TASK_CONTEXT = {
  background:
    "Background prose explaining the scheduled task setup at length for the agent",
  expected_output: "DM the user with a status update at fire time",
};

describe("agent-schedule routes", () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = makeTestDb();
    app = makeApp(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── POST /schedule ────────────────────────────────────────────────

  describe("POST /schedule", () => {
    it("registered model id persists (model, backend_id) and clears tier_override", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: "persist registered model id pin check on the row",
          model: "claude-opus-4-8",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        status: string;
        scheduleId: string;
        warnings: unknown[];
      };
      expect(data.status).toBe("scheduled");
      expect(data.warnings).toEqual([]);

      const row = selectRow(db, Number(data.scheduleId));
      expect(row.model).toBe("claude-opus-4-8");
      expect(row.backend_id).toBe("claude");
      expect(row.tier_override).toBeNull();
    });

    it("alias 'sonnet' rewrites to tier_override='medium'", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: LONG_DESCRIPTION,
          model: "sonnet",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { scheduleId: string };
      const row = selectRow(db, Number(data.scheduleId));
      expect(row.model).toBeNull();
      expect(row.backend_id).toBeNull();
      expect(row.tier_override).toBe("medium");
    });

    it("alias 'opus' rewrites to tier_override='high'", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: LONG_DESCRIPTION,
          model: "opus",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { scheduleId: string };
      const row = selectRow(db, Number(data.scheduleId));
      expect(row.model).toBeNull();
      expect(row.backend_id).toBeNull();
      expect(row.tier_override).toBe("high");
    });

    it("explicit tier 'lite' persists in tier_override (no model)", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: LONG_DESCRIPTION,
          tier: "lite",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { scheduleId: string };
      const row = selectRow(db, Number(data.scheduleId));
      expect(row.model).toBeNull();
      expect(row.backend_id).toBeNull();
      expect(row.tier_override).toBe("lite");
    });

    it("unknown model rejected with schedule.model_unknown and validValues", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: LONG_DESCRIPTION,
          model: "gpt-5.4-turbo",
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as {
        errors: Array<{
          code: string;
          validValues?: {
            aliases?: readonly string[];
            models?: Record<string, string[]>;
          };
        }>;
      };
      expect(data.errors[0].code).toBe("schedule.model_unknown");
      expect(data.errors[0].validValues?.aliases).toEqual(
        expect.arrayContaining(["sonnet", "opus"]),
      );
      expect(data.errors[0].validValues?.models?.codex).toEqual(
        expect.arrayContaining(["gpt-5.4"]),
      );
    });

    it("model + tier together rejected with schedule.tier_and_model_conflict", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: LONG_DESCRIPTION,
          model: "claude-opus-4-7",
          tier: "high",
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.tier_and_model_conflict");
    });

    it("deprecated model surfaces in warnings[] (200, not 400)", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: LONG_DESCRIPTION,
          model: "claude-opus-4-6",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        scheduleId: string;
        warnings: Array<{ code: string; severity: string }>;
      };
      const row = selectRow(db, Number(data.scheduleId));
      expect(row.model).toBe("claude-opus-4-6");
      expect(row.backend_id).toBe("claude");
      expect(data.warnings[0].code).toBe("schedule.model_deprecated");
      expect(data.warnings[0].severity).toBe("warning");
    });

    it("no model + no tier leaves all three columns NULL (process-key default at fire time)", async () => {
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: FUTURE_ISO,
          taskType: "wake",
          description: "no override row should default to process-key at dispatch",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { scheduleId: string };
      const row = selectRow(db, Number(data.scheduleId));
      expect(row.model).toBeNull();
      expect(row.tier_override).toBeNull();
      expect(row.backend_id).toBeNull();
    });
  });

  // ── POST /schedule/batch ──────────────────────────────────────────

  describe("POST /schedule/batch", () => {
    it("row with registered model id persists (model, backend_id) on the batch row", async () => {
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row pinned to a registered claude model id",
              taskContext: BATCH_TASK_CONTEXT,
              model: "claude-opus-4-7",
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { rowsCommitted: number; ids: number[] };
      expect(data.rowsCommitted).toBe(1);
      const row = selectRow(db, data.ids[0]);
      expect(row.model).toBe("claude-opus-4-7");
      expect(row.backend_id).toBe("claude");
      expect(row.tier_override).toBeNull();
    });

    it("alias 'sonnet' on a batch row rewrites to tier_override='medium'", async () => {
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row using legacy alias sonnet for medium tier",
              taskContext: BATCH_TASK_CONTEXT,
              model: "sonnet",
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { ids: number[] };
      const row = selectRow(db, data.ids[0]);
      expect(row.model).toBeNull();
      expect(row.tier_override).toBe("medium");
      expect(row.backend_id).toBeNull();
    });

    it("mixed batch: one alias row + one registered-id row both persist correctly", async () => {
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row 0 uses sonnet alias, expects medium tier",
              taskContext: BATCH_TASK_CONTEXT,
              model: "sonnet",
            },
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row 1 pins claude opus 4.7 with backend pin",
              taskContext: BATCH_TASK_CONTEXT,
              model: "claude-opus-4-7",
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { ids: number[] };
      expect(data.ids).toHaveLength(2);

      const row0 = selectRow(db, data.ids[0]);
      expect(row0.model).toBeNull();
      expect(row0.tier_override).toBe("medium");
      expect(row0.backend_id).toBeNull();

      const row1 = selectRow(db, data.ids[1]);
      expect(row1.model).toBe("claude-opus-4-7");
      expect(row1.tier_override).toBeNull();
      expect(row1.backend_id).toBe("claude");
    });

    it("unknown model on a batch row rejects with 422 and rowsCommitted=0 (atomic)", async () => {
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row carrying a model id not in the registry",
              taskContext: BATCH_TASK_CONTEXT,
              model: "gpt-5.4-turbo",
            },
          ],
        }),
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as {
        errors: Array<{ code: string; rowIndex: number | null }>;
      };
      expect(data.errors[0].code).toBe("schedule.model_unknown");
      expect(data.errors[0].rowIndex).toBe(0);

      const count = db
        .prepare("SELECT COUNT(*) AS n FROM agent_schedule")
        .get() as { n: number };
      expect(count.n).toBe(0);
    });

    it("deprecated model on a batch row surfaces in envelope.warnings[] and still commits", async () => {
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row pinned to deprecated claude opus 4.6",
              taskContext: BATCH_TASK_CONTEXT,
              model: "claude-opus-4-6",
            },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        ids: number[];
        warnings: Array<{ code: string }>;
      };
      const row = selectRow(db, data.ids[0]);
      expect(row.model).toBe("claude-opus-4-6");
      expect(data.warnings[0].code).toBe("schedule.model_deprecated");
    });

    it("tier + model on the same batch row rejects with schedule.tier_and_model_conflict", async () => {
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: FUTURE_ISO,
              taskType: "wake",
              taskDescription: "batch row carrying both tier and model — must reject",
              taskContext: BATCH_TASK_CONTEXT,
              model: "claude-opus-4-7",
              tier: "high",
            },
          ],
        }),
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.tier_and_model_conflict");
    });
  });

  // ── PATCH /schedule/:id ───────────────────────────────────────────

  describe("PATCH /schedule/:id", () => {
    function seedPendingWakeRow(): number {
      const result = db
        .prepare(
          `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
           VALUES (datetime('now', '+1 hour'), 'wake', 'seed row for PATCH integration tests', 'pending')`,
        )
        .run();
      return Number(result.lastInsertRowid);
    }

    it("PATCH model:'claude-opus-4-7' writes (model, backend_id), clears tier_override", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-7" }),
      });

      expect(res.status).toBe(200);
      const row = selectRow(db, id);
      expect(row.model).toBe("claude-opus-4-7");
      expect(row.backend_id).toBe("claude");
      expect(row.tier_override).toBeNull();
    });

    it("PATCH model:null clears both model and backend_id", async () => {
      const id = seedPendingWakeRow();
      // First set, then clear.
      const setRes = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-7" }),
      });
      expect(setRes.status).toBe(200);

      const clearRes = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null }),
      });
      expect(clearRes.status).toBe(200);

      const row = selectRow(db, id);
      expect(row.model).toBeNull();
      expect(row.backend_id).toBeNull();
    });

    it("PATCH with unknown model returns schedule.model_unknown", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "definitely-not-real" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.model_unknown");
    });

    it("PATCH with description shorter than 20 chars returns schedule.description_too_short (Fix 1)", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "too short" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as {
        errors: Array<{ code: string; field: string }>;
      };
      expect(data.errors[0].code).toBe("schedule.description_too_short");
      expect(data.errors[0].field).toBe("description");
    });

    it("PATCH with prompt shorter than 20 chars returns schedule.prompt_too_short (Fix 1)", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "short" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.prompt_too_short");
    });

    it("PATCH with unknown tier returns schedule.tier_unknown (Fix 1)", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "ultra" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.tier_unknown");
    });

    it("PATCH with empty body returns agent.no_changes (Fix 1 — root refine remap)", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as {
        errors: Array<{ code: string; field: string }>;
      };
      expect(data.errors[0].code).toBe("agent.no_changes");
      expect(data.errors[0].field).toBe("body");
    });

    it("PATCH model+tier together returns schedule.tier_and_model_conflict", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-7", tier: "high" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.tier_and_model_conflict");
    });

    it("PATCH model:'claude-opus-4-6' surfaces deprecation warning AND persists", async () => {
      const id = seedPendingWakeRow();
      const res = await app.request(`/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        warnings: Array<{ code: string }>;
      };
      const row = selectRow(db, id);
      expect(row.model).toBe("claude-opus-4-6");
      expect(data.warnings[0].code).toBe("schedule.model_deprecated");
    });
  });
});
