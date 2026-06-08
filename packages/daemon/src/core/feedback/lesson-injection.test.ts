import { describe, expect, it } from "vitest";

import {
  AGENT_LESSONS_SLIM_CAP_BYTES,
  AGENT_LESSONS_SLIM_MAX_ENTRIES,
  renderAgentLessonsBlock,
} from "./lesson-injection.js";

const NOW = "2026-06-07T12:00:00.000Z";

/** Build a `policies/agent-lessons.md` fixture from raw `## Lessons` bullets. */
function file(bullets: string): string {
  return ["# Agent Lessons", "", "## Lessons", bullets].join("\n");
}

const TWO_ACTIVE = file(
  [
    "<!-- scope: agent · cap: 8192B · 40 entries -->",
    "- [2026-06-07] Keep the BUDGET_SECTION in the weekly report.",
    "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
    "- [2026-05-29] Lead with BLOCKERS_FIRST, not status, in standup summaries.",
    "  <!-- ev=4 kind=do-more src=behavioral conf=high last=2026-06-05 -->",
  ].join("\n"),
);

describe("renderAgentLessonsBlock — global path", () => {
  it("returns null block (no overflow) when the file is null", () => {
    expect(renderAgentLessonsBlock(null, { capBytes: 8192, slim: false, nowIso: NOW }))
      .toEqual({ block: null, overflow: null });
  });

  it("returns null when there is no ## Lessons section", () => {
    const md = "# Agent Lessons\n\n## Notes\n- nothing here\n";
    expect(renderAgentLessonsBlock(md, { capBytes: 8192, slim: false, nowIso: NOW }))
      .toEqual({ block: null, overflow: null });
  });

  it("returns null when the section has no active (non-provisional) lessons", () => {
    const md = file(
      [
        "- [2026-05-01] PROVISIONAL_DRAFT not yet promoted.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
      ].join("\n"),
    );
    expect(renderAgentLessonsBlock(md, { capBytes: 8192, slim: false, nowIso: NOW }))
      .toEqual({ block: null, overflow: null });
  });

  it("renders active lessons, wrapped + preamble, dropping provisional + trailers + dates", () => {
    const md = file(
      [
        "- [2026-06-07] Keep the BUDGET_SECTION in the weekly report.",
        "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
        "- [2026-05-01] PROVISIONAL_DRAFT not yet promoted.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
      ].join("\n"),
    );
    const { block, overflow } = renderAgentLessonsBlock(md, {
      capBytes: 8192,
      slim: false,
      nowIso: NOW,
    });
    expect(overflow).toBeNull();
    expect(block).not.toBeNull();
    expect(block).toMatch(/^<agent_lessons>\n/);
    expect(block).toMatch(/\n<\/agent_lessons>$/);
    expect(block).toContain("standing directive"); // preamble
    expect(block).toContain("- Keep the BUDGET_SECTION in the weekly report.");
    // Provisional excluded; trailer + leading date stripped.
    expect(block).not.toContain("PROVISIONAL_DRAFT");
    expect(block).not.toContain("<!-- ev=");
    expect(block).not.toContain("[2026-");
  });

  it("degrades to the top-N lessons by score when over cap but some fit", () => {
    // Cap between a single top bullet and the combined body → keep the
    // highest-scored lesson, drop the rest (graceful degradation, not
    // all-or-nothing). BUDGET (correction, reinforced today) outscores BLOCKERS
    // for every `now >= the fixture dates`, so the kept lesson is deterministic.
    const topBullet = "- Keep the BUDGET_SECTION in the weekly report.";
    const cap = Buffer.byteLength(topBullet, "utf-8") + 2;
    const { block, overflow } = renderAgentLessonsBlock(TWO_ACTIVE, {
      capBytes: cap,
      slim: false,
      nowIso: NOW,
    });
    expect(block).not.toBeNull();
    expect(block).toContain("BUDGET_SECTION");
    expect(block).not.toContain("BLOCKERS_FIRST");
    expect(overflow).toEqual({ bytes: expect.any(Number), cap, dropped: 1 });
    expect(overflow?.bytes).toBeGreaterThan(cap);
    // The cap stays a hard guarantee on the body even while degrading.
    const bodyBytes = Buffer.byteLength(
      (block as string)
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .join("\n"),
      "utf-8",
    );
    expect(bodyBytes).toBeLessThanOrEqual(cap);
  });

  it("drops all lessons (null block) + flags overflow when not even one fits", () => {
    const { block, overflow } = renderAgentLessonsBlock(TWO_ACTIVE, {
      capBytes: 10,
      slim: false,
      nowIso: NOW,
    });
    expect(block).toBeNull();
    expect(overflow).not.toBeNull();
    expect(overflow?.cap).toBe(10);
    expect(overflow?.bytes).toBeGreaterThan(10);
    expect(overflow?.dropped).toBe(2); // both active lessons dropped
  });
});

