import { describe, expect, it } from "vitest";

import {
  extractMarkdownSection,
  formatLesson,
  formatLessonsSection,
  lessonsSectionByteLength,
  parseLessonsSection,
  type Lesson,
} from "./lesson-format.js";

const baseLesson: Lesson = {
  date: "2026-06-07",
  text: "Lead with blockers, not status, in standup summaries.",
  ev: 4,
  kind: "do-more",
  src: "behavioral",
  conf: "high",
  last: "2026-06-05",
  provisional: false,
};

describe("lesson-format", () => {
  describe("extractMarkdownSection", () => {
    const md = [
      "---",
      "type: rule",
      "---",
      "# Agent Lessons",
      "intro prose",
      "## Lessons",
      "- [2026-06-07] one",
      "- [2026-06-06] two",
      "## Other",
      "ignored",
    ].join("\n");

    it("returns the body between the header and the next heading", () => {
      expect(extractMarkdownSection(md, "Lessons")).toBe(
        "- [2026-06-07] one\n- [2026-06-06] two",
      );
    });

    it("returns null when the header is absent", () => {
      expect(extractMarkdownSection(md, "Nope")).toBeNull();
    });

    it("stops at an H1 heading too and tolerates CRLF", () => {
      const crlf = "## Lessons\r\n- [2026-06-07] x\r\n# Footer\r\nbye";
      expect(extractMarkdownSection(crlf, "Lessons")).toBe("- [2026-06-07] x");
    });
  });

  describe("parseLessonsSection", () => {
    it("returns [] for empty input", () => {
      expect(parseLessonsSection("")).toEqual([]);
    });

    it("parses a full trailer and strips comments from prose", () => {
      const body = [
        "<!-- scope: agent · cap: 8192B · 40 entries -->",
        "- [2026-06-07] Keep the budget section even when spend is flat.",
        "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
      ].join("\n");
      const [lesson] = parseLessonsSection(body);
      expect(lesson).toEqual<Lesson>({
        date: "2026-06-07",
        text: "Keep the budget section even when spend is flat.",
        ev: 2,
        kind: "correction",
        src: "explicit",
        conf: "high",
        last: "2026-06-07",
        provisional: false,
      });
    });

    it("applies defaults when the trailer is absent", () => {
      const [lesson] = parseLessonsSection("- [2026-05-01] No trailer here.");
      expect(lesson).toMatchObject({
        ev: 1,
        kind: "preference",
        src: "behavioral",
        conf: "low",
        last: "2026-05-01",
        provisional: false,
      });
    });

    it("captures the provisional marker", () => {
      const body =
        "- [2026-05-01] Maybe. <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->";
      const [lesson] = parseLessonsSection(body);
      expect(lesson.provisional).toBe(true);
    });

    it("coerces invalid enum + numeric attrs and a bad last date", () => {
      const body =
        "- [2026-05-01] X. <!-- ev=-3 kind=bogus src=alien conf=ultra last=not-a-date -->";
      const [lesson] = parseLessonsSection(body);
      expect(lesson).toMatchObject({
        ev: 1, // -3 is not > 0
        kind: "preference", // bogus → default
        src: "behavioral", // alien → default
        conf: "low", // ultra → default
        last: "2026-05-01", // bad date → falls back to leading date
      });
    });

    it("folds indented continuation lines into prose and ends on a blank line", () => {
      const body = [
        "- [2026-06-07] First line of the lesson",
        "  continues here.",
        "  <!-- ev=2 kind=do-more src=behavioral conf=medium last=2026-06-07 -->",
        "",
        "- [2026-06-06] Second lesson.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-06-06 -->",
      ].join("\n");
      const lessons = parseLessonsSection(body);
      expect(lessons).toHaveLength(2);
      expect(lessons[0].text).toBe("First line of the lesson continues here.");
      expect(lessons[0].ev).toBe(2);
      expect(lessons[1].text).toBe("Second lesson.");
    });

    it("ignores stray non-lesson lines before the first entry", () => {
      const body = ["random prose", "", "- [2026-06-07] real."].join("\n");
      const lessons = parseLessonsSection(body);
      expect(lessons).toHaveLength(1);
      expect(lessons[0].text).toBe("real.");
    });

    it("skips an eviction marker instead of folding it into the prior lesson", () => {
      // A re-read of a previously-evicted section must not absorb the marker
      // line into the last lesson's prose.
      const body = [
        "<!-- scope: agent · cap: 8192B · 40 entries -->",
        "- [2026-06-07] Lead with blockers.",
        "  <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
        "- [...2 lower-signal lessons omitted — full history in feedback_signals]",
      ].join("\n");
      const lessons = parseLessonsSection(body);
      expect(lessons).toHaveLength(1);
      expect(lessons[0].text).toBe("Lead with blockers.");
    });

    it("ignores trailer tokens with no value", () => {
      // `kind=` (empty value) and a bare `ev` token are both dropped.
      const body = "- [2026-05-01] X. <!-- ev kind= conf=medium -->";
      const [lesson] = parseLessonsSection(body);
      expect(lesson.ev).toBe(1);
      expect(lesson.kind).toBe("preference");
      expect(lesson.conf).toBe("medium");
    });
  });

  describe("formatLesson / formatLessonsSection", () => {
    it("renders a bullet with trailer", () => {
      expect(formatLesson(baseLesson)).toBe(
        "- [2026-06-07] Lead with blockers, not status, in standup summaries.\n" +
          "  <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
      );
    });

    it("appends the provisional marker", () => {
      const md = formatLesson({ ...baseLesson, provisional: true });
      expect(md).toContain("<!-- provisional -->");
    });

    it("round-trips through parse", () => {
      const md = formatLesson(baseLesson);
      const [parsed] = parseLessonsSection(md);
      expect(parsed).toEqual(baseLesson);
    });

    it("renders a section with header and optional omitted marker", () => {
      const withMarker = formatLessonsSection([baseLesson], {
        scopeLabel: "agent",
        capBytes: 8192,
        maxEntries: 40,
        omittedMarker: "- [...2 omitted]",
      });
      expect(withMarker).toContain(
        "<!-- scope: agent · cap: 8192B · 40 entries -->",
      );
      expect(withMarker).toContain("- [...2 omitted]");

      const withoutMarker = formatLessonsSection([baseLesson], {
        scopeLabel: "agent",
        capBytes: 8192,
        maxEntries: 40,
      });
      expect(withoutMarker).not.toContain("omitted");
    });
  });

  it("lessonsSectionByteLength measures the serialized section", () => {
    const bytes = lessonsSectionByteLength([baseLesson], {
      scopeLabel: "agent",
      capBytes: 8192,
      maxEntries: 40,
    });
    expect(bytes).toBe(
      Buffer.byteLength(
        formatLessonsSection([baseLesson], {
          scopeLabel: "agent",
          capBytes: 8192,
          maxEntries: 40,
        }),
        "utf-8",
      ),
    );
  });
});
