import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applySchema } from "../../db/schema.js";
import {
  recordFeedbackSignal,
  type FeedbackSignalRow,
} from "../../db/feedback-signals-store.js";
import {
  buildFeedbackWorksheet,
  gatherFeedbackWorksheetScopes,
  GLOBAL_LESSON_ENTRY_CAP,
  lessonCapsForScope,
  PER_AGENT_LESSON_ENTRY_CAP,
  type WorksheetScopeInput,
} from "./consolidation-prep.js";

const NOW = "2026-06-07T00:00:00Z";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function row(
  over: Partial<FeedbackSignalRow> & { id: number; summary: string },
): FeedbackSignalRow {
  return {
    created_at: "2026-06-07 00:00:00",
    source: "behavioral",
    valence: null,
    scope_type: "agent",
    scope_ref: null,
    action_kind: null,
    action_ref: null,
    agent_id: null,
    evidence_json: "{}",
    consumed_at: null,
    lesson_ref: null,
    ...over,
  };
}

const AGENT_LESSONS_FILE = [
  "---",
  "type: rule",
  "owner: agent",
  "updated: 2026-06-01",
  "---",
  "# Agent Lessons",
  "## Lessons",
  "<!-- scope: agent · cap: 8192B · 40 entries -->",
  "- [2026-06-01] Lead with blockers. <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
  "- [2026-05-01] Keep it terse. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-05-01 -->",
].join("\n");

