import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import { closeCommand, BangCommandRegistry } from "./index.js";

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

function makeEvent(): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "corr",
    sender: "owner",
    channel: "D1",
    content: "!close",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

describe("!close command", () => {
  let db: Database.Database;
  const config = { timezone: "UTC" } as AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("closes the active DM session and replies 'Session closed.'", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const closeActiveDmSession = vi.fn().mockResolvedValue({ closedId: 42 });
    await closeCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      closeActiveDmSession,
    });
    expect(closeActiveDmSession).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toBe("Session closed.");
  });

  it("replies 'No active session to close.' when none exists", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const closeActiveDmSession = vi.fn().mockResolvedValue({ closedId: null });
    await closeCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
      closeActiveDmSession,
    });
    expect(closeActiveDmSession).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toBe("No active session to close.");
  });

  it("replies with a soft failure when the dispatcher did not wire the callback", async () => {
    // Defensive branch — production wiring always supplies the callback,
    // but the BangCommandContext field is optional for unit ergonomics,
    // so the handler must not throw when called without it.
    const notify = vi.fn().mockResolvedValue(undefined);
    await closeCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/not available/i);
  });

  it("opts into pause execution (runsWhilePaused=true)", () => {
    // Session close is state-only — gating it on `!start` would force
    // the user to resume the agent (re-arming cron, observers, autonomous
    // work) just to clean up a session. The flag is the contract.
    expect(closeCommand.runsWhilePaused).toBe(true);
  });
});
