import { describe, expect, it } from "vitest";

import {
  CONF_CF_DEFAULTS,
  extractMarkdownSection,
  formatCfValue,
  formatLesson,
  formatLessonsSection,
  lessonCf,
  lessonsSectionByteLength,
  parseLessonsSection,
  roundCf,
  type Lesson,
} from "./lesson-format.js";

const baseLesson: Lesson = {
  date: "2026-06-07",
  text: "Lead with blockers, not status, in standup summaries.",
  ev: 4,
  kind: "do-more",
  src: "behavioral",
  conf: "high",
  cf: null,
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
        cf: null,
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

    it("ignores non-indented stray prose after an entry instead of folding it in", () => {
      // A hand-written note dropped between entries must NOT be absorbed into
      // the preceding lesson's prose — it would become an injectable standing
      // directive and get re-serialized permanently on the next consolidation.
      const body = [
        "- [2026-06-01] Keep it terse. <!-- ev=2 kind=preference src=explicit conf=high last=2026-06-01 -->",
        "TODO: review these next week",
        "- [2026-06-02] Second lesson.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-06-02 -->",
      ].join("\n");
      const lessons = parseLessonsSection(body);
      expect(lessons).toHaveLength(2);
      expect(lessons[0].text).toBe("Keep it terse.");
      expect(lessons[1].text).toBe("Second lesson.");
    });

    it("still folds a non-indented trailer comment on its own line", () => {
      const body = [
        "- [2026-06-01] Keep it terse.",
        "<!-- ev=3 kind=preference src=explicit conf=high last=2026-06-03 -->",
      ].join("\n");
      const [lesson] = parseLessonsSection(body);
      expect(lesson.text).toBe("Keep it terse.");
      expect(lesson.ev).toBe(3);
      expect(lesson.last).toBe("2026-06-03");
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

  describe("cf (SELF_IMPROVEMENT_PHASE2 §2.1)", () => {
    it("parses a valid cf and clamps out-of-range numerics into [0,1]", () => {
      const body = [
        "- [2026-06-07] a <!-- ev=2 kind=correction src=explicit conf=high cf=0.74 last=2026-06-07 -->",
        "- [2026-06-07] b <!-- ev=2 kind=correction src=explicit conf=high cf=1.7 last=2026-06-07 -->",
        "- [2026-06-07] c <!-- ev=2 kind=correction src=explicit conf=high cf=-0.2 last=2026-06-07 -->",
        "- [2026-06-07] d <!-- ev=2 kind=correction src=explicit conf=high cf=0.333 last=2026-06-07 -->",
      ].join("\n");
      const [a, b, c, d] = parseLessonsSection(body);
      expect(a.cf).toBe(0.74);
      expect(b.cf).toBe(1);
      expect(c.cf).toBe(0);
      expect(d.cf).toBe(0.33);
    });

    it("degrades a garbled cf to null instead of throwing", () => {
      const [lesson] = parseLessonsSection(
        "- [2026-06-07] x <!-- ev=2 kind=correction src=explicit conf=high cf=banana last=2026-06-07 -->",
      );
      expect(lesson.cf).toBeNull();
    });

    it("formats cf between conf and last, 2dp, and round-trips", () => {
      const withCf: Lesson = { ...baseLesson, cf: 0.7 };
      const md = formatLesson(withCf);
      expect(md).toContain("conf=high cf=0.70 last=2026-06-05");
      const [parsed] = parseLessonsSection(md);
      expect(parsed).toEqual(withCf);
    });

    it("omits cf when null so legacy files round-trip byte-stably", () => {
      expect(formatLesson(baseLesson)).not.toContain("cf=");
    });

    it("lessonCf reads the persisted cf or the conf default", () => {
      expect(lessonCf({ cf: 0.42, conf: "high" })).toBe(0.42);
      expect(lessonCf({ cf: null, conf: "high" })).toBe(CONF_CF_DEFAULTS.high);
      expect(lessonCf({ cf: null, conf: "medium" })).toBe(0.5);
      expect(lessonCf({ cf: null, conf: "low" })).toBe(0.3);
    });

    it("roundCf clamps and rounds to 2dp; formatCfValue pads", () => {
      expect(roundCf(1.2)).toBe(1);
      expect(roundCf(-3)).toBe(0);
      expect(roundCf(0.256)).toBe(0.26);
      expect(formatCfValue(1)).toBe("1.00");
      expect(formatCfValue(0.5)).toBe("0.50");
    });
  });
});
