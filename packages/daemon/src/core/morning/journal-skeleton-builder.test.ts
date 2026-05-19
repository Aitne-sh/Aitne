import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  buildJournalSkeleton,
  gatherJournalSkeletonFacts,
  type AgentDayWindowUtc,
  type JournalSkeletonFacts,
  type JournalSkeletonInputs,
  type SkeletonCalendarEvent,
} from "./journal-skeleton-builder.js";

const WINDOW: AgentDayWindowUtc = {
  startUtc: "2026-05-14 04:00:00",
  endUtc: "2026-05-15 04:00:00",
};

function seedAction(
  db: Database.Database,
  values: { actionType: string; result?: string; startedAt: string },
): void {
  db.prepare(
    `INSERT INTO agent_actions (action_type, result, started_at, completed_at)
     VALUES (?, ?, ?, ?)`,
  ).run(values.actionType, values.result ?? "success", values.startedAt, values.startedAt);
}

function seedMessage(
  db: Database.Database,
  values: { role: "user" | "assistant" | "system"; timestamp: string },
): void {
  db.prepare(
    `INSERT INTO messages (role, content, platform, timestamp)
     VALUES (?, ?, ?, ?)`,
  ).run(values.role, "hello", "slack", values.timestamp);
}

function seedDm(
  db: Database.Database,
  values: { summary: string; messageCount: number; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO dm_conversation_log (platform, summary, message_count, created_at)
     VALUES ('slack', ?, ?, ?)`,
  ).run(values.summary, values.messageCount, values.createdAt);
}

describe("gatherJournalSkeletonFacts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns zero counts when the window is empty", () => {
    expect(gatherJournalSkeletonFacts(db, WINDOW)).toEqual({
      totalActions: 0,
      actionsByType: [],
      messagesHandled: 0,
      dmSummaries: [],
    });
  });

  it("counts and groups agent_actions, filters by the window, and orders by count desc then action_type asc", () => {
    seedAction(db, { actionType: "hourly_check", startedAt: "2026-05-14 05:00:00" });
    seedAction(db, { actionType: "hourly_check", startedAt: "2026-05-14 06:00:00" });
    seedAction(db, { actionType: "hourly_check", startedAt: "2026-05-14 07:00:00" });
    seedAction(db, { actionType: "morning_routine", startedAt: "2026-05-14 04:01:00" });
    seedAction(db, { actionType: "evening_review", startedAt: "2026-05-14 23:00:00" });
    seedAction(db, { actionType: "evening_review", startedAt: "2026-05-14 23:30:00" });
    // before window
    seedAction(db, { actionType: "should_be_dropped", startedAt: "2026-05-14 03:59:00" });
    // after window
    seedAction(db, { actionType: "should_be_dropped", startedAt: "2026-05-15 04:00:00" });

    const facts = gatherJournalSkeletonFacts(db, WINDOW);
    expect(facts.totalActions).toBe(6);
    expect(facts.actionsByType).toEqual([
      { actionType: "hourly_check", count: 3 },
      { actionType: "evening_review", count: 2 },
      { actionType: "morning_routine", count: 1 },
    ]);
  });

  it("counts only incoming `role='user'` messages within the window (rev2 semantic — assistant + system excluded)", () => {
    // rev2 (2026-05-15) — `messages_handled` was narrowed to incoming
    // user messages only. Use TWO in-window user rows + ONE in-window
    // assistant row so the expected count (2) differs from the count
    // any single-role mutation would produce:
    //   - `role = 'user'`            → 2 ✓
    //   - `role = 'assistant'`       → 1 ✗ (would silently pass with `.toBe(1)`)
    //   - `role IN ('user','asst')`  → 3
    //   - `role = 'system'`          → 1
    //   - missing window predicate   → 3 (one user before window)
    // Combined with the "agent-replies-only → 0" defence-in-depth test
    // below, every plausible SQL mutation produces a failing assertion
    // somewhere.
    seedMessage(db, { role: "user", timestamp: "2026-05-14 10:00:00" });
    seedMessage(db, { role: "user", timestamp: "2026-05-14 11:00:00" });
    seedMessage(db, { role: "assistant", timestamp: "2026-05-14 10:01:00" });
    seedMessage(db, { role: "system", timestamp: "2026-05-14 10:02:00" });
    seedMessage(db, { role: "user", timestamp: "2026-05-14 03:30:00" }); // before window
    expect(gatherJournalSkeletonFacts(db, WINDOW).messagesHandled).toBe(2);
  });

  it("returns 0 when the only in-window messages are agent replies (defence-in-depth on rev2 semantic)", () => {
    // A day where the agent posts proactively (notifications, routine
    // outcomes, etc.) but the user never types back should land
    // `messages_handled: 0`. The bullet `## DM (rolling summary)`
    // section may still carry agent-initiated entries; the frontmatter
    // count is strictly the user's outbound side. Pin this so a future
    // "include agent-initiated DMs in handled count" refactor would
    // need an explicit override of two tests, not one.
    seedMessage(db, { role: "assistant", timestamp: "2026-05-14 10:00:00" });
    seedMessage(db, { role: "assistant", timestamp: "2026-05-14 11:00:00" });
    seedMessage(db, { role: "system", timestamp: "2026-05-14 11:30:00" });
    expect(gatherJournalSkeletonFacts(db, WINDOW).messagesHandled).toBe(0);
  });

  it("returns DM rolling summaries oldest-first within the window", () => {
    seedDm(db, { summary: "second", messageCount: 4, createdAt: "2026-05-14 14:00:00" });
    seedDm(db, { summary: "first", messageCount: 2, createdAt: "2026-05-14 11:00:00" });
    seedDm(db, { summary: "out-of-window", messageCount: 1, createdAt: "2026-05-15 04:00:00" });

    const facts = gatherJournalSkeletonFacts(db, WINDOW);
    expect(facts.dmSummaries.map((row) => row.summary)).toEqual(["first", "second"]);
    expect(facts.dmSummaries[0]).toMatchObject({
      summary: "first",
      messageCount: 2,
      createdAt: "2026-05-14 11:00:00",
    });
  });

  it("breaks ties on equal counts by action_type ASC (so the rendered order is deterministic)", () => {
    // Two action_types with identical counts must sort alphabetically.
    // Without the secondary key, SQLite's order would be arbitrary and
    // the skeleton's Actions section would render non-deterministically.
    seedAction(db, { actionType: "zebra_check", startedAt: "2026-05-14 05:00:00" });
    seedAction(db, { actionType: "zebra_check", startedAt: "2026-05-14 06:00:00" });
    seedAction(db, { actionType: "alpha_check", startedAt: "2026-05-14 07:00:00" });
    seedAction(db, { actionType: "alpha_check", startedAt: "2026-05-14 08:00:00" });
    const facts = gatherJournalSkeletonFacts(db, WINDOW);
    expect(facts.actionsByType).toEqual([
      { actionType: "alpha_check", count: 2 },
      { actionType: "zebra_check", count: 2 },
    ]);
  });

  it("breaks DM ties on equal createdAt by id ASC (insert order)", () => {
    // Two rolling summaries written in the same SQLite second must
    // surface in insert order, not in storage-layout order. The agent
    // dispatches several DMs in the same minute regularly, so this is
    // not a theoretical concern.
    seedDm(db, { summary: "older-insert", messageCount: 1, createdAt: "2026-05-14 11:00:00" });
    seedDm(db, { summary: "newer-insert", messageCount: 1, createdAt: "2026-05-14 11:00:00" });
    expect(
      gatherJournalSkeletonFacts(db, WINDOW).dmSummaries.map((row) => row.summary),
    ).toEqual(["older-insert", "newer-insert"]);
  });
});

