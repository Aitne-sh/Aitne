import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type { ApiDependencies } from "../server.js";
import { applySchema } from "../../db/schema.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import {
  TUNING_PENDING_CYCLE_STATE_KEY,
  type PendingTuningCycle,
} from "../../core/feedback/tuning-recommender.js";
import {
  ledgerStateKey,
  type TuningLedgerBlob,
} from "../../core/feedback/tuning-actuator.js";
import { createTuningRoutes } from "./tuning.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeApp(
  db: Database.Database,
  config: Record<string, unknown> = {},
  deps: Partial<ApiDependencies> = {},
) {
  return createTuningRoutes({
    db,
    config: {
      feedbackLearningEnabled: true,
      selfTuningEnabled: false,
      ...config,
    },
    ...deps,
  } as unknown as ApiDependencies);
}

function pendingCycle(over: Partial<PendingTuningCycle> = {}): PendingTuningCycle {
  return {
    cycleId: "2026-06-09",
    generatedAt: "2026-06-09T05:00:00.000Z",
    recommendations: [
      {
        id: "2026-06-09:R1:hourlyCheckPrePassFreshnessMinutes",
        rule: "R1",
        actuator: "config",
        key: "hourlyCheckPrePassFreshnessMinutes",
        currentValue: 240,
        proposedValue: 360,
        bounds: { min: 120, max: 480 },
        evidence: "fetch_window 80% empty over 20 runs/14d",
        estWeeklySavingUsd: 0.08,
      },
      {
        id: "2026-06-09:R2:notification:reminder",
        rule: "R2",
        actuator: "lesson",
        key: "notification:reminder",
        currentValue: "send",
        proposedValue: "demote",
        bounds: null,
        evidence: "reminder: 6/8 ignored (75%) over 14d",
        estWeeklySavingUsd: 0,
      },
    ],
    verdicts: {},
    ...over,
  };
}

function seedCycle(
  db: Database.Database,
  cycle: PendingTuningCycle = pendingCycle(),
): PendingTuningCycle {
  writeRuntimeState(db, TUNING_PENDING_CYCLE_STATE_KEY, cycle);
  return cycle;
}

