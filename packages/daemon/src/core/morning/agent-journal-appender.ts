/**
 * `appendMorningRoutineJournalEntry` — assemble the one-block English
 * audit-trail entry for `agent/journal.md` from **structured sources
 * only** (agent_actions rows + daily/<yesterday>.md frontmatter
 * deterministic fs read) and append it to the journal file.
 *
 * Spec: `docs/design/appendices/morning-routine-optimization.md`
 * §"Daemon-side modules to add" → agent-journal-appender (⑥). Phase 2
 * ships this module unwired; the orchestrator wires it after both
 * stages finish and before the parent audit row is emitted.
 *
 * Output shape (matches today's Step 9 byte-for-byte so `pnpm audit`
 * keeps parsing it):
 *
 *     ## 2026-05-15 morning routine
 *     - Day-type: weekday
 *     - Journal: daily/2026-05-14.md (42 lines, 3 projects referenced)
 *     - Inbox: 4 files triaged, 4 moved to scratch, 1 DM-confirmations sent
 *     - Checks from routines/morning.md: (none)
 *     - Anomalies / skipped steps: (none)
 *
 * Initial-flow / Stage-B-failed branches surface the rev1 variant:
 *
 *     - Journal synthesis: skipped (no prior-day data)
 *
 * No LLM final-text parsing anywhere — every field is sourced from a
 * structured channel: `agent_actions.metadata` (written by Stage A via
 * `PATCH /api/agent-actions/self`), `agent_actions.result` (terminal
 * state for each stage), and `daily/<date>.md` frontmatter (fs read).
 */

import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../atomic-write.js";
import { CONTEXT_RELATIVE_PATHS, dailyJournalPath } from "../context-paths.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger } from "../../logging.js";
import {
  gatherJournalSkeletonFacts,
  type AgentDayWindowUtc,
} from "./journal-skeleton-builder.js";

/** Cap on action_type breakdown bullets in the inline summary line. */
const ACTIONS_TOP_N = 5;

const logger = createLogger("morning-journal-appender");

/** Action types Stage A and Stage B insert into `agent_actions`. */
export const STAGE_A_ACTION_TYPE = "routine.morning_routine_today";
export const STAGE_B_ACTION_TYPE = "routine.morning_routine_journal";

/** Stage row shape used by the composer. Subset of `agent_actions`. */
export interface StageActionRow {
  result: "success" | "failed" | "partial" | "skipped" | "in_progress";
  /** Parsed JSON. `{}` when the column was NULL or non-object. */
  metadata: Record<string, unknown>;
}

export interface AgentJournalAppenderDeps {
  db: Database.Database;
  contextDir: string;
  writeTracker?: Pick<AgentWriteTracker, "markWriting" | "unmark">;
  onIndexableContextChange?: (relativePath: string) => void;
}

export interface AgentJournalAppenderArgs {
  /** Routine's correlation id — used as `event_id` to find both stage rows. */
  correlationId: string;
  /** Today's agent-day, used in the `## YYYY-MM-DD morning routine` H2. */
  morningDateStr: string;
  /** Yesterday's agent-day, used as the `daily/<yesterday>.md` filename. */
  yesterdayDateStr: string;
  /**
   * Yesterday's agent-day UTC window. Used to aggregate the agent-action
   * breakdown into the `- Actions: ...` footprint line. The agent-action
   * summary used to live in the user-facing `daily/<date>.md` `## Actions`
   * section, but was moved here as part of the user-diary refocus: the
   * user-side journal no longer carries agent telemetry, while the
   * agent-side footprint (`agent/journal.md`) gains a single inline
   * summary line so the breakdown remains discoverable to operators
   * running `pnpm audit`. The orchestrator owns the timezone /
   * dayBoundaryHour math; passing the window in keeps this module pure
   * of config plumbing.
   *
   * **Required.** A silent omission would render the Actions line as
   * `(none)` — indistinguishable from a legitimate zero-action day —
   * masking a wiring bug for an entire 24h cycle until the next
   * morning routine. Making the field required closes that hole at
   * compile time. Tests that don't care about the Actions line can
   * pass `EMPTY_AGENT_DAY_WINDOW_FOR_TESTS` and the aggregation will
   * deterministically return zero rows.
   */
  agentDayWindow: AgentDayWindowUtc;
}

