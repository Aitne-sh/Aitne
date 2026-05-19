import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import {
  costAllCommand,
  costBackendCommands,
  formatCostAll,
  formatCostFiltered,
  BangCommandRegistry,
} from "./index.js";

function insertAction(
  db: Database.Database,
  args: {
    backend: string | null;
    cost: number | null;
    daysAgo: number;
    result?: string;
  },
): void {
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, trigger, backend, cost_usd, result, started_at)
     VALUES ('e', 'message.received', 'reactive', ?, ?, ?, datetime('now', ?))`,
  ).run(
    args.backend,
    args.cost,
    args.result ?? "success",
    `-${args.daysAgo} days`,
  );
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

function makeEvent(): MessageEvent {
  return {
    type: "message.received",
    source: "slack",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "c",
    sender: "owner",
    channel: "D1",
    content: "!cost",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

describe("!cost", () => {
  let db: Database.Database;
  const config = { timezone: "UTC" } as AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  it("registers one exact-match key per backend (!cost <backend>) alongside the bare !cost", () => {
    expect(costAllCommand.name).toBe("!cost");
    const names = costBackendCommands.map((c) => c.name);
    expect(names).toEqual([
      "!cost claude",
      "!cost codex",
      "!cost gemini",
      "!cost opencode",
    ]);
  });

  it("includes all billed actions within trailing 7 days regardless of result", async () => {
    insertAction(db, { backend: "claude", cost: 0.50, daysAgo: 1 });
    insertAction(db, { backend: "claude", cost: 0.30, daysAgo: 2 });
    insertAction(db, { backend: "codex", cost: 0.10, daysAgo: 3 });
    // outside window
    insertAction(db, { backend: "claude", cost: 1.00, daysAgo: 8 });
    // failed runs still cost money — must be included so the user sees
    // their actual spend, not just successful spend.
    insertAction(db, {
      backend: "claude",
      cost: 0.20,
      daysAgo: 1,
      result: "failed",
    });
    // rows with no recorded cost (e.g. skipped, gated) stay excluded.
    insertAction(db, {
      backend: "claude",
      cost: null,
      daysAgo: 1,
      result: "skipped",
    });

    const notify = vi.fn().mockResolvedValue(undefined);
    await costAllCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/^\[SYSTEM · !cost · last 7d\]/);
    expect(reply).toContain("Total: $1.10 (4 sessions)");
    expect(reply).toContain("- claude: $1.00 (3)");
    expect(reply).toContain("- codex: $0.10 (1)");
    expect(reply).not.toContain("$2.10");
  });

  it("empty window returns the 'No agent runs' reply", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await costAllCommand.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0]?.[0]).toContain(
      "No agent runs recorded with a billed cost.",
    );
  });

  it("!cost claude shows only claude rows", async () => {
    insertAction(db, { backend: "claude", cost: 0.5, daysAgo: 1 });
    insertAction(db, { backend: "codex", cost: 0.1, daysAgo: 1 });
    const claudeCmd = costBackendCommands.find((c) => c.name === "!cost claude")!;
    const notify = vi.fn().mockResolvedValue(undefined);
    await claudeCmd.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/^\[SYSTEM · !cost claude · last 7d\]\n\$0\.50 \(1 session\)/);
  });

  it("!cost <backend> with no rows for that backend reports zero", async () => {
    insertAction(db, { backend: "codex", cost: 0.2, daysAgo: 1 });
    const claudeCmd = costBackendCommands.find((c) => c.name === "!cost claude")!;
    const notify = vi.fn().mockResolvedValue(undefined);
    await claudeCmd.handler({
      event: makeEvent(),
      db,
      config,
      notify,
      audit: makeAudit(),
      registry: new BangCommandRegistry(),
    });
    expect(notify.mock.calls[0]?.[0]).toContain("$0.00 (0 sessions)");
    // Plural: only `1` is singular.
  });
});

describe("formatCostAll / formatCostFiltered (pure)", () => {
  it("formats multi-row totals", () => {
    const text = formatCostAll([
      { backend: "claude", cost_usd: 1.42, sessions: 37 },
      { backend: "codex", cost_usd: 0.08, sessions: 4 },
    ]);
    expect(text).toContain("Total: $1.50 (41 sessions)");
    expect(text).toContain("- claude: $1.42 (37)");
    expect(text).toContain("- codex: $0.08 (4)");
  });

  it("formats single-backend hit", () => {
    const text = formatCostFiltered("claude", [
      { backend: "claude", cost_usd: 1.42, sessions: 37 },
    ]);
    expect(text).toContain("$1.42 (37 sessions)");
  });

  it("uses singular 'session' for n=1", () => {
    const text = formatCostFiltered("claude", [
      { backend: "claude", cost_usd: 0.5, sessions: 1 },
    ]);
    expect(text).toContain("$0.50 (1 session)");
  });
});
