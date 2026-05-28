import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { createRecurringScheduleRoutes } from "./recurring-schedules.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";
import { runDefaultSchedulesReconciler } from "../../core/context/default-schedules-runner.js";
import { reconcileRecurringSchedules } from "../../db/recurring-schedules.js";
import { computeNextOccurrence } from "../../core/recurrence.js";
import { formatSqliteDatetime } from "@aitne/shared";
import type { RecurrenceRule } from "@aitne/shared";

vi.mock("../../core/context/default-schedules-runner.js", () => ({
  runDefaultSchedulesReconciler: vi.fn().mockResolvedValue(undefined),
}));

function makeConfig(timezone = "America/New_York"): AgentConfig {
  return { timezone } as unknown as AgentConfig;
}

function makeConfigWithDir(dataDir: string, timezone = "America/New_York"): AgentConfig {
  return { timezone, dataDir } as unknown as AgentConfig;
}

function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeDeps(db: Database.Database, timezone = "America/New_York"): ApiDependencies {
  return { db, config: makeConfig(timezone) } as unknown as ApiDependencies;
}

function makeDepsWithDir(db: Database.Database, dataDir: string, timezone = "America/New_York"): ApiDependencies {
  return { db, config: makeConfigWithDir(dataDir, timezone) } as unknown as ApiDependencies;
}

const VALID_BODY = {
  taskType: "routine.daily_standup",
  description: "Daily standup preparation reminder for the morning",
  recurrenceRule: {
    frequency: "daily",
    time: "09:00",
    timezone: "America/New_York",
  },
};

