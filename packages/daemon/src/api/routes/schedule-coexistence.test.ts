import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { applySchema } from "../../db/schema.js";
import { registerAgentScheduleRoutes } from "./agent-schedule.js";
import { createRecurringScheduleRoutes } from "./recurring-schedules.js";
import { createAgentDefinitionRoutes } from "./agents/index.js";
import {
  createRecurringSchedule,
  reconcileRecurringSchedules,
} from "../../db/recurring-schedules.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";

// AGENT_DEFINITIONS_IMPLEMENTATION_PLAN.md Phase 10 — §14 "Coexistence"
// rows. The Agent Definitions layer touched files the `/schedule` skill
// depends on (`db/recurring-schedules.ts` for §7.2 agent_id stamping,
// `db/schema.ts`, `migrations.ts`) and mounts a brand-new `/api/agents`
// route group on the same Hono router. This suite proves the skill's
// documented JSON contract is UNCHANGED end-to-end:
//
//   1. doc↔code parity — every `/api/schedule*` endpoint the skill's
//      SKILL.md documents is served by the live route (no rename / drop).
//   2. response-shape fidelity — each documented endpoint round-trips the
//      exact request/response shape the skill prints (GET item key-set is
//      asserted EXACTLY, so a leaked `agent_id` field would fail here).
//   3. agent_id isolation — a raw recurring row (no owning Agent) materialises
//      WITHOUT `task_context.agent_id` (the stamp is owner-lookup-only and must
//      not leak onto unowned rows). Created here via the `createRecurringSchedule`
//      DB fn since the agent.task HTTP create door is gated. DB-store-level
//      isolation is covered in `db/recurring-schedules.test.ts`; this asserts it through
//      the actual skill route + reconciler.
//   4. route non-collision — mounting `/api/agents` alongside does not
//      shadow `/api/schedule` or `/api/recurring-schedules`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");
const SCHEDULE_SKILL_MD = join(
  REPO_ROOT,
  "agent-assets/skills/schedule/SKILL.md",
);

// The `### METHOD /api/path` headers under the skill's "## API Reference"
// section ARE the skill's published JSON contract. Freezing the expected
// set turns any add / drop / rename of a documented endpoint into a
// deliberate test update — the literal "contract is unchanged" guard.
const EXPECTED_SCHEDULE_ENDPOINTS = [
  "POST /api/schedule",
  "POST /api/schedule/batch",
  "POST /api/schedule/dm",
  "GET /api/schedule",
  "PATCH /api/schedule/:id",
  "DELETE /api/schedule/:id",
].sort();

// GET /api/schedule item shape the skill documents verbatim (SKILL.md
// "GET /api/schedule" response line). An extra/missing key here is a
// contract break — in particular a leaked `agentId`/`agent_id` would be
// exactly the coexistence regression this row guards against.
const EXPECTED_SCHEDULE_ITEM_KEYS = [
  "id",
  "scheduledFor",
  "taskType",
  "description",
  "prompt",
  "status",
  "model",
  "tier",
  "backendId",
  "taskContext",
  "createdAt",
].sort();

function extractDocumentedEndpoints(markdown: string): string[] {
  const endpoints: string[] = [];
  const headerRe = /^###\s+(GET|POST|PATCH|DELETE)\s+(\/api\/\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(markdown)) !== null) {
    endpoints.push(`${match[1]} ${match[2]}`);
  }
  return endpoints.sort();
}

interface Harness {
  app: Hono;
  db: Database.Database;
  tmp: string;
}

