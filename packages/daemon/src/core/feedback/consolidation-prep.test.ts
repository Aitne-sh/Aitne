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
      // Phase-2 §2.1 — every existing lesson surfaces its canonical cf (the
      // conf default for legacy trailers) and the note tells the LLM to
      // carry it verbatim.
      expect(block).toMatch(/<lesson rank="1"[^>]* cf="\d\.\d\d"/);
      expect(block).toContain("carry each lesson's cf= into its trailer verbatim");
      // Explicit correction promotes; the ignored-only signal holds. Both
      // candidates carry the §2.1 initial-confidence float.
      expect(block).toContain('decision="promote"');
      expect(block).toContain('conf="high"');
      expect(block).toContain('decision="hold-provisional"');
      expect(block).toContain('reason="ignored-non-initiating"');
      // explicit correction: weighted_ev 1.0 → saturate(1,2)=0.33 · 1.0
      expect(block).toContain('weighted_ev="1.00" cf0="0.33"');
      // ignored-only: weighted_ev 0.25 → saturate(0.25,2)≈0.11 · 0.7 ≈ 0.08
      expect(block).toContain('weighted_ev="0.25" cf0="0.08"');
      expect(block).toContain('<consume ids="11,12" />');
      expect(result!.signalIds).toEqual([11, 12]);
      expect(result!.scopeCount).toBe(1);
    });

    it("measures current_bytes against the ## Lessons section — the §6 cap unit", () => {
      // `current_bytes` and `over_cap` must share one unit: the on-disk
      // `## Lessons` section body, NOT the whole file. The whole-file measure
      // contradicted `over_cap` (derived from the section-serialized
      // `enforceCaps`) in the band where the section fit the cap but the
      // frontmatter + heading overhead pushed the file past it.
      const sectionBytes = Buffer.byteLength(
        AGENT_LESSONS_FILE.split("## Lessons\n")[1],
        "utf-8",
      );
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [row({ id: 31, summary: "any" })],
            existingFileMd: AGENT_LESSONS_FILE,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        opts,
      );
      const block = result!.block;
      expect(block).toContain(`current_bytes="${sectionBytes}"`);
      expect(sectionBytes).toBeLessThan(
        Buffer.byteLength(AGENT_LESSONS_FILE, "utf-8"),
      );
      expect(block).toContain('over_cap="false"');
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

    it("emits §2.3 action verdicts (keep / demote) alongside stale", () => {
      const file = [
        "# Agent Lessons",
        "## Lessons",
        // Stale + conf medium (cf default 0.5) decayed over ~157d ≈ 0.045
        // < 0.25 floor → demote.
        "- [2026-01-01] Old do-more. <!-- ev=2 kind=do-more src=behavioral conf=medium last=2026-01-01 -->",
        "- [2026-06-05] Fresh pref. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-05 -->",
        "- [2026-01-01] Hard rule. <!-- ev=2 kind=constraint src=explicit conf=high last=2026-01-01 -->",
      ].join("\n");
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [row({ id: 72, summary: "anything" })],
            existingFileMd: file,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        {
          promotionThreshold: 2,
          nowIso: NOW,
          staleDays: 60,
          confidenceFloor: 0.25,
        },
      );
      const lines = result!.block.split("\n");
      const lesson = (needle: string): string =>
        lines.find((l) => l.includes("<lesson") && l.includes(needle))!;
      expect(lesson("Old do-more")).toContain('action="demote"');
      expect(lesson("Fresh pref")).toContain('action="keep"');
      expect(lesson("Hard rule")).toContain('action="keep"');
    });

    it("renders a would-be repromote verdict as advisory keep (prep cannot judge corroboration)", () => {
      const file = [
        "# Agent Lessons",
        "## Lessons",
        // provisional, corroborated at today (last == NOW date) with ev at
        // the threshold — the normalizer would repromote; the worksheet
        // stays advisory and renders keep.
        "- [2026-06-01] Provisional corroborated today. <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-06-07 --> <!-- provisional -->",
      ].join("\n");
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [row({ id: 73, summary: "anything" })],
            existingFileMd: file,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        {
          promotionThreshold: 2,
          nowIso: NOW,
          staleDays: 60,
          confidenceFloor: 0.25,
        },
      );
      const line = result!.block
        .split("\n")
        .find((l) => l.includes("Provisional corroborated today"))!;
      expect(line).toContain('action="keep"');
      expect(line).toContain('provisional="true"');
    });

    it("holds a contradicting candidate (§2.2) and surfaces contradicts_ranks", () => {
      const file = [
        "# Agent Lessons",
        "## Lessons",
        "- [2026-06-01] Include the budget section in the weekly report. <!-- ev=4 kind=do-more src=explicit conf=high cf=0.90 last=2026-06-05 -->",
      ].join("\n");
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [
              // behavioral+self_critique corroboration reaching the plain
              // threshold (0.5 + 0.5 + 0.5 + 0.5 = 2.0) but NOT the 1.5×
              // anti-whiplash bar (1.5 · 2 · 0.9 = 2.7).
              row({ id: 81, source: "self_critique", valence: "negative", summary: "Stop including the budget section in the weekly report" }),
              row({ id: 82, source: "self_critique", valence: "negative", summary: "Stop including the budget section in the weekly report" }),
              row({ id: 83, source: "behavioral", valence: "positive", summary: "Stop including the budget section in the weekly report" }),
              row({ id: 84, source: "behavioral", valence: "positive", summary: "Stop including the budget section in the weekly report" }),
            ],
            existingFileMd: file,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        {
          promotionThreshold: 2,
          nowIso: NOW,
          contradictionGuardCf: 0.6,
        },
      );
      const block = result!.block;
      expect(block).toContain('decision="hold-contradiction"');
      expect(block).toContain('contradicts_ranks="1"');
      expect(block).toContain('reason="contradiction"');
    });

    it("an explicit correction bypasses the contradiction guard", () => {
      const file = [
        "# Agent Lessons",
        "## Lessons",
        "- [2026-06-01] Include the budget section in the weekly report. <!-- ev=4 kind=do-more src=explicit conf=high cf=0.90 last=2026-06-05 -->",
      ].join("\n");
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [
              row({
                id: 85,
                source: "explicit",
                valence: "correction",
                summary: "Stop including the budget section in the weekly report",
              }),
            ],
            existingFileMd: file,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        { promotionThreshold: 2, nowIso: NOW, contradictionGuardCf: 0.6 },
      );
      const block = result!.block;
      expect(block).toContain('decision="promote"');
      // The pairing is still surfaced so the LLM adjudicates supersede/merge.
      expect(block).toContain('contradicts_ranks="1"');
    });

    it("rides the outcome rollup between the scopes and the consume set", () => {
      const rollup =
        '  <outcome_rollup window_days="7" note="test">\n' +
        '    <type name="reminder" sent="2" replied="1" corrected="1" ignored="0" correction_rate="0.50" />\n' +
        "  </outcome_rollup>";
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [row({ id: 91, summary: "anything" })],
            existingFileMd: null,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        { promotionThreshold: 2, nowIso: NOW, outcomeRollupXml: rollup },
      );
      const block = result!.block;
      expect(block).toContain("<outcome_rollup");
      expect(block.indexOf("<outcome_rollup")).toBeGreaterThan(
        block.indexOf("</scope>"),
      );
      expect(block.indexOf("<outcome_rollup")).toBeLessThan(
        block.indexOf("<consume"),
      );
      // Absent when not supplied.
      const without = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "agent" },
            signals: [row({ id: 92, summary: "anything" })],
            existingFileMd: null,
            caps: { capBytes: 8192, maxEntries: 40 },
          },
        ],
        { promotionThreshold: 2, nowIso: NOW, outcomeRollupXml: null },
      );
      expect(without!.block).not.toContain("<outcome_rollup");
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

    it("does not split a surrogate pair at the truncation boundary", () => {
      // 298 chars then an astral emoji: the 299-char clip would otherwise cut
      // between the surrogate halves and leave a lone \uD83C in the block.
      const summary = `${"y".repeat(298)}🎉 and more text past the cap`;
      const result = buildFeedbackWorksheet(
        [
          {
            scope: { kind: "user" },
            signals: [row({ id: 51, scope_type: "user", summary })],
            existingFileMd: null,
            caps: null,
          },
        ],
        opts,
      );
      const block = result!.block;
      expect(block).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      // UTF-8 round-trip is lossless — no U+FFFD replacement chars appear.
      expect(Buffer.from(block, "utf-8").toString("utf-8")).toBe(block);
      expect(block).not.toContain("�");
    });
  });
});
