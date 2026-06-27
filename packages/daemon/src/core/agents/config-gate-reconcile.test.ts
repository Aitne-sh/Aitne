import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../db/schema.js";
import { getAgent, upsertAgent } from "../../db/agents-store.js";
import { readRuntimeState } from "../../db/runtime-state.js";
import {
  CONFIG_GATES_RECONCILED_KEY,
  reconcileConfigGates,
} from "./config-gate-reconcile.js";

function seedBuiltin(db: Database.Database, slug: string, enabled: boolean): void {
  upsertAgent(db, {
    slug,
    name: slug,
    description: "test",
    source: "builtin",
    definitionPath: `/tmp/${slug}/agent.md`,
    definitionHash: "h",
    enabled,
    processKey: null,
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "UTC",
    tags: [],
    stopWarning: null,
    metadata: {},
  });
}

describe("reconcileConfigGates", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  it("default config values change nothing but stamp the flag", () => {
    seedBuiltin(db, "activity-scan", true);
    seedBuiltin(db, "monthly-review", false);
    const result = reconcileConfigGates(db, {
      activityScanEnabled: true,
      monthlyReviewEnabled: false,
    });
    expect(result).toEqual({ applied: true, changes: [] });
    expect(getAgent(db, "activity-scan")!.enabled).toBe(true);
    expect(getAgent(db, "monthly-review")!.enabled).toBe(false);
    expect(readRuntimeState<string>(db, CONFIG_GATES_RECONCILED_KEY)).not.toBeNull();
  });

  it("carries a legacy activityScanEnabled=false onto the agent row", () => {
    seedBuiltin(db, "activity-scan", true);
    seedBuiltin(db, "monthly-review", false);
    const result = reconcileConfigGates(
      db,
      { activityScanEnabled: false, monthlyReviewEnabled: false },
      1234,
    );
    expect(result.changes).toEqual(["activity-scan"]);
    const dto = getAgent(db, "activity-scan")!;
    expect(dto.enabled).toBe(false);
    expect(dto.enabledOverriddenAt).toBe(1234);
  });

  it("carries a legacy monthlyReviewEnabled=true onto the agent row", () => {
    seedBuiltin(db, "activity-scan", true);
    seedBuiltin(db, "monthly-review", false);
    const result = reconcileConfigGates(db, {
      activityScanEnabled: true,
      monthlyReviewEnabled: true,
    });
    expect(result.changes).toEqual(["monthly-review"]);
    expect(getAgent(db, "monthly-review")!.enabled).toBe(true);
  });

  it("is a no-op when the row already matches the legacy value", () => {
    seedBuiltin(db, "activity-scan", false);
    seedBuiltin(db, "monthly-review", true);
    const result = reconcileConfigGates(db, {
      activityScanEnabled: false,
      monthlyReviewEnabled: true,
    });
    expect(result.changes).toEqual([]);
  });

  it("tolerates missing agent rows (pre-seed call ordering bug guard)", () => {
    const result = reconcileConfigGates(db, {
      activityScanEnabled: false,
      monthlyReviewEnabled: true,
    });
    expect(result).toEqual({ applied: true, changes: [] });
  });

  it("second run is a flagged no-op even with non-default settings", () => {
    seedBuiltin(db, "activity-scan", true);
    seedBuiltin(db, "monthly-review", false);
    reconcileConfigGates(db, { activityScanEnabled: true, monthlyReviewEnabled: false });
    // Operator re-enables the agent from the dashboard, then restarts with a
    // stale legacy false — the reconcile must NOT re-disable it.
    const second = reconcileConfigGates(db, {
      activityScanEnabled: false,
      monthlyReviewEnabled: false,
    });
    expect(second).toEqual({ applied: false, changes: [] });
    expect(getAgent(db, "activity-scan")!.enabled).toBe(true);
  });
});