async function postVerdicts(
  app: ReturnType<typeof makeApp>,
  body: unknown,
): Promise<Response> {
  return await app.request("/tuning/verdicts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const R1_ID = "2026-06-09:R1:hourlyCheckPrePassFreshnessMinutes";
const R2_ID = "2026-06-09:R2:notification:reminder";

describe("tuning routes", () => {
  describe("GET /tuning/pending", () => {
    it("returns null when no cycle has been generated yet", async () => {
      const app = makeApp(makeDb());
      const res = await app.request("/tuning/pending");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        cycle: null,
        selfTuningEnabled: false,
        shadow: true,
      });
    });

    it("returns the pending cycle with recorded verdicts", async () => {
      const db = makeDb();
      const cycle = seedCycle(db);
      const app = makeApp(db, { selfTuningEnabled: true });
      const res = await app.request("/tuning/pending");
      const json = (await res.json()) as {
        cycle: PendingTuningCycle;
        selfTuningEnabled: boolean;
      };
      expect(json.cycle).toEqual(cycle);
      expect(json.selfTuningEnabled).toBe(true);
    });
  });

  describe("POST /tuning/verdicts — validation", () => {
    it("rejects malformed JSON via the shared body reader", async () => {
      const app = makeApp(makeDb());
      const res = await app.request("/tuning/verdicts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a non-object body with the expected shape hint", async () => {
      const app = makeApp(makeDb());
      const res = await postVerdicts(app, [1, 2]);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; expectedShape: string };
      expect(json.error).toBe("validation_error");
      expect(json.expectedShape).toContain('"cycleId"');
    });

    it("collects field-level issues for missing cycleId / empty verdicts", async () => {
      const app = makeApp(makeDb());
      const res = await postVerdicts(app, { verdicts: [] });
      expect(res.status).toBe(400);
      const json = (await res.json()) as {
        issues: Array<{ field: string }>;
      };
      expect(json.issues.map((i) => i.field)).toEqual(
        expect.arrayContaining(["cycleId", "verdicts"]),
      );
    });

    it("validates each verdict entry's id, verdict enum, and reason", async () => {
      const app = makeApp(makeDb());
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [
          { id: null, verdict: "maybe", reason: 42 },
          "not-an-object",
          {}, // everything missing
          { id: "ok-id", verdict: "apply", reason: "   " }, // whitespace-only reason
        ],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as {
        issues: Array<{ field: string; got: string }>;
      };
      expect(json.issues.map((i) => i.field)).toEqual(
        expect.arrayContaining([
          "verdicts[0].id",
          "verdicts[0].verdict",
          "verdicts[0].reason",
          "verdicts[1]",
          "verdicts[2].id",
          "verdicts[2].verdict",
          "verdicts[2].reason",
          "verdicts[3].reason",
        ]),
      );
      const got = Object.fromEntries(json.issues.map((i) => [i.field, i.got]));
      expect(got["verdicts[0].id"]).toBe("null");
      expect(got["verdicts[0].verdict"]).toBe("maybe");
      expect(got["verdicts[2].id"]).toBe("missing");
      expect(got["verdicts[2].verdict"]).toBe("missing");
    });
  });

  describe("POST /tuning/verdicts — cycle guards (§3.4 single-use ids)", () => {
    it("409s when no pending cycle exists", async () => {
      const app = makeApp(makeDb());
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "fine" }],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        "no_pending_cycle",
      );
    });

    it("409s on an expired cycle id — no replay across cycles", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-02",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "fine" }],
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: string; activeCycleId: string };
      expect(json.error).toBe("cycle_expired");
      expect(json.activeCycleId).toBe("2026-06-09");
    });

    it("400s atomically on any unknown id — nothing is recorded", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [
          { id: R1_ID, verdict: "apply", reason: "fine" },
          { id: "2026-06-09:R9:made-up", verdict: "apply", reason: "fine" },
        ],
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as {
        error: string;
        unknownIds: string[];
      };
      expect(json.error).toBe("unknown_recommendation_ids");
      expect(json.unknownIds).toEqual(["2026-06-09:R9:made-up"]);
      const cycle = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(cycle?.verdicts).toEqual({});
    });
  });

  describe("POST /tuning/verdicts — recording (shadow mode)", () => {
    it("records verdicts, persists them, audits, and never actuates", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [
          { id: R1_ID, verdict: "apply", reason: "mail really was empty all week" },
          { id: R2_ID, verdict: "defer", reason: "one more week of data" },
        ],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toMatchObject({
        cycleId: "2026-06-09",
        recorded: 2,
        duplicates: 0,
        conflicts: 0,
        shadow: true,
        applied: [],
        selfTuningEnabled: false,
      });

      const cycle = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(cycle?.verdicts[R1_ID]?.verdict).toBe("apply");
      expect(cycle?.verdicts[R2_ID]?.verdict).toBe("defer");

      const audit = db
        .prepare(
          `SELECT detail FROM agent_actions WHERE action_type = 'self_tuning.verdict'`,
        )
        .all() as Array<{ detail: string }>;
      expect(audit).toHaveLength(1);
      const detail = JSON.parse(audit[0].detail) as {
        cycleId: string;
        shadow: boolean;
        verdicts: Array<{ id: string; status: string }>;
      };
      expect(detail.cycleId).toBe("2026-06-09");
      expect(detail.shadow).toBe(true);
      expect(detail.verdicts.map((v) => v.status)).toEqual([
        "recorded",
        "recorded",
      ]);
    });

    it("truncates an over-long reason to 280 chars", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [
          { id: R1_ID, verdict: "apply", reason: "too long reason ".repeat(40) },
        ],
      });
      expect(res.status).toBe(200);
      const cycle = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(cycle?.verdicts[R1_ID]?.reason).toHaveLength(280);
    });

    it("works without a config object in deps (test-harness parity with feedback routes)", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = createTuningRoutes({ db } as ApiDependencies);
      const pending = await app.request("/tuning/pending");
      expect(
        ((await pending.json()) as { selfTuningEnabled: boolean })
          .selfTuningEnabled,
      ).toBe(false);
      const res = await app.request("/tuning/verdicts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cycleId: "2026-06-09",
          verdicts: [{ id: R1_ID, verdict: "reject", reason: "noise" }],
        }),
      });
      expect(res.status).toBe(200);
      // No config → feedback loop defaults on → the signal still lands.
      const signals = db
        .prepare(`SELECT source FROM feedback_signals`)
        .all() as Array<{ source: string }>;
      expect(signals).toHaveLength(1);
    });

    it("is idempotent per id — a retried POST cannot double-apply", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      const body = {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "fine" }],
      };
      await postVerdicts(app, body);
      const res = await postVerdicts(app, body);
      const json = (await res.json()) as { recorded: number; duplicates: number };
      expect(json.recorded).toBe(0);
      expect(json.duplicates).toBe(1);
    });

    it("keeps the first verdict on conflict", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "reject", reason: "travel week" }],
      });
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "changed mind" }],
      });
      const json = (await res.json()) as { conflicts: number };
      expect(json.conflicts).toBe(1);
      const cycle = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(cycle?.verdicts[R1_ID]?.verdict).toBe("reject");
      expect(cycle?.verdicts[R1_ID]?.reason).toBe("travel week");
    });
  });

  describe("POST /tuning/verdicts — rejection → self_critique (§3.3)", () => {
    function critiqueSignals(db: Database.Database): Array<{
      source: string;
      valence: string;
      summary: string;
      action_ref: string | null;
    }> {
      return db
        .prepare(
          `SELECT source, valence, summary, action_ref FROM feedback_signals`,
        )
        .all() as Array<{
        source: string;
        valence: string;
        summary: string;
        action_ref: string | null;
      }>;
    }

    it("records a self_critique signal for each newly-recorded rejection", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [
          { id: R1_ID, verdict: "reject", reason: "was traveling, mail backlog is expected" },
          { id: R2_ID, verdict: "apply", reason: "reminders really are noise" },
        ],
      });
      const signals = critiqueSignals(db);
      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe("self_critique");
      expect(signals[0].valence).toBe("negative");
      expect(signals[0].action_ref).toBe(R1_ID);
      expect(signals[0].summary).toContain("R1");
      expect(signals[0].summary).toContain("rejected: was traveling");
    });

    it("does not double-post the signal on a retried rejection", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db);
      const body = {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "reject", reason: "travel week" }],
      };
      await postVerdicts(app, body);
      await postVerdicts(app, body);
      expect(critiqueSignals(db)).toHaveLength(1);
    });

    it("degrades to a warn (still 200) when the signal write throws", async () => {
      const db = makeDb();
      seedCycle(db);
      db.prepare("DROP TABLE feedback_signals").run();
      const app = makeApp(db);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "reject", reason: "travel week" }],
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { recorded: number }).recorded).toBe(1);
    });

    it("degrades to a warn (still 200) when the audit insert throws", async () => {
      const db = makeDb();
      seedCycle(db);
      db.prepare("DROP TABLE agent_actions").run();
      const app = makeApp(db);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "fine" }],
      });
      expect(res.status).toBe(200);
      const cycle = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(cycle?.verdicts[R1_ID]?.verdict).toBe("apply");
    });

    it("respects the feedback-loop kill switch", async () => {
      const db = makeDb();
      seedCycle(db);
      const app = makeApp(db, { feedbackLearningEnabled: false });
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "reject", reason: "travel week" }],
      });
      expect(res.status).toBe(200);
      expect(critiqueSignals(db)).toHaveLength(0);
      // The verdict itself is still recorded — only the signal is gated.
      const cycle = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(cycle?.verdicts[R1_ID]?.verdict).toBe("reject");
    });
  });

  describe("POST /tuning/verdicts — Phase 3 actuation (selfTuningEnabled=true)", () => {
    // A realistic-enough live config: applyConfigUpdates type-checks the
    // proposed value against the current one and the Zod schema fills the
    // rest with defaults.
    function liveConfig(over: Record<string, unknown> = {}) {
      return {
        feedbackLearningEnabled: true,
        selfTuningEnabled: true,
        hourlyCheckPrePassFreshnessMinutes: 240,
        ...over,
      };
    }

    // Unlike `makeApp` (which spreads defaults into a fresh object), the
    // actuation tests must hand the route the SAME object they assert on —
    // `applyConfigUpdates` mutates the live config in place.
    function makeLiveApp(
      db: Database.Database,
      config: Record<string, unknown>,
      deps: Partial<ApiDependencies> = {},
    ) {
      return createTuningRoutes({
        db,
        config,
        ...deps,
      } as unknown as ApiDependencies);
    }

    it("applies a config apply verdict through the chokepoint, with ledger + audit + DM", async () => {
      const db = makeDb();
      seedCycle(db);
      const config = liveConfig();
      const sendNotification = vi.fn().mockResolvedValue({
        dispatchId: "d1",
        deliveries: [],
      });
      const app = makeLiveApp(db, config, { sendNotification });
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "really was empty" }],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.shadow).toBe(false);
      expect(json.selfTuningEnabled).toBe(true);
      expect(json.actuationFailures).toEqual([]);
      expect(json.applied).toEqual([
        {
          id: R1_ID,
          key: "hourlyCheckPrePassFreshnessMinutes",
          rule: "R1",
          mode: "config",
          from: 240,
          to: 360,
        },
      ]);

      // The live config object was mutated and the settings row persisted —
      // the real applyConfigUpdates ran, not a stub.
      expect(config.hourlyCheckPrePassFreshnessMinutes).toBe(360);
      const persisted = db
        .prepare(`SELECT value_json FROM settings WHERE key = ?`)
        .get("hourlyCheckPrePassFreshnessMinutes") as
        | { value_json: string }
        | undefined;
      expect(persisted && JSON.parse(persisted.value_json)).toBe(360);

      const ledger = readRuntimeState<TuningLedgerBlob>(
        db,
        ledgerStateKey("hourlyCheckPrePassFreshnessMinutes"),
      );
      expect(ledger).toMatchObject({ prev: 240, proposed: 360, rule: "R1" });

      const audits = db
        .prepare(
          `SELECT result FROM agent_actions WHERE action_type = 'self_tuning.applied'`,
        )
        .all() as Array<{ result: string }>;
      expect(audits).toEqual([{ result: "success" }]);

      expect(sendNotification).toHaveBeenCalledTimes(1);
      const dm = sendNotification.mock.calls[0][0] as {
        message: string;
        notificationType: string;
      };
      expect(dm.notificationType).toBe("self_tuning");
      expect(dm.message).toContain("!revert tuning");
    });

    it("actuates an R2 apply as lesson guidance, never a config write", async () => {
      const db = makeDb();
      seedCycle(db);
      const config = liveConfig();
      const app = makeLiveApp(db, config);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R2_ID, verdict: "apply", reason: "reminders are noise" }],
      });
      const json = (await res.json()) as { applied: Array<{ mode: string }> };
      expect(json.applied).toEqual([
        expect.objectContaining({ mode: "lesson", key: "notification:reminder" }),
      ]);
      expect(config.hourlyCheckPrePassFreshnessMinutes).toBe(240);
      const signals = db
        .prepare(`SELECT summary FROM feedback_signals`)
        .all() as Array<{ summary: string }>;
      expect(signals).toHaveLength(1);
      expect(signals[0].summary).toContain("Demote notification:reminder");
    });

    it("never actuates reject/defer verdicts, even in live mode", async () => {
      const db = makeDb();
      seedCycle(db);
      const config = liveConfig();
      const app = makeLiveApp(db, config);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [
          { id: R1_ID, verdict: "defer", reason: "one more week" },
          { id: R2_ID, verdict: "reject", reason: "travel week" },
        ],
      });
      const json = (await res.json()) as { applied: unknown[] };
      expect(json.applied).toEqual([]);
      expect(config.hourlyCheckPrePassFreshnessMinutes).toBe(240);
    });

    it("a retried apply POST is a duplicate and never double-applies (§3.4)", async () => {
      const db = makeDb();
      seedCycle(db);
      const config = liveConfig();
      const app = makeLiveApp(db, config);
      const body = {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "fine" }],
      };
      await postVerdicts(app, body);
      expect(config.hourlyCheckPrePassFreshnessMinutes).toBe(360);
      // Sneak the knob back: a re-POST must NOT re-apply.
      config.hourlyCheckPrePassFreshnessMinutes = 240;
      const res = await postVerdicts(app, body);
      const json = (await res.json()) as {
        duplicates: number;
        applied: unknown[];
      };
      expect(json.duplicates).toBe(1);
      expect(json.applied).toEqual([]);
      expect(config.hourlyCheckPrePassFreshnessMinutes).toBe(240);
    });

    it("surfaces a bounds rejection as an actuation failure without failing the verdict", async () => {
      const db = makeDb();
      const cycle = pendingCycle();
      // Out-of-range proposal: the chokepoint (NUMERIC_RANGE 0–480) rejects.
      cycle.recommendations[0] = {
        ...cycle.recommendations[0],
        proposedValue: 9999,
      };
      seedCycle(db, cycle);
      const config = liveConfig();
      const app = makeLiveApp(db, config);
      const res = await postVerdicts(app, {
        cycleId: "2026-06-09",
        verdicts: [{ id: R1_ID, verdict: "apply", reason: "fine" }],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        applied: unknown[];
        actuationFailures: Array<{ id: string; error: string }>;
      };
      expect(json.applied).toEqual([]);
      expect(json.actuationFailures).toEqual([
        expect.objectContaining({ id: R1_ID }),
      ]);
      expect(config.hourlyCheckPrePassFreshnessMinutes).toBe(240);
      // The verdict itself is still recorded.
      const stored = readRuntimeState<PendingTuningCycle>(
        db,
        TUNING_PENDING_CYCLE_STATE_KEY,
      );
      expect(stored?.verdicts[R1_ID]?.verdict).toBe("apply");
    });

    it("GET /tuning/pending reports shadow=false when the flag is on", async () => {
      const db = makeDb();
      const app = makeApp(db, { selfTuningEnabled: true });
      const res = await app.request("/tuning/pending");
      expect(await res.json()).toMatchObject({
        selfTuningEnabled: true,
        shadow: false,
      });
    });
  });
});
