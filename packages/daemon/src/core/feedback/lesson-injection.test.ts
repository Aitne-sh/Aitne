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
  it("returns null block (no skip) when the file is null", () => {
    expect(renderAgentLessonsBlock(null, { capBytes: 8192, slim: false, nowIso: NOW }))
      .toEqual({ block: null, skipped: null });
  });

  it("returns null when there is no ## Lessons section", () => {
    const md = "# Agent Lessons\n\n## Notes\n- nothing here\n";
    expect(renderAgentLessonsBlock(md, { capBytes: 8192, slim: false, nowIso: NOW }))
      .toEqual({ block: null, skipped: null });
  });

  it("returns null when the section has no active (non-provisional) lessons", () => {
    const md = file(
      [
        "- [2026-05-01] PROVISIONAL_DRAFT not yet promoted.",
        "  <!-- ev=1 kind=preference src=behavioral conf=low last=2026-05-01 --> <!-- provisional -->",
      ].join("\n"),
    );
    expect(renderAgentLessonsBlock(md, { capBytes: 8192, slim: false, nowIso: NOW }))
      .toEqual({ block: null, skipped: null });
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
    const { block, skipped } = renderAgentLessonsBlock(md, {
      capBytes: 8192,
      slim: false,
      nowIso: NOW,
    });
    expect(skipped).toBeNull();
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

  it("skip-with-warn when the rendered body exceeds capBytes", () => {
    const { block, skipped } = renderAgentLessonsBlock(TWO_ACTIVE, {
      capBytes: 10,
      slim: false,
      nowIso: NOW,
    });
    expect(block).toBeNull();
    expect(skipped).not.toBeNull();
    expect(skipped?.reason).toBe("over_cap");
    expect(skipped?.cap).toBe(10);
    expect(skipped?.bytes).toBeGreaterThan(10);
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
    const { block, skipped } = renderAgentLessonsBlock(SCORED, {
      capBytes: cap,
      slim: true,
      nowIso: NOW,
    });
    expect(skipped).toBeNull();
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

  it("returns null when even the single highest-scored bullet exceeds the cap", () => {
    // Cap below the fixed preamble/wrapper overhead → nothing can be kept.
    const { block, skipped } = renderAgentLessonsBlock(SCORED, {
      capBytes: 10,
      slim: true,
      nowIso: NOW,
    });
    expect(block).toBeNull();
    expect(skipped).toBeNull();
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
