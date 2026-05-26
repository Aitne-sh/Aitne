import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  appendBlockToJournal,
  appendMorningRoutineJournalEntry,
  composeMorningRoutineJournalEntry,
  EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
  inspectDailyJournal,
  loadMorningRoutineActionRows,
  STAGE_A_ACTION_TYPE,
  STAGE_B_ACTION_TYPE,
  type StageActionRow,
} from "./agent-journal-appender.js";

const STAGE_A_OK: StageActionRow = {
  result: "success",
  metadata: {
    dayType: "weekday",
    inboxStats: { triaged: 4, movedToScratch: 4, dmConfirmsSent: 1, secretsSkipped: 0 },
    anomalies: [],
    morningChecks: [],
  },
};

const STAGE_B_OK: StageActionRow = {
  result: "success",
  metadata: {},
};

const DAILY_BODY = [
  "---",
  "date: 2026-05-14",
  "weekday: Wednesday",
  "type: daily",
  "owner: agent",
  "agent_generated: true",
  "calendar_events: 2",
  "messages_handled: 7",
  "projects: [launch-prep, q2-okrs]",
  "people: []",
  "tags: []",
  "---",
  "",
  "# 2026-05-14 (Wednesday)",
  "",
  "## Summary",
  "I shipped the morning routine pipeline split.",
  "",
  "## Schedule",
  "- 10:00 Standup",
  "",
].join("\n");

// ── composer ────────────────────────────────────────────────────────

describe("composeMorningRoutineJournalEntry — typical day", () => {
  it("renders the full block with day-type, journal stats, inbox, actions, checks, anomalies", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("## 2026-05-15 morning routine\n");
    expect(rendered).toContain("- Day-type: weekday\n");
    expect(rendered).toMatch(/- Journal: daily\/2026-05-14\.md \(\d+ lines, 2 projects referenced\)\n/);
    expect(rendered).toContain(
      "- Inbox: 4 files triaged, 4 moved to scratch, 1 DM-confirmations sent\n",
    );
    // The Actions line is always present (the user-diary refocus
    // moved the `## Actions` daily-journal section into this inline
    // agent-footprint line). When no breakdown is supplied — the
    // legacy / fixture path — the composer renders `(none)`.
    expect(rendered).toContain("- Actions: (none)\n");
    expect(rendered).toContain("- Checks from routines/morning.md: (none)\n");
    expect(rendered).toMatch(/- Anomalies \/ skipped steps: \(none\)$/);
  });

  it("joins multiple morningChecks with commas and anomalies with semicolons", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: {
        result: "success",
        metadata: {
          dayType: "focus",
          inboxStats: { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 },
          morningChecks: ["water bottle filled", "calendar synced"],
          anomalies: ["pre-pass partial (gmail)", "roadmap row dropped past horizon"],
        },
      },
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain(
      "- Checks from routines/morning.md: water bottle filled, calendar synced\n",
    );
    expect(rendered).toContain(
      "- Anomalies / skipped steps: pre-pass partial (gmail); roadmap row dropped past horizon",
    );
  });

  it("falls back to `unknown` when dayType is missing or empty", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: { result: "success", metadata: { dayType: "   " } },
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("- Day-type: unknown\n");
  });

  it("zeroes inbox counts when inboxStats is malformed or absent", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: { result: "success", metadata: { dayType: "weekday" } },
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("- Inbox: 0 files triaged, 0 moved to scratch, 0 DM-confirmations sent\n");
  });

  it("clamps negative and non-finite inbox counts to zero", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: {
        result: "success",
        metadata: {
          dayType: "weekday",
          inboxStats: { triaged: -3, movedToScratch: Number.POSITIVE_INFINITY, dmConfirmsSent: "bad" },
        },
      },
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("- Inbox: 0 files triaged, 0 moved to scratch, 0 DM-confirmations sent\n");
  });

  it("skips non-string / empty entries in morningChecks and anomalies arrays", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: {
        result: "success",
        metadata: {
          dayType: "weekday",
          morningChecks: ["valid", "", 42 as unknown as string, "  "],
          anomalies: [null as unknown as string, "x"],
        },
      },
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("- Checks from routines/morning.md: valid\n");
    expect(rendered).toContain("- Anomalies / skipped steps: x");
  });
});

