import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoutineEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { createAgentRoutes } from "./agent.js";

/** Build a valid today.md with one Agent Plan row. */
function todayContentWithRow(
  date: string,
  {
    time = "09:00",
    action = "Execute scheduled task",
    category = "work",
    trigger = "DM",
    checked = false,
  }: {
    time?: string;
    action?: string;
    category?: string;
    trigger?: string;
    checked?: boolean;
  } = {},
): string {
  const checkmark = checked ? "x" : " ";
  const plan = `- [${checkmark}] ${time} ${action} [${category}] →${trigger}`;
  return [
    `# ${date} (Tue)`,
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## User Tasks",
    "- (none)",
    "",
    "## Agent Plan",
    plan,
    "",
    "## Agent Notes",
    "- (none)",
    "",
    "## Agent Log",
    "- (none)",
    "",
    "## Handoff",
    "- (none)",
    "",
  ].join("\n");
}

/** Build a valid today.md with two Agent Plan rows at the same time. */
function todayContentWithTwoRows(
  date: string,
  rows: Array<{ action: string; category: string; trigger: string }>,
): string {
  const plan = rows
    .map((r) => `- [ ] 09:00 ${r.action} [${r.category}] →${r.trigger}`)
    .join("\n");
  return [
    `# ${date} (Tue)`,
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## User Tasks",
    "- (none)",
    "",
    "## Agent Plan",
    plan,
    "",
    "## Agent Notes",
    "- (none)",
    "",
    "## Agent Log",
    "- (none)",
    "",
    "## Handoff",
    "- (none)",
    "",
  ].join("\n");
}

function validTodayContent(
  date = "2099-04-21",
  agentPlan = "- [ ] 09:00 Send prep note [work] \u2192DM",
): string {
  return [
    `# ${date} (Tue)`,
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## User Tasks",
    "- (none)",
    "",
    "## Agent Plan",
    agentPlan,
    "",
    "## Agent Notes",
    "- (none)",
    "",
    "## Agent Log",
    "- (none)",
    "",
    "## Handoff",
    "- (none)",
    "",
  ].join("\n");
}

