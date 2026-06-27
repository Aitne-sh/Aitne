import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { readRuntimeState } from "../db/runtime-state.js";
import {
  DAY_BOUNDARY_LAST_AGENT_DAY_KEY,
  runDayBoundaryTasks,
} from "./day-boundary.js";

const TODAY = "2026-06-11";
const YESTERDAY = "2026-06-10";

describe("runDayBoundaryTasks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => {
    db.close();
  });

  function marker(): string | null {
    return readRuntimeState<string>(db, DAY_BOUNDARY_LAST_AGENT_DAY_KEY);
  }

  function makeDeps(overrides: {
    summarize?: () => Promise<void>;
    fanout?: () => Promise<{ enqueuedSlugs: string[] }>;
  } = {}) {
    const summarize = vi.fn(overrides.summarize ?? (async () => {}));
    const fanout = vi.fn(
      overrides.fanout ?? (async () => ({ enqueuedSlugs: ["slug-a"] })),
    );
    return {
      summarize,
      fanout,
      deps: {
        db,
        todayAgentDay: TODAY,
        summarizeDmSessions: summarize,
        fanoutResearchClusterUpdates: fanout,
      },
    };
  }

  it("runs both steps and writes the marker AFTER completion", async () => {
    const { summarize, fanout, deps } = makeDeps();
    const result = await runDayBoundaryTasks(deps);
    expect(result).toEqual({ ran: true, enqueuedSlugs: ["slug-a"] });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(fanout).toHaveBeenCalledTimes(1);
    expect(marker()).toBe(TODAY);
  });

  it("skips the body entirely when the marker matches today", async () => {
    const { deps } = makeDeps();
    await runDayBoundaryTasks(deps);
    const { summarize, fanout, deps: replayDeps } = makeDeps();
    const replay = await runDayBoundaryTasks(replayDeps);
    expect(replay).toEqual({ ran: false });
    expect(summarize).not.toHaveBeenCalled();
    expect(fanout).not.toHaveBeenCalled();
  });

  it("re-runs when the marker is from an earlier agent day", async () => {
    const first = makeDeps();
    await runDayBoundaryTasks({ ...first.deps, todayAgentDay: YESTERDAY });
    expect(marker()).toBe(YESTERDAY);
    const second = makeDeps();
    const result = await runDayBoundaryTasks(second.deps);
    expect(result.ran).toBe(true);
    expect(marker()).toBe(TODAY);
  });

  it("does not write the marker when summarize fails (next fire retries)", async () => {
    const { fanout, deps } = makeDeps({
      summarize: async () => {
        throw new Error("summarize boom");
      },
    });
    await expect(runDayBoundaryTasks(deps)).rejects.toThrow("summarize boom");
    expect(fanout).not.toHaveBeenCalled();
    expect(marker()).toBeNull();
  });

  it("does not write the marker when the fan-out fails (next fire retries)", async () => {
    const { deps } = makeDeps({
      fanout: async () => {
        throw new Error("fanout boom");
      },
    });
    await expect(runDayBoundaryTasks(deps)).rejects.toThrow("fanout boom");
    expect(marker()).toBeNull();
    // A retry on the next scheduler fire proceeds — the marker is absent.
    const retry = makeDeps();
    const result = await runDayBoundaryTasks(retry.deps);
    expect(result.ran).toBe(true);
    expect(marker()).toBe(TODAY);
  });
});
