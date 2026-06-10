import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { formatSqliteDatetime } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import {
  ledgerStateKey,
  type LedgerScanEntry,
  type TuningLedgerBlob,
} from "./tuning-actuator.js";
import {
  REVERT_MONITOR_STATE_KEY,
  buildAutoRevertDmMessage,
  evaluateAppliedEntry,
  runSelfTuningRevertMonitor,
  type RevertMonitorDeps,
} from "./tuning-revert-monitor.js";

// Applied 2026-06-01; the 7-day verify window [06-01, 06-08) has closed.
const APPLIED_AT = "2026-06-01T00:00:00.000Z";
const NOW = new Date("2026-06-09T12:00:00.000Z");
const IN_WINDOW = new Date("2026-06-03T00:00:00.000Z");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function blob(over: Partial<TuningLedgerBlob> = {}): TuningLedgerBlob {
  return {
    prev: 240,
    applied_at: APPLIED_AT,
    rule: "R1",
    actuator: "config",
    proposed: 360,
    recommendation_id: "2026-06-01:R1:hourlyCheckPrePassFreshnessMinutes",
    evidence: "fetch_window 80% empty",
    baselineMetric: { noveltyGe2PerDay: 1, cautiousEscalateShare: 0.1 },
    ...over,
  };
}

function entry(
  key = "hourlyCheckPrePassFreshnessMinutes",
  over: Partial<TuningLedgerBlob> = {},
): LedgerScanEntry {
  return { key, blob: blob(over) };
}

function seed(
  db: Database.Database,
  key: string,
  over: Partial<TuningLedgerBlob> = {},
): void {
  writeRuntimeState(db, ledgerStateKey(key), blob(over));
}

function insertGateRow(db: Database.Database, at: Date, detail: unknown): void {
  db.prepare(
    `INSERT INTO agent_actions (action_type, result, detail, started_at)
     VALUES ('hourly_check.gate', 'success', ?, ?)`,
  ).run(JSON.stringify(detail), formatSqliteDatetime(at));
}

function insertObservation(db: Database.Database, at: Date, novelty: number): void {
  db.prepare(
    `INSERT INTO observations (source, ref, change_type, observed_at, novelty_score)
     VALUES ('mail:gmail', ?, 'created', ?, ?)`,
  ).run(`m-${Math.random().toString(36).slice(2)}`, formatSqliteDatetime(at), novelty);
}

function makeDeps(
  db: Database.Database,
  over: Partial<RevertMonitorDeps> = {},
): RevertMonitorDeps {
  return {
    db,
    applyUpdates: async (updates) => ({
      updated: Object.keys(updates),
      errors: {},
    }),
    ...over,
  };
}

