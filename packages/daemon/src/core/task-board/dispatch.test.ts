import { describe, it, expect } from "vitest";
import {
  planCreateDispatch,
  planRefDispatch,
  FACADE_CREATE_KINDS,
} from "./dispatch.js";
import { parseTaskRef } from "./refs.js";
import type { TaskRef } from "./types.js";

const ref = (raw: string): TaskRef => parseTaskRef(raw) as TaskRef;

describe("planCreateDispatch", () => {
  it("routes each kind to its owning create endpoint", () => {
    expect(planCreateDispatch("reminder", {}).ownerPath).toBe("/api/schedule/dm");
    expect(planCreateDispatch("dm", {}).ownerPath).toBe("/api/recurring-schedules");
    expect(planCreateDispatch("agent", {}).ownerPath).toBe("/api/agents");
    expect(planCreateDispatch("app_fetch", {}).ownerPath).toBe("/api/managed-tasks");
    expect(planCreateDispatch("background", {}).ownerPath).toBe("/api/background-task");
  });

  it("strips the facade-only `kind` field from the forwarded body", () => {
    const plan = planCreateDispatch("background", { kind: "background", brief: "do it" });
    expect(plan.body).toEqual({ brief: "do it" });
    expect(plan.body).not.toHaveProperty("kind");
  });

  it("§9 guard: a `dm` create is pinned to task_type dm_session (cannot become agent.task)", () => {
    const plan = planCreateDispatch("dm", { kind: "dm", taskType: "agent.task", description: "x" });
    expect(plan.ownerPath).toBe("/api/recurring-schedules");
    expect(plan.body.taskType).toBe("dm_session");
  });

  it("§9 guard: an `agent` create routes to /api/agents, never a stamped recurring row", () => {
    const plan = planCreateDispatch("agent", { kind: "agent", slug: "wd", name: "WD" });
    expect(plan.ownerPath).toBe("/api/agents");
    expect(plan.body).not.toHaveProperty("taskType");
  });

  it("does not mutate the caller's object", () => {
    const raw = { kind: "dm" as const, description: "x" };
    planCreateDispatch("dm", raw);
    expect(raw).toEqual({ kind: "dm", description: "x" }); // untouched
  });

  it("exposes the canonical create-kind list", () => {
    expect([...FACADE_CREATE_KINDS]).toEqual(["reminder", "dm", "agent", "app_fetch", "background"]);
  });
});

describe("planRefDispatch", () => {
  it("resolves writable owners to their per-row route", () => {
    expect(planRefDispatch(ref("rs:42"))).toEqual({ editable: true, ownerPath: "/api/recurring-schedules/42" });
    expect(planRefDispatch(ref("mt_3"))).toEqual({ editable: true, ownerPath: "/api/managed-tasks/mt_3" });
    expect(planRefDispatch(ref("agent:wd"))).toEqual({ editable: true, ownerPath: "/api/agents/wd" });
    expect(planRefDispatch(ref("as:8"))).toEqual({ editable: true, ownerPath: "/api/schedule/8" });
    // Trigger writes forward to the owner, whose Approve tier still applies.
    expect(planRefDispatch(ref("trigger:9"))).toEqual({ editable: true, ownerPath: "/api/triggers/9" });
  });

  it("rejects read-only fulfillers and reserved refs with a reason", () => {
    for (const raw of ["bt:u", "bx:v", "cluster:c", "obj:o"]) {
      const plan = planRefDispatch(ref(raw));
      expect(plan.editable).toBe(false);
      if (!plan.editable) expect(plan.reason.length).toBeGreaterThan(0);
    }
  });
});