const BASE_INPUTS: JournalSkeletonInputs = {
  dateStr: "2026-05-14",
  weekday: "Wednesday",
  // Today's agent-day — what the daemon stamps into the `updated:`
  // frontmatter slot when the morning routine runs at 04:00 on 2026-05-15
  // (the day-after of `dateStr`). Tests pin the exact byte the validator
  // checks against on Stage B's PUT, so picking a fixed value here keeps
  // every assertion deterministic regardless of system clock.
  updatedDateStr: "2026-05-15",
  yesterdayMd: null,
  calendarEvents: [],
};

const EMPTY_FACTS: JournalSkeletonFacts = {
  totalActions: 0,
  actionsByType: [],
  messagesHandled: 0,
  dmSummaries: [],
};

function expectFrontmatterPreserved(rendered: string): void {
  // The skeleton-owned frontmatter block is what `/api/context/daily/<date>`
  // validates byte-for-byte. The assertion pins the exact ordering and
  // formatting. `updated:` was promoted from Stage-B-owned to
  // skeleton-owned because the generic context-frontmatter validator
  // requires it on every `daily/*.md` PUT — leaving it as an empty
  // placeholder produced a hard 422 every morning.
  expect(rendered.startsWith("---\n")).toBe(true);
  const frontEnd = rendered.indexOf("---", 4);
  expect(frontEnd).toBeGreaterThan(0);
  const block = rendered.slice(0, frontEnd + 3);
  expect(block).toContain("\ndate: 2026-05-14\n");
  expect(block).toContain("\nweekday: Wednesday\n");
  expect(block).toContain("\ntype: daily\n");
  expect(block).toContain("\nowner: agent\n");
  expect(block).toContain("\nagent_generated: true\n");
  expect(block).toContain("\ncalendar_events: ");
  expect(block).toContain("\nmessages_handled: ");
  expect(block).toContain("\nupdated: 2026-05-15\n");
}