describe("composeMorningRoutineJournalEntry — initial-flow / Stage-B-failed", () => {
  it("emits `Journal synthesis: skipped (no prior-day data)` on first-run (Stage B not attempted, no daily file)", () => {
    // First-run / initial-variant signal: orchestrator skipped Stage B
    // because yesterday.md was absent (no prior agent-day to author
    // about). `stageB: null` + `stageBAttempted: false` is the unambiguous
    // shape — `stageB: null` alone (without the attempt flag) used to
    // also catch the "Stage B was dispatched but its audit row never
    // landed" anomaly path, which is now disambiguated.
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: null,
      dailyJournalContent: null,
      stageBAttempted: false,
    });
    expect(rendered).toContain("- Journal synthesis: skipped (no prior-day data)\n");
    expect(rendered).not.toContain("Journal: daily/");
  });

  it("emits `Journal synthesis: failed (audit row missing — see daemon log)` when Stage B WAS attempted but produced no row", () => {
    // Defence-in-depth: with the orchestrator-side failure-row write
    // in place (`recordStageFailure` → `audit.logError`), the only way
    // to reach this state is a rare SQLite write failure inside
    // `audit.logError` itself. Surface the failure loudly rather than
    // masking it as a first-run skip — that was the exact mode that
    // hid two consecutive Stage B budget-cap regressions in production
    // before the audit-trail fix landed.
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: null,
      dailyJournalContent: null,
      stageBAttempted: true,
    });
    expect(rendered).toContain(
      "- Journal synthesis: failed (audit row missing — see daemon log)\n",
    );
    expect(rendered).not.toContain("no prior-day data");
  });

  it("surfaces `Stage B success but daily file missing` when Stage B claims success but the file is absent", () => {
    // Real anomaly we used to silently mask as "no prior-day data": Stage B's
    // `agent_actions` row records `result='success'` (the session settled
    // cleanly) but `daily/<yesterday>.md` is not on disk. That means the
    // atomic PUT either lost or was reverted between settle and appender
    // run — surface it explicitly so `pnpm audit` can grep on the distinct
    // string. The verb is `failed` (not `skipped`) so the audit-trail
    // language matches reality — Stage B ran, the side effect just didn't
    // land.
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: null,
      stageBAttempted: true,
    });
    expect(rendered).toContain(
      "- Journal synthesis: failed (Stage B success but daily file missing)\n",
    );
    expect(rendered).not.toContain("no prior-day data");
  });

  it("emits `Stage B <state>` with the `failed` verb when Stage B is non-success AND the daily file is missing", () => {
    // Before the verb-correction pass, this rendered as
    // `skipped (Stage B failed)` — the verb mismatched reality (the
    // stage ran and failed, it wasn't skipped). The renderer now
    // promotes the verb to `failed` for every Stage B non-success
    // state.
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: { result: "failed", metadata: {} },
      dailyJournalContent: null,
      stageBAttempted: true,
    });
    expect(rendered).toContain("- Journal synthesis: failed (Stage B failed)\n");
    expect(rendered).not.toContain("no prior-day data");
    expect(rendered).not.toContain("skipped (Stage B");
  });

  it("emits `Journal synthesis: failed (Stage B failed)` when Stage B terminal but non-success", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: { result: "failed", metadata: {} },
      dailyJournalContent: DAILY_BODY,
      stageBAttempted: true,
    });
    expect(rendered).toContain("- Journal synthesis: failed (Stage B failed)\n");
  });

  it("emits `Journal: ...` when Stage B is null (not yet run) but the daily file is present", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: null,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toMatch(/- Journal: daily\/2026-05-14\.md/);
  });

  it.each<"partial" | "skipped" | "in_progress">(["partial", "skipped", "in_progress"])(
    "emits `Journal synthesis: failed (Stage B %s)` for every non-success terminal state",
    (badResult) => {
      // Existing tests only covered `failed`. The `formatJournalLine`
      // branch is `stageB.result !== "success"` which fires on every
      // non-success state. Pin the rendered string so the audit log's
      // grep contract holds when Stage B lands in any of the three
      // alternate terminal states.
      const rendered = composeMorningRoutineJournalEntry({
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        stageA: STAGE_A_OK,
        stageB: { result: badResult, metadata: {} },
        dailyJournalContent: DAILY_BODY,
        stageBAttempted: true,
      });
      expect(rendered).toContain(`- Journal synthesis: failed (Stage B ${badResult})\n`);
    },
  );

  it("treats an empty-string dailyJournalContent as a present-but-empty file (not absent)", () => {
    // `formatJournalLine` switches on `dailyContent === null`, NOT on
    // truthiness. So a present-but-zero-byte daily file lands in the
    // `Journal: daily/.../md (0 lines, 0 projects referenced)` arm,
    // not the `skipped (no prior-day data)` arm. Pinning this guards
    // against a tempting refactor like `if (!dailyContent)` that would
    // silently change the audit output.
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: "",
    });
    expect(rendered).toContain(
      "- Journal: daily/2026-05-14.md (0 lines, 0 projects referenced)\n",
    );
    expect(rendered).not.toContain("skipped (no prior-day data)");
  });

  it("falls back to the legacy `skipped (no prior-day data)` render when `stageBAttempted` is omitted (backwards-compat for callers not updated yet)", () => {
    // Composer-level guarantee: when the caller doesn't supply
    // `stageBAttempted` (the legacy shape), the renderer treats
    // `stageB === null` as first-run. This keeps tests focused on
    // other composer fields terse and lets the end-to-end
    // `appendMorningRoutineJournalEntry` opt into the disambiguation
    // by supplying the flag. Don't relax — production callers MUST
    // pass `stageBAttempted` for the anomaly path to surface;
    // otherwise we slip back into the masking behaviour the
    // discriminator was added to fix.
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: null,
      dailyJournalContent: null,
    });
    expect(rendered).toContain("- Journal synthesis: skipped (no prior-day data)\n");
  });
});

// ── Actions line rendering ──────────────────────────────────────────

