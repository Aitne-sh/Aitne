import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  createDevSession,
  updateDevSessionConfig,
  recordDevIteration,
  seedDevRequirements,
  markDevAwaitingApproval,
  approveDevSession,
} from "../../db/dev-sessions-store.js";
import { createDevEscalation } from "../../db/dev-session-escalations-store.js";
import { createDevSessionsRoutes } from "./dev-sessions.js";

describe("dev-sessions routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createDevSessionsRoutes>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at) VALUES ('local:t', '/tmp/t', 1, 0, 0)`,
    ).run();
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:t",
      slug: "t",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:1",
      createdAt: 100,
    });
    updateDevSessionConfig(db, "s1", { config: { verifyCommands: ["true"] } }, 100);
    seedDevRequirements(
      db,
      "s1",
      [
        { id: "r1", reqId: "REQ-001", title: "first" },
        { id: "r2", reqId: "REQ-002", title: "second" },
      ],
      100,
    );
    markDevAwaitingApproval(db, "s1", 100);
    approveDevSession(db, {
      id: "s1",
      approvedHash: "hash",
      branch: "aitne-dev/s1",
      baseRef: "abc",
      maxIterations: 10,
      maxBudgetUsd: 5,
      approvedAt: 100,
    });
    recordDevIteration(db, {
      id: "it1",
      sessionId: "s1",
      iteration: 1,
      phase: "implement",
      verdict: "ok",
      createdAt: 200,
    });
    createDevEscalation(db, {
      id: "e1",
      sessionId: "s1",
      kind: "spec_decision",
      question: "Which DB?",
      contextSummary: "context",
      askedAt: 300,
    });
    app = createDevSessionsRoutes({ db });
  });

  afterEach(() => db.close());

  it("GET /dev-sessions lists session summaries with REQ counts", async () => {
    const res = await app.request("/dev-sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe("s1");
    expect(body.sessions[0]!.requirementsTotal).toBe(2);
    expect(body.sessions[0]!.branch).toBe("aitne-dev/s1");
  });

  it("GET /dev-sessions filters by state", async () => {
    const running = await app.request("/dev-sessions?state=running");
    expect(((await running.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    const done = await app.request("/dev-sessions?state=done");
    expect(((await done.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("GET /dev-sessions?state=<all-invalid> returns empty, not everything", async () => {
    const res = await app.request("/dev-sessions?state=nonsense");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("GET /dev-sessions/:id returns the full projection", async () => {
    const res = await app.request("/dev-sessions/s1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: Record<string, unknown>;
      iterations: unknown[];
      requirements: unknown[];
      escalations: unknown[];
    };
    expect(body.session.id).toBe("s1");
    expect(body.session.requirementsTotal).toBe(2);
    expect(body.iterations).toHaveLength(1);
    expect(body.requirements).toHaveLength(2);
    expect(body.escalations).toHaveLength(1);
  });

  it("GET /dev-sessions/:id 404s for an unknown id", async () => {
    const res = await app.request("/dev-sessions/nope");
    expect(res.status).toBe(404);
  });
});