describe("buildJournalSkeleton — frontmatter + headings", () => {
  it("emits the eight skeleton-owned frontmatter fields in fixed order", () => {
    const rendered = buildJournalSkeleton(BASE_INPUTS, EMPTY_FACTS);
    expectFrontmatterPreserved(rendered);
    expect(rendered).toContain("# 2026-05-14 (Wednesday)\n");
  });

  it("declares Stage-B-owned frontmatter slots as empty placeholders", () => {
    const rendered = buildJournalSkeleton(BASE_INPUTS, EMPTY_FACTS);
    expect(rendered).toContain("agent_last_synced_at:");
    expect(rendered).toContain("content_hash:");
    expect(rendered).toContain("projects: []");
    expect(rendered).toContain("people: []");
    expect(rendered).toContain("tags: []");
  });

  it("renders calendar_events / messages_handled counts from inputs + facts", () => {
    const events: SkeletonCalendarEvent[] = [
      { time: "10:00", title: "Standup" },
      { time: "14:00", title: "Design review" },
    ];
    const facts: JournalSkeletonFacts = { ...EMPTY_FACTS, messagesHandled: 7 };
    const rendered = buildJournalSkeleton({ ...BASE_INPUTS, calendarEvents: events }, facts);
    expect(rendered).toContain("calendar_events: 2");
    expect(rendered).toContain("messages_handled: 7");
  });
});