describe("composeMorningRoutineJournalEntry — Actions line", () => {
  it("renders `(none)` when totalActions is 0", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
      actionsSummary: { totalActions: 0, actionsByType: [] },
    });
    expect(rendered).toContain("- Actions: (none)\n");
  });

  it("renders `(none)` when actionsSummary is omitted entirely (back-compat default)", () => {
    // The optional field exists so legacy / unit-style tests can
    // exercise the composer without threading aggregation through.
    // Pin the absence-default semantics so a refactor that flips
    // the default doesn't silently emit empty parens (`Actions:  ()`).
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("- Actions: (none)\n");
  });

  it("renders `N total (type: count, ...)` with all breakdown entries when ≤ 5 types", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
      actionsSummary: {
        totalActions: 23,
        actionsByType: [
          { actionType: "curl", count: 12 },
          { actionType: "web_fetch", count: 7 },
          { actionType: "sqlite_read", count: 4 },
        ],
      },
    });
    expect(rendered).toContain(
      "- Actions: 23 total (curl: 12, web_fetch: 7, sqlite_read: 4)\n",
    );
  });

  it("caps the inline breakdown at 5 types and collapses the tail to `+N more`", () => {
    // Single-line readability constraint: a busy day with 30 action
    // types would otherwise overflow the line. Pin the cap so a
    // refactor that loosens it doesn't accidentally produce a
    // multi-paragraph footprint inside agent/journal.md.
    const actionsByType = Array.from({ length: 8 }, (_, i) => ({
      actionType: `type_${i + 1}`,
      count: 10 - i,
    }));
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
      actionsSummary: { totalActions: 52, actionsByType },
    });
    expect(rendered).toContain(
      "- Actions: 52 total (type_1: 10, type_2: 9, type_3: 8, type_4: 7, type_5: 6, +3 more)\n",
    );
  });

  it("renders a single-type day as `1 total (type: 1)` without an `+N more` tail", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
      actionsSummary: {
        totalActions: 1,
        actionsByType: [{ actionType: "hourly_check", count: 1 }],
      },
    });
    expect(rendered).toContain("- Actions: 1 total (hourly_check: 1)\n");
  });
});

// ── inspectDailyJournal ─────────────────────────────────────────────

describe("inspectDailyJournal", () => {
  it("counts body lines (excluding frontmatter) and flow-style projects array entries", () => {
    const stats = inspectDailyJournal(DAILY_BODY);
    expect(stats.projectsCount).toBe(2);
    expect(stats.bodyLineCount).toBeGreaterThan(0);
  });

  it("counts list-form projects items", () => {
    const content = [
      "---",
      "date: 2026-05-14",
      "projects:",
      "  - launch-prep",
      "  - q2-okrs",
      "  - hire-pipeline",
      "---",
      "# body",
    ].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(3);
  });

  it("returns 0 projects for empty placeholder `projects: []`", () => {
    const content = [
      "---",
      "date: 2026-05-14",
      "projects: []",
      "---",
      "# body",
      "line 2",
    ].join("\n");
    const stats = inspectDailyJournal(content);
    expect(stats.projectsCount).toBe(0);
    expect(stats.bodyLineCount).toBe(2);
  });

  it("returns 0 projects when the field is absent", () => {
    const content = ["---", "date: 2026-05-14", "---", "body only"].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(0);
  });

  it("returns 0 projects when frontmatter is malformed (no closing ---)", () => {
    const content = ["---", "date: 2026-05-14", "projects: [a, b]", "no close"].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(0);
  });

  it("returns 0 projects when content has no frontmatter at all", () => {
    expect(inspectDailyJournal("plain body\nline 2\n").projectsCount).toBe(0);
    expect(inspectDailyJournal("plain body\nline 2\n").bodyLineCount).toBe(2);
  });

  it("handles flow-style projects with whitespace and trailing commas", () => {
    const content = [
      "---",
      "projects: [ a , b , c , ]",
      "---",
      "body",
    ].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(3);
  });

  it("returns 0 projects when value starts with `[` but does not close", () => {
    const content = ["---", "projects: [a, b", "---", "body"].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(0);
  });

  it("returns 0 bodyLineCount when body is empty", () => {
    expect(inspectDailyJournal("---\ndate: x\n---\n").bodyLineCount).toBe(0);
    expect(inspectDailyJournal("---\ndate: x\n---").bodyLineCount).toBe(0);
  });

  it("returns 0 bodyLineCount when stripped body is exactly a single newline", () => {
    expect(inspectDailyJournal("---\ndate: x\n---\n\n").bodyLineCount).toBe(0);
  });

  it("treats `--- garbage` first line as not-a-frontmatter and counts the whole file as body", () => {
    // `content.startsWith("---")` is true but `lines[0].trim()` is
    // `--- garbage` which is not the bare `---` token — the function
    // bails to the no-frontmatter path. Exercises the L319 defensive
    // branch in stripFrontmatter.
    const content = "--- garbage\nbody line\n";
    const stats = inspectDailyJournal(content);
    expect(stats.bodyLineCount).toBe(2);
    expect(stats.projectsCount).toBe(0);
  });

  it("counts 0 projects when the flow-style array contains only whitespace inside the brackets", () => {
    const content = ["---", "projects: [   ]", "---", "body"].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(0);
  });

  it("stops counting list-form projects when a non-indented line breaks the block", () => {
    // The break case in countProjectsField: `if (!next.startsWith("  ")
    // && !next.startsWith("\t")) break;` — exercises both arms of the
    // indented-continuation predicate.
    const content = [
      "---",
      "projects:",
      "  - a",
      "  - b",
      "people: []",
      "---",
      "body",
    ].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(2);
  });

  it("counts list-form projects with tab indentation", () => {
    const content = [
      "---",
      "projects:",
      "\t- tab-indented",
      "\t- second",
      "---",
      "body",
    ].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(2);
  });

  it("skips indented lines that are not `- item` form", () => {
    const content = [
      "---",
      "projects:",
      "  - real",
      "  description-only line",
      "---",
      "body",
    ].join("\n");
    expect(inspectDailyJournal(content).projectsCount).toBe(1);
  });
});

