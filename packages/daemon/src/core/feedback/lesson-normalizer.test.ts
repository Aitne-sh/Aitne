import { describe, expect, it } from "vitest";

import {
  CORROBORATION_GAMMA,
  expirationVerdict,
  normalizeLessonsFileContent,
  type LessonNormalizerOptions,
} from "./lesson-normalizer.js";
import { parseLessonsSection, type Lesson } from "./lesson-format.js";
import { computeInitialCf } from "./promotion-gate.js";

const NOW = "2026-07-01T18:00:00.000Z";

const baseOpts: LessonNormalizerOptions = {
  nowIso: NOW,
  promotionThreshold: 2,
};

function fileWith(sectionLines: string[]): string {
  return [
    "---",
    "type: rule",
    "owner: agent",
    "updated: 2026-07-01",
    "---",
    "# Agent Lessons",
    "",
    "## Lessons",
    "<!-- scope: agent · cap: 8192B · 40 entries -->",
    ...sectionLines,
    "",
    "## Notes",
    "untouched prose",
  ].join("\n");
}

function lessonsOf(content: string): Lesson[] {
  const start = content.indexOf("## Lessons");
  const end = content.indexOf("## Notes");
  return parseLessonsSection(content.slice(start + "## Lessons".length, end));
}

describe("normalizeLessonsFileContent — cf stamping", () => {
  it("passes through content without a ## Lessons section", () => {
    const md = "# Nothing\n\njust prose";
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    expect(result.content).toBe(md);
    expect(result.changed).toBe(false);
    expect(result.stats.total).toBe(0);
  });

  it("passes through a section with no entries", () => {
    const md = fileWith([]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    expect(result.changed).toBe(false);
  });

  it("derives cf0 for a new bullet without cf (§2.1 initial model)", () => {
    const md = fileWith([
      "- [2026-07-01] Keep the budget section in the weekly report.",
      "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(computeInitialCf(2, "explicit", 2));
    expect(result.changed).toBe(true);
    expect(result.stats).toMatchObject({ total: 1, derived: 1 });
  });

  it("keeps a transcribed cf on a new bullet (worksheet cf0 copy)", () => {
    const md = fileWith([
      "- [2026-07-01] New directive.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.42 last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.42);
    expect(result.stats.transcribed).toBe(1);
  });

  it("caps a transcribed cf at the source factor (anti-hallucination ceiling)", () => {
    // cf0 = saturate(<1)·sourceFactor can never exceed the factor itself —
    // a hallucinated 0.99 on a behavioral bullet clamps to 0.7.
    const md = fileWith([
      "- [2026-07-01] Overclaimed directive.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.99 last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.7);
    // An explicit-source bullet has factor 1.0 — the cap is a no-op there.
    const explicit = fileWith([
      "- [2026-07-01] Explicit overclaim.",
      "  <!-- ev=1 kind=correction src=explicit conf=high cf=0.99 last=2026-07-01 -->",
    ]);
    const [kept] = lessonsOf(
      normalizeLessonsFileContent(explicit, null, baseOpts).content,
    );
    expect(kept.cf).toBe(0.99);
  });

  it("carries cf forward for an unchanged bullet (idempotent)", () => {
    const prev = fileWith([
      "- [2026-06-01] Stable directive.",
      "  <!-- ev=3 kind=do-more src=behavioral conf=medium cf=0.61 last=2026-06-20 -->",
    ]);
    const result = normalizeLessonsFileContent(prev, prev, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.61);
    expect(result.changed).toBe(false);
    expect(result.stats.carried).toBe(1);

    const again = normalizeLessonsFileContent(result.content, result.content, baseOpts);
    expect(again.content).toBe(result.content);
    expect(again.changed).toBe(false);
  });

  it("bumps a corroborated carry toward 1 (cf ← cf + (1−cf)·γ)", () => {
    const prev = fileWith([
      "- [2026-06-01] Reinforced directive.",
      "  <!-- ev=2 kind=do-more src=behavioral conf=medium cf=0.50 last=2026-06-20 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Reinforced directive.",
      "  <!-- ev=3 kind=do-more src=behavioral conf=medium cf=0.50 last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.5 + (1 - 0.5) * CORROBORATION_GAMMA);
    expect(result.stats.bumped).toBe(1);
  });

  it("bumps when only last advanced (reworded trailer kept ev)", () => {
    const prev = fileWith([
      "- [2026-06-01] Same text either way.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.40 last=2026-06-01 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Same text either way.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.40 last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, baseOpts);
    expect(result.stats.bumped).toBe(1);
  });

  it("backfills a legacy bullet (no cf before or after) with the conf default", () => {
    const legacy = fileWith([
      "- [2026-06-01] Legacy directive.",
      "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-20 -->",
    ]);
    const result = normalizeLessonsFileContent(legacy, legacy, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.8);
    expect(result.stats.backfilled).toBe(1);
    expect(result.changed).toBe(true);
  });

  it("bumps from the conf default when a legacy bullet was corroborated", () => {
    const prev = fileWith([
      "- [2026-06-01] Legacy corroborated.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium last=2026-06-01 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Legacy corroborated.",
      "  <!-- ev=3 kind=preference src=behavioral conf=medium last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.5 + (1 - 0.5) * CORROBORATION_GAMMA);
  });

  it("prefers the previous cf over a transcribed one for a matched bullet", () => {
    const prev = fileWith([
      "- [2026-06-01] Deterministic wins.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.55 last=2026-06-20 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Deterministic wins.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.99 last=2026-06-20 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(0.55);
  });

  it("appends a trailer line for a hand-written bullet without one", () => {
    const md = fileWith(["- [2026-07-01] Hand-written, no trailer."]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.cf).toBe(computeInitialCf(1, "behavioral", 2));
    expect(result.content).toContain(
      "- [2026-07-01] Hand-written, no trailer.\n  <!-- ev=1 kind=preference src=behavioral conf=low cf=",
    );
  });

  it("preserves prose, provisional markers, scope header, and other sections byte-for-byte", () => {
    const md = fileWith([
      "- [2026-07-01] Multi-line prose lesson",
      "  continued on a second line.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-07-01 --> <!-- provisional -->",
      "- [...2 lower-signal lessons omitted — full history in feedback_signals]",
    ]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    expect(result.content).toContain("  continued on a second line.");
    expect(result.content).toContain("<!-- provisional -->");
    expect(result.content).toContain("<!-- scope: agent · cap: 8192B · 40 entries -->");
    expect(result.content).toContain("- [...2 lower-signal lessons omitted");
    expect(result.content).toContain("## Notes\nuntouched prose");
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(true);
    expect(lesson.cf).not.toBeNull();
  });

  it("rewrites the LAST attr comment so a duplicated stale trailer cannot win the parse", () => {
    const md = fileWith([
      "- [2026-07-01] Duplicate trailers.",
      "  <!-- ev=9 kind=constraint src=explicit conf=high last=2026-01-01 -->",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    const [lesson] = lessonsOf(result.content);
    // Parse merges in document order — the (rewritten) last comment wins.
    expect(lesson.cf).not.toBeNull();
    expect(lesson.ev).toBe(1);
    expect(lesson.kind).toBe("preference");
  });

  it("does not treat a duplicated bullet as fresh corroboration (prev is deduped)", () => {
    const prev = fileWith([
      "- [2026-06-01] Doubled up.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-06-01 -->",
      "- [2026-06-01] Doubled up.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-06-01 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Doubled up.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-06-01 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, baseOpts);
    // Deduped prev ev=4 > written ev=2 → not corroborated → plain carry.
    expect(result.stats.carried).toBe(1);
    expect(result.stats.bumped).toBe(0);
  });

  it("preserves CRLF line endings", () => {
    const md = fileWith([
      "- [2026-07-01] CRLF lesson.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-07-01 -->",
    ]).replace(/\n/g, "\r\n");
    const result = normalizeLessonsFileContent(md, null, baseOpts);
    expect(result.content).toContain("\r\n");
    expect(result.content).not.toMatch(/[^\r]\n/);
  });
});

describe("normalizeLessonsFileContent — Gate 3 expiration", () => {
  const gateOpts: LessonNormalizerOptions = {
    ...baseOpts,
    enactExpiration: true,
    staleDays: 60,
    confidenceFloor: 0.25,
  };

  it("demotes a stale active lesson whose effective cf is below the floor", () => {
    // last 2026-03-01 = ~122 days before NOW → stale (>60) and decayed
    // (0.5^(122/45) ≈ 0.153): cf 0.5 → effective ≈ 0.076 < 0.25.
    const md = fileWith([
      "- [2026-02-01] Stale weak directive.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-03-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(true);
    expect(result.stats.demoted).toBe(1);
  });

  it("keeps a stale lesson whose effective cf clears the floor", () => {
    // last 2026-04-25 = ~67 days → stale, decay ≈ 0.357: cf 0.9 → ≈ 0.32 ≥ 0.25.
    const md = fileWith([
      "- [2026-02-01] Stale but confident.",
      "  <!-- ev=6 kind=do-more src=explicit conf=high cf=0.90 last=2026-04-25 -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(false);
    expect(result.stats.demoted).toBe(0);
  });

  it("never demotes a constraint no matter how stale", () => {
    const md = fileWith([
      "- [2025-01-01] Never do X.",
      "  <!-- ev=1 kind=constraint src=explicit conf=high cf=0.10 last=2025-01-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(false);
    expect(result.stats.demoted).toBe(0);
  });

  it("archives a provisional lesson uncorroborated for 2× staleDays", () => {
    // last 2026-02-01 = ~150 days > 120 (2×60).
    const md = fileWith([
      "- [2026-01-01] Abandoned provisional.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.20 last=2026-02-01 --> <!-- provisional -->",
      "- [2026-06-30] Fresh keeper.",
      "  <!-- ev=2 kind=do-more src=explicit conf=high cf=0.80 last=2026-06-30 -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, gateOpts);
    const lessons = lessonsOf(result.content);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].text).toContain("Fresh keeper");
    expect(result.stats.archived).toBe(1);
    expect(result.content).not.toContain("Abandoned provisional");
  });

  it("keeps a provisional lesson inside the 2× window", () => {
    const md = fileWith([
      "- [2026-06-01] Recent provisional.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.20 last=2026-06-01 --> <!-- provisional -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(true);
    expect(result.stats.archived).toBe(0);
  });

  it("re-promotes a provisional lesson genuinely corroborated by this write", () => {
    const prev = fileWith([
      "- [2026-06-01] Now corroborated.",
      "  <!-- ev=1 kind=preference src=behavioral conf=medium cf=0.50 last=2026-06-01 --> <!-- provisional -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Now corroborated.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-07-01 --> <!-- provisional -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(false);
    expect(result.stats.repromoted).toBe(1);
    expect(result.content).not.toContain("provisional");
  });

  it("a freshly-written provisional bullet is NOT re-promoted in the same write", () => {
    // The evening LLM stores a hold-provisional candidate with a rounded
    // ev=round(weighted_ev) that can meet the threshold — without genuine
    // corroboration (a carry-bump vs the previous file) the marker must
    // survive, or the promotion gate is bypassed in the very PATCH that
    // stored the hold.
    const md = fileWith([
      "- [2026-07-01] Fresh hold-provisional candidate.",
      "  <!-- ev=2 kind=preference src=behavioral conf=low cf=0.35 last=2026-07-01 --> <!-- provisional -->",
    ]);
    const result = normalizeLessonsFileContent(md, null, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(true);
    expect(result.stats.repromoted).toBe(0);
  });

  it("the sweep (prev == current) never re-promotes — corroboration required", () => {
    const md = fileWith([
      "- [2026-06-01] Provisional at threshold but uncorroborated.",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-07-01 --> <!-- provisional -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(true);
    expect(result.stats.repromoted).toBe(0);
  });

  it("vetoes a re-promotion that contradicts an established active peer", () => {
    const prev = fileWith([
      "- [2026-06-01] Stop including the budget section in reports.",
      "  <!-- ev=1 kind=do-less src=behavioral conf=medium cf=0.40 last=2026-06-01 --> <!-- provisional -->",
      "- [2026-05-01] Include the budget section in every report.",
      "  <!-- ev=4 kind=do-more src=explicit conf=high cf=0.90 last=2026-06-30 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Stop including the budget section in reports.",
      // corroborated (ev 1→2, last advanced) but bar = 1.5·2·0.9 = 2.7 > 2
      "  <!-- ev=2 kind=do-less src=behavioral conf=medium cf=0.40 last=2026-07-01 --> <!-- provisional -->",
      "- [2026-05-01] Include the budget section in every report.",
      "  <!-- ev=4 kind=do-more src=explicit conf=high cf=0.90 last=2026-06-30 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, {
      ...gateOpts,
      contradictionGuardCf: 0.6,
    });
    const vetoed = lessonsOf(result.content).find((l) =>
      l.text.includes("Stop including"),
    )!;
    expect(vetoed.provisional).toBe(true);
    expect(result.stats.repromoted).toBe(0);
  });

  it("re-promotes through the guard once evidence clears the 1.5x bar", () => {
    const prev = fileWith([
      "- [2026-06-01] Stop including the budget section in reports.",
      "  <!-- ev=2 kind=do-less src=behavioral conf=medium cf=0.40 last=2026-06-01 --> <!-- provisional -->",
      "- [2026-05-01] Include the budget section in every report.",
      "  <!-- ev=4 kind=do-more src=explicit conf=high cf=0.90 last=2026-06-30 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Stop including the budget section in reports.",
      // corroborated to ev=3 ≥ 2.7 bar
      "  <!-- ev=3 kind=do-less src=behavioral conf=medium cf=0.40 last=2026-07-01 --> <!-- provisional -->",
      "- [2026-05-01] Include the budget section in every report.",
      "  <!-- ev=4 kind=do-more src=explicit conf=high cf=0.90 last=2026-06-30 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, {
      ...gateOpts,
      contradictionGuardCf: 0.6,
    });
    const cleared = lessonsOf(result.content).find((l) =>
      l.text.includes("Stop including"),
    )!;
    expect(cleared.provisional).toBe(false);
    expect(result.stats.repromoted).toBe(1);
  });

  it("removes an own-line provisional marker instead of leaving a blank line", () => {
    // A blank line terminates the entry — leaving one would orphan the
    // trailer below it and silently reset the lesson's attrs on the next
    // pass (idempotency violation for hand-edited layouts).
    const prev = fileWith([
      "- [2026-06-01] Marker on its own line.",
      "  <!-- provisional -->",
      "  <!-- ev=1 kind=preference src=behavioral conf=medium cf=0.50 last=2026-06-01 -->",
    ]);
    const next = fileWith([
      "- [2026-06-01] Marker on its own line.",
      "  <!-- provisional -->",
      "  <!-- ev=2 kind=preference src=behavioral conf=medium cf=0.50 last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, gateOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(false);
    expect(lesson.ev).toBe(2);
    expect(result.content).not.toMatch(/\n\s*\n\s*<!-- ev=/);
    // Idempotent from here: a second pass changes nothing and the attrs
    // survive re-parsing.
    const again = normalizeLessonsFileContent(result.content, result.content, gateOpts);
    expect(again.changed).toBe(false);
    const [reparsed] = lessonsOf(again.content);
    expect(reparsed.ev).toBe(2);
    expect(reparsed.kind).toBe("preference");
  });

  it("does not enact expiration when the horizon inputs are absent", () => {
    const md = fileWith([
      "- [2026-01-01] Would demote if configured.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.10 last=2026-01-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, {
      ...baseOpts,
      enactExpiration: true,
    });
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(false);
    expect(result.stats.demoted).toBe(0);
  });

  it("stays fully inert when enactExpiration is off", () => {
    const md = fileWith([
      "- [2026-01-01] Stale but expiration off.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low cf=0.10 last=2026-01-01 -->",
    ]);
    const result = normalizeLessonsFileContent(md, md, baseOpts);
    const [lesson] = lessonsOf(result.content);
    expect(lesson.provisional).toBe(false);
  });

  it("only the Lessons section of the previous file is a carry source", () => {
    // A dated bullet in some OTHER section must not masquerade as a prior
    // lesson — a re-added lesson matching it would "carry" stale attrs
    // instead of deriving fresh ones.
    const prev = [
      "---",
      "type: rule",
      "owner: agent",
      "updated: 2026-07-01",
      "---",
      "# Agent Lessons",
      "",
      "## Lessons",
      "<!-- scope: agent · cap: 8192B · 40 entries -->",
      "",
      "## Archive",
      "- [2026-01-01] Shadow directive lives here.",
      "  <!-- ev=9 kind=constraint src=explicit conf=high cf=0.05 last=2026-01-01 -->",
    ].join("\n");
    const next = fileWith([
      "- [2026-07-01] Shadow directive lives here.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-07-01 -->",
    ]);
    const result = normalizeLessonsFileContent(next, prev, baseOpts);
    const [lesson] = lessonsOf(result.content);
    // Derived fresh (behavioral cf0), NOT carried from the archive bullet.
    expect(result.stats.derived).toBe(1);
    expect(result.stats.carried).toBe(0);
    expect(lesson.cf).toBe(computeInitialCf(1, "behavioral", 2));
  });
});

describe("expirationVerdict", () => {
  const opts = {
    nowIso: NOW,
    promotionThreshold: 2,
    staleDays: 60,
    confidenceFloor: 0.25,
  };
  const lesson = (over: Partial<Lesson>): Lesson => ({
    date: "2026-01-01",
    text: "x",
    ev: 1,
    kind: "preference",
    src: "behavioral",
    conf: "low",
    cf: 0.2,
    last: "2026-01-01",
    provisional: false,
    ...over,
  });

  it("keeps constraints", () => {
    expect(expirationVerdict(lesson({ kind: "constraint" }), opts)).toBe("keep");
  });

  it("keeps a fresh active lesson", () => {
    expect(
      expirationVerdict(lesson({ last: "2026-06-30", cf: 0.9 }), opts),
    ).toBe("keep");
  });

  it("demotes stale + below-floor", () => {
    expect(expirationVerdict(lesson({}), opts)).toBe("demote");
  });

  it("skips the demote test without a configured floor", () => {
    expect(
      expirationVerdict(lesson({}), { ...opts, confidenceFloor: undefined }),
    ).toBe("keep");
  });

  it("re-promotes a provisional only when corroborated AND at threshold", () => {
    expect(
      expirationVerdict(lesson({ provisional: true, last: "2026-07-01", ev: 2 }), {
        ...opts,
        corroborated: true,
      }),
    ).toBe("repromote");
    // Uncorroborated (fresh bullet / sweep) never re-promotes…
    expect(
      expirationVerdict(
        lesson({ provisional: true, last: "2026-07-01", ev: 2 }),
        opts,
      ),
    ).toBe("keep");
    // …and corroboration below the threshold holds too.
    expect(
      expirationVerdict(lesson({ provisional: true, last: "2026-07-01", ev: 1 }), {
        ...opts,
        corroborated: true,
      }),
    ).toBe("keep");
  });

  it("archives a provisional past 2× staleDays", () => {
    expect(expirationVerdict(lesson({ provisional: true }), opts)).toBe(
      "archive",
    );
  });

  it("keeps a provisional inside the 2× window (and without a horizon)", () => {
    expect(
      expirationVerdict(lesson({ provisional: true, last: "2026-06-01" }), opts),
    ).toBe("keep");
    expect(
      expirationVerdict(lesson({ provisional: true }), {
        ...opts,
        staleDays: undefined,
      }),
    ).toBe("keep");
  });
});