function setup(): Harness {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);

  const tmp = mkdtempSync(join(tmpdir(), "schedule-coexist-"));

  // dataDir → tmp keeps the recurring route's best-effort
  // `## Default Schedules` mirror reconciler (getContextDir → dataDir)
  // hermetic; any write lands under tmp and is removed in afterEach.
  const deps = {
    db,
    config: {
      timezone: "Asia/Tokyo",
      dayBoundaryHour: 4,
      dataDir: tmp,
    } as unknown as AgentConfig,
    triggerRoadmapRefresh: undefined,
    eventBroadcaster: { broadcastEvent: () => {} },
    agentEnabledCache: { invalidate: () => {}, isEnabled: () => true },
  } as unknown as ApiDependencies;

  // Mirror server.ts: all three route groups mount under a single `/api`
  // sub-app on one router, so a collision between the new `/api/agents`
  // group and the existing `/schedule*` / `/recurring-schedules*` groups
  // would surface here exactly as it would in production.
  const api = new Hono();
  registerAgentScheduleRoutes(api, deps); // mutates `api` → adds /schedule*
  api.route("/", createRecurringScheduleRoutes(deps)); // adds /recurring-schedules*
  api.route("/", createAgentDefinitionRoutes(deps)); // adds /agents*

  const app = new Hono();
  app.route("/api", api);

  return { app, db, tmp };
}