/**
 * A degenerate UTC window for tests that exercise non-Actions-line
 * branches of the appender. Aggregating `agent_actions` rows over a
 * zero-width window deterministically returns zero rows, so the
 * `- Actions: (none)` rendering is identical to the "no actions
 * yesterday" production case.
 *
 * Exported instead of inlined in each test so a future change to the
 * window shape (e.g. ISO string vs SQLite datetime) updates one
 * constant rather than ~10 test fixtures.
 */
export const EMPTY_AGENT_DAY_WINDOW_FOR_TESTS: AgentDayWindowUtc = {
  startUtc: "2000-01-01 00:00:00",
  endUtc: "2000-01-01 00:00:00",
};

export type AgentJournalAppenderResult =
  | { ok: true; entryText: string }
  | { ok: false; reason: "stage_a_row_missing" };

/**
 * Load Stage A + Stage B `agent_actions` rows by `event_id`. Returns
 * `null` for either side that has no row yet — the composer surfaces
 * that as "skipped" / `(none)` lines rather than throwing.
 *
 * Exported for testing so seeded-DB fixtures can verify the row binding
 * without exercising the fs side of the appender.
 */
export function loadMorningRoutineActionRows(
  db: Database.Database,
  correlationId: string,
): { stageA: StageActionRow | null; stageB: StageActionRow | null } {
  const rows = db
    .prepare(
      `SELECT action_type AS actionType,
              result AS result,
              metadata AS metadata
         FROM agent_actions
        WHERE event_id = ?
          AND action_type IN (?, ?)
        ORDER BY id ASC`,
    )
    .all(correlationId, STAGE_A_ACTION_TYPE, STAGE_B_ACTION_TYPE) as Array<{
    actionType: string;
    result: StageActionRow["result"];
    metadata: string | null;
  }>;

  let stageA: StageActionRow | null = null;
  let stageB: StageActionRow | null = null;
  for (const row of rows) {
    const parsed: StageActionRow = {
      result: row.result,
      metadata: parseJsonObject(row.metadata),
    };
    if (row.actionType === STAGE_A_ACTION_TYPE) {
      // Most recent insert wins on a retry — `ORDER BY id ASC` + naive
      // overwrite gives the latest row's metadata, which is what the
      // retry chain produces (each attempt INSERTs a fresh row).
      stageA = parsed;
    } else if (row.actionType === STAGE_B_ACTION_TYPE) {
      stageB = parsed;
    }
  }
  return { stageA, stageB };
}

/** Action-breakdown facts used to render the `- Actions: ...` footprint line. */
export interface ActionsSummaryInput {
  /** Total `agent_actions` rows in yesterday's agent-day window. */
  totalActions: number;
  /**
   * `agent_actions` rows grouped by `action_type`, ordered by count
   * desc then action_type asc. The composer caps the inline rendering
   * at `ACTIONS_TOP_N` types so the line stays single-line readable
   * even for a busy day.
   */
  actionsByType: ReadonlyArray<{ actionType: string; count: number }>;
}

/** Inputs the pure composer needs. Mirrors what `appendMorningRoutineJournalEntry` collects. */
export interface JournalEntryComposeInputs {
  morningDateStr: string;
  yesterdayDateStr: string;
  stageA: StageActionRow;
  stageB: StageActionRow | null;
  /** `null` when `daily/<yesterdayDateStr>.md` does not exist on disk. */
  dailyJournalContent: string | null;
  /**
   * Yesterday's agent-action breakdown for the `- Actions: ...`
   * footprint line. Sourced from `gatherJournalSkeletonFacts` against
   * the agent-day window. Optional so unit tests focusing on the
   * other composer fields don't have to thread the summary through;
   * an absent value renders as `(none)` (semantically correct — no
   * breakdown supplied means no actions to report). The end-to-end
   * `appendMorningRoutineJournalEntry` always populates it from the
   * SQLite aggregation.
   */
  actionsSummary?: ActionsSummaryInput;
}

const EMPTY_ACTIONS_SUMMARY: ActionsSummaryInput = {
  totalActions: 0,
  actionsByType: [],
};

/**
 * Pure composer — every output byte is a deterministic function of the
 * inputs. Exposed for unit tests so the prose can be pinned without
 * the fs / DB harness.
 */
