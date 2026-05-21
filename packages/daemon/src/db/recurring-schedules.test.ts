import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  createRecurringSchedule,
  listRecurringSchedules,
  getRecurringSchedule,
  updateRecurringSchedule,
  deleteRecurringSchedule,
  reconcileRecurringSchedules,
} from "./recurring-schedules.js";
import {
  computeNextOccurrence,
  formatRecurrenceLabel,
} from "../core/recurrence.js";
import { formatSqliteDatetime } from "@aitne/shared";
import type { RecurrenceRule } from "@aitne/shared";

const TZ = "America/New_York";

function makeRule(overrides?: Partial<RecurrenceRule>): RecurrenceRule {
  return {
    frequency: "daily",
    time: "09:00",
    timezone: TZ,
    ...overrides,
  };
}

describe("recurring-schedules DB", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createRecurringSchedule", () => {
    it("creates a recurring schedule and generates the first agent_schedule row", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Daily standup preparation task for the morning",
        recurrenceRule: makeRule(),
      });

      expect(dto.id).toBeGreaterThan(0);
      expect(dto.taskType).toBe("wake");
      expect(dto.enabled).toBe(true);
      expect(dto.nextRunAt).not.toBeNull();
      expect(dto.recurrenceLabel).toBe("Daily at 09:00");

      // Verify agent_schedule row was created
      const scheduleRow = db.prepare(
        "SELECT * FROM agent_schedule WHERE recurring_schedule_id = ?",
      ).get(dto.id) as { status: string; recurring_schedule_id: number } | undefined;

      expect(scheduleRow).toBeDefined();
      expect(scheduleRow!.status).toBe("pending");
      expect(scheduleRow!.recurring_schedule_id).toBe(dto.id);
    });

    it("persists model as NULL when caller does not pin one (no `process_backend_config` override)", () => {
      // Regression: previously `?? 'sonnet'` plus the schema's
      // `DEFAULT 'sonnet'` made every unpinned recurring row force
      // `event.requestedModel='sonnet'` downstream, silently
      // overriding any operator pin in `process_backend_config` for
      // `agent.task` / `agent.dm_task`.
      const dto = createRecurringSchedule(db, {
        taskType: "dm_session",
        description: "morning briefing — daily summary placeholder text",
        recurrenceRule: makeRule(),
      });
      expect(dto.model).toBeNull();

      const recurringRow = db
        .prepare("SELECT model FROM recurring_schedules WHERE id = ?")
        .get(dto.id) as { model: string | null };
      expect(recurringRow.model).toBeNull();

      const scheduleRow = db
        .prepare("SELECT model FROM agent_schedule WHERE recurring_schedule_id = ?")
        .get(dto.id) as { model: string | null };
      expect(scheduleRow.model).toBeNull();
    });

    it("persists explicit `model: 'opus'` end-to-end so operator escape hatches survive", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Daily heavy task that must run on Opus regardless",
        recurrenceRule: makeRule(),
        model: "opus",
      });
      expect(dto.model).toBe("opus");

      const scheduleRow = db
        .prepare("SELECT model FROM agent_schedule WHERE recurring_schedule_id = ?")
        .get(dto.id) as { model: string };
      expect(scheduleRow.model).toBe("opus");
    });

    it("persists `tier: 'lite'` end-to-end and inherits it onto the materialized child row", () => {
      // The recurring → child inheritance is the primary value
      // proposition of the column: a docker-health-check recurring
      // schedule registered with `tier: 'lite'` must produce child
      // rows that also carry `tier_override = 'lite'`, otherwise
      // the cost story collapses on every materialised tick.
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Hourly docker container health check — DM if restart loop detected",
        recurrenceRule: makeRule(),
        tier: "lite",
      });
      expect(dto.tier).toBe("lite");

      const recurringRow = db
        .prepare("SELECT tier_override FROM recurring_schedules WHERE id = ?")
        .get(dto.id) as { tier_override: string };
      expect(recurringRow.tier_override).toBe("lite");

      const scheduleRow = db
        .prepare("SELECT tier_override FROM agent_schedule WHERE recurring_schedule_id = ?")
        .get(dto.id) as { tier_override: string };
      expect(scheduleRow.tier_override).toBe("lite");
    });

    it("persists tier as NULL when omitted (mirrors model's no-override contract)", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "No tier override — let process-key default apply",
        recurrenceRule: makeRule(),
      });
      expect(dto.tier).toBeNull();

      const scheduleRow = db
        .prepare("SELECT tier_override FROM agent_schedule WHERE recurring_schedule_id = ?")
        .get(dto.id) as { tier_override: string | null };
      expect(scheduleRow.tier_override).toBeNull();
    });

    it("persists prompt override end-to-end and copies it to the materialized agent_schedule row", () => {
      // Without this guarantee, a recurring with a prompt override would
      // silently drop the override at fire time — the agent would receive
      // the short description label instead of the operator's full prompt.
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Short label for the schedule list view",
        prompt: "Detailed agent body that overrides the short description",
        recurrenceRule: makeRule(),
      });
      expect(dto.prompt).toBe(
        "Detailed agent body that overrides the short description",
      );

      const recurringRow = db
        .prepare("SELECT task_prompt FROM recurring_schedules WHERE id = ?")
        .get(dto.id) as { task_prompt: string | null };
      expect(recurringRow.task_prompt).toBe(
        "Detailed agent body that overrides the short description",
      );

      const scheduleRow = db
        .prepare("SELECT task_description, task_prompt FROM agent_schedule WHERE recurring_schedule_id = ?")
        .get(dto.id) as { task_description: string; task_prompt: string | null };
      expect(scheduleRow.task_description).toBe("Short label for the schedule list view");
      expect(scheduleRow.task_prompt).toBe(
        "Detailed agent body that overrides the short description",
      );
    });

    // SCHEDULE_API_REDESIGN_PLAN §4.3a regression — when an operator
    // pins a registered full model id (e.g. claude-opus-4-7), the
    // route must pair the (backendId, modelId) tuple on the row.
    // The DB layer must carry BOTH columns through to the materialized
    // agent_schedule row, otherwise the scheduler's read-side branch
    // falls back to no-override and the pin is silently dropped.
    it("carries `backendId` into both the parent row and the materialized child row", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Pinned to Opus 4.7 — heavy weekly synthesis",
        recurrenceRule: makeRule({ frequency: "weekly", daysOfWeek: [1] }),
        model: "claude-opus-4-7",
        backendId: "claude",
      });
      expect(dto.model).toBe("claude-opus-4-7");
      expect(dto.backendId).toBe("claude");

      const recurringRow = db
        .prepare(
          "SELECT model, backend_id FROM recurring_schedules WHERE id = ?",
        )
        .get(dto.id) as { model: string; backend_id: string };
      expect(recurringRow.model).toBe("claude-opus-4-7");
      expect(recurringRow.backend_id).toBe("claude");

      const scheduleRow = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE recurring_schedule_id = ?",
        )
        .get(dto.id) as { model: string; backend_id: string };
      expect(scheduleRow.model).toBe("claude-opus-4-7");
      expect(scheduleRow.backend_id).toBe("claude");
    });

    it("persists backendId as NULL when caller does not pin one (alias / pure-tier paths)", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Alias path — no backend pin",
        recurrenceRule: makeRule(),
        model: "opus",
      });
      expect(dto.backendId).toBeNull();

      const scheduleRow = db
        .prepare(
          "SELECT backend_id FROM agent_schedule WHERE recurring_schedule_id = ?",
        )
        .get(dto.id) as { backend_id: string | null };
      expect(scheduleRow.backend_id).toBeNull();
    });

    it("persists prompt as NULL when caller does not supply one (preserves description-as-body behavior)", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Description doubles as the agent body when no prompt is set",
        recurrenceRule: makeRule(),
      });
      expect(dto.prompt).toBeNull();

      const scheduleRow = db
        .prepare("SELECT task_prompt FROM agent_schedule WHERE recurring_schedule_id = ?")
        .get(dto.id) as { task_prompt: string | null };
      expect(scheduleRow.task_prompt).toBeNull();
    });
  });

  describe("listRecurringSchedules", () => {
    it("lists all recurring schedules", () => {
      createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });
      createRecurringSchedule(db, {
        taskType: "report",
        description: "Weekly report generation for stakeholders",
        recurrenceRule: makeRule({ frequency: "weekly", daysOfWeek: [1] }),
      });

      const items = listRecurringSchedules(db);
      expect(items).toHaveLength(2);
    });

    it("filters by enabled only", () => {
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });
      updateRecurringSchedule(db, dto.id, { enabled: false });

      createRecurringSchedule(db, {
        taskType: "report",
        description: "Weekly report generation for stakeholders",
        recurrenceRule: makeRule({ frequency: "weekly", daysOfWeek: [1] }),
      });

      const all = listRecurringSchedules(db);
      expect(all).toHaveLength(2);

      const enabledOnly = listRecurringSchedules(db, { enabledOnly: true });
      expect(enabledOnly).toHaveLength(1);
      expect(enabledOnly[0].taskType).toBe("report");
    });
  });

  describe("getRecurringSchedule", () => {
    it("returns a single schedule by ID", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const dto = getRecurringSchedule(db, created.id);
      expect(dto).not.toBeNull();
      expect(dto!.id).toBe(created.id);
    });

    it("returns null for non-existent ID", () => {
      expect(getRecurringSchedule(db, 999)).toBeNull();
    });
  });

  describe("updateRecurringSchedule", () => {
    it("updates description", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const updated = updateRecurringSchedule(db, created.id, {
        description: "Updated standup preparation description for the team",
      });

      expect(updated!.description).toBe("Updated standup preparation description for the team");
    });

    it("updates recurrence rule and reschedules", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const oldPending = db.prepare(
        "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).get(created.id) as { cnt: number };
      expect(oldPending.cnt).toBe(1);

      updateRecurringSchedule(db, created.id, {
        recurrenceRule: makeRule({ time: "10:00" }),
      });

      // Old pending should be skipped, new one created
      const skipped = db.prepare(
        "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'skipped'",
      ).get(created.id) as { cnt: number };
      expect(skipped.cnt).toBe(1);

      const newPending = db.prepare(
        "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).get(created.id) as { cnt: number };
      expect(newPending.cnt).toBe(1);
    });

    it("disabling cancels pending rows and clears next_run_at", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const updated = updateRecurringSchedule(db, created.id, { enabled: false });
      expect(updated!.enabled).toBe(false);
      expect(updated!.nextRunAt).toBeNull();

      const pending = db.prepare(
        "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).get(created.id) as { cnt: number };
      expect(pending.cnt).toBe(0);
    });

    it("updates model field", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const updated = updateRecurringSchedule(db, created.id, { model: "opus" });
      expect(updated!.model).toBe("opus");
    });

    // SCHEDULE_API_REDESIGN_PLAN §4.3a — PATCH updates that flip an
    // alias-pinned row to a registered-id pin (or vice versa) must
    // move BOTH `model` and `backend_id` in lockstep. Clearing one
    // without the other leaves the row in a half-pinned state that
    // the scheduler can't honor.
    it("sets backendId paired with model on a previously unpinned row", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Upgrade to a registered Opus 4.7 pin via PATCH",
        recurrenceRule: makeRule(),
      });
      expect(created.backendId).toBeNull();

      const updated = updateRecurringSchedule(db, created.id, {
        model: "claude-opus-4-7",
        backendId: "claude",
      });
      expect(updated!.model).toBe("claude-opus-4-7");
      expect(updated!.backendId).toBe("claude");
    });

    it("clears backendId to NULL via explicit null sentinel", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Pinned, then unpinned via PATCH null sentinel",
        recurrenceRule: makeRule(),
        model: "claude-opus-4-7",
        backendId: "claude",
      });

      const cleared = updateRecurringSchedule(db, created.id, {
        model: null,
        backendId: null,
      });
      expect(cleared!.model).toBeNull();
      expect(cleared!.backendId).toBeNull();
    });

    it("preserves backendId on a recurrenceRule-only update (no unintended drop)", () => {
      // A PATCH that only changes the rule must not silently null out
      // the model pin on the parent row, otherwise the next reconcile
      // would re-materialize without the operator's pin.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Pinned to Opus 4.7, then PATCH the rule only",
        recurrenceRule: makeRule(),
        model: "claude-opus-4-7",
        backendId: "claude",
      });

      const updated = updateRecurringSchedule(db, created.id, {
        recurrenceRule: makeRule({ time: "10:00" }),
      });
      expect(updated!.model).toBe("claude-opus-4-7");
      expect(updated!.backendId).toBe("claude");

      const childRow = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.id) as { model: string; backend_id: string };
      expect(childRow.model).toBe("claude-opus-4-7");
      expect(childRow.backend_id).toBe("claude");
    });

    it("updates taskContext field", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const context = { priority: "high", tags: ["urgent"] };
      const updated = updateRecurringSchedule(db, created.id, { taskContext: context });
      expect(updated!.taskContext).toEqual(context);
    });

    it("sets and then clears the prompt override (null is the explicit clear sentinel)", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Description doubles as agent body when no prompt is set",
        recurrenceRule: makeRule(),
      });
      expect(created.prompt).toBeNull();

      const set = updateRecurringSchedule(db, created.id, {
        prompt: "Detailed override that takes precedence over the description",
      });
      expect(set!.prompt).toBe(
        "Detailed override that takes precedence over the description",
      );

      const cleared = updateRecurringSchedule(db, created.id, { prompt: null });
      expect(cleared!.prompt).toBeNull();
      // After clear, the row's task_prompt is NULL again — dispatcher will
      // fall back to task_description for the agent body.
      const row = db
        .prepare("SELECT task_prompt FROM recurring_schedules WHERE id = ?")
        .get(created.id) as { task_prompt: string | null };
      expect(row.task_prompt).toBeNull();
    });

    it("returns null for non-existent ID", () => {
      expect(updateRecurringSchedule(db, 999, { description: "no such schedule, at least 20 chars" })).toBeNull();
    });
  });

  describe("deleteRecurringSchedule", () => {
    it("deletes and cancels pending rows", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      // Capture the pending row's ID before deletion
      const pendingRow = db.prepare(
        "SELECT id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).get(created.id) as { id: number };

      const deleted = deleteRecurringSchedule(db, created.id);
      expect(deleted).toBe(true);

      expect(getRecurringSchedule(db, created.id)).toBeNull();

      // The pending row should now be skipped (FK is NULLed for deletion)
      const row = db.prepare(
        "SELECT status, recurring_schedule_id FROM agent_schedule WHERE id = ?",
      ).get(pendingRow.id) as { status: string; recurring_schedule_id: number | null };
      expect(row.status).toBe("skipped");
      expect(row.recurring_schedule_id).toBeNull();
    });

    it("returns false for non-existent ID", () => {
      expect(deleteRecurringSchedule(db, 999)).toBe(false);
    });
  });

  describe("updateRecurringSchedule — no nextOccurrence branch", () => {
    it("enables a schedule with weekly rule and empty daysOfWeek — nextOccurrence is null", () => {
      // A weekly rule with no daysOfWeek returns null from computeNextOccurrence,
      // so the generateNextScheduleRow call is skipped (covers `if (nextOccurrence)` false branch).
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });
      updateRecurringSchedule(db, created.id, { enabled: false });

      const updated = updateRecurringSchedule(db, created.id, {
        enabled: true,
        recurrenceRule: { frequency: "weekly", time: "09:00", timezone: TZ, daysOfWeek: [] },
      });
      // nextOccurrence is null → no agent_schedule row, next_run_at stays null
      expect(updated!.nextRunAt).toBeNull();
    });
  });

  describe("reconcileRecurringSchedules", () => {
    it("skips orphaned row when computeNextOccurrence returns null (empty daysOfWeek)", () => {
      // Insert directly with an empty-daysOfWeek weekly rule so computeNextOccurrence
      // returns null and the reconcile function hits `if (!nextOccurrence) continue`.
      db.prepare(`
        INSERT INTO recurring_schedules
          (task_type, task_description, task_context, model, recurrence_rule, enabled, next_run_at)
        VALUES ('wake', 'No-day weekly', '{}', 'sonnet', ?, 1, NULL)
      `).run(JSON.stringify({ frequency: "weekly", time: "09:00", timezone: TZ, daysOfWeek: [] }));

      const generated = reconcileRecurringSchedules(db);
      expect(generated).toBe(0);
    });

    it("generates a new agent_schedule row when the pending one is completed", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      // Simulate completion of the pending row
      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(created.id);

      const reconciled = reconcileRecurringSchedules(db);
      expect(reconciled).toBe(1);

      const pending = db.prepare(
        "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).get(created.id) as { cnt: number };
      expect(pending.cnt).toBe(1);
    });

    it("preserves backend_id when regenerating an agent_schedule row", () => {
      // Self-healing path: after a fire completes, the next materialized
      // child must inherit both `model` and `backend_id` from the parent.
      // Without this, every Nth fire would silently revert from the
      // operator's registered-id pin to process-key defaults.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Pinned recurring — backend_id must survive reconcile",
        recurrenceRule: makeRule(),
        model: "claude-opus-4-7",
        backendId: "claude",
      });

      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(created.id);

      reconcileRecurringSchedules(db);

      const newRow = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.id) as { model: string; backend_id: string };
      expect(newRow.model).toBe("claude-opus-4-7");
      expect(newRow.backend_id).toBe("claude");
    });

    it("preserves task_prompt when regenerating an agent_schedule row", () => {
      // Self-healing path: after a recurring fires and completes, the
      // reconciler must re-materialize with the same prompt override —
      // otherwise every Nth occurrence would silently revert to using the
      // description as the agent body.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Short list label",
        prompt: "Detailed agent body that the dispatcher must keep using on every fire",
        recurrenceRule: makeRule(),
      });

      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(created.id);

      reconcileRecurringSchedules(db);

      const newRow = db
        .prepare(
          "SELECT task_prompt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.id) as { task_prompt: string | null };
      expect(newRow.task_prompt).toBe(
        "Detailed agent body that the dispatcher must keep using on every fire",
      );
    });

    it("does not generate a row when one is already pending", () => {
      createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      const reconciled = reconcileRecurringSchedules(db);
      expect(reconciled).toBe(0);
    });

    it("skips disabled recurring schedules", () => {
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Morning standup preparation for the team",
        recurrenceRule: makeRule(),
      });

      updateRecurringSchedule(db, created.id, { enabled: false });

      // Simulate completion of all rows
      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ?",
      ).run(created.id);

      const reconciled = reconcileRecurringSchedules(db);
      expect(reconciled).toBe(0);
    });
  });

  // ── Phase E — hourly cadence reconcile coverage ──────────────────
  //
  // SCHEDULE_API_REDESIGN_PLAN §11 step 5 acceptance criteria:
  //   (a) `next_run_at` computation matches `computeNextHourly`.
  //   (b) the auto-materialized first agent_schedule row carries
  //       `backend_id` correctly from the parent (hourly variant —
  //       daily is already covered above).
  //   (c) reconcile generates the next hourly agent_schedule row
  //       after the prior one completes, with both `model` and
  //       `backend_id` intact.
  //
  // These are guard-rails: the DB layer already inherits the columns
  // and dispatches the recurrence engine generically by `frequency`,
  // so a future refactor that introduces a frequency-specific branch
  // is the regression risk these tests pin down.
  describe("hourly cadence — Phase E reconcile coverage", () => {
    /** Sandwich a route/reconcile call between two `new Date()` references
     *  and return the set of `next_run_at` strings the recurrence engine
     *  would produce given either reference. The actual persisted value
     *  must be one of these two strings — a single-bucket check is
     *  flaky across minute boundaries. */
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

    it("first materialized agent_schedule row mirrors computeNextHourly exactly", () => {
      const rule: RecurrenceRule = { frequency: "hourly", timezone: TZ };

      const before = new Date();
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Hourly tick — verify first child mirrors recurrence engine",
        recurrenceRule: rule,
      });
      const after = new Date();

      const expected = expectedNextRunBracket(rule, before, after);

      expect(dto.nextRunAt).not.toBeNull();
      expect(expected).toContain(dto.nextRunAt!);
      expect(dto.recurrenceLabel).toBe(formatRecurrenceLabel(rule));

      const childRow = db
        .prepare(
          "SELECT scheduled_for FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(dto.id) as { scheduled_for: string };
      expect(expected).toContain(childRow.scheduled_for);
    });

    it("first materialized hourly row carries backend_id and model from parent", () => {
      // Phase E acceptance (b) — backend_id propagation on the hourly
      // variant. The daily variant of this test lives above
      // ("carries `backendId` into both the parent row and the
      // materialized child row"); duplicating for hourly so a future
      // frequency-keyed code path can't silently drop the pin only for
      // hourly cadence.
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Hourly Opus 4.7 — pin must reach the first child",
        recurrenceRule: { frequency: "hourly", intervalHours: 2, minuteOfHour: 30, timezone: TZ },
        model: "claude-opus-4-7",
        backendId: "claude",
      });

      const childRow = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(dto.id) as { model: string; backend_id: string };
      expect(childRow.model).toBe("claude-opus-4-7");
      expect(childRow.backend_id).toBe("claude");
    });

    it("reconcile re-materializes a hourly row whose scheduled_for matches computeNextHourly", () => {
      // Phase E acceptance (c) + (a) combined — after the first fire
      // completes, the reconciler must use computeNextOccurrence (which
      // dispatches to computeNextHourly) with `now` as the reference.
      // The new pending row's scheduled_for and the parent's
      // next_run_at must agree byte-for-byte.
      const rule: RecurrenceRule = { frequency: "hourly", timezone: TZ };
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Hourly tick — verify reconcile honours computeNextHourly",
        recurrenceRule: rule,
      });

      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(created.id);

      const before = new Date();
      const reconciled = reconcileRecurringSchedules(db);
      const after = new Date();
      expect(reconciled).toBe(1);

      const expected = expectedNextRunBracket(rule, before, after);

      const newRow = db
        .prepare(
          "SELECT scheduled_for FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.id) as { scheduled_for: string };
      expect(expected).toContain(newRow.scheduled_for);

      const parentRow = db
        .prepare(
          "SELECT next_run_at FROM recurring_schedules WHERE id = ?",
        )
        .get(created.id) as { next_run_at: string };
      expect(parentRow.next_run_at).toBe(newRow.scheduled_for);
    });

    it("reconcile preserves backend_id + model on the regenerated hourly child", () => {
      // Phase E acceptance (b) on the reconcile path. The pinned
      // backend has to survive every Nth fire, not just the first.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Hourly Opus 4.7 — backend_id must survive reconcile",
        recurrenceRule: { frequency: "hourly", intervalHours: 1, minuteOfHour: 0, timezone: TZ },
        model: "claude-opus-4-7",
        backendId: "claude",
      });

      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ? AND status = 'pending'",
      ).run(created.id);

      const reconciled = reconcileRecurringSchedules(db);
      expect(reconciled).toBe(1);

      const newRow = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.id) as { model: string; backend_id: string };
      expect(newRow.model).toBe("claude-opus-4-7");
      expect(newRow.backend_id).toBe("claude");
    });

    it("PATCH daily → hourly cancels the old pending child and re-materializes hourly with backend_id intact", () => {
      // PATCH path through the DB layer (route-level parity test
      // lives in api/routes/recurring-schedules.test.ts). The
      // recurrence-rule-change branch in `updateRecurringSchedule`
      // skips the old pending row and calls `generateNextScheduleRow`
      // — that helper must pick up the parent's `backend_id` column,
      // not infer it from the old child's row.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Starts daily, then PATCH'd to hourly — pin must survive",
        recurrenceRule: makeRule(),
        model: "claude-opus-4-7",
        backendId: "claude",
      });

      const oldChildId = (
        db
          .prepare(
            "SELECT id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
          )
          .get(created.id) as { id: number }
      ).id;

      const updated = updateRecurringSchedule(db, created.id, {
        recurrenceRule: {
          frequency: "hourly",
          intervalHours: 1,
          minuteOfHour: 0,
          timezone: TZ,
        },
      });
      expect(updated!.recurrenceRule.frequency).toBe("hourly");
      expect(updated!.model).toBe("claude-opus-4-7");
      expect(updated!.backendId).toBe("claude");

      const oldChild = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(oldChildId) as { status: string };
      expect(oldChild.status).toBe("skipped");

      const newChild = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(created.id) as { model: string; backend_id: string };
      expect(newChild.model).toBe("claude-opus-4-7");
      expect(newChild.backend_id).toBe("claude");
    });
  });

  describe("rowToDTO — legacy NULL/empty backfills", () => {
    it("treats a row with NULL task_description as an empty string and rehydrates `{}` from empty task_context", () => {
      // Defensive fallback for rows hand-crafted by tests, written by
      // older code paths before `task_description NOT NULL`, or where
      // a future migration leaves the JSON column as the empty string.
      const rule = makeRule();
      db.prepare(
        "INSERT INTO recurring_schedules (task_type, task_description, task_context, recurrence_rule, enabled) VALUES (?, NULL, '', ?, 1)",
      ).run("wake", JSON.stringify(rule));

      const dto = listRecurringSchedules(db)[0]!;
      expect(dto.description).toBe("");
      expect(dto.taskContext).toEqual({});
    });
  });

  describe("createRecurringSchedule — degenerate rule yielding null nextOccurrence", () => {
    it("persists the row with `next_run_at = NULL` and skips child materialization when the rule has no future occurrence", () => {
      // A weekly rule with no days selected is a degenerate input — the
      // schema's CHECK does not reject it, so the runtime must handle it
      // gracefully (no INSERT into agent_schedule, no crash).
      const dto = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Degenerate weekly rule with empty daysOfWeek selection",
        recurrenceRule: {
          frequency: "weekly",
          time: "09:00",
          timezone: TZ,
          daysOfWeek: [],
        },
      });

      expect(dto.nextRunAt).toBeNull();
      const children = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ?",
        )
        .get(dto.id) as { cnt: number };
      expect(children.cnt).toBe(0);
    });
  });

  describe("updateRecurringSchedule — empty patch", () => {
    it("returns the existing row untouched when the PATCH body carries no recognised keys", () => {
      // The route allows callers to PATCH with an empty body to refresh
      // computed fields (`recurrenceLabel`) without writing — the code
      // path early-returns once no `updates` accumulate.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "No-op PATCH must not bump updated_at or rewrite columns",
        recurrenceRule: makeRule(),
      });

      const updatedAtBefore = db
        .prepare("SELECT updated_at FROM recurring_schedules WHERE id = ?")
        .get(created.id) as { updated_at: string };

      const result = updateRecurringSchedule(db, created.id, {});
      expect(result!.id).toBe(created.id);

      const updatedAtAfter = db
        .prepare("SELECT updated_at FROM recurring_schedules WHERE id = ?")
        .get(created.id) as { updated_at: string };
      expect(updatedAtAfter.updated_at).toBe(updatedAtBefore.updated_at);
    });
  });

  describe("updateRecurringSchedule — recurrenceRule change with legacy NULL task_description", () => {
    it("rehydrates NULL task_description as empty string and empty task_context as `{}` when regenerating the child row", () => {
      // Same legacy-row defensive path as in `reconcileRecurringSchedules`,
      // but for the PATCH-driven recompute branch.
      const rule = makeRule();
      const result = db.prepare(
        "INSERT INTO recurring_schedules (task_type, task_description, task_context, recurrence_rule, enabled) VALUES (?, NULL, '', ?, 1)",
      ).run("wake", JSON.stringify(rule));
      const id = Number(result.lastInsertRowid);

      const updated = updateRecurringSchedule(db, id, {
        recurrenceRule: makeRule({ time: "10:00" }),
      });
      expect(updated!.description).toBe("");
      expect(updated!.taskContext).toEqual({});

      const child = db
        .prepare(
          "SELECT task_description, task_context FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(id) as { task_description: string; task_context: string };
      expect(child.task_description).toBe("");
      expect(JSON.parse(child.task_context)).toMatchObject({ recurringScheduleId: id });
    });
  });

  describe("reconcileRecurringSchedules — missing table guard", () => {
    it("returns 0 when the `recurring_schedules` table is absent (partial schema)", () => {
      // The runner is invoked from `ScheduleWatcher` on every poll. Some
      // historical test setups still hand-craft a partial schema and the
      // reconciler must not throw `SqliteError: no such table` and abort
      // the watcher tick.
      const partial = new Database(":memory:");
      try {
        expect(reconcileRecurringSchedules(partial)).toBe(0);
      } finally {
        partial.close();
      }
    });
  });

  describe("reconcileRecurringSchedules — legacy NULL task_description / empty task_context fallback", () => {
    it("regenerates the child row even when the parent stored NULL description and empty task_context JSON", () => {
      const rule = makeRule();
      const result = db.prepare(
        "INSERT INTO recurring_schedules (task_type, task_description, task_context, recurrence_rule, enabled) VALUES (?, NULL, '', ?, 1)",
      ).run("wake", JSON.stringify(rule));
      const id = Number(result.lastInsertRowid);

      const generated = reconcileRecurringSchedules(db);
      expect(generated).toBe(1);

      const child = db
        .prepare(
          "SELECT task_description, task_context FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(id) as { task_description: string; task_context: string };
      expect(child.task_description).toBe("");
      expect(JSON.parse(child.task_context)).toMatchObject({ recurringScheduleId: id });
    });
  });

  describe("updateRecurringSchedule — tier override", () => {
    it("sets and then clears the tier override via PATCH (`tier: null` is the explicit clear sentinel)", () => {
      // Mirrors the `model` / `prompt` / `backendId` PATCH-clear contracts
      // — `undefined` means "no change", `null` means "drop the override".
      // The tier_override column is what propagates onto every regenerated
      // agent_schedule child, so an explicit-clear path is what lets the
      // operator step back to the process-key default after an override.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Operator pins tier to lite, then clears it back to default",
        recurrenceRule: makeRule(),
      });
      expect(created.tier).toBeNull();

      const set = updateRecurringSchedule(db, created.id, { tier: "high" });
      expect(set!.tier).toBe("high");

      const cleared = updateRecurringSchedule(db, created.id, { tier: null });
      expect(cleared!.tier).toBeNull();

      const row = db
        .prepare("SELECT tier_override FROM recurring_schedules WHERE id = ?")
        .get(created.id) as { tier_override: string | null };
      expect(row.tier_override).toBeNull();
    });
  });

  describe("reconcileRecurringSchedules — malformed row recovery", () => {
    it("disables a row with a corrupt `recurrence_rule` JSON blob and keeps reconciling the rest", () => {
      // Defensive branch: a single malformed JSON row otherwise aborts the
      // whole reconcile tick, blocking healthy schedules behind the bad
      // one forever. The reconciler must catch per-row, disable the
      // offender, and continue.
      const healthy = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Healthy schedule that must still reconcile alongside a bad sibling",
        recurrenceRule: makeRule(),
      });
      const bad = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Will be corrupted so its rule fails JSON.parse on next tick",
        recurrenceRule: makeRule(),
      });

      // Simulate disk corruption / a broken older writer by overwriting
      // the rule column with non-JSON text directly.
      db.prepare(
        "UPDATE recurring_schedules SET recurrence_rule = ? WHERE id = ?",
      ).run("not-json-{", bad.id);

      // Both rows have an active pending child from creation; complete them
      // so the reconciler picks both up as orphaned.
      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id IN (?, ?)",
      ).run(healthy.id, bad.id);

      // Silence the expected per-row error log without losing visibility
      // into unexpected ones.
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const generated = reconcileRecurringSchedules(db);
        expect(generated).toBe(1);
        expect(consoleErr).toHaveBeenCalledTimes(1);
        expect(consoleErr.mock.calls[0]?.[0]).toContain("reconcile row failed");
      } finally {
        consoleErr.mockRestore();
      }

      const badRow = db
        .prepare("SELECT enabled FROM recurring_schedules WHERE id = ?")
        .get(bad.id) as { enabled: number };
      expect(badRow.enabled).toBe(0);

      const healthyChild = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM agent_schedule WHERE recurring_schedule_id = ? AND status = 'pending'",
        )
        .get(healthy.id) as { cnt: number };
      expect(healthyChild.cnt).toBe(1);
    });

    it("swallows a secondary failure when the row-disable UPDATE itself throws", () => {
      // Defense-in-depth: the inner try/catch around the disable-on-error
      // UPDATE must not mask the primary error log nor abort the rest of
      // the reconcile.
      createRecurringSchedule(db, {
        taskType: "wake",
        description: "Row whose recurrence_rule is corrupt and whose UPDATE then throws",
        recurrenceRule: makeRule(),
      });
      const bad = db.prepare("SELECT id FROM recurring_schedules").get() as { id: number };

      db.prepare(
        "UPDATE recurring_schedules SET recurrence_rule = ? WHERE id = ?",
      ).run("not-json-{", bad.id);
      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ?",
      ).run(bad.id);

      const origPrepare = db.prepare.bind(db);
      const prepareSpy = vi
        .spyOn(db, "prepare")
        .mockImplementation((sql: string) => {
          if (sql.includes("SET enabled = 0")) {
            throw new Error("simulated UPDATE failure");
          }
          return origPrepare(sql);
        });
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(() => reconcileRecurringSchedules(db)).not.toThrow();
        expect(consoleErr).toHaveBeenCalledTimes(1);
      } finally {
        prepareSpy.mockRestore();
        consoleErr.mockRestore();
      }
    });

    it("logs the row id and a non-Error rejection's string representation", () => {
      // The catch handler stringifies any non-Error throw via the
      // `String(rowErr)` branch — JSON.parse always throws SyntaxError,
      // but the branch must still be reachable in case a future
      // downstream call (e.g. generateNextScheduleRow) rejects with a
      // primitive. Force the primitive throw by stubbing JSON.parse.
      const created = createRecurringSchedule(db, {
        taskType: "wake",
        description: "Force a non-Error rejection through the catch handler",
        recurrenceRule: makeRule(),
      });
      db.prepare(
        "UPDATE agent_schedule SET status = 'completed' WHERE recurring_schedule_id = ?",
      ).run(created.id);

      const origParse = JSON.parse;
      const parseSpy = vi
        .spyOn(JSON, "parse")
        .mockImplementationOnce(() => {
          throw "string-throw"; // eslint-disable-line @typescript-eslint/only-throw-error
        });
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const generated = reconcileRecurringSchedules(db);
        expect(generated).toBe(0);
        expect(consoleErr).toHaveBeenCalledTimes(1);
        const payload = consoleErr.mock.calls[0]?.[1] as { err: string };
        expect(payload.err).toBe("string-throw");
      } finally {
        parseSpy.mockRestore();
        consoleErr.mockRestore();
        JSON.parse = origParse;
      }
    });
  });
});
