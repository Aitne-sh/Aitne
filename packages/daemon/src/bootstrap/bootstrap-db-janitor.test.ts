import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import { upsertAgent } from "../db/agents-store.js";
import {
  startExecution,
  completeExecution,
  getExecution,
} from "../db/agent-executions-store.js";
import { sweepAbandonedAgentExecutions } from "./db.js";

describe("sweepAbandonedAgentExecutions (boot crash janitor §7.4)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    upsertAgent(db, {
      slug: "morning-routine",
      name: "Morning routine",
      source: "builtin",
      definitionPath: "/agents/morning-routine/agent.md",
      definitionHash: "hash",
      enabled: true,
      scheduleKind: "cron",
      scheduleExpression: "0 4 * * *",
      scheduleTimezone: "UTC",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("flips a row abandoned before boot to error/crash", () => {
    const bootTime = 1_000_000;
    const id = startExecution(db, { agentId: "morning-routine", trigger: "cron" }, bootTime - 5000);

    const count = sweepAbandonedAgentExecutions(db, bootTime);
    expect(count).toBe(1);

    const exec = getExecution(db, id);
    expect(exec?.result).toBe("error");
    expect(exec?.errorKind).toBe("crash");
    expect(exec?.endedAt).not.toBeNull();
  });

  it("leaves an already-terminal row untouched", () => {
    const bootTime = 1_000_000;
    const id = startExecution(db, { agentId: "morning-routine", trigger: "cron" }, bootTime - 5000);
    completeExecution(db, { executionId: id, result: "success" }, bootTime - 4000);

    expect(sweepAbandonedAgentExecutions(db, bootTime)).toBe(0);
    expect(getExecution(db, id)?.result).toBe("success");
  });

  it("leaves a row started after boot untouched (a live run)", () => {
    const bootTime = 1_000_000;
    const id = startExecution(db, { agentId: "morning-routine", trigger: "cron" }, bootTime + 5000);

    expect(sweepAbandonedAgentExecutions(db, bootTime)).toBe(0);
    expect(getExecution(db, id)?.result).toBeNull();
  });

  it("is idempotent — a second sweep finds nothing", () => {
    const bootTime = 1_000_000;
    startExecution(db, { agentId: "morning-routine", trigger: "cron" }, bootTime - 5000);
    expect(sweepAbandonedAgentExecutions(db, bootTime)).toBe(1);
    expect(sweepAbandonedAgentExecutions(db, bootTime)).toBe(0);
  });
});
