import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { formatSqliteDatetime } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { SELF_TUNING_LEDGER_PREFIX } from "./self-performance-prep.js";
import type { TuningRecommendation } from "./tuning-recommender.js";
import {
  actuateApplyVerdicts,
  auditSelfTuning,
  buildApplyDmMessage,
  buildR4SuggestionDmMessage,
  captureBaselineMetric,
  computeR1Metric,
  computeR3Metric,
  countLessonRegressionSignals,
  findLatestRevertableEntry,
  ledgerStateKey,
  listLedgerEntries,
  revertAppliedTuningChange,
  type ActuatorDeps,
  type LedgerScanEntry,
  type R1Metric,
  type TuningLedgerBlob,
} from "./tuning-actuator.js";

const NOW = new Date("2026-06-09T12:00:00.000Z");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function blob(over: Partial<TuningLedgerBlob> = {}): TuningLedgerBlob {
  return {
    prev: 240,
    applied_at: "2026-06-01T00:00:00.000Z",
    rule: "R1",
    actuator: "config",
    proposed: 360,
    recommendation_id: "2026-06-01:R1:activityScanPrePassFreshnessMinutes",
    evidence: "fetch_window 80% empty over 20 runs/14d",
    baselineMetric: null,
    ...over,
  };
}

function configRec(over: Partial<TuningRecommendation> = {}): TuningRecommendation {
  return {
    id: "2026-06-09:R1:activityScanPrePassFreshnessMinutes",
    rule: "R1",
    actuator: "config",
    key: "activityScanPrePassFreshnessMinutes",
    currentValue: 240,
    proposedValue: 360,
    bounds: { min: 120, max: 480 },
    evidence: "fetch_window 80% empty over 20 runs/14d",
    estWeeklySavingUsd: 0.08,
    ...over,
  };
}

function lessonRec(): TuningRecommendation {
  return configRec({
    id: "2026-06-09:R2:notification:reminder",
    rule: "R2",
    actuator: "lesson",
    key: "notification:reminder",
    currentValue: "send",
    proposedValue: "demote",
    bounds: null,
    evidence: "reminder: 6/8 ignored (75%) over 14d",
    estWeeklySavingUsd: 0,
  });
}

function scheduleRec(): TuningRecommendation {
  return configRec({
    id: "2026-06-09:R4:recurring_schedules:7",
    rule: "R4",
    actuator: "schedule",
    key: "recurring_schedules:7",
    currentValue: "enabled",
    proposedValue: "disabled",
    bounds: null,
    evidence: "last 3 runs failed (task_type=reminder)",
    estWeeklySavingUsd: 0,
  });
}

function okApplyUpdates(
  calls: Array<Record<string, unknown>> = [],
): ActuatorDeps["applyUpdates"] {
  return async (updates) => {
    calls.push(updates);
    return { updated: Object.keys(updates), errors: {} };
  };
}

function makeDeps(
  db: Database.Database,
  over: Partial<ActuatorDeps> = {},
): ActuatorDeps {
  return {
    db,
    applyUpdates: okApplyUpdates(),
    getCurrentValue: () => 240,
    ...over,
  };
}

function insertGateRow(
  db: Database.Database,
  startedAt: Date,
  detail: unknown,
): void {
  db.prepare(
    `INSERT INTO agent_actions (action_type, result, detail, started_at)
     VALUES ('activity_scan.gate', 'success', ?, ?)`,
  ).run(
    detail === null ? null : JSON.stringify(detail),
    formatSqliteDatetime(startedAt),
  );
}

function insertObservation(
  db: Database.Database,
  observedAt: Date,
  novelty: number | null,
): void {
  db.prepare(
    `INSERT INTO observations (source, ref, change_type, observed_at, novelty_score)
     VALUES ('mail:gmail', ?, 'created', ?, ?)`,
  ).run(
    `msg-${Math.random().toString(36).slice(2)}`,
    formatSqliteDatetime(observedAt),
    novelty,
  );
}

function ledgerRows(db: Database.Database): Array<{ key: string }> {
  return db
    .prepare(`SELECT key FROM runtime_state WHERE key LIKE ?`)
    .all(`${SELF_TUNING_LEDGER_PREFIX}%`) as Array<{ key: string }>;
}

