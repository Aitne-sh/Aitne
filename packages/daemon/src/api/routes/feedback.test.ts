import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { ApiDependencies } from "../server.js";
import { applySchema } from "../../db/schema.js";
import { upsertAgent } from "../../db/agents-store.js";
import { createFeedbackRoutes } from "./feedback.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  upsertAgent(db, {
    slug: "report-writer",
    name: "Report Writer",
    source: "user",
    definitionPath: "/vault/policies/agents/report-writer/agent.md",
    definitionHash: "hash",
    enabled: true,
    scheduleKind: "cron",
    scheduleTimezone: "UTC",
  });
  return db;
}

function makeApp(db: Database.Database) {
  return createFeedbackRoutes({ db } as ApiDependencies);
}

describe("feedback routes", () => {
  it("records explicit agent-slug feedback, sanitizes evidence, and dedups repeats", async () => {
    const db = makeDb();
    const app = makeApp(db);
    const body = {
      source: "explicit",
      summary: "Keep the budget section in the weekly report",
      valence: "correction",
      kind: "correction",
      scope_type: "agent_slug",
      scope_ref: "report-writer",
      action_kind: "agent_execution",
      action_ref: "8821",
      evidence: {
        excerpt: `token ${"x".repeat(700)}`,
      },
    };

    const first = await app.request("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const firstJson = await first.json() as { id: number; deduped?: boolean };
    expect(firstJson.id).toBeGreaterThan(0);
    expect(firstJson.deduped).toBeUndefined();

    const row = db.prepare("SELECT * FROM feedback_signals WHERE id = ?").get(firstJson.id) as {
      source: string;
      scope_type: string;
      scope_ref: string;
      agent_id: string;
      evidence_json: string;
    };
    expect(row).toMatchObject({
      source: "explicit",
      scope_type: "agent_slug",
      scope_ref: "report-writer",
      agent_id: "report-writer",
    });
    expect(JSON.parse(row.evidence_json).excerpt.length).toBeLessThanOrEqual(506);

    const second = await app.request("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id: firstJson.id, deduped: true });
  });

  it("rejects daemon-only behavioral writes and unknown agent_slug scopes", async () => {
    const app = makeApp(makeDb());
    const behavioral = await app.request("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "behavioral",
        summary: "Owner ignored notification",
        valence: "neutral",
        scope_type: "agent",
      }),
    });
    expect(behavioral.status).toBe(400);
    expect(await behavioral.json()).toMatchObject({
      error: "validation_error",
      issues: [expect.objectContaining({ field: "source" })],
    });

    const missingAgent = await app.request("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "explicit",
        summary: "Tune this agent",
        valence: "correction",
        scope_type: "agent_slug",
        scope_ref: "missing-agent",
      }),
    });
    expect(missingAgent.status).toBe(400);
    expect(await missingAgent.json()).toMatchObject({
      error: "validation_error",
      issues: [expect.objectContaining({ field: "scope_ref" })],
    });
  });

  it("consumes feedback signals by id", async () => {
    const db = makeDb();
    const app = makeApp(db);
    db.prepare(
      `INSERT INTO feedback_signals (source, valence, scope_type, summary)
       VALUES ('self_critique', 'neutral', 'agent', 'Tighten the weekly review silence gate')`,
    ).run();
    const id = (db.prepare("SELECT id FROM feedback_signals").get() as { id: number }).id;

    const res = await app.request("/feedback/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id, 999], lessonRef: "policies/agent-lessons#1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consumed: 1, notFound: [999] });
    const row = db.prepare("SELECT consumed_at, lesson_ref FROM feedback_signals WHERE id = ?").get(id) as {
      consumed_at: string | null;
      lesson_ref: string | null;
    };
    expect(row.consumed_at).not.toBeNull();
    expect(row.lesson_ref).toBe("policies/agent-lessons#1");
  });
});