describe("renderAgentLessonsBlock — slim path", () => {
  // Highest eviction score appears LAST in the file so a pass that honoured
  // file order instead of score would pick the wrong lesson. Texts are long so
  // the byte cap unambiguously forces eviction rather than fitting them all.
  const SCORED = file(
    [
      "- [2026-01-01] LOW_SIGNAL — an old low-evidence stylistic preference about phrasing that ranks below corrections and constraints.",
      "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-01-01 -->",
      "- [2026-05-20] MID_SIGNAL — a mid-weight correction the owner issued once, ranking above plain preferences but below hard constraints.",
      "  <!-- ev=3 kind=correction src=explicit conf=high last=2026-05-20 -->",
      "- [2026-06-06] TOP_SIGNAL — a hard constraint with the highest evidence weight that must always survive eviction ahead of all others.",
      "  <!-- ev=6 kind=constraint src=explicit conf=high last=2026-06-06 -->",
    ].join("\n"),
  );

  it("packs by score and keeps the whole block under the hard byte cap", () => {
    const cap = 300;
    const { block, overflow } = renderAgentLessonsBlock(SCORED, {
      capBytes: cap,
      slim: true,
      nowIso: NOW,
    });
    expect(overflow).toBeNull();
    expect(block).not.toBeNull();
    expect(Buffer.byteLength(block as string, "utf-8")).toBeLessThanOrEqual(cap);
    // Highest-scored survives; the lower-signal tail is dropped (score order,
    // NOT file order — TOP_SIGNAL is last in the file but first by score).
    expect(block).toContain("TOP_SIGNAL");
    expect(block).not.toContain("MID_SIGNAL");
    expect(block).not.toContain("LOW_SIGNAL");
    expect(block).toContain("Weigh these"); // slim preamble
  });

  it("honours an explicit entry cap (top-N by score) under a generous byte cap", () => {
    const { block } = renderAgentLessonsBlock(SCORED, {
      capBytes: AGENT_LESSONS_SLIM_CAP_BYTES,
      slim: true,
      nowIso: NOW,
      maxSlimEntries: 1,
    });
    expect(block).toContain("TOP_SIGNAL");
    expect(block).not.toContain("MID_SIGNAL");
    expect(block).not.toContain("LOW_SIGNAL");
  });

  it("returns null (no overflow) when even the single highest-scored bullet exceeds the cap", () => {
    // Cap below the fixed preamble/wrapper overhead → nothing can be kept.
    // The slim path never reports overflow — tail-dropping is routine here.
    const { block, overflow } = renderAgentLessonsBlock(SCORED, {
      capBytes: 10,
      slim: true,
      nowIso: NOW,
    });
    expect(block).toBeNull();
    expect(overflow).toBeNull();
  });

  it("fits every active lesson when the budget is generous", () => {
    const { block } = renderAgentLessonsBlock(SCORED, {
      capBytes: AGENT_LESSONS_SLIM_CAP_BYTES,
      slim: true,
      nowIso: NOW,
    });
    expect(block).toContain("TOP_SIGNAL");
    expect(block).toContain("MID_SIGNAL");
    expect(block).toContain("LOW_SIGNAL");
  });

  it("exposes sane defaults", () => {
    expect(AGENT_LESSONS_SLIM_CAP_BYTES).toBe(2048);
    expect(AGENT_LESSONS_SLIM_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe("renderAgentLessonsBlock — self path (Phase 4, agent:<slug>)", () => {
  it("wraps as <agent_lessons scope=\"self\"> with the self preamble", () => {
    const { block, overflow } = renderAgentLessonsBlock(TWO_ACTIVE, {
      capBytes: 4096,
      slim: false,
      selfScope: true,
      nowIso: NOW,
    });
    expect(overflow).toBeNull();
    expect(block).not.toBeNull();
    expect(block).toMatch(/^<agent_lessons scope="self">\n/);
    expect(block).toMatch(/\n<\/agent_lessons>$/);
    // Self-facing preamble distinguishes it from the global block's text.
    expect(block).toContain("THIS agent's own past");
    expect(block).toContain("- Keep the BUDGET_SECTION in the weekly report.");
    expect(block).not.toContain("<!-- ev=");
    expect(block).not.toContain("[2026-");
  });

  it("drops provisional lessons just like the global path", () => {
    const md = file(
      [
        "- [2026-06-07] Keep the BUDGET_SECTION in the weekly report.",
        "  <!-- ev=2 kind=correction src=explicit conf=high last=2026-06-07 -->",
        "- [2026-05-01] PROVISIONAL_DRAFT not yet promoted.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
      ].join("\n"),
    );
    const { block } = renderAgentLessonsBlock(md, {
      capBytes: 4096,
      slim: false,
      selfScope: true,
      nowIso: NOW,
    });
    expect(block).toContain("BUDGET_SECTION");
    expect(block).not.toContain("PROVISIONAL_DRAFT");
  });

  it("degrades to the top lesson by score + flags overflow when over the per-agent cap", () => {
    const topBullet = "- Keep the BUDGET_SECTION in the weekly report.";
    const cap = Buffer.byteLength(topBullet, "utf-8") + 2;
    const { block, overflow } = renderAgentLessonsBlock(TWO_ACTIVE, {
      capBytes: cap,
      slim: false,
      selfScope: true,
      nowIso: NOW,
    });
    expect(block).toMatch(/^<agent_lessons scope="self">\n/);
    expect(block).toContain("BUDGET_SECTION");
    expect(block).not.toContain("BLOCKERS_FIRST");
    expect(overflow).toEqual({ bytes: expect.any(Number), cap, dropped: 1 });
  });

  it("returns null when the file is null", () => {
    expect(
      renderAgentLessonsBlock(null, {
        capBytes: 4096,
        slim: false,
        selfScope: true,
        nowIso: NOW,
      }),
    ).toEqual({ block: null, overflow: null });
  });

  it("slim wins over selfScope (slim is global-only by construction)", () => {
    const { block } = renderAgentLessonsBlock(TWO_ACTIVE, {
      capBytes: AGENT_LESSONS_SLIM_CAP_BYTES,
      slim: true,
      selfScope: true,
      nowIso: NOW,
    });
    // The plain <agent_lessons> wrapper + slim preamble, never scope="self".
    expect(block).toMatch(/^<agent_lessons>\n/);
    expect(block).toContain("Weigh these");
    expect(block).not.toContain('scope="self"');
  });
});