export function composeMorningRoutineJournalEntry(
  inputs: JournalEntryComposeInputs,
): string {
  const metadata = inputs.stageA.metadata;
  const dayType = readDayType(metadata);
  const inbox = readInboxStats(metadata);
  const checks = readMorningChecks(metadata);
  const anomalies = readAnomalies(metadata);
  const journalLine = formatJournalLine(
    inputs.yesterdayDateStr,
    inputs.stageB,
    inputs.dailyJournalContent,
  );

  const lines: string[] = [];
  lines.push(`## ${inputs.morningDateStr} morning routine`);
  lines.push(`- Day-type: ${dayType}`);
  lines.push(`- ${journalLine}`);
  lines.push(
    `- Inbox: ${inbox.triaged} files triaged, ${inbox.movedToScratch} moved to scratch, ${inbox.dmConfirmsSent} DM-confirmations sent`,
  );
  lines.push(`- Actions: ${formatActionsLine(inputs.actionsSummary ?? EMPTY_ACTIONS_SUMMARY)}`);
  lines.push(`- Checks from routines/morning.md: ${checks}`);
  lines.push(`- Anomalies / skipped steps: ${anomalies}`);
  return lines.join("\n");
}

/**
 * Render the agent-action breakdown into a single inline footprint
 * value. Examples:
 *
 *   - 0 actions      → `(none)`
 *   - 1 single type  → `1 total (curl: 1)`
 *   - busy day       → `23 total (curl: 12, web_fetch: 7, sqlite_read: 4)`
 *
 * The breakdown is capped at `ACTIONS_TOP_N` types so a 30-action-type
 * day stays on one line; the remainder collapses into `+N more`.
 * Ordering is the caller's responsibility (the upstream
 * `gatherJournalSkeletonFacts` query sorts by count desc then
 * action_type asc); the composer renders verbatim.
 */
function formatActionsLine(summary: ActionsSummaryInput): string {
  if (summary.totalActions === 0) return "(none)";
  const top = summary.actionsByType.slice(0, ACTIONS_TOP_N);
  const more = summary.actionsByType.length - top.length;
  const breakdown = top.map((row) => `${row.actionType}: ${row.count}`).join(", ");
  const suffix = more > 0 ? `, +${more} more` : "";
  return `${summary.totalActions} total (${breakdown}${suffix})`;
}

/**
 * Append the composed entry to `agent/journal.md`. Mirrors the write
 * chokepoint that `PATCH /api/context/agent/journal?mode=append_to_file`
 * exposes to the agent: snapshot the existing file into
 * `md_file_snapshots`, write the new content atomically, then notify
 * the write tracker + indexer so observers don't tag the write as a
 * user-actor change.
 */
export function appendMorningRoutineJournalEntry(
  deps: AgentJournalAppenderDeps,
  args: AgentJournalAppenderArgs,
): AgentJournalAppenderResult {
  const { stageA, stageB } = loadMorningRoutineActionRows(deps.db, args.correlationId);
  if (stageA === null) {
    return { ok: false, reason: "stage_a_row_missing" };
  }
  const dailyPath = join(deps.contextDir, dailyJournalPath(args.yesterdayDateStr));
  const dailyContent = existsSync(dailyPath) ? readFileSync(dailyPath, "utf-8") : null;

  // Reuse the skeleton builder's aggregation for the agent-action
  // breakdown. The query is cheap (two indexed reads against
  // `agent_actions`) and re-running it here keeps the appender
  // self-contained — the orchestrator doesn't have to thread the
  // skeleton facts through the Stage A/B lifecycle just to surface
  // them in the journal footprint.
  const facts = gatherJournalSkeletonFacts(deps.db, args.agentDayWindow);
  const actionsSummary: ActionsSummaryInput = {
    totalActions: facts.totalActions,
    actionsByType: facts.actionsByType,
  };

  const entryText = composeMorningRoutineJournalEntry({
    morningDateStr: args.morningDateStr,
    yesterdayDateStr: args.yesterdayDateStr,
    stageA,
    stageB,
    dailyJournalContent: dailyContent,
    actionsSummary,
  });

  const journalRelative = CONTEXT_RELATIVE_PATHS.agent.journal;
  const journalAbs = join(deps.contextDir, journalRelative);
  const original = existsSync(journalAbs) ? readFileSync(journalAbs, "utf-8") : null;
  const next = appendBlockToJournal(original, entryText);

  if (original !== null) {
    saveSnapshot(deps.db, journalRelative.replace(/\.md$/, ""), original, "morning_routine_appender");
  }
  // Mark before the rename so FS-watch consumers attribute the resulting
  // event to the agent. Roll back on failure (C2).
  deps.writeTracker?.markWriting(journalAbs, next);
  try {
    writeFileAtomically(journalAbs, next);
  } catch (writeErr) {
    deps.writeTracker?.unmark(journalAbs);
    throw writeErr;
  }
  deps.onIndexableContextChange?.(journalRelative);
  return { ok: true, entryText };
}