// ── appendBlockToJournal ────────────────────────────────────────────

describe("appendBlockToJournal", () => {
  it("seeds a fresh file with the H1 header when no original exists", () => {
    expect(appendBlockToJournal(null, "## 2026-05-15 morning routine\n- foo")).toBe(
      "# Agent journal\n\n## 2026-05-15 morning routine\n- foo\n",
    );
  });

  it("appends a new block separated by a single blank line", () => {
    const original = "# Agent journal\n\n## 2026-05-14 morning routine\n- prev\n";
    const next = appendBlockToJournal(original, "## 2026-05-15 morning routine\n- next");
    expect(next).toBe(
      "# Agent journal\n\n## 2026-05-14 morning routine\n- prev\n\n## 2026-05-15 morning routine\n- next\n",
    );
  });

  it("normalises trailing whitespace on the existing content", () => {
    const original = "# Agent journal\n\n## old\n\n\n\n";
    const next = appendBlockToJournal(original, "## new");
    expect(next).toBe("# Agent journal\n\n## old\n\n## new\n");
  });

  it("only trims trailing newlines — leading/internal whitespace in a degenerate original survives", () => {
    // `replace(/\n+$/, "")` is anchored at end-of-string; a degenerate
    // original of only spaces (no trailing `\n`) is preserved as the
    // "existing content" rather than being treated as a fresh file.
    // Pin this so a tempting `trim()` refactor that drops leading
    // whitespace doesn't accidentally re-trigger the H1 seed branch.
    expect(appendBlockToJournal("   ", "## new")).toBe("   \n\n## new\n");
  });

  it("replaces an existing same-date block instead of duplicating it (retry-idempotency)", () => {
    const original = [
      "# Agent journal",
      "",
      "## 2026-05-14 morning routine",
      "- prev day",
      "",
      "## 2026-05-15 morning routine",
      "- Day-type: weekday",
      "- attempt 1 details",
      "",
    ].join("\n");
    const next = appendBlockToJournal(
      original,
      [
        "## 2026-05-15 morning routine",
        "- Day-type: weekday",
        "- attempt 2 details",
      ].join("\n"),
    );
    expect(next).toBe(
      [
        "# Agent journal",
        "",
        "## 2026-05-14 morning routine",
        "- prev day",
        "",
        "## 2026-05-15 morning routine",
        "- Day-type: weekday",
        "- attempt 2 details",
        "",
      ].join("\n"),
    );
    expect(next.match(/^## 2026-05-15 morning routine$/gm)).toHaveLength(1);
  });

  it("replaces the LAST matching block when multiple legacy entries share the same date H2 (defence in depth)", () => {
    const original = [
      "# Agent journal",
      "",
      "## 2026-05-15 morning routine",
      "- legacy historical entry (must be preserved)",
      "",
      "## 2026-05-15 morning routine",
      "- recent attempt 1",
      "",
    ].join("\n");
    const next = appendBlockToJournal(
      original,
      "## 2026-05-15 morning routine\n- recent attempt 2",
    );
    expect(next).toContain("- legacy historical entry (must be preserved)");
    expect(next).toContain("- recent attempt 2");
    expect(next).not.toContain("- recent attempt 1");
  });

  it("replaces a CRLF-terminated same-date block instead of duplicating it (operator-edited journal stays idempotent)", () => {
    // `pnpm audit` workflow involves operators occasionally hand-
    // editing `agent/journal.md`. A single CRLF leak would otherwise
    // break the strict `===` header match — the retry would skip the
    // replace branch and emit a duplicate H2 block. Same uniform
    // CRLF policy as handoff-parser + extractUserTasksFromYesterday.
    const original = [
      "# Agent journal",
      "",
      "## 2026-05-15 morning routine",
      "- attempt 1",
    ].join("\r\n");
    const next = appendBlockToJournal(
      original,
      "## 2026-05-15 morning routine\n- attempt 2",
    );
    expect(next.match(/^## 2026-05-15 morning routine$/gm)).toHaveLength(1);
    expect(next).toContain("- attempt 2");
    expect(next).not.toContain("- attempt 1");
  });

  it("replaces a same-date block that sits at the trailing end with no later H2", () => {
    const original = "# Agent journal\n\n## 2026-05-15 morning routine\n- attempt 1\n";
    const next = appendBlockToJournal(
      original,
      "## 2026-05-15 morning routine\n- attempt 2",
    );
    expect(next).toBe(
      "# Agent journal\n\n## 2026-05-15 morning routine\n- attempt 2\n",
    );
  });

  it("preserves a later H2 sibling when replacing an earlier same-date block (out-of-order writes / future metadata sections)", () => {
    // Defence in depth — append-only writers normally produce chronological
    // ordering, but a future migration / hand-edit could land a non-date
    // H2 (e.g. `## Notes`) after the routine block. The replacer must clip
    // up to (not including) the next H2 boundary, never past it.
    const original = [
      "# Agent journal",
      "",
      "## 2026-05-15 morning routine",
      "- attempt 1 details",
      "",
      "## Notes",
      "- operator hand-edited block (must be preserved)",
      "",
    ].join("\n");
    const next = appendBlockToJournal(
      original,
      "## 2026-05-15 morning routine\n- attempt 2 details",
    );
    expect(next).toContain("- attempt 2 details");
    expect(next).not.toContain("- attempt 1 details");
    expect(next).toContain("## Notes\n- operator hand-edited block (must be preserved)");
  });
});

// ── loadMorningRoutineActionRows ────────────────────────────────────

describe("loadMorningRoutineActionRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRow(values: {
    eventId: string;
    actionType: string;
    result?: string;
    metadata?: Record<string, unknown> | null | "INVALID_JSON";
  }): void {
    const metadataJson =
      values.metadata === "INVALID_JSON"
        ? "not-json"
        : values.metadata === null || values.metadata === undefined
          ? null
          : JSON.stringify(values.metadata);
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, metadata, started_at, completed_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(values.eventId, values.actionType, values.result ?? "success", metadataJson);
  }

  it("returns null for stages that have no row", () => {
    expect(loadMorningRoutineActionRows(db, "missing-corr-id")).toEqual({
      stageA: null,
      stageB: null,
    });
  });

  it("loads Stage A + Stage B rows by event_id and parses metadata JSON", () => {
    seedRow({
      eventId: "corr-1",
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday", inboxStats: { triaged: 3, movedToScratch: 3, dmConfirmsSent: 1 } },
    });
    seedRow({ eventId: "corr-1", actionType: STAGE_B_ACTION_TYPE, metadata: { foo: "bar" } });
    // Foreign correlation id must not leak.
    seedRow({ eventId: "other-corr", actionType: STAGE_A_ACTION_TYPE, metadata: { dayType: "off" } });

    const rows = loadMorningRoutineActionRows(db, "corr-1");
    expect(rows.stageA?.result).toBe("success");
    expect(rows.stageA?.metadata.dayType).toBe("weekday");
    expect(rows.stageB?.metadata).toEqual({ foo: "bar" });
  });

  it("ignores rows with non-stage action_type", () => {
    seedRow({ eventId: "corr-1", actionType: STAGE_A_ACTION_TYPE });
    seedRow({ eventId: "corr-1", actionType: "hourly_check" });
    expect(loadMorningRoutineActionRows(db, "corr-1").stageB).toBeNull();
  });

  it("falls back to empty object when metadata JSON is invalid", () => {
    seedRow({ eventId: "corr-1", actionType: STAGE_A_ACTION_TYPE, metadata: "INVALID_JSON" });
    expect(loadMorningRoutineActionRows(db, "corr-1").stageA?.metadata).toEqual({});
  });

  it("falls back to empty object when metadata is a JSON array (not an object)", () => {
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, metadata)
       VALUES (?, ?, 'success', ?)`,
    ).run("corr-1", STAGE_A_ACTION_TYPE, JSON.stringify([1, 2, 3]));
    expect(loadMorningRoutineActionRows(db, "corr-1").stageA?.metadata).toEqual({});
  });

  it("on duplicate stage rows (retry) returns the latest by insert id", () => {
    seedRow({ eventId: "corr-1", actionType: STAGE_A_ACTION_TYPE, metadata: { dayType: "first" } });
    seedRow({ eventId: "corr-1", actionType: STAGE_A_ACTION_TYPE, metadata: { dayType: "second" } });
    expect(loadMorningRoutineActionRows(db, "corr-1").stageA?.metadata.dayType).toBe("second");
  });

  it("on duplicate Stage B rows (retry) also returns the latest by insert id", () => {
    seedRow({ eventId: "corr-1", actionType: STAGE_A_ACTION_TYPE });
    seedRow({ eventId: "corr-1", actionType: STAGE_B_ACTION_TYPE, metadata: { foo: "first" } });
    seedRow({ eventId: "corr-1", actionType: STAGE_B_ACTION_TYPE, metadata: { foo: "second" } });
    expect(loadMorningRoutineActionRows(db, "corr-1").stageB?.metadata.foo).toBe("second");
  });

  // daily-journal-daemon-write.md §4.11 — dailyWrite parsing.
  function seedRowWithDetail(values: {
    eventId: string;
    actionType: string;
    detail: unknown;
  }): void {
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, detail, started_at, completed_at)
       VALUES (?, ?, 'success', ?, datetime('now'), datetime('now'))`,
    ).run(values.eventId, values.actionType, JSON.stringify(values.detail));
  }

  it("parses dailyWrite ok='complete' on Stage B row", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: "complete", bytesWritten: 1234, wroteMode: "put" } },
    });
    const rows = loadMorningRoutineActionRows(db, "c");
    expect(rows.stageB?.dailyWrite).toEqual({
      ok: "complete",
      bytesWritten: 1234,
      wroteMode: "put",
    });
  });

  it("parses dailyWrite ok='partial' with reason", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: {
        dailyWrite: {
          ok: "partial",
          bytesWritten: 1000,
          wroteMode: "put",
          partialReason: "frontmatter_tag_missing",
        },
      },
    });
    const rows = loadMorningRoutineActionRows(db, "c");
    expect(rows.stageB?.dailyWrite).toEqual({
      ok: "partial",
      bytesWritten: 1000,
      wroteMode: "put",
      partialReason: "frontmatter_tag_missing",
    });
  });

  it("parses dailyWrite ok=false with reason", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: false, reason: "body_tag_missing" } },
    });
    const rows = loadMorningRoutineActionRows(db, "c");
    expect(rows.stageB?.dailyWrite).toEqual({ ok: false, reason: "body_tag_missing" });
  });

  it("ignores malformed dailyWrite (unknown partial reason)", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: "partial", partialReason: "not-a-real-reason" } },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  it("ignores dailyWrite on Stage A rows (only Stage B carries it)", () => {
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_A_ACTION_TYPE,
      detail: { dailyWrite: { ok: "complete" } },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageA?.dailyWrite).toBeUndefined();
  });

  it("absent detail column means dailyWrite is absent (backward compat)", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRow({ eventId: "c", actionType: STAGE_B_ACTION_TYPE });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  // Note: SQLite's `detail` column carries a CHECK(json_valid(detail))
  // constraint, so malformed JSON cannot land via the INSERT path —
  // `parseDailyWriteDetail`'s try/catch is a defence-in-depth guard
  // for a future migration that relaxes the constraint, not a
  // reachable production shape today.

  it("dailyWrite with an unrecognised ok value is rejected", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: "weird" } },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  it("dailyWrite ok='complete' with missing wroteMode drops the field but keeps the row", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: "complete", bytesWritten: 100 } },
    });
    const rows = loadMorningRoutineActionRows(db, "c");
    expect(rows.stageB?.dailyWrite).toEqual({
      ok: "complete",
      bytesWritten: 100,
    });
  });

  it("dailyWrite ok='complete' with missing bytesWritten + wroteMode parses with only ok", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: "complete" } },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toEqual({
      ok: "complete",
    });
  });

  it("dailyWrite parsing rejects a top-level JSON null detail", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, detail, started_at, completed_at)
       VALUES (?, ?, 'success', json('null'), datetime('now'), datetime('now'))`,
    ).run("c", STAGE_B_ACTION_TYPE);
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  it("dailyWrite ok='partial' with missing wroteMode + missing bytesWritten still parses", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: {
        dailyWrite: {
          ok: "partial",
          partialReason: "frontmatter_schema_invalid",
        },
      },
    });
    const rows = loadMorningRoutineActionRows(db, "c");
    expect(rows.stageB?.dailyWrite).toEqual({
      ok: "partial",
      partialReason: "frontmatter_schema_invalid",
    });
  });

  it("dailyWrite is rejected when it's null", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: null },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  it("dailyWrite is rejected when detail is a JSON array (not object)", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: [1, 2, 3],
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  it("dailyWrite ok=false with unrecognised reason is rejected", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { dailyWrite: { ok: false, reason: "made-up" } },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });

  it("detail with no dailyWrite key returns absent dailyWrite", () => {
    seedRow({ eventId: "c", actionType: STAGE_A_ACTION_TYPE });
    seedRowWithDetail({
      eventId: "c",
      actionType: STAGE_B_ACTION_TYPE,
      detail: { failureKind: "quota" },
    });
    expect(loadMorningRoutineActionRows(db, "c").stageB?.dailyWrite).toBeUndefined();
  });
});

// daily-journal-daemon-write.md §4.7 — formatJournalLine branches keyed
// on detail.dailyWrite. These tests pin every line variant in the
// design's §4.7 table without exercising the SQLite roundtrip.
describe("composeMorningRoutineJournalEntry — dailyWrite-driven Journal line", () => {
  it("ok='complete' → standard Journal line with line + projects count", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: "complete", bytesWritten: 1234, wroteMode: "put" },
      },
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toMatch(/- Journal: daily\/2026-05-14\.md \(\d+ lines, 2 projects referenced\)\n/);
  });

  it("ok='partial' frontmatter_tag_missing → bolded partial line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      },
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("**partial — frontmatter tag missing**");
  });

  it("ok='partial' frontmatter_invalid_json renders JSON parse error label", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: "partial", partialReason: "frontmatter_invalid_json" },
      },
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("**partial — frontmatter JSON parse error**");
  });

  it("ok='partial' frontmatter_schema_invalid renders schema-mismatch label", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: "partial", partialReason: "frontmatter_schema_invalid" },
      },
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toContain("**partial — frontmatter schema mismatch**");
  });

  it("ok=false body_tag_missing → 'extraction: no body' failed line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: false, reason: "body_tag_missing" },
      },
      dailyJournalContent: null,
    });
    expect(rendered).toContain("- Journal synthesis: failed (extraction: no body)");
  });

  it("ok=false empty_output → 'LLM output empty' failed line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: false, reason: "empty_output" },
      },
      dailyJournalContent: null,
    });
    expect(rendered).toContain("- Journal synthesis: failed (LLM output empty)");
  });

  it("ok=false write_failed → 'write error' failed line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: false, reason: "write_failed" },
      },
      dailyJournalContent: null,
    });
    expect(rendered).toContain("- Journal synthesis: failed (write error)");
  });

  it("ok=false stage_b_null → 'Stage B did not run' failed line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: false, reason: "stage_b_null" },
      },
      dailyJournalContent: null,
    });
    expect(rendered).toContain("- Journal synthesis: failed (Stage B did not run)");
  });

  it("ok='complete' but daily file missing → tail-risk failure line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: "complete" },
      },
      dailyJournalContent: null,
    });
    expect(rendered).toContain(
      "- Journal synthesis: failed (composer reported complete but daily file is missing)",
    );
  });

  it("ok='partial' but daily file missing → tail-risk partial-missing line", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      stageB: {
        ...STAGE_B_OK,
        dailyWrite: { ok: "partial", partialReason: "frontmatter_tag_missing" },
      },
      dailyJournalContent: null,
    });
    expect(rendered).toContain(
      "- Journal synthesis: failed (composer reported partial but daily file is missing)",
    );
  });

  it("absent dailyWrite falls back to file-presence heuristic (legacy)", () => {
    const rendered = composeMorningRoutineJournalEntry({
      morningDateStr: "2026-05-15",
      yesterdayDateStr: "2026-05-14",
      stageA: STAGE_A_OK,
      // No dailyWrite — pre-§4.11 row shape.
      stageB: STAGE_B_OK,
      dailyJournalContent: DAILY_BODY,
    });
    expect(rendered).toMatch(/- Journal: daily\/2026-05-14\.md \(\d+ lines, 2 projects referenced\)\n/);
  });
});

// ── end-to-end appendMorningRoutineJournalEntry ─────────────────────

describe("appendMorningRoutineJournalEntry — end-to-end", () => {
  let db: Database.Database;
  let dataDir: string;
  let contextDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-mra-"));
    contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "journal"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    mkdirSync(join(contextDir, "journal", "daily"), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedStageRow(values: {
    actionType: string;
    metadata: Record<string, unknown>;
    result?: string;
  }): void {
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, metadata, started_at, completed_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("corr-X", values.actionType, values.result ?? "success", JSON.stringify(values.metadata));
  }

  it("returns stage_a_row_missing when Stage A row is absent", async () => {
    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result).toEqual({ ok: false, reason: "stage_a_row_missing" });
    expect(existsSync(join(contextDir, "journal/agent.md"))).toBe(false);
  });

  it("creates agent/journal.md when absent, writes the H1 header + entry, and snapshots nothing", async () => {
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday", inboxStats: { triaged: 1, movedToScratch: 1, dmConfirmsSent: 0 } },
    });
    seedStageRow({ actionType: STAGE_B_ACTION_TYPE, metadata: {} });
    writeFileSync(join(contextDir, "journal/daily/2026-05-14.md"), DAILY_BODY);

    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);

    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal.startsWith("# Agent journal\n\n## 2026-05-15 morning routine\n")).toBe(true);
    expect(journal).toContain("- Day-type: weekday\n");
    expect(journal).toContain("- Journal: daily/2026-05-14.md");

    const snapshots = db
      .prepare("SELECT COUNT(*) AS n FROM md_file_snapshots WHERE file_path = ?")
      .get("journal/agent") as { n: number };
    expect(snapshots.n).toBe(0);
  });

  it("appends to an existing journal, snapshots the prior content, and notifies write tracker + indexer", async () => {
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday", inboxStats: { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 } },
    });
    writeFileSync(
      join(contextDir, "journal/agent.md"),
      "# Agent journal\n\n## 2026-05-14 morning routine\n- foo\n",
    );

    const markWriting = vi.fn();
    const onIndexable = vi.fn();
    const result = await appendMorningRoutineJournalEntry(
      {
        db,
        contextDir,
        writeTracker: { markWriting },
        onIndexableContextChange: onIndexable,
      },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);

    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain("## 2026-05-14 morning routine\n- foo");
    expect(journal).toContain("## 2026-05-15 morning routine\n");

    const snapshots = db
      .prepare("SELECT trigger, content FROM md_file_snapshots WHERE file_path = ?")
      .all("journal/agent") as Array<{ trigger: string; content: string }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].trigger).toBe("morning_routine_appender");
    expect(snapshots[0].content).toContain("## 2026-05-14 morning routine\n- foo");

    expect(markWriting).toHaveBeenCalledTimes(1);
    expect(onIndexable).toHaveBeenCalledWith("journal/agent.md");
  });

  it("emits the `skipped (no prior-day data)` variant when daily/<yesterday>.md is absent AND yesterday.md is absent (legitimate first-run)", async () => {
    // No `yesterday.md` on disk → orchestrator never dispatched Stage B
    // → `stageBAttempted` resolves to false at the appender boundary.
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday", inboxStats: { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 } },
    });

    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain("- Journal synthesis: skipped (no prior-day data)\n");
  });

  it("emits the `failed (audit row missing — see daemon log)` variant when yesterday.md is present but Stage B row is absent (anomaly path)", async () => {
    // The exact defence-in-depth anomaly path Fix 3 closes: Stage B
    // WAS attempted (yesterday.md is on disk so the orchestrator
    // dispatched it) but no `agent_actions(routine.morning_routine_journal)`
    // row exists. Without the `stageBAttempted` discriminator the
    // appender would mask this as a first-run skip.
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday", inboxStats: { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 } },
    });
    // Simulate the post-rotation state: today.md was rotated to
    // yesterday.md at run start. Body is irrelevant — only existence
    // matters for the `stageBAttempted` derivation.
    writeFileSync(join(contextDir, "state", "yesterday.md"), "# 2026-05-14 (Wednesday)\n");

    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain(
      "- Journal synthesis: failed (audit row missing — see daemon log)\n",
    );
    expect(journal).not.toContain("no prior-day data");
  });

  it("survives invalid metadata JSON without throwing — composer defaults apply", async () => {
    db.prepare(
      `INSERT INTO agent_actions (event_id, action_type, result, metadata, started_at, completed_at)
       VALUES (?, ?, 'success', ?, datetime('now'), datetime('now'))`,
    ).run("corr-X", STAGE_A_ACTION_TYPE, "not-json");

    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain("- Day-type: unknown\n");
    expect(journal).toContain("- Inbox: 0 files triaged, 0 moved to scratch, 0 DM-confirmations sent\n");
  });

  it("calls writeTracker.markWriting independently of onIndexableContextChange (each is optional)", async () => {
    // The two optional callbacks have independent guards (`?.`). Cover
    // the writeTracker-only variant — the no-indexer path would crash
    // silently if the guard were ever changed to call both unconditionally.
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday" },
    });
    const markWriting = vi.fn();
    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir, writeTracker: { markWriting } },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);
    expect(markWriting).toHaveBeenCalledTimes(1);
  });

  it("calls onIndexableContextChange independently of writeTracker", async () => {
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday" },
    });
    const onIndexable = vi.fn();
    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir, onIndexableContextChange: onIndexable },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);
    expect(onIndexable).toHaveBeenCalledWith("journal/agent.md");
  });

  it("aggregates the agent-action breakdown into the Actions line when `agentDayWindow` is supplied", async () => {
    // End-to-end pin for the user-diary refocus: the agent-action
    // breakdown that used to live in the user-facing
    // `daily/<yesterday>.md` `## Actions` section now lands in
    // `agent/journal.md` as a single inline `- Actions: ...` line.
    // Seed three `agent_actions` rows inside yesterday's agent-day
    // window and verify the aggregation surfaces in the rendered
    // block.
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday", inboxStats: { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 } },
    });
    const insertAction = db.prepare(
      `INSERT INTO agent_actions (action_type, result, started_at, completed_at)
       VALUES (?, 'success', ?, ?)`,
    );
    // All three rows fall inside the window `[2026-05-14 04:00:00, 2026-05-15 04:00:00)`.
    insertAction.run("hourly_check", "2026-05-14 05:00:00", "2026-05-14 05:00:00");
    insertAction.run("hourly_check", "2026-05-14 06:00:00", "2026-05-14 06:00:00");
    insertAction.run("evening_review", "2026-05-14 22:00:00", "2026-05-14 22:00:00");

    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: {
          startUtc: "2026-05-14 04:00:00",
          endUtc: "2026-05-15 04:00:00",
        },
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain("- Actions: 3 total (hourly_check: 2, evening_review: 1)\n");
  });

  it("renders `Actions: (none)` when `agentDayWindow` is supplied but the window has zero matching rows", async () => {
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday" },
    });

    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: {
          startUtc: "2026-05-14 04:00:00",
          endUtc: "2026-05-15 04:00:00",
        },
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain("- Actions: (none)\n");
  });

  it("rolls back writeTracker.markWriting and re-throws when the atomic write fails", async () => {
    // Pins the catch arm of the writeFileAtomically try/catch (lines
    // 359-362): on failure, writeTracker.unmark must fire before the
    // error propagates so FS-watch consumers don't observe a phantom
    // "agent wrote this" tag for a write that never landed.
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday" },
    });
    // Force writeFileAtomically to throw EATOMIC_TARGET_SYMLINK by
    // placing a symlink at the journal path before the call. The
    // appender invokes saveSnapshot first (no-op here because no
    // existing journal content), then markWriting, then the atomic
    // write — which sees the pre-existing symlink and refuses.
    const journalAbs = join(contextDir, "journal/agent.md");
    mkdirSync(dirname(journalAbs), { recursive: true });
    const symlinkTarget = join(contextDir, "decoy.md");
    writeFileSync(symlinkTarget, "decoy");
    symlinkSync(symlinkTarget, journalAbs);

    const markWriting = vi.fn();
    const unmark = vi.fn();
    await expect(
      appendMorningRoutineJournalEntry(
        { db, contextDir, writeTracker: { markWriting, unmark } },
        {
          correlationId: "corr-X",
          morningDateStr: "2026-05-15",
          yesterdayDateStr: "2026-05-14",
          agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
        },
      ),
    ).rejects.toThrow(/atomic-write: refusing to overwrite symlink/);
    expect(markWriting).toHaveBeenCalledTimes(1);
    expect(unmark).toHaveBeenCalledTimes(1);
    expect(unmark).toHaveBeenCalledWith(journalAbs);
  });

  it("tolerates a failed snapshot insert without aborting the journal write", async () => {
    seedStageRow({
      actionType: STAGE_A_ACTION_TYPE,
      metadata: { dayType: "weekday" },
    });
    writeFileSync(join(contextDir, "journal/agent.md"), "# Agent journal\n\n## prev\n");
    db.exec("DROP TABLE md_file_snapshots");
    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: "corr-X",
        morningDateStr: "2026-05-15",
        yesterdayDateStr: "2026-05-14",
        agentDayWindow: EMPTY_AGENT_DAY_WINDOW_FOR_TESTS,
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "journal/agent.md"), "utf-8");
    expect(journal).toContain("## 2026-05-15 morning routine\n");
  });
});