describe("evaluateAppliedEntry", () => {
  it("waits while the verify window is still open", () => {
    const db = makeDb();
    const decision = evaluateAppliedEntry(
      db,
      entry(undefined, { applied_at: "2026-06-05T00:00:00.000Z" }),
      NOW,
    );
    expect(decision).toEqual({ action: "wait" });
  });

  it("settles an unparseable applied_at as verified (never reverts blind)", () => {
    const db = makeDb();
    expect(
      evaluateAppliedEntry(db, entry(undefined, { applied_at: "not-a-date" }), NOW),
    ).toEqual({ action: "verify", result: "invalid_applied_at" });
  });

  it("settles a missing R1 baseline as no_baseline", () => {
    const db = makeDb();
    expect(
      evaluateAppliedEntry(db, entry(undefined, { baselineMetric: null }), NOW),
    ).toEqual({ action: "verify", result: "no_baseline" });
  });

  it("reverts R1 when novelty≥2 arrivals fall >30% below baseline", () => {
    const db = makeDb();
    // Baseline 1/day; window has 2 arrivals over 7d ≈ 0.29/day < 0.7.
    insertObservation(db, IN_WINDOW, 2);
    insertObservation(db, IN_WINDOW, 3);
    const decision = evaluateAppliedEntry(db, entry(), NOW);
    expect(decision.action).toBe("revert");
    expect((decision as { reason: string }).reason).toContain("novelty>=2");
  });

  it("reverts R1 when the cautious-escalate share rises >10 pt", () => {
    const db = makeDb();
    // Keep arrivals at baseline: 7 arrivals over 7 days = 1/day.
    for (let i = 0; i < 7; i++) insertObservation(db, IN_WINDOW, 2);
    // 2/4 ticks cautious = 50% vs baseline 10%.
    insertGateRow(db, IN_WINDOW, { cautious_escalate: true });
    insertGateRow(db, IN_WINDOW, { cautious_escalate: true });
    insertGateRow(db, IN_WINDOW, { stage_reached: "stage0_silent" });
    insertGateRow(db, IN_WINDOW, { stage_reached: "stage0_silent" });
    const decision = evaluateAppliedEntry(db, entry(), NOW);
    expect(decision.action).toBe("revert");
    expect((decision as { reason: string }).reason).toContain("cautious-escalate");
  });

  it("passes R1 when both margins hold, and skips the drop arm on a zero baseline", () => {
    const db = makeDb();
    for (let i = 0; i < 7; i++) insertObservation(db, IN_WINDOW, 2);
    expect(evaluateAppliedEntry(db, entry(), NOW)).toEqual({
      action: "verify",
      result: "pass",
    });

    // Zero-arrival baseline: an empty window is NOT a >30% drop.
    const db2 = makeDb();
    expect(
      evaluateAppliedEntry(
        db2,
        entry(undefined, {
          baselineMetric: { noveltyGe2PerDay: 0, cautiousEscalateShare: 0 },
        }),
        NOW,
      ),
    ).toEqual({ action: "verify", result: "pass" });
  });

  it("reverts R3 when >10% of silent ticks carried novelty≥2 snapshots", () => {
    const db = makeDb();
    insertGateRow(db, IN_WINDOW, {
      stage_reached: "stage0_silent",
      signal_snapshot: { maxNoveltyScore: 2 },
    });
    insertGateRow(db, IN_WINDOW, {
      stage_reached: "stage0_silent",
      signal_snapshot: { maxNoveltyScore: 0 },
    });
    const decision = evaluateAppliedEntry(
      db,
      entry("hourlyCheckLowSignalPendingCeiling", { rule: "R3" }),
      NOW,
    );
    expect(decision.action).toBe("revert");
    expect((decision as { reason: string }).reason).toContain("1/2 silent ticks");
  });

  it("passes R3 below the margin and on a tick-free window", () => {
    const db = makeDb();
    expect(
      evaluateAppliedEntry(db, entry("k", { rule: "R3" }), NOW),
    ).toEqual({ action: "verify", result: "pass" });
    for (let i = 0; i < 19; i++) {
      insertGateRow(db, IN_WINDOW, {
        stage_reached: "stage0_silent",
        signal_snapshot: { maxNoveltyScore: 1 },
      });
    }
    insertGateRow(db, IN_WINDOW, {
      stage_reached: "stage0_silent",
      signal_snapshot: { maxNoveltyScore: 2 },
    });
    // 1/20 = 5% ≤ 10% → pass.
    expect(
      evaluateAppliedEntry(db, entry("k", { rule: "R3" }), NOW),
    ).toEqual({ action: "verify", result: "pass" });
  });

  it("reverts R5 on the forgotten-lesson proxy and passes otherwise", () => {
    const db = makeDb();
    expect(
      evaluateAppliedEntry(db, entry("feedbackLessonMaxBytesGlobal", { rule: "R5" }), NOW),
    ).toEqual({ action: "verify", result: "pass" });
    db.prepare(
      `INSERT INTO feedback_signals (created_at, source, valence, scope_type, summary)
       VALUES (?, 'explicit', 'negative', 'agent', 'you forgot the lesson about digests')`,
    ).run(formatSqliteDatetime(IN_WINDOW));
    const decision = evaluateAppliedEntry(
      db,
      entry("feedbackLessonMaxBytesGlobal", { rule: "R5" }),
      NOW,
    );
    expect(decision.action).toBe("revert");
    expect((decision as { reason: string }).reason).toContain("forgotten-lesson");
  });

  it("settles an unknown rule as no_metric", () => {
    const db = makeDb();
    expect(evaluateAppliedEntry(db, entry("k", { rule: "R9" }), NOW)).toEqual({
      action: "verify",
      result: "no_metric",
    });
  });
});