/**
 * Append a new top-level block (delimited by H2 heading) to the
 * journal. When the file does not yet exist, seed it with the
 * `# Agent journal` H1 + the entry. Otherwise trim trailing whitespace
 * and join with a blank line.
 *
 * Retry idempotency: if `original` already contains a block whose H2
 * heading matches `block`'s first line verbatim (i.e. the morning
 * routine for this date emitted earlier in this run / a prior retry
 * attempt), the existing block is replaced from its H2 to the start of
 * the next H2 (or EOF) rather than producing a duplicate. This matches
 * the dispatcher's retry chain semantics where Stage A re-fires on
 * today.md health failure and the orchestrator re-invokes ⑥ — without
 * this guard `pnpm audit` would see two entries for the same date.
 * The replacement uses the LAST matching H2 occurrence so a legacy
 * entry for the same date in deep history is preserved (defence-in-
 * depth — re-running multiple weeks later still replaces only the
 * most-recent attempt).
 *
 * Exposed for testing so the fresh-file / existing-file / retry
 * branches can be pinned without the full appendMorningRoutineJournalEntry
 * harness.
 */
export function appendBlockToJournal(
  original: string | null,
  block: string,
): string {
  if (original === null) {
    return `# Agent journal\n\n${block}\n`;
  }
  const trimmed = original.replace(/\n+$/, "");
  const headerLine = block.split("\n", 1)[0];
  const replaced = replaceLastBlockMatchingHeader(trimmed, headerLine, block);
  if (replaced !== null) {
    return `${replaced}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Locate the last occurrence of `headerLine` as an H2 boundary in
 * `body`, and replace from that H2 to the start of the next H2 (or
 * EOF) with `block`. Returns `null` when no matching H2 is found.
 *
 * `headerLine` must be the exact H2 line (e.g.
 * `## 2026-05-15 morning routine`). The match anchors on line
 * boundaries to avoid clipping a substring inside an unrelated H2 or
 * a body bullet.
 */
function replaceLastBlockMatchingHeader(
  body: string,
  headerLine: string,
  block: string,
): string | null {
  // CRLF-tolerant — agent/journal.md is daemon-appended but operators
  // do hand-edit (cf. `pnpm audit` workflow), and a single CRLF leak
  // would silently fail the `===` header match and append a duplicate
  // block on retry instead of replacing. Same uniform policy as
  // handoff-parser + extractUserTasksFromYesterday.
  const lines = body.split(/\r?\n/);
  let lastMatch = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === headerLine) lastMatch = i;
  }
  if (lastMatch < 0) return null;
  let nextH2 = lines.length;
  for (let i = lastMatch + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") && !lines[i].startsWith("### ")) {
      nextH2 = i;
      break;
    }
  }
  const head = lines.slice(0, lastMatch).join("\n").replace(/\n+$/, "");
  const tail = nextH2 >= lines.length ? "" : lines.slice(nextH2).join("\n");
  const middle = tail.length === 0 ? block : `${block}\n\n${tail.replace(/^\n+/, "")}`;
  // `head` is empty only when the matching H2 was at line 0 with no
  // preceding `# Agent journal` header — a shape `appendBlockToJournal`
  // never produces (the fresh-file branch always seeds the H1). Kept as
  // a defensive no-leading-blank-line guard for hand-edited journals.
  /* c8 ignore next */
  return head.length === 0 ? middle : `${head}\n\n${middle}`;
}

// ── Composer helpers ────────────────────────────────────────────────

function readDayType(metadata: Record<string, unknown>): string {
  const value = metadata.dayType;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return "unknown";
}

interface InboxStats {
  triaged: number;
  movedToScratch: number;
  dmConfirmsSent: number;
}

function readInboxStats(metadata: Record<string, unknown>): InboxStats {
  const raw = metadata.inboxStats;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      triaged: readNonNegativeInt(obj.triaged),
      movedToScratch: readNonNegativeInt(obj.movedToScratch),
      dmConfirmsSent: readNonNegativeInt(obj.dmConfirmsSent),
    };
  }
  return { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 };
}