describe("Agent API routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 503 when hourly check trigger is unavailable", async () => {
    const app = createAgentRoutes({ db } as never);

    const res = await app.request("/agent/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "dashboard" }),
    });

    expect(res.status).toBe(503);
    // Agent-error envelope keeps the legacy `error` alias plus the
    // structured fields (errors[], retryable, summary). Match on the
    // observable contract rather than the full envelope shape so registry
    // additions (constraint, severity, …) do not break this assertion.
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("hourly_check_unavailable");
    expect(Array.isArray(body.errors)).toBe(true);
    expect((body.errors as Array<{ code: string }>)[0].code).toBe(
      "agent.hourly_check_unavailable",
    );
  });

  it("returns 503 while daemon startup is still in progress", async () => {
    const triggerHourlyCheck = vi.fn();
    const app = createAgentRoutes({
      db,
      triggerHourlyCheck,
      isStartupComplete: () => false,
    } as never);

    const res = await app.request("/agent/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "dashboard" }),
    });

    expect(res.status).toBe(503);
    expect(triggerHourlyCheck).not.toHaveBeenCalled();
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("daemon_starting");
    expect(body.message).toBe(
      "Daemon startup is still in progress. Try again in a moment.",
    );
    expect((body.errors as Array<{ code: string }>)[0].code).toBe(
      "agent.daemon_starting",
    );
  });

  it("forces hourly check for manual run requests and returns the dispatcher result", async () => {
    const triggerHourlyCheck = vi.fn().mockResolvedValue({
      status: "queued",
      pendingCount: 3,
      minObservations: 1,
      forced: true,
    });
    const app = createAgentRoutes({ db, triggerHourlyCheck } as never);

    const res = await app.request("/agent/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "dashboard" }),
    });

    expect(res.status).toBe(200);
    expect(triggerHourlyCheck).toHaveBeenCalledWith("manual:dashboard", {
      force: true,
    });
    await expect(res.json()).resolves.toEqual({
      status: "queued",
      pendingCount: 3,
      minObservations: 1,
      forced: true,
    });
  });

  it("uses the default manual reason when request body is empty", async () => {
    const triggerHourlyCheck = vi.fn().mockResolvedValue({
      status: "skipped",
      reason: "hourly_check_in_progress",
      minObservations: 1,
      forced: true,
    });
    const app = createAgentRoutes({ db, triggerHourlyCheck } as never);

    const res = await app.request("/agent/run-now", { method: "POST" });

    expect(res.status).toBe(200);
    expect(triggerHourlyCheck).toHaveBeenCalledWith("manual:api", {
      force: true,
    });
    await expect(res.json()).resolves.toEqual({
      status: "skipped",
      reason: "hourly_check_in_progress",
      minObservations: 1,
      forced: true,
    });
  });

  it("respects force: false when explicitly passed", async () => {
    const triggerHourlyCheck = vi.fn().mockResolvedValue({ status: "queued" });
    const app = createAgentRoutes({ db, triggerHourlyCheck } as never);

    const res = await app.request("/agent/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "cron", force: false }),
    });

    expect(res.status).toBe(200);
    expect(triggerHourlyCheck).toHaveBeenCalledWith("manual:cron", {
      force: false,
    });
  });

  it("forwards requestedModel=opus to the dispatcher", async () => {
    const triggerHourlyCheck = vi.fn().mockResolvedValue({ status: "queued" });
    const app = createAgentRoutes({ db, triggerHourlyCheck } as never);

    const res = await app.request("/agent/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "weekly", requestedModel: "opus" }),
    });

    expect(res.status).toBe(200);
    expect(triggerHourlyCheck).toHaveBeenCalledWith("manual:weekly", {
      force: true,
      requestedModel: "opus",
    });
  });

  it("rejects invalid requestedModel with 400", async () => {
    const triggerHourlyCheck = vi.fn();
    const app = createAgentRoutes({ db, triggerHourlyCheck } as never);

    const res = await app.request("/agent/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedModel: "haiku" }),
    });

    expect(res.status).toBe(400);
    expect(triggerHourlyCheck).not.toHaveBeenCalled();
  });

  // ── /escalate (removed → 410 Gone) ──

  describe("POST /escalate", () => {
    it("returns 410 Gone with a migration hint", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "whatever",
          correlationId: "corr-1",
        }),
      });

      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("gone");
      expect(body.message).toContain("advisor");
    });
  });

  // ── /notify ──

  describe("POST /notify", () => {
    it("sends notification via sendNotification callback", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "dispatch-1" });
      const app = createAgentRoutes({ db, sendNotification } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello user", platform: "slack" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; dispatchId: string };
      expect(body.status).toBe("sent");
      expect(body.dispatchId).toBe("dispatch-1");
      expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
        message: "Hello user",
        platforms: ["slack"],
        priority: "normal",
      }));
    });

    it("falls back to DB logging when sendNotification is not available", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello user" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; notificationId: string };
      expect(body.status).toBe("sent");
      expect(body.notificationId).toBeTruthy();

      // Check DB
      const row = db.prepare("SELECT content_summary FROM notification_log LIMIT 1")
        .get() as { content_summary: string } | undefined;
      expect(row?.content_summary).toBe("Hello user");
    });

    it("supports platforms array", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "d2" });
      const app = createAgentRoutes({ db, sendNotification } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test", platforms: ["slack", "telegram"] }),
      });

      expect(res.status).toBe(200);
      expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
        platforms: ["slack", "telegram"],
      }));
    });

    it("threads X-Pa-Session-Id into sendNotification as originSessionId", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "d-session" });
      const app = createAgentRoutes({ db, sendNotification } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Session-Id": "123",
        },
        body: JSON.stringify({ message: "test" }),
      });

      expect(res.status).toBe(200);
      expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
        originSessionId: 123,
      }));
    });

    it("returns 400 for invalid body", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: "data" }),
      });

      expect(res.status).toBe(400);
    });

    it("notify-dedup: forwards X-Pa-Event-Correlation-Id header to markEventNotified on success", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "dispatch-dedup" });
      const markEventNotified = vi.fn();
      const app = createAgentRoutes({ db, sendNotification, markEventNotified } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-corr-1",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      expect(res.status).toBe(200);
      expect(markEventNotified).toHaveBeenCalledWith("evt-corr-1");
    });

    it("notify-dedup: skips markEventNotified when the header is absent", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "dispatch-no-header" });
      const markEventNotified = vi.fn();
      const app = createAgentRoutes({ db, sendNotification, markEventNotified } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      });

      expect(res.status).toBe(200);
      expect(markEventNotified).not.toHaveBeenCalled();
    });

    it("uses platform from platforms array in DB-logging fallback", async () => {
      // Tests the `normalizedPlatforms?.[0] ?? "slack"` branch where
      // normalizedPlatforms is defined (non-empty array), so platforms[0]
      // takes precedence over the "slack" default.
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Test message", platforms: ["telegram"] }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare("SELECT platform FROM notification_log LIMIT 1")
        .get() as { platform: string } | undefined;
      expect(row?.platform).toBe("telegram");
    });

    it("notify-dedup: skips markEventNotified on the warn-fallback branch (sendNotification absent)", async () => {
      // The DB-logging fallback fires when the daemon failed to wire up
      // sendNotification — that's a misconfiguration path, not real
      // user-visible delivery, so we must not silence the dispatcher
      // forward in that case.
      const markEventNotified = vi.fn();
      const app = createAgentRoutes({ db, markEventNotified } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-corr-fallback",
        },
        body: JSON.stringify({ message: "Hello" }),
      });

      expect(res.status).toBe(200);
      expect(markEventNotified).not.toHaveBeenCalled();
    });
  });

  // ── /schedule ──

  describe("POST /schedule", () => {
    it("creates a scheduled task", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2026-12-01T10:00:00Z",
          taskType: "wake",
          prompt: "Follow up on the pending pull request review and merge",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        status: string;
        scheduleId: string;
        scheduledFor?: string;
      };
      expect(body.status).toBe("scheduled");
      expect(body.scheduleId).toBeTruthy();
      // 2026-05 skill/API consistency: `/schedule` returns the
      // normalized UTC SQLite timestamp alongside the new id, matching
      // the `/schedule/dm` contract so callers don't need a follow-up
      // GET to log the stored time.
      expect(body.scheduledFor).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      );
    });

    it("persists tier_override and surfaces it as `tier` on GET", async () => {
      // Primary cost-pinning path: caller POSTs with `tier: "lite"`,
      // route writes `agent_schedule.tier_override = 'lite'`, and the
      // GET response surfaces the column as `tier`. Pinning the
      // round-trip here protects the contract every dispatcher / UI
      // caller depends on.
      const app = createAgentRoutes({ db } as never);
      const future = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

      const createRes = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          taskType: "wake",
          prompt: "Hourly docker health check — alert if any container is in restart loop",
          tier: "lite",
        }),
      });
      expect(createRes.status).toBe(200);
      const created = await createRes.json() as { scheduleId: string };

      // Column persisted verbatim.
      const row = db
        .prepare("SELECT tier_override, model FROM agent_schedule WHERE id = ?")
        .get(Number(created.scheduleId)) as { tier_override: string; model: string | null };
      expect(row.tier_override).toBe("lite");
      expect(row.model).toBeNull();

      // GET surfaces the column as `tier`.
      const listRes = await app.request("/schedule?status=pending");
      const list = await listRes.json() as { items: Array<{ id: number; tier: string | null }> };
      const item = list.items.find((i) => i.id === Number(created.scheduleId));
      expect(item?.tier).toBe("lite");
    });

    it("lifts taskContext.tier_override into the column when top-level tier is omitted (legacy compat)", async () => {
      // schemas.ts has shipped a `tier_override` slot inside
      // scheduleBatchTaskContextSchema and references/batch.md has
      // documented it as a real input since the batch endpoint
      // landed — but nothing read it at dispatch time. The route now
      // lifts the slot to the column on insert so callers that still
      // follow batch.md keep working without introducing a second
      // precedence path at dispatch.
      const app = createAgentRoutes({ db } as never);
      const future = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

      const createRes = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          taskType: "wake",
          prompt: "Legacy-shaped caller using taskContext.tier_override only",
          taskContext: { tier_override: "lite" },
        }),
      });
      expect(createRes.status).toBe(200);
      const { scheduleId } = await createRes.json() as { scheduleId: string };

      const row = db
        .prepare("SELECT tier_override FROM agent_schedule WHERE id = ?")
        .get(Number(scheduleId)) as { tier_override: string };
      expect(row.tier_override).toBe("lite");
    });

    it("top-level tier wins over taskContext.tier_override when both are set", async () => {
      const app = createAgentRoutes({ db } as never);
      const future = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

      const createRes = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          taskType: "wake",
          prompt: "Both knobs set — top-level tier must win to keep dispatch unambiguous",
          tier: "high",
          taskContext: { tier_override: "lite" },
        }),
      });
      expect(createRes.status).toBe(200);
      const { scheduleId } = await createRes.json() as { scheduleId: string };

      const row = db
        .prepare("SELECT tier_override FROM agent_schedule WHERE id = ?")
        .get(Number(scheduleId)) as { tier_override: string };
      expect(row.tier_override).toBe("high");
    });

    it("accepts tier=null on PATCH to clear an existing override", async () => {
      const app = createAgentRoutes({ db } as never);
      const future = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

      // Seed with tier='high'
      const createRes = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          taskType: "wake",
          prompt: "Opus-grade multi-file PR review for the release branch handoff",
          tier: "high",
        }),
      });
      const { scheduleId } = await createRes.json() as { scheduleId: string };

      // Clear via PATCH tier:null
      const patchRes = await app.request(`/schedule/${scheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: null }),
      });
      expect(patchRes.status).toBe(200);

      const row = db
        .prepare("SELECT tier_override FROM agent_schedule WHERE id = ?")
        .get(Number(scheduleId)) as { tier_override: string | null };
      expect(row.tier_override).toBeNull();
    });

    it("does not trigger roadmap refresh for normal schedules inside 7 days", async () => {
      const triggerRoadmapRefresh = vi.fn();
      const app = createAgentRoutes({ db, triggerRoadmapRefresh } as never);
      const future = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          taskType: "wake",
          prompt: "Check the ordinary follow-up status and notify if needed",
        }),
      });

      expect(res.status).toBe(200);
      expect(triggerRoadmapRefresh).not.toHaveBeenCalled();
    });

    it("triggers roadmap refresh for normal schedules beyond 7 days", async () => {
      const triggerRoadmapRefresh = vi.fn();
      const app = createAgentRoutes({ db, triggerRoadmapRefresh } as never);
      const future = new Date(Date.now() + 8 * 24 * 3600_000).toISOString();

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          taskType: "wake",
          prompt: "Check the long-horizon follow-up status and notify if needed",
        }),
      });

      expect(res.status).toBe(200);
      expect(triggerRoadmapRefresh).toHaveBeenCalledWith("scheduled_task_created");
    });

    it("rejects times in the past with the agent-consumable error envelope", async () => {
      const app = createAgentRoutes({ db } as never);
      const past = new Date(Date.now() - 120_000).toISOString();

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: past,
          taskType: "wake",
          prompt: "Follow up on the pending pull request review and merge",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        errors: Array<{
          code: string;
          field: string;
          hint: string;
          skillAnchor: string;
        }>;
        retryable: boolean;
      };
      expect(body.ok).toBe(false);
      expect(body.retryable).toBe(true);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].code).toBe("schedule.scheduled_for_in_past");
      expect(body.errors[0].field).toBe("time");
      expect(body.errors[0].hint).toMatch(/at least 1 minute in the future/);
      expect(body.errors[0].skillAnchor).toBe("schedule#scheduledFor-bounds");
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM agent_schedule")
        .get() as { count: number };
      expect(count.count).toBe(0);
    });

    it("stores Agent Plan metadata when scheduling a matching today.md row", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          validTodayContent("2099-04-21"),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Send prep note to the user",
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as {
          agentPlan?: {
            date: string;
            ref: string;
            time: string;
            category: string;
            trigger: string;
          };
        };
        expect(ctx.agentPlan).toMatchObject({
          date: "2099-04-21",
          time: "09:00",
          category: "work",
          trigger: "DM",
        });
        expect(ctx.agentPlan?.ref).toMatch(/^agent-plan:2099-04-21:/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects invalid body (missing prompt triggers zod validation)", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-12-01T10:00:00Z",
          taskType: "wake",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        errors: Array<{ code: string; field: string; hint: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.errors.some((e) => e.code === "schedule.prompt_required")).toBe(true);
    });

    it("returns 400 with an agent-consumable envelope for an invalid body shape", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: true }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        errors: Array<{ code: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.errors.length).toBeGreaterThan(0);
    });
  });

  // ── /schedule/dm ──

  describe("POST /schedule/dm", () => {
    it("creates a scheduled DM", async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          message: "Hey, remember to check the PR",
          platform: "slack",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; scheduleId: string; scheduledFor: string };
      expect(body.status).toBe("scheduled");
      expect(body.scheduleId).toBeTruthy();
      expect(body.scheduledFor).toBeTruthy();
    });

    it("defaults scheduled DMs to transient importance and does not trigger roadmap refresh", async () => {
      const future = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
      const triggerRoadmapRefresh = vi.fn();
      const app = createAgentRoutes({ db, triggerRoadmapRefresh } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          message: "Remember to call mom",
        }),
      });

      expect(res.status).toBe(200);
      expect(triggerRoadmapRefresh).not.toHaveBeenCalled();
      const row = db.prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
        .get() as { task_context: string };
      expect(JSON.parse(row.task_context)).toMatchObject({
        platforms: null,
        importance: "transient",
      });
    });

    it("stores scheduled DM importance override and lets strategic reminders trigger roadmap refresh", async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const triggerRoadmapRefresh = vi.fn();
      const app = createAgentRoutes({ db, triggerRoadmapRefresh } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: future,
          message: "Confirm ESTA prep for LA trip",
          importance: "strategic",
        }),
      });

      expect(res.status).toBe(200);
      expect(triggerRoadmapRefresh).toHaveBeenCalledWith("scheduled_task_created");
      const row = db.prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
        .get() as { task_context: string };
      expect(JSON.parse(row.task_context).importance).toBe("strategic");
    });

    it("respects scheduled DM normal importance override with the 7-day horizon", async () => {
      const triggerRoadmapRefresh = vi.fn();
      const app = createAgentRoutes({ db, triggerRoadmapRefresh } as never);

      const near = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: new Date(Date.now() + 5 * 24 * 3600_000).toISOString(),
          message: "Remember the short-range normal reminder",
          importance: "normal",
        }),
      });
      expect(near.status).toBe(200);
      expect(triggerRoadmapRefresh).not.toHaveBeenCalled();

      const far = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: new Date(Date.now() + 8 * 24 * 3600_000).toISOString(),
          message: "Remember the long-range normal reminder",
          importance: "normal",
        }),
      });
      expect(far.status).toBe(200);
      expect(triggerRoadmapRefresh).toHaveBeenCalledWith("scheduled_task_created");
    });

    it("rejects times in the past", async () => {
      const past = new Date(Date.now() - 120_000).toISOString();
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: past,
          message: "late",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_time");
    });

    it("rejects invalid time format", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "not-a-date",
          message: "hello",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid body", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: true }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ── GET /schedule ──

  describe("GET /schedule", () => {
    it("returns scheduled items", async () => {
      const app = createAgentRoutes({ db } as never);

      // Insert a pending item
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'test task', '{"importance":"normal"}', 'pending')`,
      ).run();

      const res = await app.request("/schedule");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ taskType: string; taskContext: Record<string, unknown> }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].taskType).toBe("wake");
      expect(body.items[0].taskContext).toEqual({ importance: "normal" });
    });

    it("filters by status", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'wake', 'completed task', 'completed')`,
      ).run();

      const res = await app.request("/schedule?status=completed");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });

    it("rejects invalid status", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule?status=invalid_status");
      expect(res.status).toBe(400);
    });

    it("filters roadmap-eligible scheduled items in the daemon", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES
           (datetime('now', '+8 days'), 'dm', 'transient far ping', '{"importance":"transient"}', 'pending'),
           (datetime('now', '+8 days'), 'wake', 'low internal tick', '{"importance":"low"}', 'pending'),
           (datetime('now', '+5 days'), 'wake', 'near normal follow-up', '{"importance":"normal"}', 'pending'),
           (datetime('now', '+8 days'), 'wake', 'far normal follow-up', '{"importance":"normal"}', 'pending'),
           (datetime('now', '-1 hour'), 'wake', 'running strategic prep', '{"importance":"strategic"}', 'running')`,
      ).run();

      const res = await app.request("/schedule?status=pending,running&roadmapEligible=true");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ description: string }> };
      expect(body.items.map((item) => item.description)).toEqual([
        "running strategic prep",
        "far normal follow-up",
      ]);
    });
  });

  // ── PATCH /schedule/:id ──

  describe("PATCH /schedule/:id", () => {
    it("updates a pending scheduled item", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'original', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Updated task description that is long enough for validation" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("updated");
    });

    it("returns 400 for invalid id", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: "2026-12-01T10:00:00Z" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 when item does not exist", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Updated description that is at least twenty characters" }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 409 when item is not pending", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'wake', 'done', 'completed')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Updated description that is at least twenty characters" }),
      });

      expect(res.status).toBe(409);
    });

    it("rejects when body has no valid update fields", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("rejects message field on non-dm schedules", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "nope" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_field");
    });

    it("returns 400 when no valid fields to update (zod refine)", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("no_changes");
    });

    it("updates time on dm-type and rejects past times", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'dm', 'msg', 'pending')`,
      ).run();

      const past = new Date(Date.now() - 120_000).toISOString();
      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: past }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_time");
    });

    it("normalizes legacy alias model on PATCH to tier_override (Phase D §4.3)", async () => {
      // PATCH `model: "opus"` is the legacy alias path — under Phase D
      // the resolver rewrites it to `tier_override: "high"`, clears
      // `model` and `backend_id`, so the row ends up with one canonical
      // pin instead of carrying the alias verbatim.
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status, model)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending', 'sonnet')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus", taskContext: { key: "value" } }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare(
        "SELECT model, tier_override, backend_id, task_context FROM agent_schedule WHERE id = 1",
      ).get() as {
        model: string | null;
        tier_override: string | null;
        backend_id: string | null;
        task_context: string;
      };
      expect(row.model).toBeNull();
      expect(row.tier_override).toBe("high");
      expect(row.backend_id).toBeNull();
      expect(JSON.parse(row.task_context)).toEqual({ key: "value" });
    });

    it("persists (model, backend_id) on PATCH with a registered model id (Phase D §4.3a)", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status, tier_override)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending', 'medium')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-7" }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare(
        "SELECT model, tier_override, backend_id FROM agent_schedule WHERE id = 1",
      ).get() as {
        model: string | null;
        tier_override: string | null;
        backend_id: string | null;
      };
      expect(row.model).toBe("claude-opus-4-7");
      expect(row.backend_id).toBe("claude");
      // The PATCH resolver clears the prior tier_override so the row
      // ends up with exactly one pin (per §4.3 — never both at rest).
      expect(row.tier_override).toBeNull();
    });

    it("rejects PATCH with both tier and model set (schedule.tier_and_model_conflict)", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-7", tier: "high" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { errors: Array<{ code: string }> };
      expect(body.errors[0].code).toBe("schedule.tier_and_model_conflict");
    });

    it("rejects PATCH with an unknown model id (schedule.model_unknown carries validValues)", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4-turbo" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as {
        errors: Array<{
          code: string;
          validValues: { aliases: string[]; models: Record<string, string[]> };
        }>;
      };
      expect(body.errors[0].code).toBe("schedule.model_unknown");
      expect(body.errors[0].validValues.aliases).toEqual(["sonnet", "opus"]);
      expect(body.errors[0].validValues.models.codex).toContain("gpt-5.4");
    });

    it("clears model + backend_id on PATCH model:null", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status, model, backend_id)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending', 'claude-opus-4-7', 'claude')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare(
        "SELECT model, backend_id FROM agent_schedule WHERE id = 1",
      ).get() as { model: string | null; backend_id: string | null };
      expect(row.model).toBeNull();
      expect(row.backend_id).toBeNull();
    });

    it("surfaces schedule.model_deprecated as a warning on PATCH and still persists", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        warnings: Array<{ code: string; severity: string }>;
      };
      expect(body.warnings[0].code).toBe("schedule.model_deprecated");
      expect(body.warnings[0].severity).toBe("warning");
      const row = db.prepare(
        "SELECT model, backend_id FROM agent_schedule WHERE id = 1",
      ).get() as { model: string | null; backend_id: string | null };
      expect(row.model).toBe("claude-opus-4-6");
      expect(row.backend_id).toBe("claude");
    });
  });

  // ── DELETE /schedule/:id ──

  describe("DELETE /schedule/:id", () => {
    it("cancels a pending scheduled item", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("cancelled");
    });

    it("returns 400 for invalid id", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/abc", { method: "DELETE" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent item", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("returns 409 for non-pending item", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'wake', 'done', 'completed')`,
      ).run();

      const res = await app.request("/schedule/1", { method: "DELETE" });
      expect(res.status).toBe(409);
    });
  });

  // ── /agent/regenerate ──

  describe("POST /agent/regenerate", () => {
    it("returns 500 when eventBus is not available for today target", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "today" }),
      });

      expect(res.status).toBe(500);
    });

    it("returns 400 for invalid target", async () => {
      const eventBus = { put: vi.fn() };
      const app = createAgentRoutes({ db, eventBus, services: {} } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "invalid" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 503 when triggerRoadmapRefresh is unavailable", async () => {
      const app = createAgentRoutes({ db, services: {} } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "roadmap" }),
      });

      expect(res.status).toBe(503);
    });

    it("triggers roadmap regeneration via triggerRoadmapRefresh with bypassDedup", async () => {
      const triggerRoadmapRefresh = vi.fn();
      const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
      const app = createAgentRoutes({
        db,
        eventBus,
        services: {},
        triggerRoadmapRefresh,
      } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "roadmap" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; target: string };
      expect(body.status).toBe("triggered");
      expect(body.target).toBe("roadmap");
      expect(triggerRoadmapRefresh).toHaveBeenCalledWith(
        "dashboard_regenerate",
        { bypassDedup: true },
      );
      expect(eventBus.put).not.toHaveBeenCalled();
    });

    it("triggers today regeneration as a routine.today_refresh event", async () => {
      const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
      const app = createAgentRoutes({
        db,
        eventBus,
        services: {},
        config: { timezone: "America/New_York" },
      } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "today" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; target: string };
      expect(body.status).toBe("triggered");
      expect(body.target).toBe("today");
      expect(eventBus.put).toHaveBeenCalledTimes(1);
      const event = eventBus.put.mock.calls[0][0] as RoutineEvent;
      expect(event.type).toBe("routine.today_refresh");
      expect(event.routine).toBe("today_refresh");
      expect(event.source).toBe("dashboard_regenerate");
    });

    it("triggers today regeneration even when calendar service is null (delegated mode)", async () => {
      const eventBus = { put: vi.fn().mockResolvedValue(undefined) };
      const app = createAgentRoutes({
        db,
        eventBus,
        services: { calendar: null },
        config: { timezone: "America/New_York" },
      } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "today" }),
      });

      expect(res.status).toBe(200);
      expect(eventBus.put).toHaveBeenCalledTimes(1);
    });
  });

  // ── /action/log ──

  describe("POST /action/log", () => {
    it("records an action log entry", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/action/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: "context.update",
          detail: "Updated today.md",
          result: "success",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("logged");

      const row = db.prepare("SELECT action_type, result FROM agent_actions LIMIT 1")
        .get() as { action_type: string; result: string };
      expect(row.action_type).toBe("context.update");
      expect(row.result).toBe("success");
    });

    it("broadcasts the inserted row when an event broadcaster is configured", async () => {
      const eventBroadcaster = { broadcastEvent: vi.fn() };
      const app = createAgentRoutes({ db, eventBroadcaster } as never);

      const res = await app.request("/action/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: "context.update",
          detail: "Updated today.md",
          result: "success",
        }),
      });

      expect(res.status).toBe(200);
      expect(eventBroadcaster.broadcastEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          action_type: "context.update",
          result: "success",
        }),
      );
    });

    it("returns 400 for invalid body", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/action/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: true }),
      });

      expect(res.status).toBe(400);
    });
  });

  // DELEGATED-MODE-V2-DESIGN.md §6.1, §4.5.2 — agent-callable retrospective
  describe("GET /agent/actions", () => {
    function insertAction(opts: {
      kind: string;
      startedAt?: string;
      detail?: Record<string, unknown>;
      error?: string;
      result?: "success" | "failed";
    }): void {
      db.prepare(
        `INSERT INTO agent_actions (
           action_type, result, detail, started_at, completed_at, error
         ) VALUES (
           @action_type, @result, @detail, @started_at, @completed_at, @error
         )`,
      ).run({
        action_type: opts.kind,
        result: opts.result ?? "success",
        detail: opts.detail ? JSON.stringify(opts.detail) : null,
        started_at: opts.startedAt ?? new Date().toISOString(),
        completed_at: opts.startedAt ?? new Date().toISOString(),
        error: opts.error ?? null,
      });
    }

    it("returns recent actions with default 24h window when `since` is omitted", async () => {
      // Seed two actions: one inside the default window, one well outside.
      insertAction({
        kind: "delegated_proxy.invoke",
        startedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      insertAction({
        kind: "delegated_proxy.invoke",
        startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/agent/actions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        actions: { id: number }[];
      };
      // Only the one within 24h is returned.
      expect(body.actions).toHaveLength(1);
    });

    it("filters by `kind` query (single value)", async () => {
      insertAction({ kind: "delegated_proxy.invoke" });
      insertAction({ kind: "integration.mode_change" });
      insertAction({ kind: "context.update" });
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/agent/actions?kind=delegated_proxy.invoke");
      const body = (await res.json()) as {
        actions: { kind: string }[];
        kinds: string[] | null;
      };
      expect(body.kinds).toEqual(["delegated_proxy.invoke"]);
      expect(body.actions.every((a) => a.kind === "delegated_proxy.invoke")).toBe(true);
      expect(body.actions).toHaveLength(1);
    });

    it("filters by multiple `kind` values via repeated query parameter", async () => {
      insertAction({ kind: "delegated_proxy.invoke" });
      insertAction({ kind: "integration.mode_change" });
      insertAction({ kind: "context.update" });
      const app = createAgentRoutes({ db } as never);
      const res = await app.request(
        "/agent/actions?kind=delegated_proxy.invoke&kind=integration.mode_change",
      );
      const body = (await res.json()) as {
        actions: { kind: string }[];
      };
      expect(body.actions).toHaveLength(2);
      const kinds = new Set(body.actions.map((a) => a.kind));
      expect(kinds.has("delegated_proxy.invoke")).toBe(true);
      expect(kinds.has("integration.mode_change")).toBe(true);
    });

    it("respects `since` cutoff (rows strictly before are excluded)", async () => {
      const cutoff = "2026-04-20T00:00:00.000Z";
      insertAction({ kind: "x", startedAt: "2026-04-19T12:00:00.000Z" });
      insertAction({ kind: "x", startedAt: "2026-04-20T12:00:00.000Z" });
      const app = createAgentRoutes({ db } as never);
      const res = await app.request(`/agent/actions?since=${encodeURIComponent(cutoff)}`);
      const body = (await res.json()) as { actions: { startedAt: string }[] };
      expect(body.actions).toHaveLength(1);
      // SQLite stores TIMESTAMP columns as TEXT verbatim — round-trip is
      // the original ISO string, no normalization.
      expect(body.actions[0].startedAt).toBe("2026-04-20T12:00:00.000Z");
    });

    it("rejects an invalid `since` with 400", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/agent/actions?since=not-a-date");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_since");
    });

    it("clamps `limit` to 200 and rejects 0 / non-numeric", async () => {
      const app = createAgentRoutes({ db } as never);
      const r1 = await app.request("/agent/actions?limit=99999");
      const b1 = (await r1.json()) as { limit: number };
      expect(b1.limit).toBe(200);

      const r2 = await app.request("/agent/actions?limit=0");
      expect(r2.status).toBe(400);
      const r3 = await app.request("/agent/actions?limit=abc");
      expect(r3.status).toBe(400);
    });

    it("redacts known secret patterns in `error` and `detail`", async () => {
      const fakeBearer = "Bearer abcdefghijklmnopqrstuvwxyz0123456";
      insertAction({
        kind: "x",
        error: `auth failed: ${fakeBearer}`,
        detail: { rawHeader: fakeBearer },
      });
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/agent/actions");
      const body = (await res.json()) as {
        actions: { error: string | null; detail: string | null }[];
      };
      const row = body.actions[0];
      expect(row.error).not.toMatch(/abcdefghijkl/);
      expect(row.error).toMatch(/\[REDACTED\]/);
      // detail is serialized JSON; the bearer string inside should be
      // redacted in the same string.
      expect(row.detail).not.toMatch(/abcdefghijkl/);
    });

    it("returns rows newest first by started_at (handles out-of-order inserts)", async () => {
      // Insert in non-monotonic time order — order-by must follow started_at,
      // not id. ORDER BY started_at DESC, id DESC achieves this.
      insertAction({ kind: "x", startedAt: "2026-04-25T01:00:00.000Z" });
      insertAction({ kind: "x", startedAt: "2026-04-25T03:00:00.000Z" });
      insertAction({ kind: "x", startedAt: "2026-04-25T02:00:00.000Z" });
      const app = createAgentRoutes({ db } as never);
      const res = await app.request(
        `/agent/actions?since=${encodeURIComponent("2026-04-25T00:00:00Z")}`,
      );
      const body = (await res.json()) as { actions: { startedAt: string }[] };
      expect(body.actions.map((a) => a.startedAt)).toEqual([
        "2026-04-25T03:00:00.000Z",
        "2026-04-25T02:00:00.000Z",
        "2026-04-25T01:00:00.000Z",
      ]);
    });
  });

  // ── parseTaskContextJson edge cases ──

  describe("GET /schedule — parseTaskContextJson edge cases", () => {
    it("returns {} when task_context is NULL in the DB", async () => {
      const app = createAgentRoutes({ db } as never);
      // Insert a row with no task_context (NULL)
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'test task', 'pending')`,
      ).run();

      const res = await app.request("/schedule");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ taskContext: unknown }> };
      expect(body.items[0].taskContext).toEqual({});
    });

    it("returns {} for invalid JSON stored in task_context", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'test', 'not valid json', 'pending')`,
      ).run();

      const res = await app.request("/schedule");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ taskContext: unknown }> };
      expect(body.items[0].taskContext).toEqual({});
    });

    it("returns {} when task_context is a JSON array (not an object)", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'test', '["a","b"]', 'pending')`,
      ).run();

      const res = await app.request("/schedule");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ taskContext: unknown }> };
      expect(body.items[0].taskContext).toEqual({});
    });

    it("accepts roadmapEligible=1 as an alternative to roadmapEligible=true", async () => {
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+8 days'), 'wake', 'strategic task', '{"importance":"strategic"}', 'pending')`,
      ).run();

      const res = await app.request("/schedule?roadmapEligible=1");
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });
  });

  // ── enrichAgentPlanTaskContext branches ──

  describe("POST /schedule — enrichAgentPlanTaskContext branches", () => {
    it("skips enrichment when taskContext already has valid agentPlan metadata", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-enrich-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          validTodayContent("2099-04-21"),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        // Schedule with pre-existing agentPlan metadata (all required fields present)
        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Send prep note to the user",
            taskContext: {
              agentPlan: {
                date: "2099-04-21",
                ref: "agent-plan:2099-04-21:existing",
                fingerprint: "existingfingerprint",
                time: "09:00",
                action: "Existing action",
                category: "work",
                trigger: "DM",
              },
            },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { ref?: string } };
        // The pre-existing agentPlan should be preserved unchanged
        expect(ctx.agentPlan?.ref).toBe("agent-plan:2099-04-21:existing");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("uses local timezone when config.timezone is not set", async () => {
      // Tests `config.timezone || undefined` branch where timezone is absent
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-notz-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        // Use a far-future date so it won't accidentally match any local time
        writeFileSync(
          join(tmp, "context", "today.md"),
          validTodayContent("2099-04-21"),
          "utf-8",
        );
        // No timezone in config — uses local time
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp },
        } as never);

        // This simply exercises the code path; the agentPlan enrichment
        // may or may not match depending on local timezone, but the request
        // should succeed without throwing.
        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Task to exercise the no-timezone config path",
          }),
        });
        expect(res.status).toBe(200);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("skips enrichment when config has no dataDir", async () => {
      // No config at all — enrichment is skipped
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-21T09:00:00Z",
          taskType: "wake",
          prompt: "Send prep note to the user",
        }),
      });

      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
        .get() as { task_context: string };
      const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
      expect(ctx.agentPlan).toBeUndefined();
    });

    it("skips enrichment when today.md does not exist in context dir", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-nofile-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        // No today.md written
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Send prep note to the user",
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
        expect(ctx.agentPlan).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("skips enrichment when today.md date does not match scheduledAt", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-datemismatch-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        // today.md for 2099-04-21, but scheduling for 2099-04-22
        writeFileSync(
          join(tmp, "context", "today.md"),
          validTodayContent("2099-04-21"),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-22T09:00:00Z",
            taskType: "wake",
            prompt: "Send prep note to the user",
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
        expect(ctx.agentPlan).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("skips enrichment when today.md has no rows at the scheduled time", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-norows-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        // today.md with a row at 09:00 but scheduling for 10:00
        writeFileSync(
          join(tmp, "context", "today.md"),
          validTodayContent("2099-04-21"),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T10:00:00Z",
            taskType: "wake",
            prompt: "Different time task for today's follow-up",
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
        expect(ctx.agentPlan).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("selects single candidate even when description does not match (candidates.length === 1)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-nodescmatch-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          validTodayContent("2099-04-21", "- [ ] 09:00 Execute scheduled task [work] →DM"),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        // Description doesn't match "Execute scheduled task" but there is only
        // one candidate so it falls back to returning that candidate anyway.
        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Completely different description that does not match",
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
        // Single candidate picked even without description match
        expect(ctx.agentPlan).toBeDefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns null when multiple candidates and none match description", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-multimatch-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Task Alpha", category: "work", trigger: "DM" },
            { action: "Task Beta", category: "work", trigger: "notify" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Unrelated description matches neither alpha nor beta",
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as Record<string, unknown>;
        // Multiple ambiguous candidates, no description match → no agentPlan
        expect(ctx.agentPlan).toBeUndefined();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by trigger hint (notify)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-trigger-notify-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Task Alpha", category: "work", trigger: "DM" },
            { action: "Task Beta", category: "work", trigger: "notify" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Task Beta description",
            taskContext: { trigger: "notify" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { trigger?: string } };
        expect(ctx.agentPlan?.trigger).toBe("notify");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by trigger hint (check-in)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-trigger-checkin-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Task Alpha", category: "work", trigger: "DM" },
            { action: "Task Gamma", category: "work", trigger: "check-in" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Task Gamma check-in follow-up",
            taskContext: { trigger: "check-in" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { trigger?: string } };
        expect(ctx.agentPlan?.trigger).toBe("check-in");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by trigger hint (wake)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-trigger-wake-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Task Alpha", category: "work", trigger: "DM" },
            { action: "Task Wake", category: "work", trigger: "wake" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Task Wake action for today's follow-up",
            taskContext: { trigger: "wake" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { trigger?: string } };
        expect(ctx.agentPlan?.trigger).toBe("wake");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by agentPlanTrigger key (higher-priority hint key)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-agentplantrigger-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Task DM", category: "work", trigger: "DM" },
            { action: "Task Notify", category: "work", trigger: "notify" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Task DM action for today's morning follow-up",
            taskContext: { agentPlanTrigger: "DM" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { trigger?: string } };
        expect(ctx.agentPlan?.trigger).toBe("DM");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("trigger hint that does not match any candidate leaves candidates unchanged", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-trigger-nomatch-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        // Only DM candidates, but hint is "notify" — filter returns 0, so
        // we fall back to all candidates (selectAgentPlanRowForSchedule: filtered.length > 0 check)
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithRow("2099-04-21", { trigger: "DM" }),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Execute scheduled task",
            taskContext: { trigger: "notify" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { trigger?: string } };
        // No filter applied (notify not found) → single DM candidate picked
        expect(ctx.agentPlan?.trigger).toBe("DM");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by category hint (study)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-cat-study-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Work Task", category: "work", trigger: "DM" },
            { action: "Study Task", category: "study", trigger: "DM" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Study Task for today",
            taskContext: { category: "study" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { category?: string } };
        expect(ctx.agentPlan?.category).toBe("study");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by category hint (personal)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-cat-personal-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Work Task", category: "work", trigger: "DM" },
            { action: "Personal Task", category: "personal", trigger: "DM" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Personal Task action",
            taskContext: { category: "personal" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { category?: string } };
        expect(ctx.agentPlan?.category).toBe("personal");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by category hint (home)", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-cat-home-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Work Task", category: "work", trigger: "DM" },
            { action: "Home Task", category: "home", trigger: "DM" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Home Task action for today's chores",
            taskContext: { category: "home" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { category?: string } };
        expect(ctx.agentPlan?.category).toBe("home");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("filters candidates by agentPlanCategory key", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-agentplancat-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithTwoRows("2099-04-21", [
            { action: "Work Task", category: "work", trigger: "DM" },
            { action: "Study Task", category: "study", trigger: "DM" },
          ]),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Work Task action for today's morning",
            taskContext: { agentPlanCategory: "work" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { category?: string } };
        expect(ctx.agentPlan?.category).toBe("work");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rewrites legacy alias 'opus' to tier_override on POST /schedule (Phase D §4.3)", async () => {
      // Phase D — the alias path normalizes to `tier_override` and
      // clears `model` + `backend_id` so the row carries one
      // canonical pin (per §4.3 — never both at rest).
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-21T09:00:00Z",
          taskType: "wake",
          prompt: "Task that explicitly pins opus model for high-quality work",
          model: "opus",
        }),
      });

      expect(res.status).toBe(200);
      const row = db
        .prepare(
          "SELECT model, tier_override, backend_id FROM agent_schedule WHERE id = 1",
        )
        .get() as {
          model: string | null;
          tier_override: string | null;
          backend_id: string | null;
        };
      expect(row.model).toBeNull();
      expect(row.tier_override).toBe("high");
      expect(row.backend_id).toBeNull();
    });

    it("persists (model, backend_id) when a registered id is pinned (Phase D §4.3a)", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-21T09:00:00Z",
          taskType: "wake",
          prompt: "Task that explicitly pins claude-opus-4-8 for a one-off run",
          model: "claude-opus-4-8",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { warnings: unknown[] };
      // Non-deprecated pin → no warning.
      expect(body.warnings).toEqual([]);
      // (model pinned above is the current non-deprecated Opus generation)
      const row = db
        .prepare(
          "SELECT model, tier_override, backend_id FROM agent_schedule WHERE id = 1",
        )
        .get() as {
          model: string | null;
          tier_override: string | null;
          backend_id: string | null;
        };
      expect(row.model).toBe("claude-opus-4-8");
      expect(row.backend_id).toBe("claude");
      expect(row.tier_override).toBeNull();
    });

    it("rejects POST /schedule with both tier and model set", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-21T09:00:00Z",
          taskType: "wake",
          prompt: "Task that tries to set both tier and model at once",
          model: "claude-opus-4-7",
          tier: "high",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors: Array<{ code: string }> };
      expect(body.errors[0].code).toBe("schedule.tier_and_model_conflict");
    });

    it("returns schedule.model_unknown with a validValues payload for a typo", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-21T09:00:00Z",
          taskType: "wake",
          prompt: "Task that pins a non-existent model id",
          model: "gpt-5.4-turbo",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as {
        errors: Array<{
          code: string;
          validValues: { aliases: string[]; models: Record<string, string[]> };
        }>;
      };
      expect(body.errors[0].code).toBe("schedule.model_unknown");
      expect(body.errors[0].validValues.aliases).toEqual(["sonnet", "opus"]);
      expect(body.errors[0].validValues.models.codex).toContain("gpt-5.4");
    });

    it("surfaces schedule.model_deprecated as a warning on POST and still persists the row", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "2099-04-21T09:00:00Z",
          taskType: "wake",
          prompt: "Task that pins a deprecated model id — should still persist",
          model: "claude-opus-4-6",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        warnings: Array<{ code: string; severity: string }>;
      };
      expect(body.warnings[0].code).toBe("schedule.model_deprecated");
      expect(body.warnings[0].severity).toBe("warning");
      const row = db
        .prepare(
          "SELECT model, backend_id FROM agent_schedule WHERE id = 1",
        )
        .get() as { model: string | null; backend_id: string | null };
      expect(row.model).toBe("claude-opus-4-6");
      expect(row.backend_id).toBe("claude");
    });

    it("returns 400 with scheduled_for_invalid for unparseable time string in POST /schedule", async () => {
      const app = createAgentRoutes({ db } as never);

      // The time field passes zod (it's a string) but new Date() returns NaN
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: "totally-not-a-date-string",
          taskType: "wake",
          prompt: "Description that is long enough to pass zod min length",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        errors: Array<{ code: string; field: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.errors[0].code).toBe("schedule.scheduled_for_invalid");
      expect(body.errors[0].field).toBe("time");
    });
  });

  // ── PATCH /schedule/:id additional branches ──

  describe("PATCH /schedule/:id — additional branches", () => {
    it("returns 400 when description is set on dm-type schedule", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'dm', 'msg', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Updated description that is at least twenty chars" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_field");
    });

    it("returns 400 when prompt is set on dm-type schedule", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'dm', 'msg', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // prompt must be at least 20 chars to pass schema validation
        body: JSON.stringify({ prompt: "Override the prompt text for this agent task execution" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_field");
    });

    it("returns 400 when time is not a valid date", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: "not-a-date" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_time");
    });

    it("allows updating time to future date on non-dm schedule (no past-time rejection)", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const past = new Date(Date.now() - 120_000).toISOString();
      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: past }),
      });

      // Non-dm schedules do NOT enforce past-time rejection on PATCH
      expect(res.status).toBe(200);
    });

    it("returns 409 when item status changed between SELECT and UPDATE (optimistic lock)", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      // Change status between validation and update to simulate a race
      // We can simulate this by updating the status in the DB directly between
      // the SELECT and UPDATE. Since we can't intercept SQLite calls easily,
      // instead set it to 'running' before the PATCH and verify 409 occurs
      // (the row was found as 'pending' in the status-check query when inserted,
      // but then change it before the PATCH reaches the UPDATE WHERE status='pending')
      // The simplest test: set status to running, then attempt PATCH.
      // The row.status check (row.status !== "pending") returns 409.
      db.prepare("UPDATE agent_schedule SET status = 'running' WHERE id = 1").run();
      // Now re-insert a pending row and change it via internal race
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task2', 'pending')`,
      ).run();
      // Simulate status changing after SELECT passes but before UPDATE executes
      // by patching the route to use a stale row; we use a prepared statement
      // to change status after the PATCH begins — not possible without mocking.
      // Instead, verify the 409 path via the first row (running status):
      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Updated description that is at least twenty chars" }),
      });

      // The row's status is 'running' which means it's no longer pending
      expect(res.status).toBe(409);
    });

    it("rejects prompt: null — the body cannot be cleared (no description fallback)", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_prompt, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'existing-prompt', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: null }),
      });

      expect(res.status).toBe(400);
      // The existing prompt is preserved — no change persisted.
      const row = db.prepare("SELECT task_prompt FROM agent_schedule WHERE id = 1")
        .get() as { task_prompt: string | null };
      expect(row.task_prompt).toBe("existing-prompt");
    });

    it("updates message field on dm-type schedule", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'dm', 'original message', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Updated dm message" }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare("SELECT task_description FROM agent_schedule WHERE id = 1")
        .get() as { task_description: string };
      expect(row.task_description).toBe("Updated dm message");
    });
  });

  // ── readJsonBody not-ok branches for all routes ──

  describe("readJsonBody not-ok branches", () => {
    it("returns 400 for invalid JSON body in POST /notify", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("returns 400 for invalid JSON body in POST /schedule", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("returns 400 for invalid JSON body in POST /schedule/dm", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("returns 400 for invalid JSON body in PATCH /schedule/:id", async () => {
      const app = createAgentRoutes({ db } as never);

      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'task', 'pending')`,
      ).run();

      const res = await app.request("/schedule/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("returns 400 for invalid JSON body in POST /agent/regenerate", async () => {
      const eventBus = { put: vi.fn() };
      const app = createAgentRoutes({ db, eventBus } as never);

      const res = await app.request("/agent/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });

    it("returns 400 for invalid JSON body in POST /action/log", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/action/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json }",
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json_body");
    });
  });

  // ── contextCategoryHint filtered.length === 0 branch ──

  describe("POST /schedule — contextCategoryHint no-match branch", () => {
    it("category hint that does not match any candidate leaves candidates unchanged", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-agent-plan-catno-"));
      try {
        mkdirSync(join(tmp, "context"), { recursive: true });
        // Only work candidates, but hint is "study" — filter returns 0
        writeFileSync(
          join(tmp, "context", "today.md"),
          todayContentWithRow("2099-04-21", { category: "work", trigger: "DM" }),
          "utf-8",
        );
        const app = createAgentRoutes({
          db,
          config: { dataDir: tmp, timezone: "UTC" },
        } as never);

        const res = await app.request("/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            time: "2099-04-21T09:00:00Z",
            taskType: "wake",
            prompt: "Execute scheduled task for today",
            taskContext: { category: "study" },
          }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
          .get() as { task_context: string };
        const ctx = JSON.parse(row.task_context) as { agentPlan?: { category?: string } };
        // No filter applied (study not found) → single work candidate picked
        expect(ctx.agentPlan?.category).toBe("work");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // ── POST /notify — parsePositiveIntegerHeader edge cases ──

  describe("POST /notify — parsePositiveIntegerHeader edge cases", () => {
    it("ignores invalid X-Pa-Session-Id header (non-positive integer)", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "d-invalid-session" });
      const app = createAgentRoutes({ db, sendNotification } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Session-Id": "0",
        },
        body: JSON.stringify({ message: "test" }),
      });

      expect(res.status).toBe(200);
      // originSessionId should NOT be included when header is 0 (not a positive integer)
      expect(sendNotification).toHaveBeenCalledWith(
        expect.not.objectContaining({ originSessionId: expect.anything() }),
      );
    });

    it("ignores non-numeric X-Pa-Session-Id header", async () => {
      const sendNotification = vi.fn().mockResolvedValue({ dispatchId: "d-nan-session" });
      const app = createAgentRoutes({ db, sendNotification } as never);

      const res = await app.request("/notify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Session-Id": "abc",
        },
        body: JSON.stringify({ message: "test" }),
      });

      expect(res.status).toBe(200);
      expect(sendNotification).toHaveBeenCalledWith(
        expect.not.objectContaining({ originSessionId: expect.anything() }),
      );
    });
  });

  // ── /schedule/batch ─────────────────────────────────────────────────────
  // docs/design/appendices/morning-routine-optimization.md §"POST
  // /api/schedule/batch". Atomic-by-default bulk insert with rich
  // taskContext per row.

  describe("POST /schedule/batch", () => {
    const baseValidRow = () => ({
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      taskType: "wake" as const,
      taskDescription: "Pre-brief the 15:00 standup with the two open Q2 risks.",
      taskContext: {
        background:
          "User flagged Q2 roadmap risks in yesterday's DM; standup needs the two open items front-loaded.",
        expected_output:
          "DM with two bullet items + one suggested mitigation each, sent 30min before standup.",
        references: ["projects/q2-roadmap.md#open-risks"],
      },
    });

    it("commits a happy-path batch and returns the new ids", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [baseValidRow(), baseValidRow()],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        ok: boolean;
        rowsAttempted: number;
        rowsCommitted: number;
        ids: number[];
      };
      expect(body.ok).toBe(true);
      expect(body.rowsAttempted).toBe(2);
      expect(body.rowsCommitted).toBe(2);
      expect(body.ids).toHaveLength(2);
      const persisted = db
        .prepare("SELECT COUNT(*) AS count FROM agent_schedule")
        .get() as { count: number };
      expect(persisted.count).toBe(2);
    });

    it("returns a no-op success on an empty rows array", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        rowsCommitted: number;
        ids: number[];
      };
      expect(body.ok).toBe(true);
      expect(body.rowsCommitted).toBe(0);
      expect(body.ids).toEqual([]);
    });

    it("rejects non-object body with body_not_object", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([baseValidRow()]),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        errors: Array<{ code: string; field: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.body_not_object");
    });

    it("rejects missing taskContext.background with task_context_field_missing", async () => {
      const app = createAgentRoutes({ db } as never);
      const row = baseValidRow();
      const rowWithoutBackground = {
        ...row,
        taskContext: { expected_output: row.taskContext.expected_output },
      };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [rowWithoutBackground] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        ok: boolean;
        rowsAttempted: number;
        rowsCommitted: number;
        retryable: boolean;
        retryHint?: string;
        errors: Array<{ code: string; field: string; rowIndex: number | null; hint: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.rowsAttempted).toBe(1);
      expect(body.rowsCommitted).toBe(0);
      expect(body.retryable).toBe(true);
      expect(body.retryHint).toBeTruthy();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].code).toBe("schedule.task_context_field_missing");
      expect(body.errors[0].field).toBe("rows[0].taskContext.background");
      expect(body.errors[0].rowIndex).toBe(0);
    });

    it("rejects too-short taskContext.background with task_context_field_too_short", async () => {
      const app = createAgentRoutes({ db } as never);
      const row = baseValidRow();
      const rowWithShortBackground = {
        ...row,
        taskContext: { ...row.taskContext, background: "tiny" },
      };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [rowWithShortBackground] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        errors: Array<{ code: string; field: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.task_context_field_too_short");
      expect(body.errors[0].field).toBe("rows[0].taskContext.background");
    });

    it("rejects past scheduledFor with scheduled_for_in_past per-row", async () => {
      const app = createAgentRoutes({ db } as never);
      const row = baseValidRow();
      const rowInPast = {
        ...row,
        scheduledFor: new Date(Date.now() - 120_000).toISOString(),
      };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [rowInPast] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        errors: Array<{ code: string; rowIndex: number | null }>;
      };
      expect(body.errors[0].code).toBe("schedule.scheduled_for_in_past");
      expect(body.errors[0].rowIndex).toBe(0);
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM agent_schedule")
        .get() as { count: number };
      expect(count.count).toBe(0);
    });

    it("rejects unparseable scheduledFor with scheduled_for_invalid", async () => {
      const app = createAgentRoutes({ db } as never);
      const row = baseValidRow();
      const rowBadDate = { ...row, scheduledFor: "not-a-date" };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [rowBadDate] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        errors: Array<{ code: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.scheduled_for_invalid");
    });

    it("rejects unknown taskType with task_type_unknown", async () => {
      const app = createAgentRoutes({ db } as never);
      const row = baseValidRow();
      const rowBadType = { ...row, taskType: "bogus" };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [rowBadType] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        errors: Array<{ code: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.task_type_unknown");
    });

    it("rejects > 50 rows with rows_too_many", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: Array.from({ length: 51 }, () => baseValidRow()),
        }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        errors: Array<{ code: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.rows_too_many");
    });

    it("rolls back the entire batch under atomic:true when one row is invalid", async () => {
      const app = createAgentRoutes({ db } as never);
      const goodRow = baseValidRow();
      const badRow = {
        ...baseValidRow(),
        scheduledFor: new Date(Date.now() - 120_000).toISOString(),
      };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [goodRow, badRow] }),
      });

      expect(res.status).toBe(422);
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM agent_schedule")
        .get() as { count: number };
      // No partial commit — the request is rejected before any insert
      // runs because the pre-insert validation pass catches the bad row.
      expect(count.count).toBe(0);
    });

    it("stores correlationId and normalizes legacy alias model on batch row (Phase D §4.3)", async () => {
      // Batch row with `model:"opus"` — Phase D rewrites to
      // `tier_override:"high"` and clears `(model, backend_id)`.
      const app = createAgentRoutes({ db } as never);
      const row = {
        ...baseValidRow(),
        correlationId: "morning-routine-2026-05-15-abc",
        model: "opus" as const,
      };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [row] }),
      });

      expect(res.status).toBe(201);
      const stored = db
        .prepare(
          "SELECT correlation_id, model, tier_override, backend_id FROM agent_schedule WHERE id = 1",
        )
        .get() as {
          correlation_id: string;
          model: string | null;
          tier_override: string | null;
          backend_id: string | null;
        };
      expect(stored.correlation_id).toBe("morning-routine-2026-05-15-abc");
      expect(stored.model).toBeNull();
      expect(stored.tier_override).toBe("high");
      expect(stored.backend_id).toBeNull();
    });

    it("stores (model, backend_id) on batch row when a registered id is pinned", async () => {
      const app = createAgentRoutes({ db } as never);
      const row = {
        ...baseValidRow(),
        model: "claude-opus-4-7" as string,
      };

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [row] }),
      });

      expect(res.status).toBe(201);
      const stored = db
        .prepare(
          "SELECT model, tier_override, backend_id FROM agent_schedule WHERE id = 1",
        )
        .get() as {
          model: string | null;
          tier_override: string | null;
          backend_id: string | null;
        };
      expect(stored.model).toBe("claude-opus-4-7");
      expect(stored.backend_id).toBe("claude");
      expect(stored.tier_override).toBeNull();
    });

    it("accumulates per-row warnings[] on batch when a row pins a deprecated id", async () => {
      const app = createAgentRoutes({ db } as never);
      const rows = [
        { ...baseValidRow(), model: "claude-opus-4-6" as string },
        { ...baseValidRow() }, // no model — no warning
      ];

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        warnings: Array<{ code: string; rowIndex: number | null }>;
      };
      // Exactly one warning, on row 0.
      expect(body.warnings.length).toBe(1);
      expect(body.warnings[0].code).toBe("schedule.model_deprecated");
      expect(body.warnings[0].rowIndex).toBe(0);
    });

    it("rejects an entire batch with schedule.tier_and_model_conflict on a single bad row (atomic default)", async () => {
      const app = createAgentRoutes({ db } as never);
      const rows = [
        { ...baseValidRow() },
        { ...baseValidRow(), model: "claude-opus-4-7" as string, tier: "high" as const },
      ];

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });

      expect(res.status).toBe(422);
      const body = await res.json() as {
        rowsCommitted: number;
        errors: Array<{ code: string; rowIndex: number | null }>;
      };
      expect(body.rowsCommitted).toBe(0);
      expect(body.errors[0].code).toBe("schedule.tier_and_model_conflict");
      expect(body.errors[0].rowIndex).toBe(1);
    });

    it("retains taskContext fields on the persisted row", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [baseValidRow()] }),
      });

      expect(res.status).toBe(201);
      const stored = db
        .prepare("SELECT task_context FROM agent_schedule WHERE id = 1")
        .get() as { task_context: string };
      const ctx = JSON.parse(stored.task_context) as {
        background: string;
        expected_output: string;
        references: string[];
      };
      expect(ctx.background.length).toBeGreaterThanOrEqual(30);
      expect(ctx.expected_output.length).toBeGreaterThanOrEqual(20);
      expect(ctx.references).toEqual(["projects/q2-roadmap.md#open-risks"]);
    });

    it("triggers roadmap refresh for strategic-importance rows", async () => {
      const triggerRoadmapRefresh = vi.fn();
      const app = createAgentRoutes({
        db,
        triggerRoadmapRefresh,
      } as never);

      const row = baseValidRow();
      (row.taskContext as Record<string, unknown>).importance = "strategic";

      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [row] }),
      });

      expect(res.status).toBe(201);
      expect(triggerRoadmapRefresh).toHaveBeenCalledWith("scheduled_task_created");
    });
  });

  // ── /agent-actions/self ─────────────────────────────────────────────────
  // docs/design/appendices/morning-routine-optimization.md §"PATCH
  // /api/agent-actions/self". Agent-self-reported structured metadata
  // patched into the row resolved from session identity headers.

  describe("PATCH /agent-actions/self", () => {
    function seedInFlightRow(
      eventId: string,
      actionType: string,
      existingMetadata: Record<string, unknown> | null = null,
    ): number {
      const result = db
        .prepare(
          `INSERT INTO agent_actions (event_id, action_type, result, metadata, started_at)
           VALUES (?, ?, 'in_progress', ?, datetime('now'))`,
        )
        .run(
          eventId,
          actionType,
          existingMetadata === null ? null : JSON.stringify(existingMetadata),
        );
      return Number(result.lastInsertRowid);
    }

    it("merges the patched metadata into the seeded in-flight row", async () => {
      const app = createAgentRoutes({ db } as never);
      const rowId = seedInFlightRow("evt-1", "routine.morning_routine_today");

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-1",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({
          metadata: {
            dayType: "weekday",
            anomalies: [],
            filesTouched: ["context/today.md"],
            inboxStats: {
              triaged: 4,
              movedToScratch: 4,
              dmConfirmsSent: 1,
              secretsSkipped: 0,
            },
            scheduleBatchSize: 5,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        id: number;
        metadata: Record<string, unknown>;
      };
      expect(body.ok).toBe(true);
      expect(body.id).toBe(rowId);
      expect(body.metadata.dayType).toBe("weekday");
      expect(body.metadata.scheduleBatchSize).toBe(5);

      const stored = db
        .prepare("SELECT metadata FROM agent_actions WHERE id = ?")
        .get(rowId) as { metadata: string };
      const persisted = JSON.parse(stored.metadata);
      expect(persisted.dayType).toBe("weekday");
    });

    it("shallow-merges across repeated PATCH calls within the same session", async () => {
      const app = createAgentRoutes({ db } as never);
      seedInFlightRow("evt-2", "routine.morning_routine_today", {
        dayType: "weekday",
      });

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-2",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({
          metadata: { anomalies: ["one"], filesTouched: ["context/today.md"] },
        }),
      });
      expect(res.status).toBe(200);

      const second = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-2",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({
          metadata: { anomalies: ["two"], scheduleBatchSize: 7 },
        }),
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as {
        metadata: Record<string, unknown>;
      };
      expect(body.metadata.dayType).toBe("weekday"); // preserved
      expect(body.metadata.anomalies).toEqual(["two"]); // later wins
      expect(body.metadata.filesTouched).toEqual(["context/today.md"]); // preserved
      expect(body.metadata.scheduleBatchSize).toBe(7);
    });

    it("returns 400 session_identity_missing when correlation id header is absent", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({ metadata: { dayType: "weekday" } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        ok: boolean;
        retryable: boolean;
        errors: Array<{ code: string; field: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.retryable).toBe(false);
      expect(body.errors[0].code).toBe("agent_actions.session_identity_missing");
      expect(body.errors[0].field).toBe("headers.x-pa-event-correlation-id");
    });

    it("returns 400 session_identity_missing when process-key header is absent", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-3",
        },
        body: JSON.stringify({ metadata: { dayType: "weekday" } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors: Array<{ code: string; field: string }>;
      };
      expect(body.errors.some((e) => e.field === "headers.x-process-key")).toBe(true);
    });

    it("returns 404 session_row_not_found when no row matches the headers", async () => {
      const app = createAgentRoutes({ db } as never);

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-missing",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({ metadata: { dayType: "weekday" } }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        retryable: boolean;
        errors: Array<{ code: string }>;
      };
      expect(body.retryable).toBe(false);
      expect(body.errors[0].code).toBe("agent_actions.session_row_not_found");
    });

    it("returns 400 metadata_field_invalid when metadata is missing", async () => {
      const app = createAgentRoutes({ db } as never);
      seedInFlightRow("evt-4", "routine.morning_routine_today");

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-4",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({ unrelated: true }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors: Array<{ code: string; field: string }>;
      };
      expect(body.errors[0].code).toBe("agent_actions.metadata_field_invalid");
    });

    it("returns 400 body_not_object when body is an array", async () => {
      const app = createAgentRoutes({ db } as never);
      seedInFlightRow("evt-5", "routine.morning_routine_today");

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-5",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify([{ metadata: { dayType: "weekday" } }]),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors: Array<{ code: string }>;
      };
      expect(body.errors[0].code).toBe("agent_actions.body_not_object");
    });

    it("recovers gracefully when the existing metadata column is corrupt JSON", async () => {
      const app = createAgentRoutes({ db } as never);
      // Seed an in-flight row whose metadata column is not valid JSON.
      // The endpoint should fall back to an empty existing-object,
      // overwrite with the PATCH body, and succeed (rather than 500).
      const result = db
        .prepare(
          `INSERT INTO agent_actions (event_id, action_type, result, metadata, started_at)
           VALUES (?, ?, 'in_progress', ?, datetime('now'))`,
        )
        .run("evt-8", "routine.morning_routine_today", "this is not json");
      const rowId = Number(result.lastInsertRowid);

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-8",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({ metadata: { dayType: "weekday" } }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        metadata: Record<string, unknown>;
      };
      expect(body.metadata.dayType).toBe("weekday");
      // Corrupted JSON was overwritten — metadata column now holds the
      // PATCH body verbatim.
      const stored = db
        .prepare("SELECT metadata FROM agent_actions WHERE id = ?")
        .get(rowId) as { metadata: string };
      expect(JSON.parse(stored.metadata)).toEqual({ dayType: "weekday" });
    });

    it("picks the most recent in-flight row when several share the same identity", async () => {
      const app = createAgentRoutes({ db } as never);
      // Older row (retry attempt 1).
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, result, started_at)
         VALUES (?, ?, 'failed', datetime('now', '-2 minutes'))`,
      ).run("evt-6", "routine.morning_routine_today");
      // Newer in-flight row (retry attempt 2).
      const newer = db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, result, started_at)
         VALUES (?, ?, 'in_progress', datetime('now'))`,
      ).run("evt-6", "routine.morning_routine_today");
      const newerId = Number(newer.lastInsertRowid);

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-6",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({ metadata: { dayType: "focus" } }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: number };
      expect(body.id).toBe(newerId);
    });

    it("returns 404 session_row_not_found when only terminal rows match", async () => {
      // Phase 1 in-flight filter: a settled `success` row sharing the
      // session's identity must NOT be patchable. The endpoint's contract
      // is "patch the running session's row" — once the row settles, the
      // metadata is part of the audit trail and is read-only.
      const app = createAgentRoutes({ db } as never);
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, result, started_at)
         VALUES (?, ?, 'success', datetime('now'))`,
      ).run("evt-terminal", "routine.morning_routine_today");

      const res = await app.request("/agent-actions/self", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Pa-Event-Correlation-Id": "evt-terminal",
          "X-Process-Key": "routine.morning_routine_today",
        },
        body: JSON.stringify({ metadata: { dayType: "weekday" } }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        errors: Array<{ code: string }>;
      };
      expect(body.errors[0].code).toBe("agent_actions.session_row_not_found");
      // Sanity-check: the row's metadata is unchanged — schema default
      // `'{}'` survives because the PATCH was rejected before any UPDATE.
      const stored = db
        .prepare(
          "SELECT metadata FROM agent_actions WHERE event_id = 'evt-terminal'",
        )
        .get() as { metadata: string };
      expect(JSON.parse(stored.metadata)).toEqual({});
    });
  });

  // ── Field-keyed remap regressions ───────────────────────────────────────

  describe("POST /schedule field-keyed envelope coverage", () => {
    it("missing time → schedule.scheduled_for_invalid (not the placeholder hint)", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "wake",
          prompt: "a".repeat(25),
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors: Array<{ code: string; field: string; hint: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.scheduled_for_invalid");
      expect(body.errors[0].hint).not.toMatch(/unregistered code/);
    });

    it("missing taskType → schedule.task_type_unknown (not the placeholder hint)", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: new Date(Date.now() + 3600_000).toISOString(),
          prompt: "a".repeat(25),
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        errors: Array<{ code: string; hint: string }>;
      };
      expect(body.errors[0].code).toBe("schedule.task_type_unknown");
      expect(body.errors[0].hint).not.toMatch(/unregistered code/);
    });
  });

  describe("POST /schedule/batch taskContext optional-field remap", () => {
    it("wrong-typed taskContext.references → schedule.task_context_field_wrong_type", async () => {
      const app = createAgentRoutes({ db } as never);
      const res = await app.request("/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
              taskType: "wake",
              taskDescription:
                "Pre-brief the 15:00 standup with the two open Q2 risks.",
              taskContext: {
                background:
                  "User flagged Q2 roadmap risks in yesterday's DM; standup needs the two open items front-loaded.",
                expected_output:
                  "DM with two bullet items + one mitigation each, sent 30min before standup.",
                references: "projects/q2-roadmap.md#open-risks",
              },
            },
          ],
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        errors: Array<{ code: string; field: string; hint: string }>;
      };
      expect(body.errors[0].code).toBe(
        "schedule.task_context_field_wrong_type",
      );
      expect(body.errors[0].field).toBe("rows[0].taskContext.references");
      expect(body.errors[0].hint).not.toMatch(/unregistered code/);
    });
  });

  // Registry reachability — per morning-routine-optimization.md
  // §"Test coverage": every registered schedule.* and agent_actions.* code
  // must be reachable via a crafted bad request. The table below pins
  // each code to a request body shape that should produce it. Adding a
  // new registry code without updating this table (or making it
  // unreachable) fails the drift-guard test at the bottom.

  describe("Registry reachability — schedule + agent_actions", () => {
    const futureIso = (offsetMs = 3600_000): string =>
      new Date(Date.now() + offsetMs).toISOString();
    const validBatchRow = (): Record<string, unknown> => ({
      scheduledFor: futureIso(),
      taskType: "wake",
      taskDescription:
        "Pre-brief the 15:00 standup with the two open Q2 risks.",
      taskContext: {
        background:
          "User flagged Q2 roadmap risks in yesterday's DM; standup needs the two open items front-loaded.",
        expected_output:
          "DM with two bullet items + one mitigation each, sent 30min before standup.",
      },
    });
    const seedInFlightRow = (eventId: string, actionType: string): void => {
      db.prepare(
        `INSERT INTO agent_actions (event_id, action_type, result, started_at)
         VALUES (?, ?, 'in_progress', datetime('now'))`,
      ).run(eventId, actionType);
    };

    type Case = {
      code: string;
      label: string;
      request: () => Promise<Response>;
    };

    const cases: Case[] = [
      {
        code: "schedule.scheduled_for_invalid",
        label: "POST /schedule with unparseable time",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: "not-a-date",
              taskType: "wake",
              prompt: "a".repeat(25),
            }),
          });
        },
      },
      {
        code: "schedule.scheduled_for_in_past",
        label: "POST /schedule with past time",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: new Date(Date.now() - 120_000).toISOString(),
              taskType: "wake",
              prompt: "a".repeat(25),
            }),
          });
        },
      },
      {
        // The single `/schedule` row no longer floors `description` (it is an
        // optional label and `prompt` is the required body). The 20-char floor
        // survives on batch rows, so exercise it there.
        code: "schedule.description_too_short",
        label: "POST /schedule/batch with short taskDescription",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          const row = validBatchRow();
          row.taskDescription = "tiny";
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: [row] }),
          });
        },
      },
      {
        // `taskPrompt` keeps its 20-char floor on batch rows (it is an
        // optional override there). The single-row `/schedule` prompt is
        // required and only emits prompt_required / prompt_too_long.
        code: "schedule.prompt_too_short",
        label: "POST /schedule/batch with short taskPrompt",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          const row = validBatchRow();
          row.taskPrompt = "x";
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: [row] }),
          });
        },
      },
      {
        code: "schedule.prompt_required",
        label: "POST /schedule with no prompt",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ time: futureIso(), taskType: "wake" }),
          });
        },
      },
      {
        code: "schedule.prompt_too_long",
        label: "POST /schedule with an over-cap prompt",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: futureIso(),
              taskType: "wake",
              prompt: "x".repeat(8001),
            }),
          });
        },
      },
      {
        code: "schedule.description_too_long",
        label: "POST /schedule with an over-cap description label",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: futureIso(),
              taskType: "wake",
              prompt: "A valid instruction for the wake-up agent.",
              description: "x".repeat(201),
            }),
          });
        },
      },
      {
        code: "schedule.model_unknown",
        label: "POST /schedule with invalid model",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: futureIso(),
              taskType: "wake",
              prompt: "a".repeat(25),
              model: "haiku",
            }),
          });
        },
      },
      {
        // Phase D §4.3 — both `tier` and `model` set on create.
        code: "schedule.tier_and_model_conflict",
        label: "POST /schedule with both tier and model",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: futureIso(),
              taskType: "wake",
              prompt: "a".repeat(25),
              model: "claude-opus-4-7",
              tier: "high",
            }),
          });
        },
      },
      {
        code: "schedule.tier_unknown",
        label: "POST /schedule with invalid tier",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: futureIso(),
              taskType: "wake",
              prompt: "a".repeat(25),
              tier: "ultra",
            }),
          });
        },
      },
      {
        code: "schedule.task_type_unknown",
        label: "POST /schedule with missing taskType",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              time: futureIso(),
              prompt: "a".repeat(25),
            }),
          });
        },
      },
      {
        code: "schedule.body_not_object",
        label: "POST /schedule/batch with array body",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([validBatchRow()]),
          });
        },
      },
      {
        code: "schedule.rows_field_missing",
        label: "POST /schedule/batch missing rows",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
        },
      },
      {
        code: "schedule.rows_too_many",
        label: "POST /schedule/batch with 51 rows",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rows: Array.from({ length: 51 }, () => validBatchRow()),
            }),
          });
        },
      },
      {
        code: "schedule.task_context_field_missing",
        label: "POST /schedule/batch missing taskContext.background",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          const row = validBatchRow();
          (row.taskContext as Record<string, unknown>) = {
            expected_output:
              "DM with two bullet items + one mitigation each, sent 30min before standup.",
          };
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: [row] }),
          });
        },
      },
      {
        code: "schedule.task_context_field_too_short",
        label: "POST /schedule/batch with short taskContext.background",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          const row = validBatchRow();
          (row.taskContext as Record<string, unknown>).background = "tiny";
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: [row] }),
          });
        },
      },
      {
        code: "schedule.task_context_field_wrong_type",
        label: "POST /schedule/batch with wrong-typed references",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          const row = validBatchRow();
          (row.taskContext as Record<string, unknown>).references =
            "not-an-array";
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: [row] }),
          });
        },
      },
      {
        code: "schedule.batch_atomic_invalid",
        label: "POST /schedule/batch with non-boolean atomic",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/schedule/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: [validBatchRow()], atomic: "yes" }),
          });
        },
      },
      {
        code: "agent_actions.session_identity_missing",
        label: "PATCH /agent-actions/self missing headers",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/agent-actions/self", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metadata: { dayType: "weekday" } }),
          });
        },
      },
      {
        code: "agent_actions.session_row_not_found",
        label: "PATCH /agent-actions/self with no matching row",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          return app.request("/agent-actions/self", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-Pa-Event-Correlation-Id": "evt-missing",
              "X-Process-Key": "routine.morning_routine_today",
            },
            body: JSON.stringify({ metadata: { dayType: "weekday" } }),
          });
        },
      },
      {
        code: "agent_actions.metadata_field_invalid",
        label: "PATCH /agent-actions/self with missing metadata",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          seedInFlightRow("evt-meta", "routine.morning_routine_today");
          return app.request("/agent-actions/self", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-Pa-Event-Correlation-Id": "evt-meta",
              "X-Process-Key": "routine.morning_routine_today",
            },
            body: JSON.stringify({ unrelated: true }),
          });
        },
      },
      {
        code: "agent_actions.body_not_object",
        label: "PATCH /agent-actions/self with array body",
        request: async () => {
          const app = createAgentRoutes({ db } as never);
          seedInFlightRow("evt-arr", "routine.morning_routine_today");
          return app.request("/agent-actions/self", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-Pa-Event-Correlation-Id": "evt-arr",
              "X-Process-Key": "routine.morning_routine_today",
            },
            body: JSON.stringify([{ metadata: { dayType: "weekday" } }]),
          });
        },
      },
    ];

    it.each(cases)(
      "$code reachable via $label",
      async ({ code, request }) => {
        const res = await request();
        expect(res.ok).toBe(false);
        const body = (await res.json()) as {
          errors: Array<{ code: string; hint: string }>;
        };
        expect(body.errors).toBeTruthy();
        const matching = body.errors.find((e) => e.code === code);
        expect(matching, `expected response to emit ${code}`).toBeTruthy();
        // Reachable codes must never surface the placeholder hint.
        expect(matching!.hint).not.toMatch(/unregistered code/);
      },
    );

    it("covers every registered schedule.* and agent_actions.* code reachable from this router", async () => {
      // Drift guard: if a new code lands in AGENT_ERROR_REGISTRY and the
      // table above isn't extended, this test fails. Codes outside the
      // schedule.* / agent_actions.* namespaces are covered by other
      // route suites (context.* lives in context.test.ts and downstream
      // suites as they migrate to the envelope).
      //
      // Phase D — exclusions:
      //   - Recurring-only codes (skillAnchor === "recurring#...") are
      //     reachable only via `/api/recurring-schedules`, which lives
      //     in a different router file. They're exercised by
      //     `recurring-schedules.test.ts`'s own reachability suite.
      //   - Warning-only codes (severity === "warning") never reach
      //     `body.errors[]` — they surface via `body.warnings[]`. The
      //     reachability assertion below switches on errors, so these
      //     get a separate "deprecated → warning" test elsewhere.
      //   - `schedule.backend_id_unknown` is a defensive code. The
      //     resolver narrows token prefixes against `BACKEND_IDS` and
      //     never returns the unknown shape today; the registry entry
      //     exists so a hand-constructed `(backend_id)` mutation from
      //     a future API path has a code to emit.
      const { AGENT_ERROR_REGISTRY } = await import(
        "../helpers/agent-errors.js"
      );
      const RECURRING_ONLY_PREFIX = "recurring#";
      // Phase D §5 — codes that are reachable in principle but require
      // a registry state that does not exist on this build:
      //   - `schedule.backend_id_unknown` is defensive; the resolver
      //     narrows backend tags against `BACKEND_IDS` so a real
      //     unknown-backend payload never lands.
      //   - `schedule.model_ambiguous` requires a collision across
      //     backends in `MODEL_REGISTRY`. The live registry has none
      //     (`claude-opus-4-7` vs opencode's `anthropic/claude-opus-4-7`
      //     differ); `schedule-validation.test.ts` exercises the
      //     branch with a synthetic snapshot.
      const KNOWN_DEFENSIVE = new Set<string>([
        "schedule.backend_id_unknown",
        "schedule.model_ambiguous",
      ]);
      const registered = new Set(
        Object.entries(AGENT_ERROR_REGISTRY)
          .filter(([key, entry]) => {
            if (!(key.startsWith("schedule.") || key.startsWith("agent_actions."))) {
              return false;
            }
            if (entry.severity === "warning") return false;
            if (entry.skillAnchor?.startsWith(RECURRING_ONLY_PREFIX)) return false;
            if (KNOWN_DEFENSIVE.has(key)) return false;
            return true;
          })
          .map(([key]) => key),
      );
      const exercised = new Set(cases.map((c) => c.code));
      const missing = [...registered].filter((c) => !exercised.has(c));
      expect(missing).toEqual([]);
    });
  });
});
