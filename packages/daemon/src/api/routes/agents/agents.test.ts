import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchema } from "../../../db/schema.js";
import type { AgentConfig } from "../../../config.js";
import type { ApiDependencies } from "../../server.js";
import {
  upsertAgent,
  getAgent,
  setLastExecutionId,
} from "../../../db/agents-store.js";
import {
  startExecution,
  completeExecution,
} from "../../../db/agent-executions-store.js";
import { createRecurringSchedule, getRecurringSchedule } from "../../../db/recurring-schedules.js";
import { createAgentDefinitionRoutes } from "./index.js";

const USER_AGENT_MD = `---
slug: my-task
name: My Task
description: Recurring task that does the thing every morning.
kind: user
schedule:
  kind: cron
  expression: "0 9 * * *"
backend:
  process_key: agent.task
limits: {}
---

Do the thing.
`;

interface Harness {
  db: Database.Database;
  app: ReturnType<typeof createAgentDefinitionRoutes>;
  tmp: string;
  userAgentPath: string;
  notifications: Array<{ message: string; notificationType?: string }>;
  broadcasts: Array<Record<string, unknown>>;
  invalidations: number;
  recurringId: number;
}

function setup(): Harness {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);

  const tmp = mkdtempSync(join(tmpdir(), "agents-routes-"));

  // ── built-in: morning-routine (no file on disk → registry fallback) ──
  upsertAgent(db, {
    slug: "morning-routine",
    name: "Morning Routine",
    description: "Generate today.md and register the day schedule.",
    source: "builtin",
    definitionPath: join(tmp, "builtin", "morning-routine", "agent.md"),
    definitionHash: "h-morning",
    enabled: true,
    processKey: "routine.morning_routine",
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "UTC",
    tags: ["routine", "daily"],
    stopWarning: { level: "critical", services_lost: ["today.md"], dependent_agents: [] },
  });
  const exId = startExecution(db, { agentId: "morning-routine", trigger: "cron" });
  completeExecution(db, {
    executionId: exId,
    result: "success",
    cost: { usd: 0.18 },
    successCriteriaHits: { today_md_populated: true },
    outputSummary: "today.md updated",
  });
  setLastExecutionId(db, "morning-routine", exId);

  // ── built-in: roadmap-maintenance (no-LLM, null process_key) ──
  upsertAgent(db, {
    slug: "roadmap-maintenance",
    name: "Roadmap Maintenance",
    description: "Mechanical roadmap.md maintenance pass.",
    source: "builtin",
    definitionPath: join(tmp, "builtin", "roadmap-maintenance", "agent.md"),
    definitionHash: "h-roadmap",
    enabled: true,
    processKey: null,
    scheduleKind: "cron",
    scheduleExpression: "45 17 * * *",
    scheduleTimezone: "UTC",
    stopWarning: { level: "high", services_lost: ["roadmap upkeep"], dependent_agents: [] },
  });

  // ── user: my-task (real file on disk + paired recurring row) ──
  const userDir = join(tmp, "policies", "agents", "my-task");
  mkdirSync(userDir, { recursive: true });
  const userAgentPath = join(userDir, "agent.md");
  writeFileSync(userAgentPath, USER_AGENT_MD, "utf-8");
  const recurring = createRecurringSchedule(db, {
    taskType: "agent.task",
    description: "My Task",
    prompt: "Do the thing",
    recurrenceRule: { frequency: "daily", time: "09:00", timezone: "UTC" },
  });
  upsertAgent(db, {
    slug: "my-task",
    name: "My Task",
    description: "Recurring task that does the thing every morning.",
    source: "user",
    definitionPath: userAgentPath,
    definitionHash: "h-user",
    enabled: true,
    processKey: "agent.task",
    scheduleKind: "cron",
    scheduleExpression: "0 9 * * *",
    scheduleTimezone: "UTC",
    recurringScheduleId: recurring.id,
  });

  // ── invalid: broken-agent (carries last_error) ──
  upsertAgent(db, {
    slug: "broken-agent",
    name: "broken-agent",
    description: null,
    source: "user",
    definitionPath: join(tmp, "policies", "agents", "broken-agent", "agent.md"),
    definitionHash: "h-broken",
    enabled: false,
    processKey: "agent.task",
    scheduleKind: "cron",
    scheduleExpression: null,
    scheduleTimezone: "UTC",
    metadata: { last_error: "schema validation failed: backend.process_key: required" },
  });

  const notifications: Harness["notifications"] = [];
  const broadcasts: Harness["broadcasts"] = [];
  let invalidations = 0;

  const deps = {
    db,
    config: { dayBoundaryHour: 4, timezone: "UTC" } as unknown as AgentConfig,
    eventBroadcaster: {
      broadcastEvent: (d: unknown) => broadcasts.push(d as Record<string, unknown>),
    },
    sendNotification: async (p: { message: string; notificationType?: string }) => {
      notifications.push(p);
      return { dispatchId: "x", deliveries: [] };
    },
    agentEnabledCache: {
      invalidate: () => {
        invalidations += 1;
      },
      isEnabled: () => true,
    },
  } as unknown as ApiDependencies;

  const harness: Harness = {
    db,
    app: createAgentDefinitionRoutes(deps),
    tmp,
    userAgentPath,
    notifications,
    broadcasts,
    get invalidations() {
      return invalidations;
    },
    recurringId: recurring.id,
  } as Harness;
  return harness;
}

