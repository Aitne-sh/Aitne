import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import { MOBILE_REPLY_BUDGET } from "./format-utils.js";
import {
  BangCommandRegistry,
  createDefaultBangCommandRegistry,
  createUserBangCommand,
  formatHelp,
  getBangCommandName,
  helpCommand,
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
    content: "!help",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

describe("!help command", () => {
  let db: Database.Database;
  const config = { timezone: "UTC" } as AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("is registered in the default registry", () => {
    const registry = createDefaultBangCommandRegistry();
    expect(registry.match("!help")).toBeDefined();
    expect(registry.match("!help")?.describe).toMatch(/registered command/i);
  });

  it("lists every built-in command with its description", async () => {
    const registry = createDefaultBangCommandRegistry();
    const notify = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry,
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply.startsWith("[SYSTEM · !help]")).toBe(true);
    expect(reply).toContain("Built-in:");
    for (const cmd of registry.list()) {
      expect(reply).toContain(getBangCommandName(cmd));
      expect(reply).toContain(cmd.describe);
    }
  });

  it("uses a two-line mobile layout: name on own line, indented description", () => {
    const reply = formatHelp(
      [
        {
          name: "!ping",
          describe: "Quick health check.",
          handler: async () => {},
        },
      ],
      [],
    );
    expect(reply).toContain("\n!ping\n  Quick health check.");
  });

  it("inserts a blank line between entries so chat-bubble wraps stay attached", () => {
    const reply = formatHelp(
      [
        { name: "!a", describe: "first", handler: async () => {} },
        { name: "!b", describe: "second", handler: async () => {} },
      ],
      [],
    );
    expect(reply).toContain("!a\n  first\n\n!b\n  second");
  });

  it("appends enabled user commands under a 'Custom:' heading", async () => {
    // P4b — keep descriptions tight so the assertion fits inside the
    // 1500-char MOBILE_REPLY_BUDGET alongside the full default registry
    // (which now carries 20+ built-ins). The test pins the auto-reflection
    // behaviour, not the exact phrasing.
    createUserBangCommand(db, {
      name: "sum",
      description: "Sum inbox.",
      prompt: "summarize the inbox",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });
    createUserBangCommand(db, {
      name: "draft",
      description: "Draft a reply",
      prompt: "draft a reply",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: false,
    });
    const registry = createDefaultBangCommandRegistry();
    const notify = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry,
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("Custom:");
    expect(reply).toContain("!sum\n  Sum inbox.");
    expect(reply).not.toContain("!draft");
  });

  it("omits the 'Custom:' section when no user commands are enabled", async () => {
    const registry = createDefaultBangCommandRegistry();
    const notify = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry,
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).not.toContain("Custom:");
  });

  it("falls back to backend·model when a user command has no description", () => {
    const reply = formatHelp(
      [],
      [
        {
          id: 1,
          command: "!ping",
          name: "ping",
          description: "",
          prompt: "ping",
          backendId: "claude",
          modelId: "claude-haiku-4-5",
          enabled: true,
          enabledSkills: null,
          instructionMd: null,
          createdAt: "2026-05-12T00:00:00Z",
          updatedAt: "2026-05-12T00:00:00Z",
        },
      ],
    );
    expect(reply).toContain("!ping\n  claude · claude-haiku-4-5");
  });

  it("sorts both built-ins and user commands alphabetically", () => {
    const registry = new BangCommandRegistry();
    registry.register({
      name: "!zebra",
      describe: "z",
      handler: async () => {},
    });
    registry.register({
      name: "!apple",
      describe: "a",
      handler: async () => {},
    });
    const reply = formatHelp(registry.list(), []);
    expect(reply.indexOf("!apple")).toBeLessThan(reply.indexOf("!zebra"));
  });

  it("auto-reflects a user command created after the registry was built", async () => {
    // Auto-reflection invariant: !help must read user_bang_commands live on
    // each invocation, so dashboard-created commands appear without a daemon
    // restart or any registration step.
    const registry = createDefaultBangCommandRegistry();
    const notify1 = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify: notify1,
      audit: makeAudit(),
      registry,
    });
    expect(notify1.mock.calls[0]?.[0] as string).not.toContain("!late_bloomer");

    // P4b — keep the late entry short so it fits inside MOBILE_REPLY_BUDGET
    // alongside the full default registry. The test still pins the
    // auto-reflection invariant (a newly-created user command appears on
    // the next !help) — the only thing that changed is the entry's prose.
    createUserBangCommand(db, {
      name: "late",
      description: "Added late.",
      prompt: "later",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });

    const notify2 = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify: notify2,
      audit: makeAudit(),
      registry,
    });
    const reply2 = notify2.mock.calls[0]?.[0] as string;
    expect(reply2).toContain("!late\n  Added late.");
  });

  it("auto-reflects a built-in registered after the registry was built", async () => {
    const registry = createDefaultBangCommandRegistry();
    registry.register({
      name: "!late_builtin",
      describe: "Registered post-construction.",
      handler: async () => {},
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry,
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("!late_builtin\n  Registered post-construction.");
  });

  it("stays within the mobile reply budget for the default surface", async () => {
    const registry = createDefaultBangCommandRegistry();
    const notify = vi.fn().mockResolvedValue(undefined);
    await helpCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry,
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply.length).toBeLessThanOrEqual(MOBILE_REPLY_BUDGET);
    expect(reply).not.toContain("… (truncated)");
  });
});
