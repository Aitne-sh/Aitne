/**
 * Phase 2 cross-module golden fixture — exercises all four daemon
 * primitives end-to-end against representative inputs and asserts the
 * outputs match the current monolithic session's byte-format contract.
 *
 * Spec: `docs/design/appendices/morning-routine-optimization.md`
 * §"Phased implementation plan" Phase 2: "Verify against the current
 * monolithic session's outputs as golden fixtures."
 *
 * The current monolithic session's user-facing artifacts that the
 * split must preserve byte-for-byte:
 *
 *   1. `agent/journal.md` Step 9 paragraph block — 1 H2 header + 5
 *      bullets. `pnpm audit` parses this verbatim.
 *   2. `agent_actions` parent row keyed `routine.morning_routine` — the
 *      pre-routine gate's `morningRoutineRanToday` SELECTs on this
 *      action_type string.
 *
 * The daemon-prep artifacts (handoff JSON, journal skeleton MD) are
 * NOT user-facing in Phase 2 — they become prompt-injection blocks for
 * Stage A / Stage B in Phase 5/6. The golden test pins their shape so
 * Phase 5/6 wiring picks them up without further drift.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { parseHandoff } from "./handoff-parser.js";
import {
  buildJournalSkeleton,
  gatherJournalSkeletonFacts,
  type AgentDayWindowUtc,
} from "./journal-skeleton-builder.js";
import {
  appendMorningRoutineJournalEntry,
  STAGE_A_ACTION_TYPE,
  STAGE_B_ACTION_TYPE,
} from "./agent-journal-appender.js";
import {
  emitMorningRoutineParentAuditRow,
  PARENT_AUDIT_ACTION_TYPE,
} from "./parent-audit-emitter.js";

const CORRELATION_ID = "corr-morning-2026-05-15";
const MORNING_DATE = "2026-05-15";
const YESTERDAY_DATE = "2026-05-14";

const YESTERDAY_MD = [
  "# 2026-05-14 (Wednesday)",
  "",
  "## User Schedule",
  "- 10:00 — Standup",
  "- 14:00 — Design review",
  "",
  "## User Tasks",
  "- [ ] Mail Alex back",
  "- [x] Filed Q1 retro",
  "",
  "## Agent Plan",
  "- [ ] 14:30 — Pre-brief design review [work] → DM",
  "",
  "## Agent Log",
  "- 04:00 Morning Routine completed (day-type: weekday)",
  "",
  "## Handoff",
  "### Tomorrow",
  "- Mail Alex back",
  "- Confirm Q2 OKRs with the team",
  "### Later",
  "- 2026-05-20 Quarterly review prep",
  "",
].join("\n");

const DAILY_MD = [
  "---",
  "date: 2026-05-14",
  "weekday: Wednesday",
  "type: daily",
  "owner: agent",
  "agent_generated: true",
  "calendar_events: 2",
  "messages_handled: 7",
  "agent_last_synced_at: 2026-05-15T04:01:30Z",
  "content_hash: sha256:abc123",
  "projects: [launch-prep, q2-okrs, hire-pipeline]",
  "people: [alex, mei]",
  "tags: [routine, review]",
  "---",
  "",
  "# 2026-05-14 (Wednesday)",
  "",
  "## Summary",
  "I shipped the morning-routine pipeline split and confirmed Q2 OKRs with Alex.",
  "",
  "## Schedule",
  "- 10:00 — Standup (attended)",
  "- 14:00 — Design review (attended)",
  "",
  "## What moved forward",
  "- Cut over journal skeleton to deterministic frontmatter.",
  "- Drafted Stage A task-flow rewrite.",
  "",
  "## Tomorrow hook",
  "Pre-brief the 14:00 design review.",
  "",
].join("\n");

const WINDOW: AgentDayWindowUtc = {
  // Agent-day 2026-05-14 starts 04:00 local → for UTC test let's pin a window
  // that matches the inserted rows verbatim. Real wiring will derive this
  // from `dayBoundaryHour` + `timezone`; the module just consumes the pair.
  startUtc: "2026-05-14 04:00:00",
  endUtc: "2026-05-15 04:00:00",
};

describe("morning-routine pipeline golden fixture (Phase 2)", () => {
  let db: Database.Database;
  let dataDir: string;
  let contextDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "pa-mp-"));
    contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "agent"), { recursive: true });
    mkdirSync(join(contextDir, "daily"), { recursive: true });
    writeFileSync(join(contextDir, `daily/${YESTERDAY_DATE}.md`), DAILY_MD);
    seedPipelineRows(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("parseHandoff produces structured arrays the orchestrator can inject as <handoff_parsed>", () => {
    expect(parseHandoff(YESTERDAY_MD)).toEqual({
      tomorrow: ["Mail Alex back", "Confirm Q2 OKRs with the team"],
      later: ["2026-05-20 Quarterly review prep"],
    });
  });

  it("buildJournalSkeleton renders the deterministic frontmatter Stage B must preserve byte-for-byte", () => {
    const facts = gatherJournalSkeletonFacts(db, WINDOW);
    const skeleton = buildJournalSkeleton(
      {
        dateStr: YESTERDAY_DATE,
        weekday: "Wednesday",
        updatedDateStr: MORNING_DATE,
        yesterdayMd: YESTERDAY_MD,
        calendarEvents: [
          { time: "10:00", title: "Standup" },
          { time: "14:00", title: "Design review" },
        ],
      },
      facts,
    );
    // Frontmatter block — every line in this set is the contract Stage
    // B's PUT to /api/context/daily/<date> must echo. Byte-for-byte.
    expect(skeleton).toContain("\ndate: 2026-05-14\n");
    expect(skeleton).toContain("\nweekday: Wednesday\n");
    expect(skeleton).toContain("\ntype: daily\n");
    expect(skeleton).toContain("\nowner: agent\n");
    expect(skeleton).toContain("\nagent_generated: true\n");
    expect(skeleton).toContain("\ncalendar_events: 2\n");
    expect(skeleton).toContain(`\nmessages_handled: ${facts.messagesHandled}\n`);
    // `updated:` is what the generic context-frontmatter validator
    // requires on every daily/*.md PUT. Daemon-emitting today's date
    // (MORNING_DATE) closes the gap where Stage B would otherwise have
    // to fill the slot — the legacy task-flow guidance for the
    // placeholder version was missing, so Stage B PUTs silently 422'd.
    expect(skeleton).toContain(`\nupdated: ${MORNING_DATE}\n`);
    // Stage-B-owned slots must be present as placeholders.
    expect(skeleton).toContain("\nprojects: []\n");
    expect(skeleton).toContain("\npeople: []\n");
    expect(skeleton).toContain("\ntags: []\n");
    // Body sections — pre-aggregated facts visible to Stage B.
    expect(skeleton).toContain("## Tasks\n- Mail Alex back\n- Filed Q1 retro\n");
    expect(skeleton).toContain("## Schedule\n- 10:00 — Standup\n- 14:00 — Design review\n");
    expect(skeleton).toContain("## Conversations\n");
    // Stage B authors the entire body per rules/journal-format.md;
    // the skeleton emits a scratch-body marker, NOT a `## Summary`
    // placeholder header. Pin both directions so a refactor that
    // re-adds the header surfaces here.
    expect(skeleton).toContain("<!-- Stage B: author the body per rules/journal-format.md.");
    expect(skeleton).not.toMatch(/^## Summary$/m);
    // User-diary refocus: `## Actions` is no longer a scratch
    // section — the agent-action breakdown lives in
    // `agent/journal.md` via the appender. Pin the absence so a
    // regression that re-emits agent telemetry into the user-facing
    // journal surfaces here.
    expect(skeleton).not.toMatch(/^## Actions$/m);
    expect(skeleton).not.toContain("hourly_check: ");
  });

  it("appendMorningRoutineJournalEntry emits the Step-9 byte-shape the current task-flow produces", async () => {
    const result = await appendMorningRoutineJournalEntry(
      { db, contextDir },
      {
        correlationId: CORRELATION_ID,
        morningDateStr: MORNING_DATE,
        yesterdayDateStr: YESTERDAY_DATE,
        agentDayWindow: WINDOW,
      },
    );
    expect(result.ok).toBe(true);
    const journal = readFileSync(join(contextDir, "agent/journal.md"), "utf-8");
    // Exact bytes the current Step 9 template emits, anchored at the
    // H2 line. `pnpm audit` parses each `- <field>:` line; do not
    // reorder or rename without updating audit.
    //
    // `seedPipelineRows` inserts 19 hourly_check rows
    // (`for h = 5..23 { ... }`) plus the Stage A
    // `routine.morning_routine_today` row inside the agent-day
    // window — total 20 actions across 2 distinct types. The Stage B
    // row's started_at falls in the morning-of next day (window
    // exclusive at 04:00:00 endUtc), so it doesn't count.
    expect(journal).toContain(
      [
        "## 2026-05-15 morning routine",
        "- Day-type: weekday",
        "- Journal: daily/2026-05-14.md (16 lines, 3 projects referenced)",
        "- Inbox: 4 files triaged, 4 moved to scratch, 1 DM-confirmations sent",
        "- Actions: 19 total (hourly_check: 19)",
        "- Checks from routines/morning.md: water bottle filled, calendar synced",
        "- Anomalies / skipped steps: pre-pass partial (gmail)",
        "",
      ].join("\n"),
    );
    expect(journal.startsWith("# Agent journal\n\n")).toBe(true);
  });

  it("emitMorningRoutineParentAuditRow INSERTs the row the pre-routine gate reads", () => {
    const result = emitMorningRoutineParentAuditRow(db, {
      correlationId: CORRELATION_ID,
      stageA: { cost_usd: 0.32, num_turns: 12, result: "success" },
      stageB: { cost_usd: 0.07, num_turns: 5, result: "success" },
      todayMdHealth: "fresh",
      startedAt: new Date("2026-05-15T04:00:00.000Z"),
      completedAt: new Date("2026-05-15T04:02:11.000Z"),
    });
    expect(result.emitted).toBe(true);
    // Replay what `morningRoutineRanToday` checks: SELECT WHERE
    // action_type='routine.morning_routine' AND result='success'. The
    // pre-routine gate is keyed on this exact string — drift here
    // silently kills the gate.
    const gateRow = db
      .prepare(
        `SELECT action_type, result
           FROM agent_actions
          WHERE action_type = ? AND result = 'success'
            AND event_id = ?`,
      )
      .get(PARENT_AUDIT_ACTION_TYPE, CORRELATION_ID) as
      | { action_type: string; result: string }
      | undefined;
    expect(gateRow).toEqual({
      action_type: "routine.morning_routine",
      result: "success",
    });
  });

  it("returns a stable skip reason when Stage A failed — pre-routine gate stays unfired", () => {
    const result = emitMorningRoutineParentAuditRow(db, {
      correlationId: CORRELATION_ID,
      stageA: { cost_usd: 0.32, num_turns: 12, result: "failed" },
      stageB: null,
      todayMdHealth: "fresh",
      startedAt: new Date("2026-05-15T04:00:00.000Z"),
      completedAt: new Date("2026-05-15T04:02:11.000Z"),
    });
    expect(result).toEqual({ emitted: false, reason: "stage_a_not_success" });
    const gateRow = db
      .prepare("SELECT id FROM agent_actions WHERE action_type = ? AND event_id = ?")
      .get(PARENT_AUDIT_ACTION_TYPE, CORRELATION_ID);
    expect(gateRow).toBeUndefined();
  });
});

/**
 * Seed the action rows + activity that Phase 5+ would land while the
 * pipeline runs:
 *   - 1 Stage A row with full Stage A metadata (dayType, anomalies,
 *     inboxStats, morningChecks).
 *   - 1 Stage B row carrying the success terminal state.
 *   - A handful of hourly_check / evening_review rows to give the
 *     skeleton builder non-zero Actions counts.
 *   - User+assistant messages so messages_handled > 0.
 */