function readNonNegativeInt(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.trunc(value);
}

function readMorningChecks(metadata: Record<string, unknown>): string {
  const arr = readStringArray(metadata.morningChecks);
  return arr.length === 0 ? "(none)" : arr.join(", ");
}

function readAnomalies(metadata: Record<string, unknown>): string {
  const arr = readStringArray(metadata.anomalies);
  return arr.length === 0 ? "(none)" : arr.join("; ");
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function formatJournalLine(
  yesterdayDateStr: string,
  stageB: StageActionRow | null,
  dailyContent: string | null,
): string {
  if (dailyContent !== null) {
    if (stageB !== null && stageB.result !== "success") {
      return `Journal synthesis: skipped (Stage B ${stageB.result})`;
    }
    const stats = inspectDailyJournal(dailyContent);
    return `Journal: daily/${yesterdayDateStr}.md (${stats.bodyLineCount} lines, ${stats.projectsCount} projects referenced)`;
  }
  // dailyContent === null
  //
  // Disambiguate the missing-file branch by Stage B state so the audit
  // trail surfaces real anomalies instead of masking them as "no prior
  // day". Three sub-cases:
  //   1. Stage B was skipped (`stageB === null`) — first-run initial
  //      variant. Rendering "no prior-day data" is correct.
  //   2. Stage B ran and failed (`result !== 'success'`) — render the
  //      terminal state. Matches the dailyContent-present-but-failed
  //      branch above so the audit log uses one consistent shape per
  //      Stage B outcome.
  //   3. Stage B ran and succeeded but the file is not on disk — a real
  //      anomaly (atomic PUT lost, fs race, or the appender ran before
  //      the PUT settled). Surface explicitly so `pnpm audit` can
  //      filter on it; the original "no prior-day data" string silently
  //      masked this as a benign first-run condition.
  if (stageB === null) {
    return "Journal synthesis: skipped (no prior-day data)";
  }
  if (stageB.result !== "success") {
    return `Journal synthesis: skipped (Stage B ${stageB.result})`;
  }
  return "Journal synthesis: skipped (Stage B success but daily file missing)";
}

export interface DailyJournalStats {
  bodyLineCount: number;
  projectsCount: number;
}

/**
 * Pull body-line count + projects-array length from a `daily/<date>.md`
 * body. Tolerant of both flow-style (`projects: [a, b, c]`) and list
 * form (`projects:\n  - a\n  - b`); placeholder `projects: []` and
 * absent field both count as zero. Body excludes the YAML frontmatter
 * block.
 *
 * Exposed for testing so the parsing branches stay pinnable.
 */
export function inspectDailyJournal(content: string): DailyJournalStats {
  const body = stripFrontmatter(content);
  const bodyLineCount = countBodyLines(body);
  const projectsCount = countProjectsField(content);
  return { bodyLineCount, projectsCount };
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return content;
}

function countBodyLines(body: string): number {
  if (body.length === 0) return 0;
  // Drop a single trailing newline so `"foo\n"` counts as 1 line, not 2.
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

function countProjectsField(content: string): number {
  const lines = content.split("\n");
  // Locate the frontmatter block — only count projects: inside it.
  if (lines[0]?.trim() !== "---") return 0;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return 0;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (!line.startsWith("projects:")) continue;
    const rest = line.slice("projects:".length).trim();
    if (rest === "" || rest === "[]") {
      // List form (or empty placeholder). Walk indented `- ` lines.
      let count = 0;
      for (let j = i + 1; j < close; j++) {
        const next = lines[j];
        if (!next.startsWith("  ") && !next.startsWith("\t")) break;
        if (/^\s+-\s+\S/.test(next)) count += 1;
      }
      return count;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      if (inner.length === 0) return 0;
      return inner.split(",").filter((s) => s.trim().length > 0).length;
    }
    return 0;
  }
  return 0;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "agent_actions.metadata is not valid JSON; treating as empty");
    return {};
  }
}

function saveSnapshot(
  db: Database.Database,
  filePath: string,
  content: string,
  trigger: string,
): void {
  try {
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
    ).run(filePath, content, trigger, null);
  } catch (err) {
    logger.warn({ err, filePath, trigger }, "Failed to save md_file_snapshots row");
  }
}
