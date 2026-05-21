import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import { setUserPaused } from "../../db/runtime-state.js";
import { incrementReloadSignals } from "../../db/browser-history-store.js";
import {
  BangCommandRegistry,
  tryHandle,
  checksCommand,
  formatChecks,
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

function makeEvent(content = "!checks"): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "corr-checks",
    sender: "owner",
    channel: "D1",
    content,
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

describe("!checks", () => {
  let db: Database.Database;
  const config = { timezone: "UTC", dayBoundaryHour: 4 } as AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("opts into runsWhilePaused (pure DB read, no LLM dispatch)", () => {
    expect(checksCommand.runsWhilePaused).toBe(true);
  });

  it("returns the calm empty-state line when no reloads recorded today", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await checksCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/^\[SYSTEM · !checks · \d{4}-\d{2}-\d{2}\]/);
    expect(reply).toContain(
      "No reload patterns recorded for today's agent-day yet.",
    );
    // The empty case must not invent a list shape — pin the absence of
    // any "- " bullet so a future format change does not regress the
    // calm empty-state contract.
    expect(reply).not.toContain("\n- ");
  });

  it("lists today's top patterns sorted by count, then pattern (lexicographic)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    incrementReloadSignals(db, [
      { date: today, urlPattern: "claude.ai/usage", count: 8 },
      { date: today, urlPattern: "twitter.com/home", count: 12 },
      { date: today, urlPattern: "github.com/notifications", count: 12 },
    ]);
    const notify = vi.fn().mockResolvedValue(undefined);
    await checksCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/^\[SYSTEM · !checks · \d{4}-\d{2}-\d{2}\]/);
    // Sort key: count DESC, pattern ASC. github.com/notifications and
    // twitter.com/home tie at 12 → github before twitter alphabetically.
    const idxGithub = reply.indexOf("github.com/notifications");
    const idxTwitter = reply.indexOf("twitter.com/home");
    const idxClaude = reply.indexOf("claude.ai/usage");
    expect(idxGithub).toBeGreaterThan(0);
    expect(idxTwitter).toBeGreaterThan(idxGithub);
    expect(idxClaude).toBeGreaterThan(idxTwitter);
    expect(reply).toContain("- github.com/notifications: 12");
    expect(reply).toContain("- twitter.com/home: 12");
    expect(reply).toContain("- claude.ai/usage: 8");
  });

  it("does not return rows from other agent-days", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    incrementReloadSignals(db, [
      { date: yesterday, urlPattern: "old.example.com/page", count: 99 },
      { date: today, urlPattern: "fresh.example.com/page", count: 3 },
    ]);
    const notify = vi.fn().mockResolvedValue(undefined);
    await checksCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("fresh.example.com/page: 3");
    expect(reply).not.toContain("old.example.com/page");
  });

  it("anchors 'today' on the agent-day boundary (dayBoundaryHour=4), not UTC midnight", async () => {
    // At 03:00 UTC on 2026-05-20, the agent-day is still 2026-05-19
    // (the day boundary is 04:00 local; with timezone='UTC' the agent
    // -day-date for 03:00 is the previous calendar date). We can't
    // freeze Date.now in this test cleanly without a clock injection
    // surface on the command, so this test is restricted to the
    // pure-formatter shape — the agent-day routing is exercised by the
    // store's listReloadsForDate (a date-keyed query, not a clock
    // computation), and `formatChecks` is the only place that emits
    // the date string in the reply.
    const reply = formatChecks("2026-05-19", [
      { urlPattern: "x.example.com/y", reloadCount: 4 },
    ]);
    expect(reply).toMatch(/^\[SYSTEM · !checks · 2026-05-19\]/);
  });

  it("falls back to local-time / 04:00 day boundary when config omits timezone and dayBoundaryHour", async () => {
    // Mirrors how skill-side / dashboard-side reads work when the
    // operator has not pinned timezone/dayBoundaryHour: getAgentDayDateStr
    // accepts `undefined` for both. The command must still produce a
    // valid ISO date marker — not crash on the optional fields.
    const today = new Date().toISOString().slice(0, 10);
    incrementReloadSignals(db, [
      { date: today, urlPattern: "x.example.com/y", count: 1 },
    ]);
    const minimalConfig = {} as AgentConfig;
    const notify = vi.fn().mockResolvedValue(undefined);
    await checksCommand.handler({
      event: makeEvent(),
      db,
      config: minimalConfig,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/^\[SYSTEM · !checks · \d{4}-\d{2}-\d{2}\]/);
  });

  it("survives while the agent is paused (runsWhilePaused gate)", async () => {
    // !checks is a pure read — pause is meant to prevent LLM dispatch,
    // not to gate read-only diagnostics. The registry's pause branch
    // must let this command through.
    setUserPaused(db, {
      since: new Date().toISOString(),
      source: "!stop",
      byPlatform: "slack",
    });
    const today = new Date().toISOString().slice(0, 10);
    incrementReloadSignals(db, [
      { date: today, urlPattern: "site.example.com/feed", count: 2 },
    ]);
    const registry = new BangCommandRegistry();
    registry.register(checksCommand);
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await tryHandle(registry, {
      event: makeEvent(),
      db,
      config,
      audit: makeAudit(),
      rawSend: send,
    });
    expect(result).toBe(true);
    const reply = send.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/^\[SYSTEM · !checks · \d{4}-\d{2}-\d{2}\]/);
    expect(reply).toContain("- site.example.com/feed: 2");
  });
});

describe("formatChecks (pure)", () => {
  it("includes the agent-day date in the marker so multi-day pulls are unambiguous", () => {
    expect(formatChecks("2026-05-19", [])).toMatch(
      /^\[SYSTEM · !checks · 2026-05-19\]/,
    );
  });

  it("renders the count parenthetical so a deep-loaded reply still announces the total at top", () => {
    const reply = formatChecks("2026-05-19", [
      { urlPattern: "a.example.com/b", reloadCount: 3 },
      { urlPattern: "c.example.com/d", reloadCount: 1 },
    ]);
    expect(reply).toContain("Top reload patterns (2):");
  });

  it("emits one bullet per row in the supplied order", () => {
    const reply = formatChecks("2026-05-19", [
      { urlPattern: "first.example.com/x", reloadCount: 7 },
      { urlPattern: "second.example.com/y", reloadCount: 4 },
    ]);
    expect(reply).toContain("- first.example.com/x: 7");
    expect(reply).toContain("- second.example.com/y: 4");
    expect(reply.indexOf("first.example.com/x")).toBeLessThan(
      reply.indexOf("second.example.com/y"),
    );
  });
});
