import { describe, expect, it } from "vitest";

import {
  buildRegeneralizationWorksheet,
  MIN_LESSONS_FOR_REGENERALIZATION,
  type RegeneralizationScopeInput,
} from "./regeneralization-prep.js";
import type { CanonicalScope } from "./scope-parser.js";

const NOW = "2026-06-07T00:00:00Z";
const DEFAULT_CAPS = { capBytes: 8192, maxEntries: 40 };

function lessonsFile(bullets: string[]): string {
  return [
    "---",
    "type: rule",
    "owner: agent",
    "updated: 2026-06-01",
    "---",
    "# Agent Lessons",
    "## Lessons",
    "<!-- scope: agent · cap: 8192B · 40 entries -->",
    ...bullets,
  ].join("\n");
}

function scope(
  over: Partial<RegeneralizationScopeInput> & { existingFileMd: string },
): RegeneralizationScopeInput {
  return {
    scope: { kind: "agent" } as CanonicalScope,
    storeFile: "policies/agent-lessons.md",
    caps: DEFAULT_CAPS,
    ...over,
  };
}

const TWO_LESSONS = [
  "- [2026-06-01] Lead with blockers. <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
  "- [2026-05-01] Keep it terse. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-05-01 -->",
];

describe("regeneralization-prep", () => {
  describe("buildRegeneralizationWorksheet", () => {
    it("returns null when no scopes are supplied", () => {
      expect(buildRegeneralizationWorksheet([], { nowIso: NOW })).toBeNull();
    });

    it("returns null when every scope holds fewer than the minimum lessons", () => {
      const single = scope({
        existingFileMd: lessonsFile([TWO_LESSONS[0]]),
      });
      const empty = scope({
        existingFileMd: "# Agent Lessons\n\n(no lessons section here)",
      });
      expect(
        buildRegeneralizationWorksheet([single, empty], { nowIso: NOW }),
      ).toBeNull();
    });

    it("requires at least two lessons to surface a scope (the collapse minimum)", () => {
      expect(MIN_LESSONS_FOR_REGENERALIZATION).toBe(2);
    });

    it("emits a scope with its lessons ranked lowest-score-first", () => {
      const result = buildRegeneralizationWorksheet(
        [scope({ existingFileMd: lessonsFile(TWO_LESSONS) })],
        { nowIso: NOW },
      );
      expect(result).not.toBeNull();
      expect(result!.scopeCount).toBe(1);
      expect(result!.lessonCount).toBe(2);
      const block = result!.block;
      expect(block).toContain(
        '<feedback_regeneralization generated_at="2026-06-07T00:00:00Z" scopes="1">',
      );
      expect(block).toContain(
        '<scope label="agent" store="policies/agent-lessons.md" section="lessons"',
      );
      expect(block.trimEnd().endsWith("</feedback_regeneralization>")).toBe(true);
      // "Keep it terse" (ev=2, older) scores below "Lead with blockers"
      // (ev=4, fresher) so it ranks first (drop-first).
      const rank1 = block.indexOf('rank="1"');
      const rank2 = block.indexOf('rank="2"');
      expect(rank1).toBeGreaterThan(-1);
      expect(rank2).toBeGreaterThan(rank1);
      expect(block.slice(rank1, rank2)).toContain("Keep it terse");
      expect(block.slice(rank2)).toContain("Lead with blockers");
    });

    it("flags over_cap when current bytes exceed the byte cap", () => {
      const result = buildRegeneralizationWorksheet(
        [
          scope({
            existingFileMd: lessonsFile(TWO_LESSONS),
            caps: { capBytes: 32, maxEntries: 40 },
          }),
        ],
        { nowIso: NOW },
      );
      expect(result!.block).toContain('over_cap="true"');
      expect(result!.block).toContain('cap_bytes="32"');
    });

    it("flags over_cap when entry count exceeds the entry cap", () => {
      const result = buildRegeneralizationWorksheet(
        [
          scope({
            existingFileMd: lessonsFile(TWO_LESSONS),
            caps: { capBytes: 8192, maxEntries: 1 },
          }),
        ],
        { nowIso: NOW },
      );
      expect(result!.block).toContain('over_cap="true"');
    });

    it("leaves over_cap false when within both caps", () => {
      const result = buildRegeneralizationWorksheet(
        [scope({ existingFileMd: lessonsFile(TWO_LESSONS) })],
        { nowIso: NOW },
      );
      expect(result!.block).toContain('over_cap="false"');
    });

    it("excludes provisional lessons from the collapse set (promotion-neutral)", () => {
      const result = buildRegeneralizationWorksheet(
        [
          scope({
            existingFileMd: lessonsFile([
              ...TWO_LESSONS,
              "- [2026-06-03] Tentative pattern. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-06-03 --> <!-- provisional -->",
            ]),
          }),
        ],
        { nowIso: NOW },
      );
      // Two active lessons surfaced; the provisional one is held, not shown.
      expect(result!.lessonCount).toBe(2);
      expect(result!.block).not.toContain("Tentative pattern");
      expect(result!.block).not.toContain('provisional="true"');
      // The scope still reports the whole-file state for the cap guard.
      expect(result!.block).toContain('current_entries="3"');
      expect(result!.block).toContain('provisional_held="1"');
    });

    it("does not surface a scope whose active lessons fall below the minimum", () => {
      // 1 active + 2 provisional → only 1 collapsible → below the minimum.
      const result = buildRegeneralizationWorksheet(
        [
          scope({
            existingFileMd: lessonsFile([
              TWO_LESSONS[0],
              "- [2026-06-03] Tentative one. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-06-03 --> <!-- provisional -->",
              "- [2026-06-04] Tentative two. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-06-04 --> <!-- provisional -->",
            ]),
          }),
        ],
        { nowIso: NOW },
      );
      expect(result).toBeNull();
    });

    it("flags stale lessons past the horizon but exempts constraints", () => {
      const bullets = [
        "- [2026-01-01] Old preference. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-01-01 -->",
        "- [2026-01-01] Durable rule. <!-- ev=2 kind=constraint src=explicit conf=high last=2026-01-01 -->",
      ];
      const result = buildRegeneralizationWorksheet(
        [scope({ existingFileMd: lessonsFile(bullets) })],
        { nowIso: NOW, staleDays: 60 },
      );
      const block = result!.block;
      // preference reinforced 2026-01-01 is > 60 days before 2026-06-07 → stale.
      const prefIdx = block.indexOf("Old preference");
      const constIdx = block.indexOf("Durable rule");
      expect(block.slice(0, prefIdx).lastIndexOf('stale="true"')).toBeGreaterThan(-1);
      // the constraint line carries stale="false" despite the same old date.
      const constLineStart = block.lastIndexOf("<lesson", constIdx);
      expect(block.slice(constLineStart, constIdx)).toContain('stale="false"');
    });

    it("never flags stale when no horizon is configured", () => {
      const bullets = [
        "- [2024-01-01] Ancient one. <!-- ev=2 kind=preference src=behavioral conf=medium last=2024-01-01 -->",
        "- [2024-01-01] Ancient two. <!-- ev=2 kind=preference src=behavioral conf=medium last=2024-01-01 -->",
      ];
      const result = buildRegeneralizationWorksheet(
        [scope({ existingFileMd: lessonsFile(bullets) })],
        { nowIso: NOW },
      );
      expect(result!.block).not.toContain('stale="true"');
    });

    it("emits multiple scopes in input order and sums their lessons", () => {
      const global = scope({ existingFileMd: lessonsFile(TWO_LESSONS) });
      const perAgent = scope({
        scope: { kind: "agent_slug", ref: "report-writer" } as CanonicalScope,
        storeFile: "policies/agents/report-writer/lessons.md",
        caps: { capBytes: 4096, maxEntries: 20 },
        existingFileMd: lessonsFile([
          "- [2026-06-01] Keep the budget section. <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-01 -->",
          "- [2026-06-02] Lead with the headline. <!-- ev=3 kind=do-more src=behavioral conf=high last=2026-06-02 -->",
          "- [2026-06-03] Cite the source row. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-06-03 -->",
        ]),
      });
      const result = buildRegeneralizationWorksheet([global, perAgent], {
        nowIso: NOW,
      });
      expect(result!.scopeCount).toBe(2);
      expect(result!.lessonCount).toBe(5);
      const globalIdx = result!.block.indexOf('label="agent"');
      const perAgentIdx = result!.block.indexOf('label="agent:report-writer"');
      expect(globalIdx).toBeGreaterThan(-1);
      expect(perAgentIdx).toBeGreaterThan(globalIdx);
      expect(result!.block).toContain(
        'store="policies/agents/report-writer/lessons.md"',
      );
    });

    it("xml-escapes special characters in labels and lesson prose", () => {
      const result = buildRegeneralizationWorksheet(
        [
          scope({
            existingFileMd: lessonsFile([
              '- [2026-06-01] Prefer A & B over <C> "always". <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-01 -->',
              "- [2026-06-02] Second lesson. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-02 -->",
            ]),
          }),
        ],
        { nowIso: NOW },
      );
      expect(result!.block).toContain("A &amp; B over &lt;C&gt; &quot;always&quot;");
      expect(result!.block).not.toContain("A & B over <C>");
    });

    it("clips overly long lesson prose to a bounded excerpt", () => {
      const long = "x".repeat(400);
      const result = buildRegeneralizationWorksheet(
        [
          scope({
            existingFileMd: lessonsFile([
              `- [2026-06-01] ${long} <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-01 -->`,
              "- [2026-06-02] Second lesson. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-02 -->",
            ]),
          }),
        ],
        { nowIso: NOW },
      );
      expect(result!.block).toContain("…");
      expect(result!.block).not.toContain("x".repeat(400));
    });

    it("honours a custom recency half-life without throwing", () => {
      const result = buildRegeneralizationWorksheet(
        [scope({ existingFileMd: lessonsFile(TWO_LESSONS) })],
        { nowIso: NOW, recencyHalfLifeDays: 7 },
      );
      expect(result!.scopeCount).toBe(1);
      expect(result!.block).toContain('score="');
    });
  });
});
