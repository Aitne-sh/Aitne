import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  getAgentDayBoundsUtc,
  parseSqliteUtcMs,
} from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import type { AgentConfig } from "../config.js";
import {
  buildAgentDayDmContext,
  buildYesterdayContext,
  truncateAgentLog,
} from "./context-builder-yesterday.js";

/**
 * Per-sibling test peer for `context-builder-yesterday.ts`. Pins the
 * SQLite query shape, the agent-day boundary anchoring, and the
 * cross-cutting formatting helpers without needing a ContextBuilder.
 *
 * Time-anchored seed rows always use bounds derived from
 * `getAgentDayBoundsUtc` so the tests don't drift when run near the
 * agent-day boundary.
 */
describe("context-builder-yesterday", () => {
  let db: Database.Database;
  let config: AgentConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    config = {
      dataDir: "/tmp/pa-yesterday-test",
      externalObsidianVaultPath: null,
      timezone: "UTC",
      dayBoundaryHour: 4,
    } as unknown as AgentConfig;
  });

  afterEach(() => {
    db.close();
  });

  function deps(): { db: Database.Database; config: AgentConfig } {
    return { db, config };
  }

  function previousAgentDayBounds(): { start: string; end: string } {
    return getAgentDayBoundsUtc(
      "UTC",
      4,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
  }

  function currentAgentDayBounds(): { start: string; end: string } {
    return getAgentDayBoundsUtc("UTC", 4);
  }

  function offsetIntoBounds(
    bounds: { start: string; end: string },
    hours: number,
  ): string {
    return new Date(parseSqliteUtcMs(bounds.start) + hours * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
  }

  describe("buildYesterdayContext", () => {
    it("renders three (none) stubs with Rows: 0 when the previous agent-day produced no rows", async () => {
      const result = await buildYesterdayContext(deps());
      expect(result.agentActions).toContain("Rows: 0");
      expect(result.agentActions).toContain("(none)");
      expect(result.messages).toContain("Rows: 0");
      expect(result.messages).toContain("(none)");
      expect(result.dmConversationLog).toContain("Rows: 0");
      expect(result.dmConversationLog).toContain("(none)");
    });

    it("anchors the bounds to the PREVIOUS agent-day — current-day rows must not bleed in", async () => {
      // Seed one row inside the previous agent-day and one inside the
      // current agent-day; only the first should appear.
      const prevBounds = previousAgentDayBounds();
      const curBounds = currentAgentDayBounds();
      const prevTs = offsetIntoBounds(prevBounds, 6);
      const curTs = offsetIntoBounds(curBounds, 1);

      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, started_at)
         VALUES ('routine.hourly_check', 'autonomous', 'success', ?)`,
      ).run(prevTs);
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, started_at)
         VALUES ('routine.evening_review', 'cron', 'success', ?)`,
      ).run(curTs);

      const result = await buildYesterdayContext(deps());

      expect(result.agentActions).toContain("routine.hourly_check");
      expect(result.agentActions).not.toContain("routine.evening_review");
    });

    it("renders agent_actions rows with [result] action_type (trigger) and error suffix when present", async () => {
      const prevBounds = previousAgentDayBounds();
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, started_at, error)
         VALUES ('routine.hourly_check', 'autonomous', 'failed', ?, ?)`,
      ).run(offsetIntoBounds(prevBounds, 2), "auth expired during MCP probe");

      const result = await buildYesterdayContext(deps());

      expect(result.agentActions).toContain("[failed] routine.hourly_check");
      expect(result.agentActions).toContain("(autonomous)");
      expect(result.agentActions).toContain(
        "error: auth expired during MCP probe",
      );
    });

    it("excludes role='system' messages from the yesterday_messages window", async () => {
      const prevBounds = previousAgentDayBounds();
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'user-line', 'slack', ?)`,
      ).run(offsetIntoBounds(prevBounds, 5));
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('system', 'system-internal-line', 'slack', ?)`,
      ).run(offsetIntoBounds(prevBounds, 6));

      const result = await buildYesterdayContext(deps());

      expect(result.messages).toContain("user-line");
      expect(result.messages).not.toContain("system-internal-line");
    });

    it("emits 'Showing latest N rows only' when the total exceeds the per-section limit", async () => {
      // YESTERDAY_MESSAGE_LIMIT is 60; seed 65 messages so the
      // truncation breadcrumb fires.
      const prevBounds = previousAgentDayBounds();
      const insert = db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', ?, 'slack', ?)`,
      );
      for (let i = 0; i < 65; i++) {
        insert.run(
          `msg-${String(i).padStart(3, "0")}`,
          offsetIntoBounds(prevBounds, 1 + i / 100),
        );
      }

      const result = await buildYesterdayContext(deps());

      expect(result.messages).toContain("Rows: 65");
      expect(result.messages).toContain("Showing latest 60 rows only");
    });

    it("formats dm_conversation_log rows with `(N msgs) summary`", async () => {
      const prevBounds = previousAgentDayBounds();
      db.prepare(
        `INSERT INTO dm_conversation_log
           (platform, scope, scope_key, summary, message_count, created_at)
           VALUES ('slack', 'owner_dm', 'owner', ?, 4, ?)`,
      ).run("Kyoto trip planning", offsetIntoBounds(prevBounds, 7));

      const result = await buildYesterdayContext(deps());

      expect(result.dmConversationLog).toContain("(4 msgs)");
      expect(result.dmConversationLog).toContain("Kyoto trip planning");
      expect(result.dmConversationLog).toContain("[slack:owner_dm/owner]");
    });
  });

  describe("buildAgentDayDmContext", () => {
    it("returns messages + dmConversationLog formatted strings (no agent_actions field)", () => {
      const result = buildAgentDayDmContext(deps());
      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("dmConversationLog");
      expect(result).not.toHaveProperty("agentActions");
    });

    it("anchors the window to the CURRENT agent-day (not the previous one)", () => {
      const prevBounds = previousAgentDayBounds();
      const curBounds = currentAgentDayBounds();
      // Previous-day row — must be EXCLUDED.
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'previous-day-msg', 'slack', ?)`,
      ).run(offsetIntoBounds(prevBounds, 6));
      // Current-day row — must be INCLUDED.
      db.prepare(
        `INSERT INTO messages (role, content, platform, timestamp)
         VALUES ('user', 'current-day-msg', 'slack', ?)`,
      ).run(offsetIntoBounds(curBounds, 1));

      const result = buildAgentDayDmContext(deps());

      expect(result.messages).toContain("current-day-msg");
      expect(result.messages).not.toContain("previous-day-msg");
    });

    it("renders a Rows: 0 / (none) stub when the current agent-day produced no DM activity", () => {
      const result = buildAgentDayDmContext(deps());
      expect(result.messages).toContain("Rows: 0");
      expect(result.messages).toContain("(none)");
      expect(result.dmConversationLog).toContain("Rows: 0");
      expect(result.dmConversationLog).toContain("(none)");
    });
  });

  describe("truncateAgentLog", () => {
    it("is a no-op when the ## Agent Log heading is absent", () => {
      const content = "# Today\n\nSome notes\n\n## Handoff\nbody\n";
      expect(truncateAgentLog(content, 5)).toBe(content);
    });

    it("is a no-op when the bullet count is at or under the limit", () => {
      const content = [
        "# Today",
        "",
        "## Agent Log",
        "- bullet one",
        "- bullet two",
        "- bullet three",
        "",
        "## Handoff",
        "wrap-up body",
      ].join("\n");
      expect(truncateAgentLog(content, 3)).toBe(content);
      expect(truncateAgentLog(content, 5)).toBe(content);
    });

    it("keeps only the last N bullets and inserts an omission marker pointing at /api/context/today", () => {
      const bullets = Array.from({ length: 6 }, (_, i) => `- bullet ${i + 1}`);
      const content = [
        "# Today",
        "",
        "## Agent Log",
        ...bullets,
        "",
        "## Handoff",
        "wrap-up body",
      ].join("\n");

      const out = truncateAgentLog(content, 2);

      expect(out).toContain("[...4 earlier entries omitted");
      expect(out).toContain("GET /api/context/today");
      // Last two bullets must survive.
      expect(out).toContain("- bullet 5");
      expect(out).toContain("- bullet 6");
      // First four bullets must be dropped.
      expect(out).not.toContain("- bullet 1");
      expect(out).not.toContain("- bullet 4");
      // Subsequent sections must be preserved unchanged.
      expect(out).toContain("## Handoff");
      expect(out).toContain("wrap-up body");
    });

    it("preserves the heading position relative to surrounding sections", () => {
      const content = [
        "# Today",
        "intro",
        "",
        "## Agent Log",
        "- a",
        "- b",
        "- c",
        "- d",
        "",
        "## Notes",
        "n1",
      ].join("\n");
      const out = truncateAgentLog(content, 2);
      const headingIdx = out.indexOf("## Agent Log");
      const notesIdx = out.indexOf("## Notes");
      expect(headingIdx).toBeGreaterThan(-1);
      expect(notesIdx).toBeGreaterThan(headingIdx);
    });
  });
});
