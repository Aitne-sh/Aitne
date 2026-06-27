import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import {
  ledgerStateKey,
  type TuningLedgerBlob,
} from "../feedback/tuning-actuator.js";
import { BangArgError, BangCommandRegistry, revertTuningCommand } from "./index.js";

const KEY = "activityScanPrePassFreshnessMinutes";

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
    insertInProgressRow: vi.fn(() => -1),
  };
}

function makeEvent(content = "!revert tuning"): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "corr-revert",
    sender: "owner",
    channel: "D1",
    content,
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

function blob(over: Partial<TuningLedgerBlob> = {}): TuningLedgerBlob {
  return {
    prev: 240,
    applied_at: "2026-06-01T00:00:00.000Z",
    rule: "R1",
    actuator: "config",
    proposed: 360,
    recommendation_id: `2026-06-01:R1:${KEY}`,
    evidence: "fetch_window 80% empty over 20 runs/14d",
    baselineMetric: null,
    ...over,
  };
}

describe("!revert tuning", () => {
  let db: Database.Database;
  let config: AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    config = {
      timezone: "UTC",
      dayBoundaryHour: 4,
      activityScanPrePassFreshnessMinutes: 360,
      feedbackLearningEnabled: true,
    } as AgentConfig;
  });

  function ctx(notify = vi.fn().mockResolvedValue(undefined)) {
    return {
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    };
  }

  it("opts into runsWhilePaused (pure config/DB write, no LLM dispatch)", () => {
    expect(revertTuningCommand.runsWhilePaused).toBe(true);
  });

  describe("parseArgs", () => {
    it("accepts 'tuning' case-insensitively", () => {
      expect(revertTuningCommand.parseArgs?.("tuning", ctx())).toBeUndefined();
      expect(revertTuningCommand.parseArgs?.("Tuning", ctx())).toBeUndefined();
    });

    it("rejects a bare or trailing-argument invocation with usage", () => {
      for (const rest of ["", "tuning now", "all"]) {
        try {
          revertTuningCommand.parseArgs?.(rest, ctx());
          expect.unreachable("expected BangArgError");
        } catch (err) {
          expect(err).toBeInstanceOf(BangArgError);
          expect((err as Error).message).toContain("!revert tuning");
        }
      }
    });
  });

  it("replies with the calm empty state when nothing is revertable", async () => {
    // A lesson entry alone is not revertable — no machine state to restore.
    writeRuntimeState(
      db,
      ledgerStateKey("notification:reminder"),
      blob({ actuator: "lesson", prev: "send" }),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    await revertTuningCommand.handler(ctx(notify), undefined);
    expect(notify.mock.calls[0][0]).toContain(
      "No applied self-tuning change to revert",
    );
    expect(config.activityScanPrePassFreshnessMinutes).toBe(360);
  });

  it("reverts the most recent applied config change through the chokepoint", async () => {
    writeRuntimeState(db, ledgerStateKey(KEY), blob());
    const notify = vi.fn().mockResolvedValue(undefined);
    await revertTuningCommand.handler(ctx(notify), undefined);

    // Live config mutated back and the settings row persisted.
    expect(config.activityScanPrePassFreshnessMinutes).toBe(240);
    const persisted = db
      .prepare(`SELECT value_json FROM settings WHERE key = ?`)
      .get(KEY) as { value_json: string } | undefined;
    expect(persisted && JSON.parse(persisted.value_json)).toBe(240);

    // Ledger stamped → 28-day cool-down; audit + correction signal landed.
    const stored = readRuntimeState<TuningLedgerBlob>(db, ledgerStateKey(KEY));
    expect(stored?.reverted_at).toBeDefined();
    expect(stored?.revert_trigger).toBe("bang_command");
    const audits = db
      .prepare(
        `SELECT trigger FROM agent_actions WHERE action_type = 'self_tuning.reverted'`,
      )
      .all() as Array<{ trigger: string }>;
    expect(audits).toEqual([{ trigger: "user" }]);
    const signals = db
      .prepare(`SELECT source, valence FROM feedback_signals`)
      .all() as Array<{ source: string; valence: string }>;
    expect(signals).toEqual([{ source: "explicit", valence: "correction" }]);

    const reply = notify.mock.calls[0][0] as string;
    expect(reply).toContain(`Reverted ${KEY} 360 → 240`);
    expect(reply).toContain("28-day");
  });

  it("surfaces a chokepoint rejection without stamping the ledger", async () => {
    // prev=9999 violates the 0–480 NUMERIC_RANGE → applyConfigUpdates rejects.
    writeRuntimeState(db, ledgerStateKey(KEY), blob({ prev: 9999 }));
    const notify = vi.fn().mockResolvedValue(undefined);
    await revertTuningCommand.handler(ctx(notify), undefined);
    expect(notify.mock.calls[0][0]).toContain(`Could not revert ${KEY}`);
    expect(config.activityScanPrePassFreshnessMinutes).toBe(360);
    const stored = readRuntimeState<TuningLedgerBlob>(db, ledgerStateKey(KEY));
    expect(stored?.reverted_at).toBeUndefined();
  });
});