function auditRows(
  db: Database.Database,
  actionType: string,
): Array<{ trigger: string; result: string; detail: string }> {
  return db
    .prepare(
      `SELECT trigger, result, detail FROM agent_actions WHERE action_type = ?`,
    )
    .all(actionType) as Array<{ trigger: string; result: string; detail: string }>;
}

describe("ledgerStateKey / listLedgerEntries", () => {
  it("prefixes keys with the §3.4 ledger namespace", () => {
    expect(ledgerStateKey("foo")).toBe("self_tuning:foo");
  });

  it("scans valid entries and skips corrupt or applied_at-less blobs", () => {
    const db = makeDb();
    writeRuntimeState(db, ledgerStateKey("good"), blob());
    db.prepare(
      `INSERT INTO runtime_state (key, value_json) VALUES (?, ?)`,
    ).run(ledgerStateKey("corrupt"), "{not json");
    writeRuntimeState(db, ledgerStateKey("array"), [1, 2]);
    writeRuntimeState(db, ledgerStateKey("no-applied-at"), { prev: 1 });
    // The pending-cycle blob uses a dot namespace and must never appear.
    writeRuntimeState(db, "self_tuning.pending_cycle", { cycleId: "x" });

    const entries = listLedgerEntries(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("good");
    expect(entries[0].blob.prev).toBe(240);
  });
});

describe("findLatestRevertableEntry", () => {
  it("returns null when nothing is revertable", () => {
    expect(findLatestRevertableEntry([])).toBeNull();
    const entries: LedgerScanEntry[] = [
      { key: "a", blob: blob({ reverted_at: "2026-06-05T00:00:00.000Z" }) },
      { key: "b", blob: blob({ actuator: "lesson" }) },
      { key: "c", blob: blob({ prev: undefined }) },
    ];
    expect(findLatestRevertableEntry(entries)).toBeNull();
  });

  it("picks the most recently applied config entry; verified stays revertable", () => {
    const entries: LedgerScanEntry[] = [
      { key: "older", blob: blob({ applied_at: "2026-05-01T00:00:00.000Z" }) },
      {
        key: "newest",
        blob: blob({
          applied_at: "2026-06-08T00:00:00.000Z",
          verified_at: "2026-06-09T00:00:00.000Z",
        }),
      },
      { key: "middle", blob: blob({ applied_at: "2026-06-01T00:00:00.000Z" }) },
    ];
    expect(findLatestRevertableEntry(entries)?.key).toBe("newest");
  });
});

describe("computeR1Metric", () => {
  it("counts novelty≥2 arrivals per day and the cautious-escalate share", () => {
    const db = makeDb();
    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-06-08T00:00:00.000Z");
    insertObservation(db, new Date("2026-06-02T00:00:00.000Z"), 2);
    insertObservation(db, new Date("2026-06-03T00:00:00.000Z"), 3);
    insertObservation(db, new Date("2026-06-04T00:00:00.000Z"), 1); // below floor
    insertObservation(db, new Date("2026-06-04T00:00:00.000Z"), null);
    insertObservation(db, new Date("2026-05-30T00:00:00.000Z"), 3); // outside
    insertObservation(db, to, 3); // boundary: excluded (>= to)

    insertGateRow(db, new Date("2026-06-02T01:00:00.000Z"), {
      stage_reached: "stage3",
      cautious_escalate: true,
    });
    insertGateRow(db, new Date("2026-06-02T02:00:00.000Z"), {
      stage_reached: "stage0_silent",
    });
    insertGateRow(db, new Date("2026-06-02T03:00:00.000Z"), null); // corrupt

    const metric = computeR1Metric(db, from, to);
    expect(metric.noveltyGe2PerDay).toBeCloseTo(2 / 7);
    expect(metric.cautiousEscalateShare).toBeCloseTo(1 / 3);
  });

  it("degrades to zero share with no gate rows and guards a degenerate window", () => {
    const db = makeDb();
    const at = new Date("2026-06-01T00:00:00.000Z");
    const metric = computeR1Metric(db, at, at);
    expect(metric.cautiousEscalateShare).toBe(0);
    expect(Number.isFinite(metric.noveltyGe2PerDay)).toBe(true);
  });
});

describe("computeR3Metric", () => {
  it("counts silent ticks and the novelty≥2 snapshots among them", () => {
    const db = makeDb();
    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-06-08T00:00:00.000Z");
    const at = new Date("2026-06-02T00:00:00.000Z");
    insertGateRow(db, at, {
      stage_reached: "stage0_silent",
      signal_snapshot: { maxNoveltyScore: 2 },
    });
    insertGateRow(db, at, {
      stage_reached: "stage0_silent",
      signal_snapshot: { maxNoveltyScore: 1 },
    });
    insertGateRow(db, at, { stage_reached: "stage0_silent" }); // no snapshot
    insertGateRow(db, at, {
      stage_reached: "stage3",
      signal_snapshot: { maxNoveltyScore: 3 },
    });
    insertGateRow(db, at, null); // corrupt detail

    expect(computeR3Metric(db, from, to)).toEqual({
      stage0Ticks: 3,
      noveltyGe2: 1,
    });
  });
});

describe("countLessonRegressionSignals", () => {
  function insertSignal(
    db: Database.Database,
    createdAt: Date,
    source: string,
    valence: string,
    summary: string,
  ): void {
    db.prepare(
      `INSERT INTO feedback_signals (created_at, source, valence, scope_type, summary)
       VALUES (?, ?, ?, 'agent', ?)`,
    ).run(formatSqliteDatetime(createdAt), source, valence, summary);
  }

  it("counts lesson-citing corrections and excludes the loop's own bookkeeping", () => {
    const db = makeDb();
    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-06-08T00:00:00.000Z");
    const at = new Date("2026-06-02T00:00:00.000Z");
    insertSignal(db, at, "explicit", "negative", "you forgot the lesson about digests");
    insertSignal(db, at, "self_critique", "correction", "ignored a lesson again");
    insertSignal(db, at, "behavioral", "negative", "lesson ignored"); // wrong source
    insertSignal(db, at, "explicit", "positive", "great lesson recall"); // wrong valence
    insertSignal(db, at, "explicit", "negative", "no mention of the l-word"); // no match
    insertSignal(
      db,
      at,
      "self_critique",
      "negative",
      "Tuning recommendation R5 (feedbackLessonMaxBytesGlobal) rejected: noise",
    );
    insertSignal(
      db,
      at,
      "self_critique",
      "negative",
      "Self-tuning change feedbackLessonMaxBytesGlobal (R5) reverted (auto): x",
    );
    insertSignal(db, new Date("2026-05-30T00:00:00.000Z"), "explicit", "negative", "lesson"); // outside

    expect(countLessonRegressionSignals(db, from, to)).toBe(2);
  });
});

describe("captureBaselineMetric", () => {
  it("captures R1/R3 metrics over the prior 7 days and null otherwise", () => {
    const db = makeDb();
    insertObservation(db, new Date("2026-06-08T00:00:00.000Z"), 3);
    const r1 = captureBaselineMetric(db, "R1", NOW) as R1Metric;
    expect(r1.noveltyGe2PerDay).toBeCloseTo(1 / 7);
    expect(captureBaselineMetric(db, "R3", NOW)).toEqual({
      stage0Ticks: 0,
      noveltyGe2: 0,
    });
    expect(captureBaselineMetric(db, "R5", NOW)).toBeNull();
    expect(captureBaselineMetric(db, "R9", NOW)).toBeNull();
  });
});

describe("auditSelfTuning", () => {
  it("writes the audit row and tolerates insert failure", () => {
    const db = makeDb();
    auditSelfTuning(db, "self_tuning.applied", "autonomous", "success", { a: 1 });
    expect(auditRows(db, "self_tuning.applied")).toHaveLength(1);
    db.prepare("DROP TABLE agent_actions").run();
    expect(() =>
      auditSelfTuning(db, "self_tuning.applied", "autonomous", "success", {}),
    ).not.toThrow();
  });
});

describe("DM message builders", () => {
  it("buildApplyDmMessage carries the change, evidence, and the undo hint", () => {
    const message = buildApplyDmMessage(configRec(), 240);
    expect(message).toContain("activityScanPrePassFreshnessMinutes 240 → 360");
    expect(message).toContain("80% empty");
    expect(message).toContain("!revert tuning");
  });

  it("buildR4SuggestionDmMessage proposes, never flips", () => {
    const message = buildR4SuggestionDmMessage(scheduleRec());
    expect(message).toContain("recurring_schedules:7");
    expect(message).toContain("never");
  });
});

describe("actuateApplyVerdicts — config namespace", () => {
  it("applies through the chokepoint, writes the ledger, audits, and DMs", async () => {
    const db = makeDb();
    const calls: Array<Record<string, unknown>> = [];
    const dms: string[] = [];
    const deps = makeDeps(db, {
      applyUpdates: okApplyUpdates(calls),
      sendDm: async (message) => {
        dms.push(message);
      },
    });
    const outcome = await actuateApplyVerdicts(deps, [configRec()], NOW);

    expect(calls).toEqual([{ activityScanPrePassFreshnessMinutes: 360 }]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.applied).toEqual([
      {
        id: "2026-06-09:R1:activityScanPrePassFreshnessMinutes",
        key: "activityScanPrePassFreshnessMinutes",
        rule: "R1",
        mode: "config",
        from: 240,
        to: 360,
      },
    ]);
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
    );
    expect(stored).toMatchObject({
      prev: 240,
      applied_at: NOW.toISOString(),
      rule: "R1",
      actuator: "config",
      proposed: 360,
    });
    // R1 baseline metric is captured even on an empty DB (zeros).
    expect(stored?.baselineMetric).toEqual({
      noveltyGe2PerDay: 0,
      cautiousEscalateShare: 0,
    });
    const audits = auditRows(db, "self_tuning.applied");
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe("success");
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("!revert tuning");
  });

  it("falls back to the recommendation's currentValue when the live read is undefined", async () => {
    const db = makeDb();
    const deps = makeDeps(db, { getCurrentValue: () => undefined });
    const outcome = await actuateApplyVerdicts(deps, [configRec()], NOW);
    expect(outcome.applied[0].from).toBe(240);
  });

  it("reports a bounds rejection as a failure and writes no ledger entry", async () => {
    const db = makeDb();
    const deps = makeDeps(db, {
      applyUpdates: async () => ({
        updated: [],
        errors: { activityScanPrePassFreshnessMinutes: "Value must be 0–480 minutes" },
      }),
    });
    const outcome = await actuateApplyVerdicts(deps, [configRec()], NOW);
    expect(outcome.applied).toEqual([]);
    expect(outcome.failures).toEqual([
      {
        id: "2026-06-09:R1:activityScanPrePassFreshnessMinutes",
        key: "activityScanPrePassFreshnessMinutes",
        error: "Value must be 0–480 minutes",
      },
    ]);
    expect(ledgerRows(db)).toHaveLength(0);
    const audits = auditRows(db, "self_tuning.applied");
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe("failed");
  });

  it("treats a silently-not-updated key as a failure", async () => {
    const db = makeDb();
    const deps = makeDeps(db, {
      applyUpdates: async () => ({ updated: [], errors: {} }),
    });
    const outcome = await actuateApplyVerdicts(deps, [configRec()], NOW);
    expect(outcome.failures[0].error).toContain("did not apply");
  });

  it("keeps the apply when baseline capture throws (degrades to null)", async () => {
    const db = makeDb();
    db.prepare("DROP TABLE observations").run();
    const outcome = await actuateApplyVerdicts(makeDeps(db), [configRec()], NOW);
    expect(outcome.applied).toHaveLength(1);
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
    );
    expect(stored?.baselineMetric).toBeNull();
  });

  it("keeps the apply when the DM throws, and warns when no DM path exists", async () => {
    const db = makeDb();
    const throwing = makeDeps(db, {
      sendDm: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const outcome = await actuateApplyVerdicts(throwing, [configRec()], NOW);
    expect(outcome.applied).toHaveLength(1);

    const db2 = makeDb();
    const silent = await actuateApplyVerdicts(makeDeps(db2), [configRec()], NOW);
    expect(silent.applied).toHaveLength(1);
  });

  it("isolates a thrown chokepoint into a per-recommendation failure", async () => {
    const db = makeDb();
    const deps = makeDeps(db, {
      applyUpdates: async () => {
        throw new Error("settings store locked");
      },
      sendDm: async () => {},
    });
    const outcome = await actuateApplyVerdicts(
      deps,
      [configRec(), scheduleRec()],
      NOW,
    );
    expect(outcome.failures).toEqual([
      expect.objectContaining({ error: "settings store locked" }),
    ]);
    // The R4 suggestion still went through.
    expect(outcome.applied).toEqual([
      expect.objectContaining({ mode: "dm_suggestion" }),
    ]);
  });

  it("stringifies a non-Error throw", async () => {
    const db = makeDb();
    const deps = makeDeps(db, {
      applyUpdates: async () => {
        throw "boom";
      },
    });
    const outcome = await actuateApplyVerdicts(deps, [configRec()], NOW);
    expect(outcome.failures[0].error).toBe("boom");
  });
});

describe("actuateApplyVerdicts — lesson namespace (R2)", () => {
  function signals(db: Database.Database): Array<{ summary: string; evidence_json: string }> {
    return db
      .prepare(`SELECT summary, evidence_json FROM feedback_signals`)
      .all() as Array<{ summary: string; evidence_json: string }>;
  }

  it("records the demotion as lesson guidance plus a hysteresis ledger entry", async () => {
    const db = makeDb();
    const outcome = await actuateApplyVerdicts(makeDeps(db), [lessonRec()], NOW);
    expect(outcome.applied).toEqual([
      {
        id: "2026-06-09:R2:notification:reminder",
        key: "notification:reminder",
        rule: "R2",
        mode: "lesson",
      },
    ]);
    const recorded = signals(db);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].summary).toContain("Demote notification:reminder");
    expect(JSON.parse(recorded[0].evidence_json)).toMatchObject({
      kind: "do-less",
      rule: "R2",
    });
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("notification:reminder"),
    );
    expect(stored?.actuator).toBe("lesson");
    expect(stored?.prev).toBe("send");
  });

  it("respects the feedback-loop kill switch but still records hysteresis", async () => {
    const db = makeDb();
    const deps = makeDeps(db, { feedbackLearningEnabled: false });
    const outcome = await actuateApplyVerdicts(deps, [lessonRec()], NOW);
    expect(outcome.applied).toHaveLength(1);
    expect(signals(db)).toHaveLength(0);
    const audits = auditRows(db, "self_tuning.applied");
    expect(JSON.parse(audits[0].detail)).toMatchObject({
      mode: "lesson",
      note: "feedback_loop_disabled",
    });
  });

  it("reports a failure when the signal write throws (re-proposes next cycle)", async () => {
    const db = makeDb();
    db.prepare("DROP TABLE feedback_signals").run();
    const outcome = await actuateApplyVerdicts(makeDeps(db), [lessonRec()], NOW);
    expect(outcome.applied).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(ledgerRows(db)).toHaveLength(0);
  });
});