describe("/api/agents routes", () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  // ── GET /agents ──────────────────────────────────────────────────────
  describe("GET /agents", () => {
    it("lists enabled valid agents with metrics + last execution, hiding invalid by default", async () => {
      const res = await h.app.request("/agents");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
      const slugs = body.agents.map((a) => a.slug);
      expect(slugs).toContain("morning-routine");
      expect(slugs).toContain("my-task");
      expect(slugs).not.toContain("broken-agent");

      const morning = body.agents.find((a) => a.slug === "morning-routine")!;
      expect(morning.kind).toBe("builtin");
      expect((morning.metrics_7d as Record<string, unknown>).executions).toBe(1);
      expect((morning.last_execution as Record<string, unknown>).result).toBe("success");
      expect(morning.stop_warning).toMatchObject({ level: "critical" });
    });

    it("filters by source and enabled", async () => {
      const res = await h.app.request("/agents?source=user&enabled=true");
      const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
      // broken-agent is enabled=0 + invalid; my-task is the only enabled valid user agent.
      expect(body.agents.map((a) => a.slug)).toEqual(["my-task"]);
    });

    it("surfaces invalid rows with last_error when include_invalid=true", async () => {
      const res = await h.app.request("/agents?include_invalid=true");
      const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
      const broken = body.agents.find((a) => a.slug === "broken-agent");
      expect(broken).toBeDefined();
      expect(broken!.invalid).toBe(true);
      expect(broken!.last_error).toMatch(/schema validation failed/);
    });
  });

  // ── GET /agents/:slug ────────────────────────────────────────────────
  describe("GET /agents/:slug", () => {
    it("returns the synthesized definition + metric windows for a fileless built-in", async () => {
      const res = await h.app.request("/agents/morning-routine");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.agent.slug).toBe("morning-routine");
      expect(body.definition_yaml).toBeNull();
      expect(body.metrics["7d"].executions).toBe(1);
      expect(body.metrics["30d"]).toBeDefined();
      expect(body.metrics.by_error_kind_7d).toBeDefined();
      expect(body.recent_executions.length).toBe(1);
      expect(body.row.process_key).toBe("routine.morning_routine");
    });

    it("returns the file-parsed definition for a user agent", async () => {
      const res = await h.app.request("/agents/my-task");
      const body = (await res.json()) as Record<string, any>;
      expect(body.agent.kind).toBe("user");
      expect(body.agent.backend.process_key).toBe("agent.task");
      expect(body.definition_yaml).toBe(USER_AGENT_MD);
    });

    it("404s an unknown slug", async () => {
      const res = await h.app.request("/agents/nope");
      expect(res.status).toBe(404);
    });
  });

  // ── GET /agents/:slug/executions ─────────────────────────────────────
  describe("GET /agents/:slug/executions", () => {
    it("paginates execution history", async () => {
      const res = await h.app.request("/agents/morning-routine/executions?limit=10");
      const body = (await res.json()) as { executions: Array<Record<string, unknown>> };
      expect(body.executions.length).toBe(1);
      expect(body.executions[0].result).toBe("success");
      expect(body.executions[0].started_at).toMatch(/T.*Z$/);
    });

    it("filters by result and 404s an unknown slug", async () => {
      const filtered = await h.app.request("/agents/morning-routine/executions?result=error");
      expect(((await filtered.json()) as { executions: unknown[] }).executions).toEqual([]);
      const missing = await h.app.request("/agents/nope/executions");
      expect(missing.status).toBe(404);
    });
  });

  // ── POST /agents/:slug/run-now ───────────────────────────────────────
  describe("POST /agents/:slug/run-now", () => {
    it("enqueues a built-in routine row with agent_id + routine marker, and DMs the owner", async () => {
      const res = await h.app.request("/agents/morning-routine/run-now", { method: "POST" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { schedule_row_id: number; execution_id: null };
      expect(body.execution_id).toBeNull();
      expect(h.notifications.length).toBe(1);
      expect(h.notifications[0].notificationType).toBe("agent");

      const row = h.db
        .prepare("SELECT task_type, task_context FROM agent_schedule WHERE id = ?")
        .get(body.schedule_row_id) as { task_type: string; task_context: string };
      expect(row.task_type).toBe("routine.morning_routine");
      const ctx = JSON.parse(row.task_context);
      expect(ctx).toMatchObject({ agent_id: "morning-routine", trigger: "manual", routine: "morning_routine" });
    });

    it("honours an optional trigger_note: stamps task_context + echoes it in the audit (§9.4)", async () => {
      const res = await h.app.request("/agents/my-task/run-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger_note: "manual smoke" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { schedule_row_id: number };
      const row = h.db
        .prepare("SELECT task_context FROM agent_schedule WHERE id = ?")
        .get(body.schedule_row_id) as { task_context: string };
      expect(JSON.parse(row.task_context).trigger_note).toBe("manual smoke");

      const audit = h.db
        .prepare("SELECT detail FROM agent_actions WHERE action_type = 'agent.run_now' AND agent_id = 'my-task' ORDER BY id DESC LIMIT 1")
        .get() as { detail: string };
      expect(JSON.parse(audit.detail).trigger_note).toBe("manual smoke");
    });

    it("enqueues a user row carrying the recurring prompt and sends no DM", async () => {
      const res = await h.app.request("/agents/my-task/run-now", { method: "POST" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { schedule_row_id: number };
      expect(h.notifications.length).toBe(0);
      const row = h.db
        .prepare("SELECT task_prompt, task_context FROM agent_schedule WHERE id = ?")
        .get(body.schedule_row_id) as { task_prompt: string; task_context: string };
      expect(row.task_prompt).toBe("Do the thing");
      expect(JSON.parse(row.task_context).agent_id).toBe("my-task");
    });

    it("copies the user Agent's backend/model/tier pin onto the run-now row", async () => {
      // Engine-only pin (backend_id set, model null): a manual run must enqueue
      // the same routing fields a cron fire would (generateNextScheduleRow), so
      // the scheduler routes it to the pinned backend. Regression guard for the
      // run-now path silently dropping the Agent's backend selection.
      h.db
        .prepare("UPDATE recurring_schedules SET backend_id = 'codex', tier_override = 'lite' WHERE id = ?")
        .run(h.recurringId);
      const res = await h.app.request("/agents/my-task/run-now", { method: "POST" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { schedule_row_id: number };
      const row = h.db
        .prepare("SELECT backend_id, model, tier_override FROM agent_schedule WHERE id = ?")
        .get(body.schedule_row_id) as {
          backend_id: string | null;
          model: string | null;
          tier_override: string | null;
        };
      expect(row.backend_id).toBe("codex");
      expect(row.model).toBeNull();
      expect(row.tier_override).toBe("lite");
    });

    it("409s a no-LLM in-process pass", async () => {
      const res = await h.app.request("/agents/roadmap-maintenance/run-now", { method: "POST" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("agent_not_runnable");
    });

    it("409s an invalid agent and 404s an unknown slug", async () => {
      const invalid = await h.app.request("/agents/broken-agent/run-now", { method: "POST" });
      expect(invalid.status).toBe(409);
      expect(((await invalid.json()) as { error: string }).error).toBe("agent_invalid");
      const missing = await h.app.request("/agents/nope/run-now", { method: "POST" });
      expect(missing.status).toBe(404);
    });
  });

  // ── PATCH /agents/:slug ──────────────────────────────────────────────
  describe("PATCH /agents/:slug", () => {
    const patch = (slug: string, body: unknown) =>
      h.app.request(`/agents/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("blocks disabling a built-in without ack_warning (409 + warning)", async () => {
      const res = await patch("morning-routine", { enabled: false });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; warning: Record<string, unknown> };
      expect(body.error).toBe("stop_warning_required");
      expect(body.warning).toMatchObject({ level: "critical" });
    });

    it("re-disabling an already-stopped built-in is a 200 no-op, not a 409 (no fresh ack required)", async () => {
      // Stop it first (with ack)…
      expect((await patch("morning-routine", { enabled: false, ack_warning: true })).status).toBe(200);
      // …then a second `{enabled:false}` is not a transition, so no ack gate.
      const res = await patch("morning-routine", { enabled: false });
      expect(res.status).toBe(200);
      // Still disabled; no second enabled-change audit row was written.
      expect(getAgent(h.db, "morning-routine")!.enabled).toBe(false);
      const audit = h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE action_type = 'agent.enabled_changed' AND agent_id = 'morning-routine'")
        .get() as { n: number };
      expect(audit.n).toBe(1);
    });

    it("disables a built-in with ack_warning: column flips, cache invalidated, audit + SSE recorded", async () => {
      const res = await patch("morning-routine", { enabled: false, ack_warning: true });
      expect(res.status).toBe(200);
      expect(getAgent(h.db, "morning-routine")!.enabled).toBe(false);
      expect(h.invalidations).toBeGreaterThan(0);
      expect(h.broadcasts.some((b) => b.kind === "agent.enabled_changed")).toBe(true);
      const audit = h.db
        .prepare("SELECT detail FROM agent_actions WHERE action_type = 'agent.enabled_changed' AND agent_id = 'morning-routine'")
        .all() as Array<{ detail: string }>;
      expect(audit.length).toBe(1);
      // The stop-warning consent is persisted in the audit detail (§12.3).
      expect(JSON.parse(audit[0].detail)).toMatchObject({ enabled: false, ack_warning: true });
    });

    it("writes a built-in override snapshot and reflects it in the effective definition", async () => {
      const set = await patch("morning-routine", { backend: { tier: "high" } });
      expect(set.status).toBe(200);
      const stored = getAgent(h.db, "morning-routine")!;
      expect(stored.metadata.override_snapshot).toEqual({ "backend.tier": "high" });
      const detail = (await (await h.app.request("/agents/morning-routine")).json()) as Record<string, any>;
      expect(detail.agent.backend.tier).toBe("high");

      const reset = await patch("morning-routine", { reset: ["backend.tier"] });
      expect(reset.status).toBe(200);
      expect(getAgent(h.db, "morning-routine")!.metadata.override_snapshot).toBeUndefined();
    });

    it("strips read-only fields on a built-in and reports them", async () => {
      const res = await patch("morning-routine", { process_key: "routine.x", schedule: { kind: "cron" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { stripped: string[] };
      expect(body.stripped).toEqual(expect.arrayContaining(["process_key", "schedule"]));
      // read-only field did not change the row
      expect(getAgent(h.db, "morning-routine")!.processKey).toBe("routine.morning_routine");
    });

    it("mirrors a user enabled toggle onto its recurring row", async () => {
      const res = await patch("my-task", { enabled: false });
      expect(res.status).toBe(200);
      expect(getAgent(h.db, "my-task")!.enabled).toBe(false);
      expect(getRecurringSchedule(h.db, h.recurringId)!.enabled).toBe(false);
    });

    it("routes user field edits to the file (400)", async () => {
      const res = await patch("my-task", { limits: { max_turns: 5 } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("user_agent_edit_via_file");
    });

    it("404s an unknown slug", async () => {
      const res = await patch("nope", { enabled: true });
      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /agents/:slug ─────────────────────────────────────────────
  describe("DELETE /agents/:slug", () => {
    it("409s a built-in (system Agents are undeletable)", async () => {
      const res = await h.app.request("/agents/morning-routine", { method: "DELETE" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("system_agent_undeletable");
      expect(body.hint).toMatch(/stopped but not deleted/);
    });

    it("disables a user agent + its recurring row by default (keep_history), retaining the row", async () => {
      const res = await h.app.request("/agents/my-task", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("disabled");
      expect(getAgent(h.db, "my-task")!.enabled).toBe(false);
      expect(getRecurringSchedule(h.db, h.recurringId)!.enabled).toBe(false);
      expect(existsSync(h.userAgentPath)).toBe(true); // file untouched
    });

    it("hard-deletes the row + file when keep_history is false", async () => {
      const res = await h.app.request("/agents/my-task", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep_history: false }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("deleted");
      expect(getAgent(h.db, "my-task")).toBeNull();
      expect(existsSync(h.userAgentPath)).toBe(false);
      // The paired recurring row is deleted too (not just disabled), so the
      // loader's first-boot auto-import can't resurrect it as imported-<id>.
      expect(getRecurringSchedule(h.db, h.recurringId)).toBeNull();
      // snapshot recorded for recovery
      const snap = h.db
        .prepare("SELECT COUNT(*) AS n FROM md_file_snapshots WHERE trigger = 'agent_delete'")
        .get() as { n: number };
      expect(snap.n).toBe(1);
    });

    it("404s an unknown slug", async () => {
      const res = await h.app.request("/agents/nope", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
