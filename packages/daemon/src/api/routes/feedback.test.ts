import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiDependencies } from "../server.js";
import { applySchema } from "../../db/schema.js";
import { upsertAgent } from "../../db/agents-store.js";
import { recordFeedbackSignal } from "../../db/feedback-signals-store.js";
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

const FEEDBACK_CONFIG = {
  feedbackLearningEnabled: true,
  feedbackPromotionThreshold: 2,
  feedbackLessonMaxBytesGlobal: 8192,
  feedbackLessonMaxBytesPerAgent: 4096,
};

function lessonsFile(label: string, bullets: string[]): string {
  return [
    "---",
    "type: rule",
    "owner: agent",
    "updated: 2026-06-01",
    "---",
    `# Agent Lessons${label === "agent" ? "" : ` — ${label}`}`,
    "## Lessons",
    `<!-- scope: ${label} · cap: 8192B · 40 entries -->`,
    ...bullets,
  ].join("\n");
}

const tempDirs: string[] = [];
function makeContextDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "feedback-lessons-"));
  tempDirs.push(dataDir);
  mkdirSync(join(dataDir, "context", "policies"), { recursive: true });
  return dataDir;
}

function makeLessonsApp(db: Database.Database, dataDir: string) {
  return createFeedbackRoutes({
    db,
    config: { dataDir, ...FEEDBACK_CONFIG },
  } as unknown as ApiDependencies);
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

  it("drops captures (without recording) when feedbackLearningEnabled is false", async () => {
    const db = makeDb();
    const app = createFeedbackRoutes({
      db,
      config: { feedbackLearningEnabled: false },
    } as unknown as ApiDependencies);

    const res = await app.request("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "explicit",
        summary: "Keep the budget section in the weekly report",
        valence: "correction",
        scope_type: "agent",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: true });
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM feedback_signals").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(0);
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

  describe("GET /feedback/lessons", () => {
    afterEach(() => {
      while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
      }
    });

    it("always lists the global store (even before first write) with pending count", async () => {
      const db = makeDb();
      const dataDir = makeContextDir();
      recordFeedbackSignal(db, {
        source: "explicit",
        scopeType: "agent",
        summary: "pending row 1",
      });
      const app = makeLessonsApp(db, dataDir);

      const res = await app.request("/feedback/lessons");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        enabled: boolean;
        promotionThreshold: number;
        pendingSignals: number;
        stores: Array<Record<string, unknown>>;
      };
      expect(body.enabled).toBe(true);
      expect(body.promotionThreshold).toBe(2);
      expect(body.pendingSignals).toBe(1);
      expect(body.stores).toHaveLength(1);
      expect(body.stores[0]).toMatchObject({
        scope: "agent",
        path: "policies/agent-lessons.md",
        exists: false,
        entries: 0,
        capBytes: 8192,
      });
    });

    it("summarises the global store and per-agent stores that exist on disk", async () => {
      const db = makeDb();
      const dataDir = makeContextDir();
      const contextDir = join(dataDir, "context");
      writeFileSync(
        join(contextDir, "policies", "agent-lessons.md"),
        lessonsFile("agent", [
          "- [2026-06-01] Lead with blockers. <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
          "- [2026-05-01] Keep it terse. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
        ]),
      );
      const agentDir = join(contextDir, "policies", "agents", "report-writer");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "lessons.md"),
        lessonsFile("agent:report-writer", [
          "- [2026-06-01] Keep the budget section. <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-01 -->",
        ]),
      );
      // A directory with a path-unsafe name is skipped (defence-in-depth).
      mkdirSync(join(contextDir, "policies", "agents", ".hidden"), {
        recursive: true,
      });

      const app = makeLessonsApp(db, dataDir);
      const res = await app.request("/feedback/lessons");
      const body = (await res.json()) as {
        stores: Array<{
          scope: string;
          exists: boolean;
          entries: number;
          active: number;
          provisional: number;
        }>;
      };
      expect(body.stores.map((s) => s.scope)).toEqual([
        "agent",
        "agent:report-writer",
      ]);
      const global = body.stores[0];
      expect(global.exists).toBe(true);
      expect(global.entries).toBe(2);
      expect(global.active).toBe(1);
      expect(global.provisional).toBe(1);
      expect(body.stores[1].entries).toBe(1);
    });
  });
});