describe("consolidation-prep", () => {
  describe("gatherFeedbackWorksheetScopes", () => {
    it("groups requested scopes, preserves order, and excludes others", () => {
      const db = makeDb();
      recordFeedbackSignal(db, {
        source: "explicit",
        valence: "correction",
        scopeType: "user",
        summary: "Prefers metric units",
      });
      recordFeedbackSignal(db, {
        source: "behavioral",
        valence: "positive",
        scopeType: "agent",
        summary: "Owner responded to notification",
      });
      recordFeedbackSignal(db, {
        source: "explicit",
        valence: "correction",
        scopeType: "agent_slug",
        scopeRef: "report-writer",
        agentId: "report-writer",
        summary: "Keep the budget section",
      });

      const groups = gatherFeedbackWorksheetScopes(db, {
        scopeTypes: ["user", "agent"],
      });
      expect(groups.map((g) => g.scope.kind)).toEqual(["user", "agent"]);
      expect(groups[0].signals).toHaveLength(1);
      expect(groups[1].signals).toHaveLength(1);
    });

    it("skips rows whose scope cannot be parsed", () => {
      const db = makeDb();
      // agent_slug with no ref → parseScope returns null → dropped.
      recordFeedbackSignal(db, {
        source: "explicit",
        valence: "correction",
        scopeType: "agent_slug",
        scopeRef: null,
        summary: "orphaned",
      });
      const groups = gatherFeedbackWorksheetScopes(db, {
        scopeTypes: ["agent_slug"],
      });
      expect(groups).toEqual([]);
    });

    it("respects the limit", () => {
      const db = makeDb();
      for (let i = 0; i < 3; i++) {
        recordFeedbackSignal(db, {
          source: "behavioral",
          valence: "positive",
          scopeType: "agent",
          summary: `signal ${i}`,
        });
      }
      const groups = gatherFeedbackWorksheetScopes(db, {
        scopeTypes: ["agent"],
        limit: 2,
      });
      const total = groups.reduce((n, g) => n + g.signals.length, 0);
      expect(total).toBe(2);
    });

    it("does not let an older agent_slug backlog starve the agent scope", () => {
      // agent_slug rows are written by the behavioral sink but not consolidated
      // until Phase 4. With a single global LIMIT over created_at ASC they would
      // occupy the oldest-N window and silently starve the agent scope; the
      // per-scope-type query keeps each type's budget independent.
      const db = makeDb();
      for (let i = 0; i < 3; i++) {
        recordFeedbackSignal(db, {
          source: "behavioral",
          valence: "neutral",
          scopeType: "agent_slug",
          scopeRef: "report-writer",
          agentId: "report-writer",
          summary: `slug backlog ${i}`,
        });
      }
      recordFeedbackSignal(db, {
        source: "behavioral",
        valence: "positive",
        scopeType: "agent",
        summary: "owner responded to a notification",
      });
      const groups = gatherFeedbackWorksheetScopes(db, {
        scopeTypes: ["user", "agent"],
        limit: 2, // smaller than the agent_slug backlog
      });
      expect(groups.map((g) => g.scope.kind)).toEqual(["agent"]);
      expect(groups[0].signals).toHaveLength(1);
    });
  });

  describe("lessonCapsForScope", () => {
    const byteCaps = { global: 8192, perAgent: 4096 };
    it("resolves caps for stored lessons scopes", () => {
      expect(lessonCapsForScope({ kind: "agent" }, byteCaps)).toEqual({
        capBytes: 8192,
        maxEntries: GLOBAL_LESSON_ENTRY_CAP,
      });
      expect(
        lessonCapsForScope({ kind: "agent_slug", ref: "x" }, byteCaps),
      ).toEqual({
        capBytes: 4096,
        maxEntries: PER_AGENT_LESSON_ENTRY_CAP,
      });
    });
    it("returns null for raw / unstored scopes", () => {
      expect(lessonCapsForScope({ kind: "user" }, byteCaps)).toBeNull();
      expect(
        lessonCapsForScope({ kind: "channel", ref: "slack" }, byteCaps),
      ).toBeNull();
    });
  });

  describe("buildFeedbackWorksheet", () => {
    const opts = { promotionThreshold: 2, nowIso: NOW };

    it("returns null when there are no signals", () => {
      expect(buildFeedbackWorksheet([], opts)).toBeNull();
      expect(
        buildFeedbackWorksheet(
          [
            {
              scope: { kind: "agent" },
              signals: [],
              existingFileMd: null,
              caps: { capBytes: 8192, maxEntries: 40 },
            },
          ],
          opts,
        ),
      ).toBeNull();
    });

    it("renders a lessons scope over cap with ranked existing lessons + verdicts", () => {
      const scope: WorksheetScopeInput = {
        scope: { kind: "agent" },
        signals: [
          row({
            id: 11,
            source: "explicit",
            valence: "correction",
            summary: "Keep the budget section",
          }),
          row({
            id: 12,
            source: "behavioral",
            valence: "neutral",
            summary: "Owner did not respond to a github PR alert",
          }),
        ],
        existingFileMd: AGENT_LESSONS_FILE,
        caps: { capBytes: 50, maxEntries: 40 }, // tiny → already over cap
      };
      const result = buildFeedbackWorksheet([scope], opts);
      expect(result).not.toBeNull();
      const block = result!.block;
      expect(block).toContain('<feedback_worksheet generated_at="');
      expect(block).toContain('promotion_threshold="2"');
      expect(block).toContain('<scope label="agent"');
      expect(block).toContain('store="policies/agent-lessons.md"');
      expect(block).toContain('section="lessons"');
      expect(block).toContain('mode="lessons"');
      expect(block).toContain('over_cap="true"');
      expect(block).toContain("<existing_lessons");
      expect(block).toContain('<lesson rank="1"');
      expect(block).toContain('<lesson rank="2"');
      // Explicit correction promotes; the ignored-only signal holds.
      expect(block).toContain('decision="promote"');
      expect(block).toContain('conf="high"');
      expect(block).toContain('decision="hold-provisional"');
      expect(block).toContain('reason="ignored-non-initiating"');
      expect(block).toContain('<consume ids="11,12" />');
      expect(result!.signalIds).toEqual([11, 12]);
      expect(result!.scopeCount).toBe(1);
    });

    it("renders a lessons scope with no existing file (empty store)", () => {
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [
              row({
                id: 21,
                source: "self_critique",
                valence: "positive",
                summary: "Over-notified about minor calendar changes",
              }),
            ],
            existingFileMd: null,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        opts,
      );
      const block = result!.block;
      expect(block).toContain('current_bytes="0"');
      expect(block).toContain('current_entries="0"');
      expect(block).not.toContain("<existing_lessons");
    });

    it("surfaces a candidate's dominant src + stated kind for the trailer", () => {
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [
              // distinct summaries → one candidate each, exercising every
              // evidence_json branch: null, malformed, and a valid stated kind.
              row({
                id: 61,
                source: "behavioral",
                valence: "neutral",
                summary: "no evidence",
                evidence_json: null,
              }),
              row({
                id: 62,
                source: "behavioral",
                valence: "positive",
                summary: "malformed evidence",
                evidence_json: "not json",
              }),
              row({
                id: 63,
                source: "self_critique",
                valence: "positive",
                summary: "stated kind wins",
                evidence_json: JSON.stringify({ kind: "do-less" }),
              }),
              row({
                id: 64,
                source: "behavioral",
                valence: "positive",
                summary: "invalid stated kind",
                evidence_json: JSON.stringify({ kind: "bogus" }),
              }),
            ],
            existingFileMd: null,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        opts,
      );
      const lines = result!.block.split("\n");
      const c63 = lines.find((l) => l.includes('ids="63"'))!;
      // self_critique outranks behavioral; its stated evidence kind surfaces.
      expect(c63).toContain('src="self_critique"');
      expect(c63).toContain('kind="do-less"');
      // The behavioral candidates carry src but no kind attribute (none known —
      // exercises the null + malformed evidence_json branches).
      const c61 = lines.find((l) => l.includes('ids="61"'))!;
      const c62 = lines.find((l) => l.includes('ids="62"'))!;
      const c64 = lines.find((l) => l.includes('ids="64"'))!;
      expect(c61).toContain('src="behavioral"');
      expect(c61).not.toContain("kind=");
      expect(c62).not.toContain("kind=");
      // A stated-but-invalid kind string is dropped, not echoed.
      expect(c64).not.toContain("kind=");
    });

    it("flags stale non-constraint lessons and exempts constraints", () => {
      const file = [
        "# Agent Lessons",
        "## Lessons",
        "- [2026-01-01] Old do-more. <!-- ev=2 kind=do-more src=behavioral conf=medium last=2026-01-01 -->",
        "- [2026-06-05] Fresh pref. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-05 -->",
        "- [2026-01-01] Hard rule. <!-- ev=2 kind=constraint src=explicit conf=high last=2026-01-01 -->",
      ].join("\n");
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [row({ id: 71, summary: "anything" })],
            existingFileMd: file,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        { promotionThreshold: 2, nowIso: NOW, staleDays: 60 },
      );
      const lines = result!.block.split("\n");
      const lesson = (needle: string): string =>
        lines.find((l) => l.includes("<lesson") && l.includes(needle))!;
      // Old non-constraint → past the 60-day horizon → stale.
      expect(lesson("Old do-more")).toContain('stale="true"');
      // Reinforced two days ago → fresh.
      expect(lesson("Fresh pref")).toContain('stale="false"');
      // Old, but a constraint is durable → never stale-pruned.
      expect(lesson("Hard rule")).toContain('stale="false"');
    });

    it("renders a raw (user) scope as candidates without a verdict", () => {
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "user" },
            signals: [
              row({
                id: 31,
                scope_type: "user",
                source: "explicit",
                valence: "neutral",
                summary: "Prefers metric units",
              }),
            ],
            existingFileMd: null,
            caps: null,
          },
        ],
        opts,
      );
      const block = result!.block;
      expect(block).toContain('<scope label="user"');
      expect(block).toContain('mode="raw"');
      expect(block).toContain('section="learned_context"');
      expect(block).toContain('<candidate signals="1" ids="31">');
      expect(block).not.toContain('decision=');
    });

    it("renders a v2 channel scope (not yet stored) with an empty store attr", () => {
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "channel", ref: "slack" },
            signals: [
              row({ id: 51, scope_type: "channel", scope_ref: "slack", summary: "noisy on slack" }),
            ],
            existingFileMd: null,
            caps: null,
          },
        ],
        opts,
      );
      const block = result!.block;
      expect(block).toContain('<scope label="channel:slack"');
      expect(block).toContain('store=""');
    });

    it("xml-escapes and truncates long candidate text", () => {
      const longSummary = `start ${"x".repeat(400)} end`;
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "user" },
            signals: [
              row({ id: 41, scope_type: "user", summary: '<b> & "q"' }),
              row({ id: 42, scope_type: "user", summary: longSummary }),
            ],
            existingFileMd: null,
            caps: null,
          },
        ],
        opts,
      );
      const block = result!.block;
      expect(block).toContain("&lt;b&gt; &amp; &quot;q&quot;");
      expect(block).toContain("…"); // truncated long text
    });
  });
});