function futureIso(minutesAhead: number): string {
  return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

describe("/schedule skill coexistence with the Agent Definitions layer", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  describe("doc↔code parity (§14 coexistence — skill-contract)", () => {
    it("SKILL.md documents exactly the frozen `/api/schedule*` endpoint set", () => {
      const md = readFileSync(SCHEDULE_SKILL_MD, "utf-8");
      expect(extractDocumentedEndpoints(md)).toEqual(EXPECTED_SCHEDULE_ENDPOINTS);
    });

    it("every documented endpoint is served by the live route (not 404)", async () => {
      // POST /api/schedule — create so PATCH/DELETE have a real id.
      const created = await h.app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: futureIso(120),
          taskType: "wake",
          prompt: "Coexistence probe: verify the schedule route is served end-to-end",
          description: "Coexistence probe: verify the schedule route is served",
          tier: "lite",
          taskContext: { scheduledBy: "coexistence_test" },
        }),
      });
      expect(created.status).toBe(200);
      const createdJson = (await created.json()) as { scheduleId: string };
      const id = createdJson.scheduleId;

      // Each documented endpoint must resolve to its handler (never 404).
      const batch = await h.app.request("/api/schedule/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(batch.status).not.toBe(404); // served (400 for the empty body)

      const dm = await h.app.request("/api/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(dm.status).not.toBe(404);

      const list = await h.app.request("/api/schedule?status=pending");
      expect(list.status).toBe(200);

      const patch = await h.app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: futureIso(180) }),
      });
      expect(patch.status).toBe(200);

      const del = await h.app.request(`/api/schedule/${id}`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);
    });
  });

  describe("response-shape fidelity (contract unchanged)", () => {
    it("POST /api/schedule returns { status, scheduleId, scheduledFor }", async () => {
      const res = await h.app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: futureIso(90),
          taskType: "wake",
          prompt: "Schedule a self-contained agent task for the shape test",
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.status).toBe("scheduled");
      expect(typeof json.scheduleId).toBe("string");
      expect(typeof json.scheduledFor).toBe("string");
    });

    it("POST /api/schedule/dm returns { status, scheduleId, scheduledFor }", async () => {
      const res = await h.app.request("/api/schedule/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: futureIso(45),
          message: "Reminder: design review in 30 min.",
          platform: "slack",
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.status).toBe("scheduled");
      expect(typeof json.scheduleId).toBe("string");
      expect(typeof json.scheduledFor).toBe("string");
    });

    it("GET /api/schedule returns { items } with the documented item key-set (no leaked fields)", async () => {
      await h.app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: futureIso(60),
          taskType: "wake",
          prompt: "Schedule a task so the list endpoint returns one item",
        }),
      });
      const res = await h.app.request("/api/schedule?status=pending");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { items: Record<string, unknown>[] };
      expect(Array.isArray(json.items)).toBe(true);
      expect(json.items.length).toBeGreaterThan(0);
      for (const item of json.items) {
        expect(Object.keys(item).sort()).toEqual(EXPECTED_SCHEDULE_ITEM_KEYS);
      }
    });

    it("PATCH /api/schedule/:id returns { status, id, warnings }; DELETE returns { status, id }", async () => {
      const created = await h.app.request("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: futureIso(120),
          taskType: "wake",
          prompt: "Schedule a task to exercise PATCH then DELETE round-trip",
        }),
      });
      const id = ((await created.json()) as { scheduleId: string }).scheduleId;

      const patch = await h.app.request(`/api/schedule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ time: futureIso(150) }),
      });
      expect(patch.status).toBe(200);
      const patchJson = (await patch.json()) as Record<string, unknown>;
      expect(patchJson.status).toBe("updated");
      expect(patchJson.id).toBe(Number(id));
      expect(Array.isArray(patchJson.warnings)).toBe(true);

      const del = await h.app.request(`/api/schedule/${id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      const delJson = (await del.json()) as Record<string, unknown>;
      expect(delJson.status).toBe("cancelled");
      expect(delJson.id).toBe(Number(id));
    });

    it("recurring-schedules is dm_session-only: dm_session works, agent.task is 410", async () => {
      // The split keeps recurring scheduled DMs (dm_session — the morning
      // briefing, retimed by quiet-hours-sync) on this route; recurring
      // agent.task LLM work moved to /api/agents.
      const dmPost = await h.app.request("/api/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "dm_session",
          description: "Morning briefing daily summary delivered as a DM at 07:00",
          recurrenceRule: { frequency: "daily", time: "07:00", timezone: "UTC" },
          taskContext: { sub_flow: "morning_briefing", pin_to_quiet_hours_end: true },
        }),
      });
      expect(dmPost.status).toBe(201);

      const agentTaskPost = await h.app.request("/api/recurring-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskType: "agent.task",
          description: "Daily inbox triage at 09:00 via a recurring rule",
          recurrenceRule: { frequency: "daily", time: "09:00", timezone: "UTC" },
        }),
      });
      expect(agentTaskPost.status).toBe(410);
      const postJson = (await agentTaskPost.json()) as Record<string, unknown>;
      expect(postJson.error).toBe("recurring_agent_task_moved_to_agents");
      expect(String(postJson.hint)).toContain("/api/agents");

      const list = await h.app.request("/api/recurring-schedules?enabled=true");
      expect(list.status).toBe(200);
      const listJson = (await list.json()) as { items: unknown[] };
      expect(Array.isArray(listJson.items)).toBe(true);
    });

    it("POST /api/agents rejects a one_shot schedule with a /schedule pointer", async () => {
      const res = await h.app.request("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "one-off-agent",
          name: "One Off",
          schedule: { kind: "one_shot", one_shot_at: futureIso(60) },
        }),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error).toBe("one_shot_not_supported");
      expect(String(json.hint)).toContain("/api/schedule");
    });
  });

  describe("agent_id isolation (Agent layer must not touch skill-created rows)", () => {
    it("a raw recurring row materialises without task_context.agent_id", () => {
      // Create the raw row via the DB store (the HTTP create door is now 410).
      const dto = createRecurringSchedule(h.db, {
        taskType: "agent.task",
        description: "Raw recurring rule with no paired Agent definition",
        recurrenceRule: { frequency: "daily", time: "09:00", timezone: "UTC" },
      });

      // Cancel the create-time materialised row and force a fresh
      // reconcile so we exercise the §7.2 stamping branch directly.
      h.db
        .prepare(
          "UPDATE agent_schedule SET status='completed' WHERE recurring_schedule_id = ?",
        )
        .run(dto.id);
      const generated = reconcileRecurringSchedules(h.db);
      expect(generated).toBeGreaterThan(0);

      const row = h.db
        .prepare<[number], { task_context: string }>(
          "SELECT task_context FROM agent_schedule WHERE recurring_schedule_id = ? AND status='pending' ORDER BY id DESC LIMIT 1",
        )
        .get(dto.id);
      expect(row).toBeTruthy();
      const ctx = JSON.parse(row!.task_context) as Record<string, unknown>;
      expect("agent_id" in ctx).toBe(false);
    });
  });

  describe("route non-collision", () => {
    it("/api/agents is served and does not shadow /api/schedule or /api/recurring-schedules", async () => {
      const agents = await h.app.request("/api/agents");
      expect(agents.status).toBe(200);

      // The pre-existing skill endpoints still resolve to their handlers.
      const sched = await h.app.request("/api/schedule?status=pending");
      expect(sched.status).toBe(200);
      const recurring = await h.app.request("/api/recurring-schedules");
      expect(recurring.status).toBe(200);
    });
  });
});
