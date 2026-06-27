import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";

import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import { createBackgroundTask } from "../../db/background-task-store.js";
import {
  createDefaultBangCommandRegistry,
} from "./index.js";
import { statusCommand, stopTaskCommand } from "./commands-task-control.js";
import type { BangCommandContext } from "./registry.js";

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
    content: "!status",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

function seedBackground(db: Database.Database, id: string, state: string): void {
  createBackgroundTask(db, {
    id,
    brief: `brief ${id}`,
    title: `Task ${id}`,
    notificationPolicy: "always",
    originatingChannel: "slack:D1",
    correlationId: null,
    scheduleRowId: null,
    tier: null,
    maxBudgetUsd: null,
    createdAt: 1000,
  });
  if (state !== "pending") {
    db.prepare("UPDATE background_task SET state = ? WHERE id = ?").run(state, id);
  }
}

function seedBrowser(db: Database.Database, id: string, state: string): void {
  db.prepare(
    `INSERT INTO browser_task (id, description, state, created_at)
     VALUES (?, ?, ?, 1000)`,
  ).run(id, `Browser ${id}`, state);
}

function makeCtx(
  db: Database.Database,
  overrides: Partial<BangCommandContext> = {},
): { ctx: BangCommandContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    event: makeEvent(),
    db,
    config: { timezone: "UTC" } as AgentConfig,
    notify,
    audit: makeAudit(),
    registry: createDefaultBangCommandRegistry(),
    ...overrides,
  } as unknown as BangCommandContext;
  return { ctx, notify };
}

