import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applySchema } from "./schema.js";
import {
  consumeFeedbackSignals,
  findRecentFeedbackSignal,
  getPendingFeedbackSignals,
  hasFeedbackSignalForAction,
  recordFeedbackSignal,
  sweepConsumedFeedbackSignals,
} from "./feedback-signals-store.js";

describe("feedback-signals-store", () => {
  function makeDb(): Database.Database {
    const db = new Database(":memory:");
    applySchema(db);
    return db;
  }

  it("records pending feedback and finds recent duplicates by scope + summary", () => {
    const db = makeDb();
    const id = recordFeedbackSignal(db, {
      source: "explicit",
      valence: "correction",
      scopeType: "agent_slug",
      scopeRef: "report-writer",
      actionKind: "agent_execution",
      actionRef: "42",
      agentId: "report-writer",
      summary: "Keep the budget section in weekly reports",
      evidence: { kind: "correction", excerpt: "budget missing" },
    });

    expect(id).toBeGreaterThan(0);
    const pending = getPendingFeedbackSignals(db, {
      scopeType: "agent_slug",
      scopeRef: "report-writer",
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.summary).toBe("Keep the budget section in weekly reports");

    const duplicate = findRecentFeedbackSignal(db, {
      scopeType: "agent_slug",
      scopeRef: "report-writer",
      summary: "Keep the budget section in weekly reports",
      withinSeconds: 600,
    });
    expect(duplicate?.id).toBe(id);
  });

  it("checks action-level duplicate reactions, consumes by id, and sweeps old consumed rows", () => {
    const db = makeDb();
    const id = recordFeedbackSignal(db, {
      source: "behavioral",
      valence: "neutral",
      scopeType: "agent",
      actionKind: "notification",
      actionRef: "dispatch-1",
      summary: "Owner did not respond to notification",
      evidence: { userReaction: "ignored" },
    });

    expect(
      hasFeedbackSignalForAction(db, {
        source: "behavioral",
        actionKind: "notification",
        actionRef: "dispatch-1",
        valence: "neutral",
        userReaction: "ignored",
      }),
    ).toBe(true);
    expect(
      hasFeedbackSignalForAction(db, {
        source: "behavioral",
        actionKind: "notification",
        actionRef: "dispatch-1",
        valence: "neutral",
        userReaction: "replied",
      }),
    ).toBe(false);

    expect(consumeFeedbackSignals(db, [id, 999], "policies/agent-lessons#x")).toEqual({
      consumed: 1,
      notFound: [999],
    });
    expect(getPendingFeedbackSignals(db)).toHaveLength(0);

    db.prepare("UPDATE feedback_signals SET consumed_at = datetime('now', '-10 days') WHERE id = ?").run(id);
    expect(sweepConsumedFeedbackSignals(db, new Date().toISOString())).toBe(1);
  });

  it("stores nullable columns and the default evidence blob when optional fields are omitted", () => {
    const db = makeDb();
    // Minimal row: no valence/scopeRef/actionKind/actionRef/agentId/evidence.
    const id = recordFeedbackSignal(db, {
      source: "self_critique",
      scopeType: "agent",
      summary: "Tighten the silence gate",
    });
    const row = db
      .prepare("SELECT * FROM feedback_signals WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      valence: null,
      scope_ref: null,
      action_kind: null,
      action_ref: null,
      agent_id: null,
      evidence_json: "{}",
    });
  });

  it("findRecentFeedbackSignal matches null scope_ref and returns null when nothing is recent", () => {
    const db = makeDb();
    recordFeedbackSignal(db, {
      source: "explicit",
      scopeType: "agent",
      summary: "Lead with blockers",
    });
    // scopeRef omitted → COALESCE(null,'') match against the stored null ref.
    expect(
      findRecentFeedbackSignal(db, {
        scopeType: "agent",
        summary: "Lead with blockers",
        withinSeconds: 600,
      }),
    ).not.toBeNull();
    // Different summary → no recent match.
    expect(
      findRecentFeedbackSignal(db, {
        scopeType: "agent",
        summary: "nonexistent",
        withinSeconds: 600,
      }),
    ).toBeNull();
  });

  it("hasFeedbackSignalForAction matches with and without the valence / userReaction filters", () => {
    const db = makeDb();
    recordFeedbackSignal(db, {
      source: "behavioral",
      valence: null,
      scopeType: "agent",
      actionKind: "notification",
      actionRef: "d-1",
      summary: "no valence row",
    });
    // No valence / no userReaction filter → matches on action triple alone.
    expect(
      hasFeedbackSignalForAction(db, {
        source: "behavioral",
        actionKind: "notification",
        actionRef: "d-1",
      }),
    ).toBe(true);
    // valence: null filter → matches the IS NULL branch.
    expect(
      hasFeedbackSignalForAction(db, {
        source: "behavioral",
        actionKind: "notification",
        actionRef: "d-1",
        valence: null,
      }),
    ).toBe(true);
  });

  it("consumeFeedbackSignals short-circuits on empty input and all-missing ids", () => {
    const db = makeDb();
    expect(consumeFeedbackSignals(db, [])).toEqual({ consumed: 0, notFound: [] });
    // No lessonRef arg + every id missing → existingIds.size === 0 branch.
    expect(consumeFeedbackSignals(db, [4242])).toEqual({ consumed: 0, notFound: [4242] });
  });

  it("consumes without a lessonRef, leaving lesson_ref null", () => {
    const db = makeDb();
    const id = recordFeedbackSignal(db, {
      source: "behavioral",
      scopeType: "agent",
      summary: "no lesson ref",
    });
    expect(consumeFeedbackSignals(db, [id])).toEqual({ consumed: 1, notFound: [] });
    const row = db
      .prepare("SELECT lesson_ref FROM feedback_signals WHERE id = ?")
      .get(id) as { lesson_ref: string | null };
    expect(row.lesson_ref).toBeNull();
  });
});
