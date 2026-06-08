import { describe, expect, it } from "vitest";

import { summarizeLessonStore } from "./lesson-store-overview.js";

const CAPS = { capBytes: 8192, maxEntries: 40 };

function file(bullets: string[]): string {
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

describe("lesson-store-overview", () => {
  describe("summarizeLessonStore", () => {
    it("counts active and provisional lessons separately", () => {
      const md = file([
        "- [2026-06-01] Lead with blockers. <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
        "- [2026-05-01] Keep it terse. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
      ]);
      const summary = summarizeLessonStore(md, CAPS);
      expect(summary.entries).toBe(2);
      expect(summary.active).toBe(1);
      expect(summary.provisional).toBe(1);
      expect(summary.bytes).toBe(Buffer.byteLength(md, "utf-8"));
      expect(summary.capBytes).toBe(8192);
      expect(summary.maxEntries).toBe(40);
      expect(summary.overCap).toBe(false);
    });

    it("reports an empty store when there is no Lessons section", () => {
      const summary = summarizeLessonStore(
        "# Agent Lessons\n\nnothing here yet",
        CAPS,
      );
      expect(summary.entries).toBe(0);
      expect(summary.active).toBe(0);
      expect(summary.provisional).toBe(0);
      expect(summary.overCap).toBe(false);
    });

    it("reports an empty store for an empty Lessons section body", () => {
      const summary = summarizeLessonStore(
        "# Agent Lessons\n## Lessons\n",
        CAPS,
      );
      expect(summary.entries).toBe(0);
    });

    it("flags overCap when the file exceeds the byte cap", () => {
      const md = file([
        "- [2026-06-01] Lead with blockers. <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
      ]);
      const summary = summarizeLessonStore(md, { capBytes: 16, maxEntries: 40 });
      expect(summary.overCap).toBe(true);
      expect(summary.capBytes).toBe(16);
    });

    it("flags overCap when the file exceeds the entry cap", () => {
      const md = file([
        "- [2026-06-01] One. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-01 -->",
        "- [2026-06-02] Two. <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-02 -->",
      ]);
      const summary = summarizeLessonStore(md, { capBytes: 8192, maxEntries: 1 });
      expect(summary.overCap).toBe(true);
      expect(summary.entries).toBe(2);
    });
  });
});
