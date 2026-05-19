import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import {
  reportCommand,
  formatReport,
  BangCommandRegistry,
} from "./index.js";

function insertFailure(
  db: Database.Database,
  args: {
    backend: string | null;
    actionType: string;
    daysAgo: number;
    error: string;
  },
): void {
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, trigger, backend, result, error, started_at)
     VALUES ('e', ?, 'reactive', ?, 'failed', ?, datetime('now', ?))`,
  ).run(args.actionType, args.backend, args.error, `-${args.daysAgo} days`);
}

function makeEvent(): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "c",
    sender: "o",
    channel: "D1",
    content: "!report",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
  };
}

describe("!report", () => {
  let db: Database.Database;
  const config = { timezone: "UTC" } as AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("returns 'Clean' when no failures in window", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await reportCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0]?.[0]).toContain("Clean. No agent failures recorded.");
  });

  it("groups by (action_type, backend) — different error strings collapse to one", async () => {
    // Two failures with the same action_type+backend but different errors:
    // grouping must collapse them, not split.
    insertFailure(db, {
      backend: "claude",
      actionType: "routine.hourly_check",
      daysAgo: 1,
      error: "Backend quota exceeded for claude (req-abc)",
    });
    insertFailure(db, {
      backend: "claude",
      actionType: "routine.hourly_check",
      daysAgo: 1,
      error: "Backend quota exceeded for claude (req-xyz)",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    await reportCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("1 error groups (2 total)");
    expect(reply).toMatch(/routine\.hourly_check · claude \(2×\)/);
  });

  it("excludes failures outside the 7-day window", async () => {
    insertFailure(db, {
      backend: "claude",
      actionType: "routine.hourly_check",
      daysAgo: 8,
      error: "old",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    await reportCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0]?.[0]).toContain("Clean.");
  });

  it("caps to LIMIT 5 with '… and N more' footer", async () => {
    for (let i = 0; i < 7; i++) {
      insertFailure(db, {
        backend: i % 2 === 0 ? "claude" : "codex",
        actionType: `task.${i}`,
        daysAgo: 1,
        error: `err${i}`,
      });
    }
    const notify = vi.fn().mockResolvedValue(undefined);
    await reportCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("7 error groups (7 total)");
    expect(reply).toMatch(/… and 2 more/);
  });

  it("uses 'claude' as the backend label for NULL backends", async () => {
    insertFailure(db, {
      backend: null,
      actionType: "observer.git.fetch",
      daysAgo: 1,
      error: "fetch origin failed: timeout",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    await reportCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/observer\.git\.fetch · claude/);
  });
});

describe("formatReport (pure)", () => {
  const config = { timezone: "UTC" } as AgentConfig;

  it("renders empty report", () => {
    expect(
      formatReport({ rows: [], totalGroups: 0, totalEvents: 0 }, config),
    ).toContain("Clean.");
  });

  it("renders sample with newline-collapsed message and length cap", () => {
    const longSample = "Backend\nquota\texceeded ".repeat(20);
    const reply = formatReport(
      {
        rows: [
          {
            backend: "claude",
            action_type: "routine.hourly_check",
            n: 3,
            first_seen: "2026-04-30 12:00:00",
            last_seen: "2026-05-01 03:02:00",
            sample: longSample,
          },
        ],
        totalGroups: 1,
        totalEvents: 3,
      },
      config,
    );
    // Single line, ends with ellipsis when oversized
    expect(reply).not.toContain("\nquota");
    expect(reply).toMatch(/…/);
    expect(reply).toContain("last: 05-01 03:02");
  });

  it("renders '—' for an empty-string backend label", () => {
    const reply = formatReport(
      {
        rows: [
          {
            backend: "",
            action_type: "observer.git.fetch",
            n: 1,
            first_seen: "2026-05-01 00:00:00",
            last_seen: "2026-05-01 00:00:00",
            sample: "fetch failed",
          },
        ],
        totalGroups: 1,
        totalEvents: 1,
      },
      config,
    );
    expect(reply).toMatch(/observer\.git\.fetch · — \(1×\)/);
  });

  it("redacts secret-shaped tokens out of the sample", () => {
    const reply = formatReport(
      {
        rows: [
          {
            backend: "claude",
            action_type: "routine.hourly_check",
            n: 1,
            first_seen: "2026-05-01 00:00:00",
            last_seen: "2026-05-01 00:00:00",
            sample:
              "Auth failed Bearer abcdef0123456789abcdef0123456789abcdef0123",
          },
        ],
        totalGroups: 1,
        totalEvents: 1,
      },
      config,
    );
    expect(reply).toContain("[REDACTED]");
    expect(reply).not.toContain("abcdef0123456789abcdef0123456789abcdef0123");
  });

  it("falls back to '(no error message)' when sample is null", () => {
    const reply = formatReport(
      {
        rows: [
          {
            backend: "claude",
            action_type: "x",
            n: 1,
            first_seen: "2026-05-01 00:00:00",
            last_seen: "2026-05-01 00:00:00",
            sample: null,
          },
        ],
        totalGroups: 1,
        totalEvents: 1,
      },
      config,
    );
    expect(reply).toContain("(no error message)");
  });
});