describe("commands-task-control", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  describe("!status", () => {
    it("reports when nothing is running", async () => {
      const { ctx, notify } = makeCtx(db);
      await statusCommand.handler(ctx);
      expect(notify.mock.calls[0]?.[0]).toContain("No background or browser tasks are running");
    });

    it("lists active background + browser tasks with short ids, excluding terminals", async () => {
      seedBackground(db, "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running");
      seedBackground(db, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "completed");
      seedBrowser(db, "33333333-cccc-4ccc-8ccc-cccccccccccc", "awaiting_user");
      const { ctx, notify } = makeCtx(db);
      await statusCommand.handler(ctx);
      const reply = notify.mock.calls[0]?.[0] as string;
      expect(reply).toContain("2 active tasks:");
      expect(reply).toContain("[bg 11111111]");
      expect(reply).toContain("running");
      expect(reply).toContain("[web 33333333]");
      // terminal background task is excluded
      expect(reply).not.toContain("22222222");
    });

    it("uses the singular header + brief fallback for a single untitled task", async () => {
      // null title ⇒ the brief-slice fallback path in backgroundTitle
      createBackgroundTask(db, {
        id: "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        brief: "summarize the long quarterly report in detail",
        title: null,
        notificationPolicy: "always",
        originatingChannel: null,
        correlationId: null,
        scheduleRowId: null,
        tier: null,
        maxBudgetUsd: null,
        createdAt: 1000,
      });
      db.prepare("UPDATE background_task SET state = 'running' WHERE id = ?").run(
        "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      const { ctx, notify } = makeCtx(db);
      await statusCommand.handler(ctx);
      const reply = notify.mock.calls[0]?.[0] as string;
      expect(reply).toContain("1 active task:");
      expect(reply).toContain("summarize the long quarterly report");
    });

    it("runs while paused (pure read)", () => {
      expect(statusCommand.runsWhilePaused).toBe(true);
    });
  });

  describe("!stop <id>", () => {
    it("cancels a background task via the injected hook", async () => {
      seedBackground(db, "abcd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running");
      const cancelBackgroundTask = vi.fn().mockResolvedValue(true);
      const { ctx, notify } = makeCtx(db, { cancelBackgroundTask });
      await stopTaskCommand.handler(ctx, "abcd1234");
      expect(cancelBackgroundTask).toHaveBeenCalledWith(
        "abcd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "user_bang_stop",
      );
      expect(notify.mock.calls[0]?.[0]).toContain("Stopping the background task");
    });

    it("cancels a background task via the exact full id (fast path)", async () => {
      seedBackground(db, "abcd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running");
      const cancelBackgroundTask = vi.fn().mockResolvedValue(true);
      const { ctx } = makeCtx(db, { cancelBackgroundTask });
      await stopTaskCommand.handler(ctx, "abcd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(cancelBackgroundTask).toHaveBeenCalledWith(
        "abcd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "user_bang_stop",
      );
    });

    it("cancels a browser task via the injected hook (full id)", async () => {
      seedBrowser(db, "ffff0000-cccc-4ccc-8ccc-cccccccccccc", "running");
      const cancelBrowserTask = vi.fn().mockResolvedValue(true);
      const { ctx, notify } = makeCtx(db, { cancelBrowserTask });
      await stopTaskCommand.handler(ctx, "ffff0000-cccc-4ccc-8ccc-cccccccccccc");
      expect(cancelBrowserTask).toHaveBeenCalledWith(
        "ffff0000-cccc-4ccc-8ccc-cccccccccccc",
        "user_bang_stop",
      );
      expect(notify.mock.calls[0]?.[0]).toContain("Stopping the browser task");
    });

    it("reports no match for an unknown id", async () => {
      const cancelBackgroundTask = vi.fn();
      const { ctx, notify } = makeCtx(db, { cancelBackgroundTask });
      await stopTaskCommand.handler(ctx, "deadbeef");
      expect(cancelBackgroundTask).not.toHaveBeenCalled();
      expect(notify.mock.calls[0]?.[0]).toContain('No active task matches "deadbeef"');
    });

    it("refuses an ambiguous prefix instead of cancelling the wrong task", async () => {
      seedBackground(db, "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running");
      seedBackground(db, "aaaa2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "running");
      const cancelBackgroundTask = vi.fn();
      const { ctx, notify } = makeCtx(db, { cancelBackgroundTask });
      await stopTaskCommand.handler(ctx, "aaaa");
      expect(cancelBackgroundTask).not.toHaveBeenCalled();
      expect(notify.mock.calls[0]?.[0]).toContain("matches 2 active tasks");
    });

    it("tells the owner when the runner hook is unavailable", async () => {
      seedBackground(db, "cccc1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running");
      const { ctx, notify } = makeCtx(db); // no cancel hook
      await stopTaskCommand.handler(ctx, "cccc1234");
      expect(notify.mock.calls[0]?.[0]).toContain("runner isn't available");
    });

    it("shows a usage hint for an empty / non-string id (defensive guard)", async () => {
      const { ctx, notify } = makeCtx(db);
      await stopTaskCommand.handler(ctx, "");
      expect(notify.mock.calls[0]?.[0]).toContain("Usage: !stop <id>");
      const { ctx: ctx2, notify: notify2 } = makeCtx(db);
      await stopTaskCommand.handler(ctx2, undefined);
      expect(notify2.mock.calls[0]?.[0]).toContain("Usage: !stop <id>");
    });

    it("reports failure when the runner says the task already finished", async () => {
      seedBackground(db, "eeee1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running");
      const cancelBackgroundTask = vi.fn().mockResolvedValue(false);
      const { ctx, notify } = makeCtx(db, { cancelBackgroundTask });
      await stopTaskCommand.handler(ctx, "eeee1234");
      expect(notify.mock.calls[0]?.[0]).toContain("Couldn't stop");
    });

    it("does not match a terminal task", async () => {
      seedBackground(db, "dddd1234-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "completed");
      const cancelBackgroundTask = vi.fn();
      const { ctx, notify } = makeCtx(db, { cancelBackgroundTask });
      await stopTaskCommand.handler(ctx, "dddd1234");
      expect(cancelBackgroundTask).not.toHaveBeenCalled();
      expect(notify.mock.calls[0]?.[0]).toContain("No active task matches");
    });
  });

  describe("registry resolution — bare !stop vs !stop <id>", () => {
    const registry = createDefaultBangCommandRegistry();

    it("bare !stop resolves to the exact pause command", () => {
      const m = registry.resolve("!stop");
      expect(m?.kind).toBe("exact");
      expect(m?.commandName).toBe("!stop");
    });

    it("!stop <id> resolves to the prefix per-task command with the id as rest", () => {
      const m = registry.resolve("!stop abcd1234");
      expect(m?.kind).toBe("prefix");
      expect(m?.commandName).toBe("!stop");
      expect(m?.rest).toBe("abcd1234");
    });

    it("!status is registered", () => {
      expect(registry.match("!status")).toBeDefined();
    });
  });
});
