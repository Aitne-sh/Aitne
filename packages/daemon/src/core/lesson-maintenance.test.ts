import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySchema } from "../db/schema.js";
import {
  enumerateLessonStores,
  runLessonMechanicalMaintenance,
  LESSON_MAINTENANCE_ACTION_TYPE,
  type LessonMaintenanceDeps,
} from "./lesson-maintenance.js";

const NOW = new Date("2026-07-01T18:00:00.000Z");

const CONFIG: LessonMaintenanceDeps["config"] = {
  feedbackLearningEnabled: true,
  feedbackPromotionThreshold: 2,
  feedbackLessonStaleDays: 60,
  feedbackLessonConfidenceFloor: 0.25,
  feedbackContradictionGuardCf: 0.6,
};

function storeFile(bullets: string[]): string {
  return [
    "---",
    "type: rule",
    "owner: agent",
    "updated: 2026-07-01",
    "---",
    "# Agent Lessons",
    "",
    "## Lessons",
    "<!-- scope: agent · cap: 8192B · 40 entries -->",
    ...bullets,
    "",
  ].join("\n");
}

describe("lesson-maintenance", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lesson-maint-"));
    mkdirSync(join(dir, "policies"), { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function auditRows(): Array<{ result: string; detail: string }> {
    return db
      .prepare(
        "SELECT result, detail FROM agent_actions WHERE action_type = ? ORDER BY id",
      )
      .all(LESSON_MAINTENANCE_ACTION_TYPE) as Array<{
      result: string;
      detail: string;
    }>;
  }

  it("skips (with an audit row) when feedback learning is disabled", async () => {
    const result = await runLessonMechanicalMaintenance({
      db,
      contextDir: dir,
      config: { ...CONFIG, feedbackLearningEnabled: false },
      now: NOW,
    });
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("feedback_learning_disabled");
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("skipped");
  });

  it("succeeds as a no-op when no store files exist", async () => {
    const result = await runLessonMechanicalMaintenance({
      db,
      contextDir: dir,
      config: CONFIG,
      now: NOW,
    });
    expect(result).toMatchObject({ status: "success", stores: 0, rewritten: 0 });
    expect(auditRows()[0].result).toBe("success");
  });

  it("stamps cf on a legacy global store and snapshots the previous bytes", async () => {
    const globalPath = join(dir, "policies", "agent-lessons.md");
    const original = storeFile([
      "- [2026-06-20] Legacy directive.",
      "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-20 -->",
    ]);
    writeFileSync(globalPath, original);

    const marked: string[] = [];
    const indexed: string[] = [];
    const result = await runLessonMechanicalMaintenance({
      db,
      contextDir: dir,
      config: CONFIG,
      now: NOW,
      writeTracker: {
        markWriting: (path: string) => {
          marked.push(path);
        },
        unmark: () => {},
      } as unknown as LessonMaintenanceDeps["writeTracker"],
      onIndexableContextChange: (path) => indexed.push(path),
    });

    expect(result).toMatchObject({
      status: "success",
      stores: 1,
      rewritten: 1,
      backfilled: 1,
    });
    expect(readFileSync(globalPath, "utf-8")).toContain("cf=0.80");
    expect(marked).toEqual([globalPath]);
    expect(indexed).toEqual(["policies/agent-lessons.md"]);

    const snapshot = db
      .prepare("SELECT file_path, content, trigger FROM md_file_snapshots")
      .get() as { file_path: string; content: string; trigger: string };
    expect(snapshot.file_path).toBe("policies/agent-lessons");
    expect(snapshot.content).toBe(original);
    expect(snapshot.trigger).toBe("lesson_maintenance");
  });

  it("is idempotent — a normalized store produces no rewrite or snapshot", async () => {
    const globalPath = join(dir, "policies", "agent-lessons.md");
    writeFileSync(
      globalPath,
      storeFile([
        "- [2026-06-20] Already stamped.",
        "  <!-- ev=2 kind=correction src=explicit conf=high cf=0.80 last=2026-06-20 -->",
      ]),
    );
    const first = await runLessonMechanicalMaintenance({
      db,
      contextDir: dir,
      config: CONFIG,
      now: NOW,
    });
    expect(first.rewritten).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM md_file_snapshots").get(),
    ).toEqual({ n: 0 });
  });

  it("enacts expiration over per-agent stores (archive counted)", async () => {
    const agentDir = join(dir, "policies", "agents", "report-writer");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "lessons.md"),
      storeFile([
        // provisional, last ~150 days back > 2×60 → archive
        "- [2026-01-01] Abandoned provisional.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.20 last=2026-02-01 --> <!-- provisional -->",
      ]),
    );
    const result = await runLessonMechanicalMaintenance({
      db,
      contextDir: dir,
      config: CONFIG,
      now: NOW,
    });
    expect(result).toMatchObject({ stores: 1, rewritten: 1, archived: 1 });
    expect(readFileSync(join(agentDir, "lessons.md"), "utf-8")).not.toContain(
      "Abandoned provisional",
    );
  });

  it("accumulates per-store errors without aborting the sweep", async () => {
    const globalPath = join(dir, "policies", "agent-lessons.md");
    writeFileSync(
      globalPath,
      storeFile([
        "- [2026-06-20] Fine store.",
        "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-20 -->",
      ]),
    );
    const agentDir = join(dir, "policies", "agents", "broken");
    mkdirSync(agentDir, { recursive: true });
    const brokenPath = join(agentDir, "lessons.md");
    writeFileSync(brokenPath, storeFile([]));
    chmodSync(brokenPath, 0o000);

    try {
      const result = await runLessonMechanicalMaintenance({
        db,
        contextDir: dir,
        config: CONFIG,
        now: NOW,
      });
      expect(result.status).toBe("failed");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].store).toBe("policies/agents/broken/lessons.md");
      // The healthy store was still normalized.
      expect(result.rewritten).toBe(1);
      expect(auditRows()[0].result).toBe("failed");
    } finally {
      chmodSync(brokenPath, 0o644);
    }
  });

  describe("enumerateLessonStores", () => {
    it("lists the global store and safe-slug per-agent stores only", () => {
      writeFileSync(join(dir, "policies", "agent-lessons.md"), storeFile([]));
      const safe = join(dir, "policies", "agents", "report-writer");
      mkdirSync(safe, { recursive: true });
      writeFileSync(join(safe, "lessons.md"), storeFile([]));
      const unsafe = join(dir, "policies", "agents", ".hidden");
      mkdirSync(unsafe, { recursive: true });
      writeFileSync(join(unsafe, "lessons.md"), storeFile([]));
      const noLessons = join(dir, "policies", "agents", "empty-agent");
      mkdirSync(noLessons, { recursive: true });
      // stray FILE in agents/ (not a directory) is skipped
      writeFileSync(join(dir, "policies", "agents", "stray.md"), "x");

      expect(enumerateLessonStores(dir)).toEqual([
        "policies/agent-lessons.md",
        "policies/agents/report-writer/lessons.md",
      ]);
    });

    it("tolerates a missing agents tree and a missing global store", () => {
      expect(enumerateLessonStores(dir)).toEqual([]);
    });
  });
});