describe("recurring-schedules routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── POST /recurring-schedules ─────────────────────────────────────

  describe("POST /recurring-schedules", () => {
    it("creates a new recurring schedule and returns 201", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });

      expect(res.status).toBe(201);
      const data = await res.json() as { status: string; item: { id: number; taskType: string } };
      expect(data.status).toBe("created");
      expect(data.item.taskType).toBe("routine.daily_standup");
      expect(data.item.id).toBeGreaterThan(0);
    });

    it("returns 400 with schedule.* errors for missing taskType (Phase D §5.4 — field-keyed translation)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "no type", recurrenceRule: { frequency: "daily", time: "09:00" } }),
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string; field: string }> };
      // Phase D — the legacy single-issue `error:"validation_error"`
      // collapse is gone. Each Zod failure surfaces as its own code.
      expect(data.errors).toBeDefined();
      expect(data.errors[0].code).toBe("schedule.task_type_unknown");
      expect(data.errors[0].field).toBe("taskType");
    });

    it("auto-fills timezone from config when rule has no timezone", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db, "Europe/London"));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          recurrenceRule: { frequency: "daily", time: "08:00" }, // no timezone
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json() as { item: { recurrenceRule: { timezone: string } } };
      expect(data.item.recurrenceRule.timezone).toBe("Europe/London");
    });

    it("falls back to system timezone when both rule and config timezone are empty", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db, ""));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          recurrenceRule: { frequency: "daily", time: "08:00" }, // no timezone in rule
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json() as { item: { recurrenceRule: { timezone: string } } };
      // Should fall back to system timezone (non-empty string)
      expect(typeof data.item.recurrenceRule.timezone).toBe("string");
      expect(data.item.recurrenceRule.timezone.length).toBeGreaterThan(0);
    });
  });

  // ── GET /recurring-schedules ──────────────────────────────────────

  describe("GET /recurring-schedules", () => {
    it("returns all schedules", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const res = await app.request("/recurring-schedules");
      const data = await res.json() as { items: unknown[] };
      expect(res.status).toBe(200);
      expect(data.items).toHaveLength(1);
    });

    it("filters by enabled=true", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      // Disable it via PATCH
      await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      const res = await app.request("/recurring-schedules?enabled=true");
      const data = await res.json() as { items: unknown[] };
      expect(data.items).toHaveLength(0);
    });
  });

  // ── GET /recurring-schedules/:id ──────────────────────────────────

  describe("GET /recurring-schedules/:id", () => {
    it("returns a single schedule", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { id: number; taskType: string };
      expect(data.id).toBe(created.item.id);
      expect(data.taskType).toBe("routine.daily_standup");
    });

    it("returns 404 for non-existent id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/abc");
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_id");
    });

    it("returns 400 for zero id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/0");
      expect(res.status).toBe(400);
    });
  });

  // ── PATCH /recurring-schedules/:id ───────────────────────────────

  describe("PATCH /recurring-schedules/:id", () => {
    it("updates the description", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated standup description for the daily routine" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { status: string; item: { description: string } };
      expect(data.status).toBe("updated");
      expect(data.item.description).toBe("Updated standup description for the daily routine");
    });

    it("updates recurrence rule and auto-fills timezone from config", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db, "America/New_York"));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurrenceRule: { frequency: "weekly", time: "10:00", daysOfWeek: [1, 3] },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { item: { recurrenceRule: { timezone: string } } };
      expect(data.item.recurrenceRule.timezone).toBe("America/New_York");
    });

    it("returns 404 for non-existent id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Non-existent schedule description here" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_id");
    });

    it("returns 400 with field-keyed schedule.* envelope for validation error (Phase D §5.4)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "not-a-boolean" }), // invalid type
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string; field: string }> };
      // Phase D — the field-keyed translator emits a per-field code
      // (here `enabled` falls through to the placeholder code since
      // we don't map `enabled` in RECURRING_FIELD_CODE_MAP — but it
      // is still a structured issue with the offending field path).
      expect(data.errors).toBeDefined();
      expect(data.errors[0].field).toBe("enabled");
    });
  });

  // ── DELETE /recurring-schedules/:id ──────────────────────────────

  describe("DELETE /recurring-schedules/:id", () => {
    it("deletes a recurring schedule", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { status: string; id: number };
      expect(data.status).toBe("deleted");
      expect(data.id).toBe(created.item.id);
    });

    it("returns 404 for non-existent id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules/abc", { method: "DELETE" });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_id");
    });
  });

  // ── readJsonBody !ok early-exit paths ─────────────────────────────

  describe("invalid JSON body handling", () => {
    it("POST returns 400 when the request body is not valid JSON", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      });
      expect(res.status).toBe(400);
    });

    it("PATCH returns 400 when the request body is not valid JSON", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      // Create a real schedule first so the id check passes
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      });
      expect(res.status).toBe(400);
    });
  });

  // ── refreshDefaultSchedulesMirror async paths ─────────────────────

  describe("refreshDefaultSchedulesMirror async paths", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "pa-rec-schedules-"));
      vi.mocked(runDefaultSchedulesReconciler).mockResolvedValue(undefined);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("calls runDefaultSchedulesReconciler when getContextDir succeeds", async () => {
      const app = createRecurringScheduleRoutes(makeDepsWithDir(db, tmpDir));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      expect(res.status).toBe(201);
      // Allow the fire-and-forget promise to settle.
      await new Promise((r) => setTimeout(r, 20));
      expect(runDefaultSchedulesReconciler).toHaveBeenCalled();
    });

    it("catches and logs when runDefaultSchedulesReconciler rejects", async () => {
      vi.mocked(runDefaultSchedulesReconciler).mockRejectedValueOnce(
        new Error("reconciler failed"),
      );
      const app = createRecurringScheduleRoutes(makeDepsWithDir(db, tmpDir));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      // The route itself still succeeds; the rejection is caught internally.
      expect(res.status).toBe(201);
      await new Promise((r) => setTimeout(r, 20));
      expect(runDefaultSchedulesReconciler).toHaveBeenCalled();
    });
  });

  // ── Phase D — hourly + monthly support ────────────────────────────────

  describe("hourly + monthly creation paths (Phase D §1)", () => {
    it("creates an hourly recurring schedule with defaults", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_ping",
          description: "Hourly health check on the indexing pipeline at :00 every hour",
          recurrenceRule: { frequency: "hourly" },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as {
        item: {
          recurrenceRule: { frequency: string };
          recurrenceLabel: string;
          nextRunAt: string | null;
        };
      };
      expect(data.item.recurrenceRule.frequency).toBe("hourly");
      expect(data.item.recurrenceLabel.toLowerCase()).toContain("hour");
      expect(data.item.nextRunAt).toBeTruthy();
    });

    it("creates an hourly schedule with intervalHours + minuteOfHour", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_ping",
          description: "Every 2 hours at :30 reconciler tick on the index pipeline",
          recurrenceRule: { frequency: "hourly", intervalHours: 2, minuteOfHour: 30 },
        }),
      });
      expect(res.status).toBe(201);
    });

    it("creates a monthly schedule with onMissingDay='skip'", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.month_end",
          description: "Monthly reconciliation on the 31st only when the month has one",
          recurrenceRule: {
            frequency: "monthly",
            time: "21:00",
            daysOfMonth: [31],
            onMissingDay: "skip",
          },
        }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects hourly with a time field (schedule.frequency_field_mismatch)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_bad",
          description: "Tries to set time on an hourly rule (forbidden combination)",
          recurrenceRule: { frequency: "hourly", time: "09:00" },
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string; field: string }> };
      expect(data.errors[0].code).toBe("schedule.frequency_field_mismatch");
      expect(data.errors[0].field).toBe("recurrenceRule.time");
    });

    it("rejects intervalHours=24 (schedule.interval_hours_out_of_range)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_bad",
          description: "Tries to set intervalHours=24 on an hourly rule (out of range)",
          recurrenceRule: { frequency: "hourly", intervalHours: 24 },
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.interval_hours_out_of_range");
    });

    it("rejects an unknown frequency (schedule.frequency_unknown)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.bad_freq",
          description: "Tries to set an unsupported frequency value on the rule",
          recurrenceRule: { frequency: "yearly", time: "09:00" },
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.frequency_unknown");
    });

    it("rejects malformed time (schedule.time_format_invalid)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.bad_time",
          description: "Tries to set time in 12h AM/PM format which is rejected",
          recurrenceRule: { frequency: "daily", time: "9:00am" },
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.time_format_invalid");
    });
  });

  // ── Phase D — model-id resolution paths on the recurring routes ───────

  describe("model-id resolution + persistence (Phase D §4.3 / §4.3a)", () => {
    it("persists (model, backend_id) on POST when a registered id is pinned", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          model: "claude-opus-4-8",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as {
        item: { model: string | null; backendId: string | null; tier: string | null };
        warnings: unknown[];
      };
      expect(data.item.model).toBe("claude-opus-4-8");
      expect(data.item.backendId).toBe("claude");
      expect(data.item.tier).toBeNull();
      expect(data.warnings).toEqual([]);
    });

    it("rewrites legacy alias 'sonnet' to tier='medium' on POST", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          model: "sonnet",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as {
        item: { model: string | null; backendId: string | null; tier: string | null };
      };
      expect(data.item.model).toBeNull();
      expect(data.item.tier).toBe("medium");
      expect(data.item.backendId).toBeNull();
    });

    it("rejects POST with both tier and model set (schedule.tier_and_model_conflict)", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          model: "claude-opus-4-7",
          tier: "high",
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.tier_and_model_conflict");
    });

    it("emits schedule.model_unknown with a validValues payload for a typo on POST", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          model: "gpt-5.4-turbo",
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as {
        errors: Array<{
          code: string;
          validValues: { aliases: string[]; models: Record<string, string[]> };
        }>;
      };
      expect(data.errors[0].code).toBe("schedule.model_unknown");
      expect(data.errors[0].validValues.aliases).toEqual(["sonnet", "opus"]);
      expect(data.errors[0].validValues.models.codex).toContain("gpt-5.4");
    });

    it("surfaces schedule.model_deprecated as a warning on POST and still persists", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          model: "claude-opus-4-6",
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as {
        item: { model: string | null; backendId: string | null };
        warnings: Array<{ code: string; severity: string }>;
      };
      expect(data.item.model).toBe("claude-opus-4-6");
      expect(data.item.backendId).toBe("claude");
      expect(data.warnings[0].code).toBe("schedule.model_deprecated");
      expect(data.warnings[0].severity).toBe("warning");
    });

    it("PATCH model:null clears model + backend_id", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID_BODY, model: "claude-opus-4-7" }),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as {
        item: { model: string | null; backendId: string | null };
      };
      expect(data.item.model).toBeNull();
      expect(data.item.backendId).toBeNull();
    });

    it("PATCH with an empty body returns schedule.recurring_no_changes", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { item: { id: number } };

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { errors: Array<{ code: string }> };
      expect(data.errors[0].code).toBe("schedule.recurring_no_changes");
    });
  });

  // ── Phase D — schedule.on_missing_day_unused warning (review pass) ─────
  //
  // SCHEDULE_API_REDESIGN_PLAN §5 / §5.0.5 — `onMissingDay` is a no-op
  // intent signal when `daysOfMonth` has no entry in [29, 30, 31].
  // The recurring route accepts the row (200/201) and surfaces the
  // advisory through the warnings[] channel so future PATCHes can
  // converge on the cleaner shape.

  describe("schedule.on_missing_day_unused warning channel (Phase D §5)", () => {
    it("emits the warning on POST when onMissingDay is set but daysOfMonth has no 29/30/31", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.month_mid",
          description:
            "monthly mid-month rule with a no-op onMissingDay policy",
          recurrenceRule: {
            frequency: "monthly",
            time: "10:00",
            daysOfMonth: [1, 15],
            onMissingDay: "lastDayOfMonth",
          },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as {
        warnings: Array<{ code: string; field: string; severity: string }>;
      };
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0].code).toBe("schedule.on_missing_day_unused");
      expect(data.warnings[0].field).toBe("recurrenceRule.onMissingDay");
      expect(data.warnings[0].severity).toBe("warning");
    });

    it("does NOT emit the warning when daysOfMonth includes 29/30/31", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.month_end",
          description: "monthly month-end rule with onMissingDay set sensibly",
          recurrenceRule: {
            frequency: "monthly",
            time: "21:00",
            daysOfMonth: [31],
            onMissingDay: "lastDayOfMonth",
          },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as { warnings: unknown[] };
      expect(data.warnings).toEqual([]);
    });

    it("does NOT emit the warning when onMissingDay is omitted", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.month_mid",
          description: "monthly mid-month rule without an onMissingDay policy",
          recurrenceRule: {
            frequency: "monthly",
            time: "10:00",
            daysOfMonth: [1, 15],
          },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as { warnings: unknown[] };
      expect(data.warnings).toEqual([]);
    });

    it("does NOT emit the warning for non-monthly frequencies", async () => {
      // The schema's superRefine forbids onMissingDay on non-monthly,
      // so the only way to reach this branch is via a rule that the
      // schema accepts. Cover the "frequency != monthly" guard with a
      // daily rule that has no onMissingDay.
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.daily",
          description: "plain daily rule — warning detector must not fire",
          recurrenceRule: { frequency: "daily", time: "09:00" },
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as { warnings: unknown[] };
      expect(data.warnings).toEqual([]);
    });

    it("PATCH that removes the no-op onMissingDay clears the warning on the next response", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.month_mid",
          description: "monthly mid-month rule with no-op onMissingDay",
          recurrenceRule: {
            frequency: "monthly",
            time: "10:00",
            daysOfMonth: [1, 15],
            onMissingDay: "skip",
          },
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as {
        item: { id: number };
        warnings: Array<{ code: string }>;
      };
      expect(created.warnings[0].code).toBe("schedule.on_missing_day_unused");

      const res = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurrenceRule: {
            frequency: "monthly",
            time: "10:00",
            daysOfMonth: [1, 15], // onMissingDay dropped
          },
        }),
      });
      expect(res.status).toBe(200);
      const patched = await res.json() as { warnings: unknown[] };
      expect(patched.warnings).toEqual([]);
    });
  });

  // ── Phase E — route-layer hourly reconcile coverage ──────────────
  //
  // Plan §11 step 5: Recurring route adopts hourly. Reconcile-loop
  // test for hourly; ensure `next_run_at` computation matches
  // `computeNextHourly` and that the auto-materialized first row
  // carries `backend_id` correctly from the parent.
  //
  // The DB-layer tests in `db/recurring-schedules.test.ts` exercise
  // the same paths against the in-process helpers — these route-layer
  // tests verify the full POST/PATCH/reconcile loop comes out the
  // other side intact, including the timezone auto-fill from config.
  describe("hourly reconcile end-to-end (Phase E)", () => {
    /** Bracket-match helper — see db/recurring-schedules.test.ts for
     *  rationale: a single `new Date()` reference is flaky across
     *  minute boundaries; capture before and after the route call. */
    function expectedNextRunBracket(rule: RecurrenceRule, before: Date, after: Date): string[] {
      const expectedBefore = computeNextOccurrence(rule, before);
      const expectedAfter = computeNextOccurrence(rule, after);
      if (!expectedBefore || !expectedAfter) {
        throw new Error("computeNextOccurrence returned null for an hourly rule");
      }
      return [
        formatSqliteDatetime(expectedBefore),
        formatSqliteDatetime(expectedAfter),
      ];
    }

    it("POST hourly emits a nextRunAt that matches computeNextHourly through the recurrence engine", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db, "America/New_York"));
      const before = new Date();
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_ping",
          description: "Hourly tick at :00 — verify route emits engine-consistent nextRunAt",
          recurrenceRule: { frequency: "hourly" },
        }),
      });
      const after = new Date();
      expect(res.status).toBe(201);
      const data = await res.json() as {
        item: {
          id: number;
          nextRunAt: string | null;
          recurrenceRule: RecurrenceRule;
        };
      };
      expect(data.item.nextRunAt).toBeTruthy();

      // The route auto-fills timezone from config when omitted, so the
      // expected computation must use the same rule shape as persisted.
      const persistedRule = data.item.recurrenceRule;
      expect(persistedRule.frequency).toBe("hourly");
      expect(persistedRule.timezone).toBe("America/New_York");

      const expected = expectedNextRunBracket(persistedRule, before, after);
      expect(expected).toContain(data.item.nextRunAt!);

      // Pending child row must agree with the parent's next_run_at —
      // otherwise the dispatcher's read at fire time would diverge
      // from what the operator sees in the dashboard / DTO.
      const childRow = db
        .prepare(
          "SELECT scheduled_for FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(data.item.id) as { scheduled_for: string };
      expect(childRow.scheduled_for).toBe(data.item.nextRunAt);
    });

    it("POST hourly with intervalHours + minuteOfHour mirrors the engine for non-default cadence", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db, "UTC"));
      const before = new Date();
      const res = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_ping",
          description: "Every 2 hours at :30 — engine must drive the next fire selection",
          recurrenceRule: { frequency: "hourly", intervalHours: 2, minuteOfHour: 30 },
        }),
      });
      const after = new Date();
      expect(res.status).toBe(201);
      const data = await res.json() as {
        item: { id: number; nextRunAt: string | null; recurrenceRule: RecurrenceRule };
      };
      const expected = expectedNextRunBracket(data.item.recurrenceRule, before, after);
      expect(expected).toContain(data.item.nextRunAt!);
    });

    it("reconcile after the first hourly row completes regenerates the next fire with backend_id preserved", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const rule: RecurrenceRule = {
        frequency: "hourly",
        intervalHours: 2,
        minuteOfHour: 30,
        timezone: "America/New_York",
      };
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.hourly_ping",
          description: "Hourly Opus 4.7 — reconcile path must keep the pin",
          recurrenceRule: rule,
          model: "claude-opus-4-7",
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as {
        item: { id: number; model: string | null; backendId: string | null };
      };
      expect(created.item.model).toBe("claude-opus-4-7");
      expect(created.item.backendId).toBe("claude");

      // Simulate the dispatcher consuming the pending row.
      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(created.item.id);

      // Bracket-match the reconcile so the route assertion is byte-for-byte
      // against `computeNextOccurrence`, parity with the DB-layer test in
      // db/recurring-schedules.test.ts. The looser `> Date.now()` check
      // failed to pin down a reconcile-loop regression that would emit a
      // valid-but-wrong-cadence timestamp (e.g. ignoring intervalHours).
      const before = new Date();
      const generated = reconcileRecurringSchedules(db);
      const after = new Date();
      expect(generated).toBe(1);

      const newRow = db
        .prepare(
          "SELECT model, backend_id, scheduled_for FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.item.id) as { model: string; backend_id: string; scheduled_for: string };
      expect(newRow.model).toBe("claude-opus-4-7");
      expect(newRow.backend_id).toBe("claude");

      const expected = expectedNextRunBracket(rule, before, after);
      expect(expected).toContain(newRow.scheduled_for);

      // Parent's next_run_at must also agree byte-for-byte with the
      // child's scheduled_for — otherwise the dashboard view diverges
      // from what the dispatcher reads at fire time.
      const parentRow = db
        .prepare("SELECT next_run_at FROM recurring_schedules WHERE id = ?")
        .get(created.item.id) as { next_run_at: string };
      expect(parentRow.next_run_at).toBe(newRow.scheduled_for);
    });

    // Gap surfaced during the Phase E review pass: combining
    // recurrenceRule + model in a single PATCH exercises a non-trivial
    // read-after-write inside `updateRecurringSchedule` — the helper
    // applies every field UPDATE first, THEN re-reads the row and
    // re-materializes the child from the post-update column values.
    // The plan §9 documents that a model-only PATCH does NOT
    // re-materialize, but a rule-change PATCH must pick up the NEW
    // model on the regenerated child. Without this assertion a refactor
    // that re-orders "read row → write columns" would silently regress
    // to materializing with the pre-update model.
    it("PATCH rule + model in one call re-materializes with both new values applied", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...VALID_BODY,
          model: "claude-sonnet-4-6",
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { item: { id: number } };

      const oldPending = db
        .prepare(
          "SELECT id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.item.id) as { id: number };

      const patchRes = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurrenceRule: { frequency: "hourly", intervalHours: 1, minuteOfHour: 0 },
          model: "claude-opus-4-7",
        }),
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json() as {
        item: {
          recurrenceRule: RecurrenceRule;
          model: string | null;
          backendId: string | null;
          nextRunAt: string | null;
        };
      };
      // Parent DTO reflects BOTH changes atomically.
      expect(patched.item.recurrenceRule.frequency).toBe("hourly");
      expect(patched.item.model).toBe("claude-opus-4-7");
      expect(patched.item.backendId).toBe("claude");

      // Old child skipped, new child carries the NEW model + backend_id.
      // The read-after-write invariant: `updateRecurringSchedule` must
      // see the post-update model column when it re-materializes, not
      // the pre-update "claude-sonnet-4-6" value.
      const oldRow = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(oldPending.id) as { status: string };
      expect(oldRow.status).toBe("skipped");

      const newPending = db
        .prepare(
          "SELECT model, backend_id, scheduled_for FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.item.id) as {
          model: string;
          backend_id: string;
          scheduled_for: string;
        };
      expect(newPending.model).toBe("claude-opus-4-7");
      expect(newPending.backend_id).toBe("claude");
      expect(newPending.scheduled_for).toBe(patched.item.nextRunAt);

      // Cadence sanity — the new fire must land inside the hourly
      // window the PATCH installed (intervalHours=1).
      const nextMs = new Date(newPending.scheduled_for.replace(" ", "T") + "Z").getTime();
      const deltaMs = nextMs - Date.now();
      expect(deltaMs).toBeGreaterThanOrEqual(0);
      expect(deltaMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
    });

    it("PATCH daily → hourly cancels the old pending row and re-materializes with backend_id intact", async () => {
      const app = createRecurringScheduleRoutes(makeDeps(db));
      const createRes = await app.request("/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "routine.daily_then_hourly",
          description: "Starts daily then switched to hourly via PATCH — pin must survive",
          recurrenceRule: { frequency: "daily", time: "10:00" },
          model: "claude-opus-4-7",
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { item: { id: number } };

      const oldPending = db
        .prepare(
          "SELECT id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.item.id) as { id: number };

      const patchRes = await app.request(`/recurring-schedules/${created.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recurrenceRule: { frequency: "hourly", intervalHours: 1, minuteOfHour: 0 },
        }),
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json() as {
        item: { recurrenceRule: RecurrenceRule; nextRunAt: string | null };
      };
      expect(patched.item.recurrenceRule.frequency).toBe("hourly");

      // Old pending row must be marked `skipped`, not duplicated.
      const oldRow = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(oldPending.id) as { status: string };
      expect(oldRow.status).toBe("skipped");

      // Newly materialized child must inherit the operator's pin.
      const newPending = db
        .prepare(
          "SELECT model, backend_id, scheduled_for FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.item.id) as {
          model: string;
          backend_id: string;
          scheduled_for: string;
        };
      expect(newPending.model).toBe("claude-opus-4-7");
      expect(newPending.backend_id).toBe("claude");
      expect(newPending.scheduled_for).toBe(patched.item.nextRunAt);

      // Hourly cadence: next fire within the next hour (intervalHours=1).
      const nextMs = new Date(newPending.scheduled_for.replace(" ", "T") + "Z").getTime();
      const deltaMs = nextMs - Date.now();
      expect(deltaMs).toBeGreaterThanOrEqual(0);
      expect(deltaMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
    });
  });
});