describe("buildAutoRevertDmMessage", () => {
  it("names the key, restored value, reason, and cool-down", () => {
    const message = buildAutoRevertDmMessage(entry(), "novelty dropped");
    expect(message).toContain("hourlyCheckPrePassFreshnessMinutes");
    expect(message).toContain("240");
    expect(message).toContain("novelty dropped");
    expect(message).toContain("28-day");
  });
});

describe("runSelfTuningRevertMonitor", () => {
  it("throttles to one pass per day", async () => {
    const db = makeDb();
    const first = await runSelfTuningRevertMonitor(makeDeps(db), NOW);
    expect(first.ran).toBe(true);
    const second = await runSelfTuningRevertMonitor(makeDeps(db), NOW);
    expect(second).toEqual({ ran: false, reverted: [], verified: [] });
    expect(
      readRuntimeState<{ lastRunDay: string }>(db, REVERT_MONITOR_STATE_KEY)
        ?.lastRunDay,
    ).toBe("2026-06-09");
    // A new day runs again.
    const nextDay = await runSelfTuningRevertMonitor(
      makeDeps(db),
      new Date("2026-06-10T12:00:00.000Z"),
    );
    expect(nextDay.ran).toBe(true);
  });

  it("skips non-config, reverted, verified, and still-waiting entries", async () => {
    const db = makeDb();
    seed(db, "notification:reminder", { actuator: "lesson" });
    seed(db, "already-reverted", { reverted_at: "2026-06-08T00:00:00.000Z" });
    seed(db, "already-verified", { verified_at: "2026-06-08T00:00:00.000Z" });
    seed(db, "still-waiting", { applied_at: "2026-06-08T00:00:00.000Z" });
    const run = await runSelfTuningRevertMonitor(makeDeps(db), NOW);
    expect(run).toEqual({ ran: true, reverted: [], verified: [] });
    // The waiting entry is untouched for tomorrow's pass.
    const waiting = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("still-waiting"),
    );
    expect(waiting?.verified_at).toBeUndefined();
  });

  it("verifies a clean entry: stamps the ledger and audits", async () => {
    const db = makeDb();
    seed(db, "hourlyCheckPrePassFreshnessMinutes", {
      baselineMetric: { noveltyGe2PerDay: 0, cautiousEscalateShare: 0 },
    });
    const run = await runSelfTuningRevertMonitor(makeDeps(db), NOW);
    expect(run.verified).toEqual(["hourlyCheckPrePassFreshnessMinutes"]);
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("hourlyCheckPrePassFreshnessMinutes"),
    );
    expect(stored?.verified_at).toBe(NOW.toISOString());
    expect(stored?.verify_result).toBe("pass");
    const audits = db
      .prepare(
        `SELECT detail FROM agent_actions WHERE action_type = 'self_tuning.verified'`,
      )
      .all() as Array<{ detail: string }>;
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].detail)).toMatchObject({ verifyResult: "pass" });
  });

  it("reverts a regressed entry and DMs the owner", async () => {
    const db = makeDb();
    // Baseline 1/day, empty verify window → >30% drop.
    seed(db, "hourlyCheckPrePassFreshnessMinutes", {});
    const calls: Array<Record<string, unknown>> = [];
    const dms: string[] = [];
    const run = await runSelfTuningRevertMonitor(
      makeDeps(db, {
        applyUpdates: async (updates) => {
          calls.push(updates);
          return { updated: Object.keys(updates), errors: {} };
        },
        sendDm: async (message) => {
          dms.push(message);
        },
      }),
      NOW,
    );
    expect(run.reverted).toEqual(["hourlyCheckPrePassFreshnessMinutes"]);
    expect(calls).toEqual([{ hourlyCheckPrePassFreshnessMinutes: 240 }]);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("auto-revert");
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("hourlyCheckPrePassFreshnessMinutes"),
    );
    expect(stored?.reverted_at).toBe(NOW.toISOString());
    expect(stored?.revert_trigger).toBe("auto");
  });

  it("keeps the revert when the DM throws, and warns when no DM path exists", async () => {
    const db = makeDb();
    seed(db, "hourlyCheckPrePassFreshnessMinutes", {});
    const run = await runSelfTuningRevertMonitor(
      makeDeps(db, { sendDm: vi.fn().mockRejectedValue(new Error("offline")) }),
      NOW,
    );
    expect(run.reverted).toHaveLength(1);

    const db2 = makeDb();
    seed(db2, "hourlyCheckPrePassFreshnessMinutes", {});
    const silent = await runSelfTuningRevertMonitor(makeDeps(db2), NOW);
    expect(silent.reverted).toHaveLength(1);
  });

  it("leaves the entry unstamped when the chokepoint rejects the revert", async () => {
    const db = makeDb();
    seed(db, "hourlyCheckPrePassFreshnessMinutes", {});
    const run = await runSelfTuningRevertMonitor(
      makeDeps(db, {
        applyUpdates: async () => ({
          updated: [],
          errors: { hourlyCheckPrePassFreshnessMinutes: "rejected" },
        }),
      }),
      NOW,
    );
    expect(run.reverted).toEqual([]);
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("hourlyCheckPrePassFreshnessMinutes"),
    );
    expect(stored?.reverted_at).toBeUndefined();
  });

  it("re-reads before the verify stamp so concurrent writes survive, and falls back when the row vanished", async () => {
    const db = makeDb();
    // Processed in key order: "aaa" reverts first; its applyUpdates call
    // simulates writes landing between the pass's scan and the later
    // verify stamps — an `!revert tuning` stamping "bbb" and a vanished
    // "ccc" row.
    seed(db, "aaa", {}); // R1, empty window → revert (calls applyUpdates)
    seed(db, "bbb", { rule: "R9" }); // unknown rule → verify "no_metric"
    seed(db, "ccc", { rule: "R9" });
    const run = await runSelfTuningRevertMonitor(
      makeDeps(db, {
        applyUpdates: async (updates) => {
          writeRuntimeState(db, ledgerStateKey("bbb"), {
            ...blob({ rule: "R9" }),
            reverted_at: "2026-06-09T11:59:00.000Z",
            revert_trigger: "bang_command",
          });
          db.prepare(`DELETE FROM runtime_state WHERE key = ?`).run(
            ledgerStateKey("ccc"),
          );
          return { updated: Object.keys(updates), errors: {} };
        },
      }),
      NOW,
    );
    expect(run.reverted).toEqual(["aaa"]);
    expect(run.verified).toEqual(["bbb", "ccc"]);
    // The concurrent bang-revert stamp on "bbb" is preserved, not clobbered
    // by the stale scanned blob.
    const bbb = readRuntimeState<TuningLedgerBlob>(db, ledgerStateKey("bbb"));
    expect(bbb?.reverted_at).toBe("2026-06-09T11:59:00.000Z");
    expect(bbb?.revert_trigger).toBe("bang_command");
    expect(bbb?.verified_at).toBe(NOW.toISOString());
    // The vanished "ccc" row degrades to the scanned blob — still stamped.
    const ccc = readRuntimeState<TuningLedgerBlob>(db, ledgerStateKey("ccc"));
    expect(ccc?.verified_at).toBe(NOW.toISOString());
    expect(ccc?.verify_result).toBe("no_metric");
    expect(ccc?.rule).toBe("R9");
  });

  it("isolates a throwing entry so the rest are still processed", async () => {
    const db = makeDb();
    // R1 with a baseline forces computeR1Metric → throws once the
    // observations table is gone; the R3 entry below never touches it.
    seed(db, "hourlyCheckPrePassFreshnessMinutes", {});
    seed(db, "hourlyCheckLowSignalPendingCeiling", { rule: "R3" });
    db.prepare("DROP TABLE observations").run();
    const run = await runSelfTuningRevertMonitor(makeDeps(db), NOW);
    expect(run.reverted).toEqual([]);
    expect(run.verified).toEqual(["hourlyCheckLowSignalPendingCeiling"]);
  });
});