describe("buildJournalSkeleton — body sections", () => {
  it("renders ## Schedule with timed and all-day events", () => {
    const events: SkeletonCalendarEvent[] = [
      { time: "10:00", title: "Standup" },
      { time: null, title: "Focus block" },
    ];
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, calendarEvents: events },
      EMPTY_FACTS,
    );
    expect(rendered).toMatch(/## Schedule\n- 10:00 — Standup\n- Focus block\n/);
  });

  it("renders ## Schedule with `(none)` when no events", () => {
    const rendered = buildJournalSkeleton(BASE_INPUTS, EMPTY_FACTS);
    expect(rendered).toMatch(/## Schedule\n- \(none\)\n/);
  });

  it("falls back to `(untitled)` for empty / whitespace titles", () => {
    const events: SkeletonCalendarEvent[] = [
      { time: "09:30", title: "   " },
      { time: null, title: "" },
    ];
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, calendarEvents: events },
      EMPTY_FACTS,
    );
    expect(rendered).toMatch(/- 09:30 — \(untitled\)\n/);
    expect(rendered).toMatch(/- \(untitled\)\n/);
  });

  it("renders ## Tasks from yesterday's ## User Tasks (checkbox markers stripped, `(none)` filtered)", () => {
    const yesterdayMd = [
      "# 2026-05-13 (Tuesday)",
      "",
      "## User Tasks",
      "- [ ] Mail Alex back",
      "- [x] Filed Q1 retro",
      "- plain bullet",
      "- (none)",
      "",
      "## Agent Plan",
      "- 10:00 — Standup → notify",
    ].join("\n");
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, yesterdayMd },
      EMPTY_FACTS,
    );
    expect(rendered).toContain("## Tasks\n- Mail Alex back\n- Filed Q1 retro\n- plain bullet\n");
    expect(rendered).not.toContain("## Tasks\n- (none)");
  });

  it("renders ## Tasks with `(none)` when yesterday.md has no User Tasks section", () => {
    const yesterdayMd = ["# 2026-05-13", "## Agent Log", "- something"].join("\n");
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, yesterdayMd },
      EMPTY_FACTS,
    );
    expect(rendered).toMatch(/## Tasks\n- \(none\)\n/);
  });

  it("handles uppercase `- [X]` checkbox marker in addition to `- [x]` and `- [ ]`", () => {
    // The regex `^- (?:\[[ xX]\] )?(.*)$` allows both lowercase and
    // uppercase X. Operators handwriting `- [X]` in yesterday.md
    // shouldn't have the marker leak into the rendered task.
    const yesterdayMd = ["## User Tasks", "- [X] Done with uppercase mark"].join("\n");
    const rendered = buildJournalSkeleton({ ...BASE_INPUTS, yesterdayMd }, EMPTY_FACTS);
    expect(rendered).toContain("## Tasks\n- Done with uppercase mark\n");
    expect(rendered).not.toContain("- [X]");
  });

  it("renders ## Tasks `(none)` when `## User Tasks` is immediately followed by the next H2 (empty section)", () => {
    const yesterdayMd = [
      "## User Tasks",
      "## Agent Log",
      "- noise",
    ].join("\n");
    const rendered = buildJournalSkeleton({ ...BASE_INPUTS, yesterdayMd }, EMPTY_FACTS);
    expect(rendered).toMatch(/## Tasks\n- \(none\)\n/);
  });

  it("extracts ## User Tasks bullets from a CRLF-terminated yesterday.md (parallel with handoff-parser)", () => {
    // Same module-boundary contract as parseHandoff: the strict `===`
    // header match would silently fail against `"## User Tasks\r"`,
    // dropping every task. Pin CRLF tolerance here so a future
    // refactor that re-introduces an LF-only split surfaces as a
    // failing test, not a silently empty `## Tasks` section in the
    // user-facing daily journal.
    const yesterdayMd = [
      "# 2026-05-13 (Tuesday)",
      "",
      "## User Tasks",
      "- [ ] Mail Alex back",
      "- File Q1 retro",
      "",
      "## Agent Log",
      "- noise",
    ].join("\r\n");
    const rendered = buildJournalSkeleton({ ...BASE_INPUTS, yesterdayMd }, EMPTY_FACTS);
    expect(rendered).toContain("## Tasks\n- Mail Alex back\n- File Q1 retro\n");
  });

  it("skips empty checkbox bullets like `- ` and `- [ ] ` (whitespace-only items)", () => {
    const yesterdayMd = [
      "## User Tasks",
      "- ",
      "- [ ] ",
      "- real task",
    ].join("\n");
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, yesterdayMd },
      EMPTY_FACTS,
    );
    expect(rendered).toContain("## Tasks\n- real task\n");
  });

  it("renders ## Tasks with `(none)` when yesterday.md is null (initial flow)", () => {
    const rendered = buildJournalSkeleton(BASE_INPUTS, EMPTY_FACTS);
    expect(rendered).toMatch(/## Tasks\n- \(none\)\n/);
  });

  it("does NOT emit a `## Actions` scratch section (agent-action breakdown moved to agent/journal.md)", () => {
    // The user-diary refocus dropped `## Actions` from the daily
    // journal — agent-action counts are an agent-side footprint, not
    // a user-diary fact. They live in `agent/journal.md` via the
    // appender's inline `- Actions: ...` line. Pin the absence here so
    // any regression that re-introduces an agent-centric body section
    // into the user-facing journal surfaces immediately.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      totalActions: 6,
      actionsByType: [
        { actionType: "hourly_check", count: 3 },
        { actionType: "evening_review", count: 2 },
        { actionType: "morning_routine", count: 1 },
      ],
    };
    const rendered = buildJournalSkeleton(BASE_INPUTS, facts);
    expect(rendered).not.toMatch(/^## Actions$/m);
    expect(rendered).not.toContain("hourly_check: 3");
  });

  it("renders ## Conversations summaries with HH:MM extracted from createdAt", () => {
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "Q2 OKR\n  follow-up", messageCount: 4, createdAt: "2026-05-14 11:30:00" },
      ],
    };
    const rendered = buildJournalSkeleton(BASE_INPUTS, facts);
    expect(rendered).toContain("## Conversations\n- 11:30: Q2 OKR follow-up (n=4)\n");
  });

  it("extracts HH:MM from an ISO-8601 createdAt (`YYYY-MM-DDTHH:MM:SS.sssZ`)", () => {
    // SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS`, but a
    // future migration / direct INSERT might land an ISO string. The
    // regex is `(\d{2}):(\d{2})` so it scans past the date portion
    // (`2026-05-14` has no `H:M` shape) and matches the first time
    // component — pin that here so an ISO row doesn't surface as `??:??`.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "iso-form row", messageCount: 1, createdAt: "2026-05-14T11:30:00.000Z" },
      ],
    };
    const rendered = buildJournalSkeleton(BASE_INPUTS, facts);
    expect(rendered).toContain("## Conversations\n- 11:30: iso-form row (n=1)\n");
  });

  it("collapses internal whitespace runs (tabs, multiple newlines) inside a Conversations summary to a single space", () => {
    // `summary.replace(/\s+/g, " ").trim()` — pin both directions so a
    // multi-line summary written by a future agent doesn't break the
    // bullet's single-line layout.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        {
          summary: "  pre   tabs\t\there\n\nand newlines  ",
          messageCount: 2,
          createdAt: "2026-05-14 09:15:00",
        },
      ],
    };
    const rendered = buildJournalSkeleton(BASE_INPUTS, facts);
    expect(rendered).toContain("## Conversations\n- 09:15: pre tabs here and newlines (n=2)\n");
  });

  it("renders ## Conversations `??:??` when createdAt does not look like a timestamp", () => {
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [{ summary: "x", messageCount: 1, createdAt: "not-a-time" }],
    };
    const rendered = buildJournalSkeleton(BASE_INPUTS, facts);
    expect(rendered).toContain("## Conversations\n- ??:??: x (n=1)\n");
  });

  it("renders ## Conversations bullets in the user's local timezone when one is supplied", () => {
    // The skeleton's ## Conversations section is the scratch input
    // Stage B reshapes into the user-facing daily journal. A Tokyo
    // user (UTC+9) looking at a SQLite-stored `02:30:00` UTC DM must
    // see `11:30` in their journal — not `02:30`. Without TZ awareness
    // the bullet is 9 hours off; pin both the happy path and the
    // wrap-around case where the UTC date is the morning of
    // yesterday's agent-day.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        // 02:30 UTC on May 14 → 11:30 local on May 14 in Tokyo.
        { summary: "Q2 OKR follow-up", messageCount: 4, createdAt: "2026-05-14 02:30:00" },
        // 22:00 UTC on May 13 → 07:00 local on May 14 in Tokyo
        // (wraps a calendar day on the UTC side).
        { summary: "early-morning ping", messageCount: 1, createdAt: "2026-05-13 22:00:00" },
      ],
    };
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, timezone: "Asia/Tokyo" },
      facts,
    );
    expect(rendered).toContain("## Conversations\n- 11:30: Q2 OKR follow-up (n=4)\n");
    expect(rendered).toContain("- 07:00: early-morning ping (n=1)\n");
  });

  it("renders ## Conversations bullets in TZ when the createdAt has SQLite subsecond fraction (`YYYY-MM-DD HH:MM:SS.SSS`)", () => {
    // SQLite's `datetime('now', 'subsec')` mode (and any migration
    // that enables it) emits a `.SSS` suffix. The TZ path's shape
    // regex accepts the optional fraction so the timestamp is
    // promoted to ISO (`...T...Z`) rather than falling to
    // `Date.parse` on the space-separated form, which is
    // implementation-defined (may parse as local). Pin Tokyo to
    // verify the UTC interpretation survives the wider regex.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "subsec row", messageCount: 1, createdAt: "2026-05-14 02:30:00.456" },
      ],
    };
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, timezone: "Asia/Tokyo" },
      facts,
    );
    expect(rendered).toContain("- 11:30: subsec row (n=1)\n");
  });

  it("renders ## Conversations bullets in TZ when the createdAt is in ISO-8601 form (`...Z`)", () => {
    // Some future code path may write `datetime('now', 'subsec')`-style
    // ISO timestamps. The TZ path must still localise correctly.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "iso row", messageCount: 1, createdAt: "2026-05-14T02:30:00.000Z" },
      ],
    };
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, timezone: "Asia/Tokyo" },
      facts,
    );
    expect(rendered).toContain("- 11:30: iso row (n=1)\n");
  });

  it("falls back to the UTC slice when the TZ name is unrecognised — pure builder never throws past the boundary", () => {
    // `Intl.DateTimeFormat` throws `RangeError` on `"Atlantis/Lost"`.
    // The renderer catches it and falls back to the slice path so the
    // skeleton stays renderable. Stage B sees UTC HH:MM with a bad TZ
    // setting, which is the same shape it saw before the TZ feature
    // landed — a degradation, not a crash.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "bad-tz row", messageCount: 1, createdAt: "2026-05-14 02:30:00" },
      ],
    };
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, timezone: "Atlantis/Lost" },
      facts,
    );
    expect(rendered).toContain("- 02:30: bad-tz row (n=1)\n");
  });

  it("falls back to the UTC slice when the createdAt is itself unparseable (Number.isFinite branch)", () => {
    // Date.parse on a junk string returns NaN — the TZ formatter would
    // throw, so the renderer must fall back to the UTC slice path. The
    // empty placeholder still shows up in the bullet so Stage B sees the
    // row rather than dropping it silently.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "junk timestamp", messageCount: 1, createdAt: "not-a-date" },
      ],
    };
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, timezone: "Asia/Tokyo" },
      facts,
    );
    // UTC slice of "not-a-date" yields the substring before any space —
    // "not-a-d" is meaningless but proves the catch / fallback branch
    // routed through `Number.isFinite(ms) → false`.
    expect(rendered).toMatch(/junk timestamp/);
  });

  it("treats an empty-string timezone as `undefined` and slices UTC verbatim", () => {
    // The TZ branch fires only on `timezone.length > 0`. Pin the
    // empty-string opt-out so a wiring bug that passes `""` doesn't
    // unintentionally exercise the catch path.
    const facts: JournalSkeletonFacts = {
      ...EMPTY_FACTS,
      dmSummaries: [
        { summary: "empty-tz row", messageCount: 1, createdAt: "2026-05-14 02:30:00" },
      ],
    };
    const rendered = buildJournalSkeleton(
      { ...BASE_INPUTS, timezone: "" },
      facts,
    );
    expect(rendered).toContain("- 02:30: empty-tz row (n=1)\n");
  });

  it("renders ## Conversations with `(none)` when no summaries in the window", () => {
    const rendered = buildJournalSkeleton(BASE_INPUTS, EMPTY_FACTS);
    expect(rendered).toMatch(/## Conversations\n- \(none\)\n/);
  });

  it("emits a scratch-body marker comment instead of a `## Summary` placeholder (Stage B authors entire body per template)", () => {
    // Stage B authors the full user-diary body per
    // rules/journal-format.md (Title / Summary / Schedule / Tasks /
    // Conversations). A `## Summary` placeholder would mislead Stage
    // B into thinking Summary is its only writing duty. Pin the
    // scratch comment + assert no Summary header is emitted by the
    // skeleton.
    const rendered = buildJournalSkeleton(BASE_INPUTS, EMPTY_FACTS);
    expect(rendered).toContain("<!-- Stage B: author the body per rules/journal-format.md.");
    expect(rendered).toContain("scratch data from the daemon");
    expect(rendered).toContain("Replace the");
    expect(rendered).toContain("entire body wholesale");
    expect(rendered).not.toMatch(/^## Summary$/m);
  });

  it("does NOT emit `## Summary` as an authored section header anywhere in the skeleton", () => {
    // Defence in depth: a section-header drift that re-introduces
    // `## Summary` (e.g. a copy-paste from the rev1 design) would
    // silently re-bias Stage B back to Summary-only authorship. The
    // multiline-anchored regex (`/^## Summary$/m`) catches header
    // lines while letting the journal-format.md spec reference
    // ("...follow rules/journal-format.md ## Summary...") survive in
    // skill prose elsewhere.
    const rendered = buildJournalSkeleton(
      {
        ...BASE_INPUTS,
        calendarEvents: [{ time: "10:00", title: "Standup" }],
        yesterdayMd: "## User Tasks\n- [ ] foo\n",
      },
      { ...EMPTY_FACTS, totalActions: 1, actionsByType: [{ actionType: "x", count: 1 }] },
    );
    expect(rendered).not.toMatch(/^## Summary$/m);
  });
});

describe("buildJournalSkeleton — full snapshot", () => {
  it("matches a stable byte sequence for representative inputs (golden fixture)", () => {
    const inputs: JournalSkeletonInputs = {
      dateStr: "2026-05-14",
      weekday: "Wednesday",
      updatedDateStr: "2026-05-15",
      yesterdayMd: [
        "# 2026-05-13 (Tuesday)",
        "",
        "## User Tasks",
        "- [ ] Mail Alex back",
        "- [x] File Q1 retro",
        "",
        "## Agent Log",
        "- 04:00 Morning Routine completed (day-type: weekday)",
      ].join("\n"),
      calendarEvents: [
        { time: "10:00", title: "Standup" },
        { time: "14:00", title: "Design review" },
      ],
    };
    const facts: JournalSkeletonFacts = {
      totalActions: 6,
      actionsByType: [
        { actionType: "hourly_check", count: 3 },
        { actionType: "evening_review", count: 2 },
        { actionType: "morning_routine", count: 1 },
      ],
      messagesHandled: 7,
      dmSummaries: [
        { summary: "Q2 OKR follow-up", messageCount: 4, createdAt: "2026-05-14 11:30:00" },
      ],
    };
    const rendered = buildJournalSkeleton(inputs, facts);
    expect(rendered).toBe(
      [
        "---",
        "date: 2026-05-14",
        "weekday: Wednesday",
        "type: daily",
        "owner: agent",
        "agent_generated: true",
        "calendar_events: 2",
        "messages_handled: 7",
        "updated: 2026-05-15",
        "agent_last_synced_at:",
        "content_hash:",
        "projects: []",
        "people: []",
        "tags: []",
        "---",
        "",
        "# 2026-05-14 (Wednesday)",
        "",
        "<!-- Stage B: author the body per rules/journal-format.md.",
        "     The sections below are scratch data from the daemon —",
        "     use them as input, not as final output. Replace the",
        "     entire body wholesale. Only the frontmatter (above)",
        "     is byte-for-byte preserved. -->",
        "",
        "## Schedule",
        "- 10:00 — Standup",
        "- 14:00 — Design review",
        "",
        "## Tasks",
        "- Mail Alex back",
        "- File Q1 retro",
        "",
        "## Conversations",
        "- 11:30: Q2 OKR follow-up (n=4)",
        "",
      ].join("\n"),
    );
  });
});
