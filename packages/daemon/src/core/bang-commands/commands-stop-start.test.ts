import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  getUserPaused,
  isUserPaused,
  setUserPaused,
} from "../../db/runtime-state.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import {
  startCommand,
  stopCommand,
  BangCommandRegistry,
} from "./index.js";

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
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
    content: "!stop",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

describe("!stop / !start commands", () => {
  let db: Database.Database;
  const config = { timezone: "UTC" } as AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("!stop pauses when not paused", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await stopCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(isUserPaused(db)).toBe(true);
    const state = getUserPaused(db);
    expect(state?.source).toBe("!stop");
    expect(state?.byPlatform).toBe("slack");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/^\[SYSTEM · !stop\]\nAgent paused\./);
  });

  it("!stop is idempotent — already-paused returns 'Already paused'", async () => {
    setUserPaused(db, {
      since: "2026-04-30T12:00:00.000Z",
      source: "!stop",
      byPlatform: "telegram",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    await stopCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0]?.[0]).toContain("Already paused.");
    expect(notify.mock.calls[0]?.[0]).toContain("Source: !stop");
  });

  it("!start resumes when paused", async () => {
    setUserPaused(db, {
      since: "2026-04-30T12:00:00.000Z",
      source: "!stop",
      byPlatform: "slack",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    await startCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(isUserPaused(db)).toBe(false);
    expect(notify.mock.calls[0]?.[0]).toMatch(/Agent resumed/);
    expect(notify.mock.calls[0]?.[0]).toContain("Was paused: 2026-04-30 12:00");
  });

  it("!start while not paused replies 'not currently paused'", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await startCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0]?.[0]).toContain("not currently paused");
  });
});
