import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cron from "node-cron";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "./event-bus.js";
import { AgentScheduler } from "./scheduler.js";
import { AgentEnabledCache } from "./agents/loader.js";
import { applySchema } from "../db/schema.js";
import { upsertAgent, setEnabled } from "../db/agents-store.js";
import type { AgentConfig } from "../config.js";

/**
 * AGENT_DEFINITIONS_DESIGN.md §7.1 / §12.3 — the scheduler's per-built-in
 * enabled gate. `scheduler.ts` is coverage-excluded; this is a behavioral test
 * that captures the registered cron callback and fires it under a real
 * AgentEnabledCache to prove the gate short-circuits + throttles.
 */

function seedAgent(db: Database.Database, slug: string, enabled: boolean): void {
  upsertAgent(db, {
    slug,
    name: slug,
    source: "builtin",
    definitionPath: `/agents/${slug}/agent.md`,
    definitionHash: `hash-${slug}`,
    enabled,
    scheduleKind: "cron",
    scheduleExpression: "0 18 * * *",
    scheduleTimezone: "UTC",
  });
}

describe("scheduler agent enabled-gate", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let scheduler: AgentScheduler;
  let dataDir: string;
  let captured: Array<{ expr: string; fn: () => void }>;

  function fireAllEveningCrons(): void {
    // "0 18 * * *" is shared by evening_review + monthly_review; with
    // monthlyReviewEnabled OFF the monthly callback returns before its gate,
    // so only evening_review reaches the enabled gate.
    for (const job of captured.filter((c) => c.expr === "0 18 * * *")) job.fn();
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-sched-gate-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    eventBus = new EventBus();
    const config = {
      dataDir,
      dayBoundaryHour: 4,
      timezone: "UTC",
      schedulePollIntervalSeconds: 3600,
      monthlyReviewEnabled: false,
      hourlyCheckEnabled: false,
      quietHoursStart: "00:00",
      quietHoursEnd: "00:00",
      browserTaskRespectQuietHours: true,
    } as unknown as AgentConfig;
    scheduler = new AgentScheduler(eventBus, db, config);
    scheduler.setAutonomousGate(() => null); // gate open — isolate the enabled gate

    captured = [];
    vi.spyOn(cron, "schedule").mockImplementation((expr, fn) => {
      captured.push({ expr, fn: fn as () => void });
      return { start: () => {}, stop: () => {} } as unknown as ReturnType<
        typeof cron.schedule
      >;
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function firingBlockedRow(slug: string): { count: number; suppressed: number } {
    const row = db
      .prepare(
        `SELECT json_extract(detail, '$.suppressed_count') AS suppressed
           FROM agent_actions
          WHERE action_type = 'agent.firing_blocked' AND agent_id = ?`,
      )
      .all(slug) as { suppressed: number }[];
    return { count: row.length, suppressed: row[0]?.suppressed ?? -1 };
  }

  it("short-circuits a disabled built-in cron + records a firing_blocked row", () => {
    seedAgent(db, "evening-review", false);
    scheduler.setAgentEnabledCache(new AgentEnabledCache(db));
    scheduler.start();
    const putSpy = vi.spyOn(eventBus, "put");

    fireAllEveningCrons();

    // Disabled → no evening_review event emitted.
    const emitted = putSpy.mock.calls.map((c) => (c[0] as { routine?: string }).routine);
    expect(emitted).not.toContain("evening_review");
    expect(firingBlockedRow("evening-review")).toEqual({ count: 1, suppressed: 0 });
  });

  it("throttles repeated disabled firings to one row/day with an incrementing suppressed_count", () => {
    seedAgent(db, "evening-review", false);
    scheduler.setAgentEnabledCache(new AgentEnabledCache(db));
    scheduler.start();

    fireAllEveningCrons();
    fireAllEveningCrons();
    fireAllEveningCrons();

    expect(firingBlockedRow("evening-review")).toEqual({ count: 1, suppressed: 2 });
  });

  it("runs the routine again once re-enabled", () => {
    seedAgent(db, "evening-review", false);
    const cache = new AgentEnabledCache(db);
    scheduler.setAgentEnabledCache(cache);
    scheduler.start();
    const putSpy = vi.spyOn(eventBus, "put");

    fireAllEveningCrons(); // blocked
    expect(putSpy.mock.calls.map((c) => (c[0] as { routine?: string }).routine)).not.toContain(
      "evening_review",
    );

    setEnabled(db, "evening-review", true, Date.now());
    cache.invalidate();
    fireAllEveningCrons(); // now runs

    expect(putSpy.mock.calls.map((c) => (c[0] as { routine?: string }).routine)).toContain(
      "evening_review",
    );
  });

  it("does not gate when no enabled cache is wired (legacy / pre-load)", () => {
    seedAgent(db, "evening-review", false); // disabled, but no cache set
    scheduler.start();
    const putSpy = vi.spyOn(eventBus, "put");

    fireAllEveningCrons();

    expect(putSpy.mock.calls.map((c) => (c[0] as { routine?: string }).routine)).toContain(
      "evening_review",
    );
    expect(firingBlockedRow("evening-review").count).toBe(0);
  });
});