function seedPipelineRows(db: Database.Database): void {
  const stageAMetadata = {
    dayType: "weekday",
    inboxStats: {
      triaged: 4,
      movedToScratch: 4,
      dmConfirmsSent: 1,
      secretsSkipped: 0,
    },
    morningChecks: ["water bottle filled", "calendar synced"],
    anomalies: ["pre-pass partial (gmail)"],
    filesTouched: ["context/today.md", "context/roadmap.md"],
    scheduleBatchSize: 3,
  };
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, result, metadata, started_at, completed_at, cost_usd, num_turns)
     VALUES (?, ?, 'success', ?, '2026-05-15 04:00:01', '2026-05-15 04:01:48', 0.32, 12)`,
  ).run(CORRELATION_ID, STAGE_A_ACTION_TYPE, JSON.stringify(stageAMetadata));
  db.prepare(
    `INSERT INTO agent_actions
       (event_id, action_type, result, metadata, started_at, completed_at, cost_usd, num_turns)
     VALUES (?, ?, 'success', '{}', '2026-05-15 04:00:01', '2026-05-15 04:00:43', 0.07, 5)`,
  ).run(CORRELATION_ID, STAGE_B_ACTION_TYPE);

  for (let h = 5; h < 24; h += 1) {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, result, started_at, completed_at)
       VALUES ('hourly_check', 'success', ?, ?)`,
    ).run(
      `2026-05-14 ${String(h).padStart(2, "0")}:00:00`,
      `2026-05-14 ${String(h).padStart(2, "0")}:01:00`,
    );
  }
  for (let i = 0; i < 7; i += 1) {
    db.prepare(
      `INSERT INTO messages (role, content, platform, timestamp)
       VALUES (?, 'msg', 'slack', ?)`,
    ).run(i % 2 === 0 ? "user" : "assistant", `2026-05-14 ${String(10 + i).padStart(2, "0")}:00:00`);
  }
}
