import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { applySchema } from "../../db/schema.js";
import { createTasksRoutes } from "./tasks.js";
import { createRecurringScheduleRoutes } from "./recurring-schedules.js";
import { createRecurringSchedule } from "../../db/recurring-schedules.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";

/**
 * `/api/tasks` — L0 read board + L1 write facade. The facade test composes the
 * tasks router with the REAL recurring-schedules owner router and forwards
 * through it, so the round-trip proves the facade reaches the hardened owner
 * (its validation/cascade unchanged), not a reimplementation. Tier enforcement
 * (agent: stays Approve) rides the top-level auth middleware in production and
 * is asserted at the pure planner + risk-classifier level.
 */

function makeConfig(): AgentConfig {
  return { timezone: "Asia/Tokyo" } as unknown as AgentConfig;
}
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}
function makeDeps(db: Database.Database): ApiDependencies {
  return { db, config: makeConfig() } as unknown as ApiDependencies;
}

function seedDmSession(db: Database.Database): number {
  return createRecurringSchedule(db, {
    taskType: "dm_session",
    description: "morning briefing — daily summary sent at wake time",
    recurrenceRule: { frequency: "daily", time: "08:00", timezone: "Asia/Tokyo" },
    taskContext: { sub_flow: "morning_briefing" },
  }).id;
}
function seedPendingOneOff(db: Database.Database): void {
  db.prepare(
    `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
     VALUES (?, 'dm_session', ?, 'pending')`,
  ).run("2026-06-30 15:00:00", "call dentist");
}