describe("actuateApplyVerdicts — schedule namespace (R4)", () => {
  it("DMs the suggestion and records hysteresis, never flipping anything", async () => {
    const db = makeDb();
    const dms: string[] = [];
    const deps = makeDeps(db, {
      sendDm: async (message) => {
        dms.push(message);
      },
    });
    const outcome = await actuateApplyVerdicts(deps, [scheduleRec()], NOW);
    expect(outcome.applied).toEqual([
      expect.objectContaining({ mode: "dm_suggestion" }),
    ]);
    expect(dms[0]).toContain("recurring_schedules:7");
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("recurring_schedules:7"),
    );
    expect(stored?.actuator).toBe("schedule");
  });

  it("fails without a DM path so the rule re-proposes next cycle", async () => {
    const db = makeDb();
    const outcome = await actuateApplyVerdicts(makeDeps(db), [scheduleRec()], NOW);
    expect(outcome.applied).toEqual([]);
    expect(outcome.failures[0].error).toContain("No DM path");
    expect(ledgerRows(db)).toHaveLength(0);
  });
});

describe("revertAppliedTuningChange", () => {
  function seedEntry(
    db: Database.Database,
    over: Partial<TuningLedgerBlob> = {},
  ): LedgerScanEntry {
    const stored = blob(over);
    writeRuntimeState(
      db,
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
      stored,
    );
    return { key: "activityScanPrePassFreshnessMinutes", blob: stored };
  }

  it("restores prev, stamps the ledger, audits, and records the auto signal", async () => {
    const db = makeDb();
    const entry = seedEntry(db, { verified_at: "2026-06-08T00:00:00.000Z" });
    const calls: Array<Record<string, unknown>> = [];
    const result = await revertAppliedTuningChange(
      { db, applyUpdates: okApplyUpdates(calls) },
      entry,
      { trigger: "auto", reason: "novelty arrivals dropped", now: NOW },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ activityScanPrePassFreshnessMinutes: 240 }]);
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
    );
    expect(stored).toMatchObject({
      reverted_at: NOW.toISOString(),
      revert_trigger: "auto",
      revert_reason: "novelty arrivals dropped",
      // The concurrent stamp survives — re-read before write.
      verified_at: "2026-06-08T00:00:00.000Z",
    });
    const audits = auditRows(db, "self_tuning.reverted");
    expect(audits).toHaveLength(1);
    expect(audits[0].trigger).toBe("autonomous");
    const signals = db
      .prepare(`SELECT source, valence FROM feedback_signals`)
      .all() as Array<{ source: string; valence: string }>;
    expect(signals).toEqual([{ source: "self_critique", valence: "negative" }]);
  });

  it("records an explicit correction for the bang-command trigger", async () => {
    const db = makeDb();
    // A pre-Phase-3 / hand-written blob without a recommendation_id falls
    // back to the key as the signal's action_ref.
    const entry = seedEntry(db, {
      recommendation_id: undefined as unknown as string,
    });
    await revertAppliedTuningChange(
      { db, applyUpdates: okApplyUpdates() },
      entry,
      { trigger: "bang_command", reason: "owner requested", now: NOW },
    );
    const refs = db
      .prepare(`SELECT action_ref FROM feedback_signals`)
      .all() as Array<{ action_ref: string }>;
    expect(refs).toEqual([
      { action_ref: "activityScanPrePassFreshnessMinutes" },
    ]);
    const audits = auditRows(db, "self_tuning.reverted");
    expect(audits[0].trigger).toBe("user");
    const signals = db
      .prepare(`SELECT source, valence FROM feedback_signals`)
      .all() as Array<{ source: string; valence: string }>;
    expect(signals).toEqual([{ source: "explicit", valence: "correction" }]);
  });

  it("returns the chokepoint error and leaves the ledger unstamped", async () => {
    const db = makeDb();
    const entry = seedEntry(db);
    const result = await revertAppliedTuningChange(
      {
        db,
        applyUpdates: async () => ({
          updated: [],
          errors: { activityScanPrePassFreshnessMinutes: "out of range" },
        }),
      },
      entry,
      { trigger: "auto", reason: "regressed", now: NOW },
    );
    expect(result).toEqual({ ok: false, error: "out of range" });
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
    );
    expect(stored?.reverted_at).toBeUndefined();
    const audits = auditRows(db, "self_tuning.reverted");
    expect(audits[0].result).toBe("failed");
  });

  it("fails on a silently-not-updated key (user-triggered audit attribution)", async () => {
    const db = makeDb();
    const entry = seedEntry(db);
    const result = await revertAppliedTuningChange(
      { db, applyUpdates: async () => ({ updated: [], errors: {} }) },
      entry,
      { trigger: "bang_command", reason: "owner requested", now: NOW },
    );
    expect(result.ok).toBe(false);
    const audits = auditRows(db, "self_tuning.reverted");
    expect(audits).toEqual([
      expect.objectContaining({ trigger: "user", result: "failed" }),
    ]);
  });

  it("falls back to the scanned blob when the ledger row vanished mid-flight", async () => {
    const db = makeDb();
    const entry = seedEntry(db);
    db.prepare(`DELETE FROM runtime_state WHERE key = ?`).run(
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
    );
    const result = await revertAppliedTuningChange(
      { db, applyUpdates: okApplyUpdates() },
      entry,
      { trigger: "auto", reason: "regressed", now: NOW },
    );
    expect(result.ok).toBe(true);
    const stored = readRuntimeState<TuningLedgerBlob>(
      db,
      ledgerStateKey("activityScanPrePassFreshnessMinutes"),
    );
    expect(stored?.prev).toBe(240);
    expect(stored?.reverted_at).toBe(NOW.toISOString());
  });

  it("honors the feedback kill switch and tolerates a signal write failure", async () => {
    const db = makeDb();
    const entry = seedEntry(db);
    await revertAppliedTuningChange(
      { db, applyUpdates: okApplyUpdates(), feedbackLearningEnabled: false },
      entry,
      { trigger: "auto", reason: "regressed", now: NOW },
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM feedback_signals`).get()).toEqual(
      { n: 0 },
    );

    const db2 = makeDb();
    const entry2 = seedEntry(db2);
    db2.prepare("DROP TABLE feedback_signals").run();
    const result = await revertAppliedTuningChange(
      { db: db2, applyUpdates: okApplyUpdates() },
      entry2,
      { trigger: "auto", reason: "regressed", now: NOW },
    );
    expect(result.ok).toBe(true);
  });
});
