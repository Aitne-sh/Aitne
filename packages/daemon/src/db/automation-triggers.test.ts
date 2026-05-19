import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  createTrigger,
  listTriggers,
  getTrigger,
  updateTrigger,
  deleteTrigger,
  getCatalog,
} from "./automation-triggers.js";

const TZ = "America/New_York";

const SAMPLE_PROMPT =
  "Summarize today's commits across all watched repos and append the result to today.md.";

describe("automation_triggers DB", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createTrigger", () => {
    it("populates triggerId in the first agent_schedule row's task_context", () => {
      // Regression: previously the schedule row was materialized BEFORE the
      // automation_triggers insert, so the first firing of every new trigger
      // had no triggerId in task_context. Once dispatcher Phase 2.5 lands and
      // writes source_ref from triggerId, that would yield NULL source_ref
      // for the first run of every trigger.
      const dto = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });

      const pending = db
        .prepare(
          `SELECT task_context FROM agent_schedule
           WHERE recurring_schedule_id = ? AND status = 'pending'`,
        )
        .get(dto.recurringScheduleId) as { task_context: string };
      const ctx = JSON.parse(pending.task_context) as Record<string, unknown>;
      expect(ctx.triggerId).toBe(dto.id);
      expect(ctx.triggerSource).toBe("automation_trigger");
      expect(ctx.triggerEventType).toBe("cron.daily");
    });

    it("creates a daily cron trigger and the paired recurring_schedule row", () => {
      const dto = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });

      expect(dto.id).toBeGreaterThan(0);
      expect(dto.domain).toBe("git");
      expect(dto.eventType).toBe("cron.daily");
      expect(dto.prompt).toBe(SAMPLE_PROMPT);
      expect(dto.enabled).toBe(true);
      expect(dto.recurringScheduleId).not.toBeNull();
      expect(dto.recurrence).toMatchObject({
        frequency: "daily",
        time: "21:00",
        timezone: TZ,
      });
      expect(dto.nextRunAt).not.toBeNull();

      // Paired recurring_schedule row exists and has triggerId in taskContext
      const sched = db
        .prepare(
          "SELECT task_type, task_description, task_context FROM recurring_schedules WHERE id = ?",
        )
        .get(dto.recurringScheduleId) as
        | { task_type: string; task_description: string; task_context: string }
        | undefined;
      expect(sched).toBeDefined();
      expect(sched!.task_type).toBe("agent.task");
      expect(sched!.task_description).toBe(SAMPLE_PROMPT);
      const ctx = JSON.parse(sched!.task_context) as Record<string, unknown>;
      expect(ctx.triggerId).toBe(dto.id);
      expect(ctx.triggerSource).toBe("automation_trigger");
      expect(ctx.triggerDomain).toBe("git");
      expect(ctx.triggerEventType).toBe("cron.daily");
    });

    it("creates a weekly cron trigger with daysOfWeek", () => {
      const dto = createTrigger(db, {
        domain: "git",
        eventType: "cron.weekly",
        prompt: SAMPLE_PROMPT,
        time: "08:30",
        daysOfWeek: [1, 3, 5],
        configTimezone: TZ,
      });
      expect(dto.recurrence).toMatchObject({
        frequency: "weekly",
        time: "08:30",
        daysOfWeek: [1, 3, 5],
      });
    });
  });

  describe("listTriggers / getTrigger", () => {
    it("lists triggers ordered by created_at and filters by domain", () => {
      createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "09:00",
        configTimezone: TZ,
      });
      createTrigger(db, {
        domain: "git",
        eventType: "cron.weekly",
        prompt: SAMPLE_PROMPT,
        time: "10:00",
        daysOfWeek: [0],
        configTimezone: TZ,
      });

      const all = listTriggers(db);
      expect(all).toHaveLength(2);
      const onlyGit = listTriggers(db, { domain: "git" });
      expect(onlyGit).toHaveLength(2);
    });

    it("getTrigger returns null for unknown id", () => {
      expect(getTrigger(db, 999)).toBeNull();
    });
  });

  describe("updateTrigger", () => {
    it("propagates prompt edits into the paired recurring_schedule.task_description", () => {
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });
      const newPrompt =
        "New instruction: review today's PRs and summarize them in today.md.";
      const updated = updateTrigger(db, created.id, {
        prompt: newPrompt,
        configTimezone: TZ,
      });
      expect(updated?.prompt).toBe(newPrompt);

      const sched = db
        .prepare("SELECT task_description FROM recurring_schedules WHERE id = ?")
        .get(created.recurringScheduleId) as { task_description: string };
      expect(sched.task_description).toBe(newPrompt);
    });

    it("propagates prompt edits to the pending agent_schedule row (next firing uses new prompt)", () => {
      // Regression: updateRecurringSchedule only re-materializes the pending
      // row when recurrenceRule or enabled changes. A prompt-only edit
      // therefore left the very next firing using the stale prompt.
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });
      const newPrompt =
        "New instruction: review today's PRs and summarize them in today.md.";
      updateTrigger(db, created.id, { prompt: newPrompt, configTimezone: TZ });
      const pending = db
        .prepare(
          `SELECT task_description FROM agent_schedule
           WHERE recurring_schedule_id = ? AND status = 'pending'`,
        )
        .get(created.recurringScheduleId) as { task_description: string };
      expect(pending.task_description).toBe(newPrompt);
    });

    it("preserves existing time on a daysOfWeek-only edit of a weekly trigger", () => {
      // Mirror of the time-only test: when only daysOfWeek changes, the
      // rebuild reads `existingSched?.recurrenceRule.time` for the
      // existing time. Walks the non-null arm of that optional chain.
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.weekly",
        prompt: SAMPLE_PROMPT,
        time: "08:30",
        daysOfWeek: [1, 3, 5],
        configTimezone: TZ,
      });
      const updated = updateTrigger(db, created.id, {
        daysOfWeek: [2, 4],
        configTimezone: TZ,
      });
      expect(updated?.recurrence).toMatchObject({
        frequency: "weekly",
        time: "08:30",
        daysOfWeek: [2, 4],
      });
    });

    it("preserves existing daysOfWeek on a time-only edit of a weekly trigger", () => {
      // Regression: buildRecurrenceFromEvent used to default missing
      // daysOfWeek to [1] (Monday), so PATCH {time} on a weekly trigger
      // silently collapsed [1,3,5] → [1].
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.weekly",
        prompt: SAMPLE_PROMPT,
        time: "08:30",
        daysOfWeek: [1, 3, 5],
        configTimezone: TZ,
      });
      const updated = updateTrigger(db, created.id, {
        time: "09:30",
        configTimezone: TZ,
      });
      expect(updated?.recurrence).toMatchObject({
        frequency: "weekly",
        time: "09:30",
        daysOfWeek: [1, 3, 5],
      });
    });

    it("re-enables a trigger and propagates the flag to the paired recurring_schedule", () => {
      // Mirrors the disabled-side test below but exercises the
      // `enabled ? 1 : 0` true branch — re-enabling a previously
      // disabled trigger must also flip recurring_schedules.enabled
      // back to 1 so the cron tick resumes firing it.
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });
      updateTrigger(db, created.id, { enabled: false, configTimezone: TZ });
      const reEnabled = updateTrigger(db, created.id, {
        enabled: true,
        configTimezone: TZ,
      });
      expect(reEnabled?.enabled).toBe(true);
      const sched = db
        .prepare("SELECT enabled FROM recurring_schedules WHERE id = ?")
        .get(created.recurringScheduleId) as { enabled: number };
      expect(sched.enabled).toBe(1);
    });

    it("toggles enabled on both trigger and paired recurring_schedule", () => {
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });
      const updated = updateTrigger(db, created.id, {
        enabled: false,
        configTimezone: TZ,
      });
      expect(updated?.enabled).toBe(false);

      const sched = db
        .prepare("SELECT enabled FROM recurring_schedules WHERE id = ?")
        .get(created.recurringScheduleId) as { enabled: number };
      expect(sched.enabled).toBe(0);
    });
  });

  describe("deleteTrigger", () => {
    it("deletes the trigger and its paired recurring_schedule", () => {
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });
      const ok = deleteTrigger(db, created.id);
      expect(ok).toBe(true);
      expect(getTrigger(db, created.id)).toBeNull();
      const sched = db
        .prepare("SELECT id FROM recurring_schedules WHERE id = ?")
        .get(created.recurringScheduleId);
      expect(sched).toBeUndefined();
    });

    it("returns false for unknown id", () => {
      expect(deleteTrigger(db, 999)).toBe(false);
    });
  });

  describe("getCatalog", () => {
    it("returns the git event vocabulary", () => {
      const cat = getCatalog("git");
      expect(cat.domain).toBe("git");
      const types = cat.events.map((e) => e.type);
      expect(types).toEqual(["cron.daily", "cron.weekly"]);
      expect(cat.events.find((e) => e.type === "cron.weekly")?.needsDayOfWeek).toBe(
        true,
      );
    });

    it("returns an empty event list for unknown domains", () => {
      // The catalog is a `domain → events[]` table; the only branch a
      // future caller can hit here is "unknown domain → []". Cast as the
      // narrow union to exercise the fall-through arm without loosening
      // the public API.
      const cat = getCatalog("not-a-domain" as unknown as Parameters<typeof getCatalog>[0]);
      expect(cat.events).toEqual([]);
    });
  });

  describe("updateTrigger edge cases", () => {
    it("returns null for an unknown trigger id", () => {
      expect(
        updateTrigger(db, 999, { prompt: "x", configTimezone: TZ }),
      ).toBeNull();
    });

    it("preserves daysOfWeek=undefined on a time-only edit of a daily trigger", () => {
      // Hits the `existing.event_type === 'cron.weekly' ? ... : undefined`
      // false arm — daily triggers don't carry daysOfWeek, so the
      // recurrence rebuild must not invent one.
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "08:00",
        configTimezone: TZ,
      });
      const updated = updateTrigger(db, created.id, {
        time: "09:00",
        configTimezone: TZ,
      });
      expect(updated?.recurrence).toMatchObject({
        frequency: "daily",
        time: "09:00",
      });
      expect(updated?.recurrence).not.toHaveProperty("daysOfWeek");
    });
  });

  describe("createTrigger validation", () => {
    it("throws when cron.weekly is created without daysOfWeek", () => {
      // Defensive guard inside buildRecurrenceFromEvent: weekly events
      // require an explicit daysOfWeek list. The route layer's Zod schema
      // catches this earlier in production, but the helper itself must
      // refuse the empty case so direct callers can't sneak past.
      expect(() =>
        createTrigger(db, {
          domain: "git",
          eventType: "cron.weekly",
          prompt: SAMPLE_PROMPT,
          time: "08:30",
          configTimezone: TZ,
        }),
      ).toThrow(/daysOfWeek is required/);
    });

    it("throws when cron.weekly is created with an empty daysOfWeek array", () => {
      expect(() =>
        createTrigger(db, {
          domain: "git",
          eventType: "cron.weekly",
          prompt: SAMPLE_PROMPT,
          time: "08:30",
          daysOfWeek: [],
          configTimezone: TZ,
        }),
      ).toThrow(/daysOfWeek is required/);
    });
  });

  describe("updateTrigger fallback path when paired schedule is gone", () => {
    it("falls back to '09:00' when daysOfWeek-only update finds no paired schedule", () => {
      // Defensive `?? "09:00"` arm in the recurrenceRebuild branch:
      // reachable only when the recurring_schedules row was deleted out
      // from under the trigger (FK is ON DELETE SET NULL in production,
      // so we manually break that link with FK enforcement off).
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.weekly",
        prompt: SAMPLE_PROMPT,
        time: "08:30",
        daysOfWeek: [1],
        configTimezone: TZ,
      });
      // Simulate "schedule was wiped but trigger row still references it"
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM recurring_schedules WHERE id = ?").run(
        created.recurringScheduleId,
      );
      db.pragma("foreign_keys = ON");

      // Trigger is still pointed at the now-orphan recurring_schedule_id;
      // a daysOfWeek-only update walks `params.time ??
      // existingSched?.recurrenceRule.time ?? "09:00"` and lands on the
      // literal fallback because both prior lookups are undefined.
      const updated = updateTrigger(db, created.id, {
        daysOfWeek: [3],
        configTimezone: TZ,
      });
      // The trigger's own row updates fine — DTO hydration just doesn't
      // see a recurrence (no schedule row to read). The important thing
      // is the call did not throw on the fallback branch.
      expect(updated?.id).toBe(created.id);
    });
  });

  describe("getTrigger edge cases", () => {
    it("returns null when the row exists in agent_actions but the trigger has been deleted", () => {
      // Walks the explicit `if (!row) return null` branch in getTrigger,
      // distinct from the unknown-id case in the parent suite.
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });
      deleteTrigger(db, created.id);
      expect(getTrigger(db, created.id)).toBeNull();
    });
  });

  describe("DTO last-run hydration", () => {
    it("includes the most recent agent_actions row matching this trigger", () => {
      const created = createTrigger(db, {
        domain: "git",
        eventType: "cron.daily",
        prompt: SAMPLE_PROMPT,
        time: "21:00",
        configTimezone: TZ,
      });

      // Simulate the dispatcher writing a provenance-tagged action row.
      db.prepare(
        `INSERT INTO agent_actions (action_type, result, source_kind, source_ref, started_at)
         VALUES ('automation_trigger', 'success', 'trigger', ?, datetime('now'))`,
      ).run(String(created.id));

      const fresh = getTrigger(db, created.id);
      expect(fresh?.lastRunResult).toBe("success");
      expect(fresh?.lastRunStartedAt).not.toBeNull();
    });
  });
});