describe("GET /tasks — inventory", () => {
  let db: Database.Database;
  let board: ReturnType<typeof createTasksRoutes>;
  beforeEach(() => {
    db = makeDb();
    board = createTasksRoutes({ db });
  });
  afterEach(() => db.close());

  it("projects dm_session rows and pending one-offs with typed refs", async () => {
    const rsId = seedDmSession(db);
    seedPendingOneOff(db);
    const res = await board.request("/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { ref: string; kind: string; origin: string }[];
      total: number;
      generatedAt: string;
    };
    expect(body.total).toBe(2);
    const dm = body.items.find((i) => i.ref === `rs:${rsId}`);
    expect(dm).toMatchObject({ kind: "dm", origin: "system" });
    expect(body.items.some((i) => i.kind === "reminder")).toBe(true);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("returns an empty board when nothing is scheduled", async () => {
    const res = await board.request("/tasks");
    expect(await res.json()).toMatchObject({ items: [], total: 0 });
  });
});

describe("GET /tasks/impact — blast radius", () => {
  let db: Database.Database;
  let board: ReturnType<typeof createTasksRoutes>;
  beforeEach(() => {
    db = makeDb();
    board = createTasksRoutes({ db });
  });
  afterEach(() => db.close());

  it("previews a live recurring row", async () => {
    const rsId = seedDmSession(db);
    const res = await board.request(`/tasks/impact?ref=rs:${rsId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { found: boolean; nodes: { cascade: string }[] };
    expect(body.found).toBe(true);
    expect(body.nodes[0].cascade).toBe("self");
  });

  it("returns found:false (200) for a well-formed but missing ref", async () => {
    const res = await board.request("/tasks/impact?ref=rs:999");
    expect(res.status).toBe(200);
    expect((await res.json()) as { found: boolean }).toMatchObject({ found: false });
  });

  it("400s on a missing or malformed ref", async () => {
    expect((await board.request("/tasks/impact")).status).toBe(400);
    expect((await board.request("/tasks/impact?ref=not-a-ref")).status).toBe(400);
  });
});

describe("L1 facade — routes to the hardened owner", () => {
  let db: Database.Database;
  let app: Hono;
  beforeEach(() => {
    db = makeDb();
    const deps = makeDeps(db);
    const owner = new Hono();
    owner.route("/api", createRecurringScheduleRoutes(deps));
    const tasks = createTasksRoutes({ db, dispatch: (req) => owner.fetch(req) });
    app = new Hono();
    app.route("/api", tasks);
  });
  afterEach(() => db.close());

  const post = (body: unknown) =>
    app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("kind:'dm' creates a dm_session recurring row via /api/recurring-schedules", async () => {
    const res = await post({
      kind: "dm",
      description: "A recurring scheduled DM reminder for the daily standup",
      recurrenceRule: { frequency: "daily", time: "09:00", timezone: "Asia/Tokyo" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ok: boolean;
      dispatchedTo: string;
      result: { status: string; item: { id: number; taskType: string } };
    };
    expect(body).toMatchObject({ ok: true, dispatchedTo: "/api/recurring-schedules" });
    expect(body.result.item.taskType).toBe("dm_session");
  });

  it("§9 guard: kind:'dm' with taskType:'agent.task' is pinned to dm_session (no 410)", async () => {
    const res = await post({
      kind: "dm",
      taskType: "agent.task",
      description: "This must be pinned back to a dm_session row, never agent.task",
      recurrenceRule: { frequency: "daily", time: "09:00", timezone: "Asia/Tokyo" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { result: { item: { taskType: string } } }).result.item.taskType).toBe(
      "dm_session",
    );
  });

  it("PATCH then DELETE by ref route to the owner and preserve its cascade", async () => {
    const rsId = seedDmSession(db);
    const patch = await app.request(`/api/tasks/rs:${rsId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { result: { status: string } }).result.status).toBe("updated");

    const del = await app.request(`/api/tasks/rs:${rsId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { result: { status: string } }).result.status).toBe("deleted");
    // The owner actually deleted the row.
    expect(db.prepare("SELECT COUNT(*) AS n FROM recurring_schedules").get()).toMatchObject({ n: 0 });
  });

  it("rejects read-only fulfiller refs (422) without dispatching", async () => {
    const res = await app.request("/api/tasks/bt:some-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("ref_not_editable");
  });

  it("400s on an unknown kind, a missing kind, or a malformed ref", async () => {
    expect((await post({ kind: "bogus" })).status).toBe(400);
    expect((await post({ description: "x" })).status).toBe(400);
    expect((await app.request("/api/tasks/zzz:1", { method: "DELETE" })).status).toBe(400);
  });
});

describe("L1 facade — DELETE forwards the caller body (audit A2)", () => {
  let db: Database.Database;
  let app: Hono;
  let forwarded: { method: string; path: string; body: string } | null;

  beforeEach(() => {
    db = makeDb();
    forwarded = null;
    // Spy dispatcher — capture the request the facade forwards to the owner.
    const dispatch = async (req: Request): Promise<Response> => {
      forwarded = {
        method: req.method,
        path: new URL(req.url).pathname,
        body: await req.text(),
      };
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const tasks = createTasksRoutes({ db, dispatch });
    app = new Hono();
    app.route("/api", tasks);
  });
  afterEach(() => db.close());

  it("forwards {keep_history:false} to the agent owner so its hard-delete branch is reachable", async () => {
    // Before the fix the facade dropped the body, so the agent owner always saw
    // keepHistory=true (disable) and a board-driven hard-delete was impossible.
    const res = await app.request("/api/tasks/agent:my-agent", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep_history: false }),
    });
    expect(res.status).toBe(200);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.method).toBe("DELETE");
    expect(forwarded!.path).toBe("/api/agents/my-agent");
    expect(JSON.parse(forwarded!.body)).toEqual({ keep_history: false });
  });

  it("forwards NO body for a body-less DELETE (rs/mt/as owners read the path id only)", async () => {
    const res = await app.request("/api/tasks/rs:1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.path).toBe("/api/recurring-schedules/1");
    expect(forwarded!.body).toBe(""); // absent body → undefined → not forwarded
  });

  it("400s a PRESENT-but-malformed DELETE body without dispatching (consistent with PATCH)", async () => {
    const res = await app.request("/api/tasks/agent:my-agent", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_json_body");
    expect(forwarded).toBeNull(); // never reached the owner
  });
});

describe("L1 facade — disabled when no dispatch is wired", () => {
  it("returns 501 for a write when the facade has no dispatcher", async () => {
    const db = makeDb();
    const board = createTasksRoutes({ db });
    const res = await board.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "dm", description: "x".repeat(25), recurrenceRule: { frequency: "daily", time: "09:00", timezone: "Asia/Tokyo" } }),
    });
    expect(res.status).toBe(501);
    db.close();
  });
});
