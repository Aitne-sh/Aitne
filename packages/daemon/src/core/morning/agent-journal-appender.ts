/**
 * `appendMorningRoutineJournalEntry` — assemble the one-block English
 * audit-trail entry for `journal/agent.md` from **structured sources
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
 * The `- Journal: ...` line is replaced by a `Journal synthesis: ...`
 * variant when the daily file is absent or Stage B did not succeed:
 *
 *     - Journal synthesis: skipped (no prior-day data)               (first-run)
 *     - Journal synthesis: failed (audit row missing — see daemon log) (anomaly)
 *     - Journal synthesis: failed (Stage B <state>)                   (terminal failure)
 *     - Journal synthesis: failed (Stage B success but daily file missing) (PUT lost)
 *
 * The verb (`skipped` vs `failed`) reflects whether Stage B was even
 * attempted — `skipped` is reserved for the first-run case where the
 * orchestrator never dispatched Stage B; everything else surfaces as
 * `failed` so the audit-trail language matches reality.
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
import { serializeContextFileWrite } from "../context-file-serializer.js";
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
  /**
   * daily-journal-daemon-write.md §4.7 — Stage B `agent_actions.detail`
   * carries a discriminated `dailyWrite` block when the daemon-side
   * composer ran. Three states map to the journal-line verbs:
   *   - `"complete"` → "Journal: daily/<date>.md (N lines, M projects)"
   *   - `"partial"`  → "Journal: daily/<date>.md (N lines, **partial — <reason>**)"
   *   - `false`      → "Journal synthesis: failed (<reason>)"
   *
   * Absent on rows written before the §4.11 wiring landed; readers fall
   * back to the file-presence heuristic for backward compatibility.
   */
  dailyWrite?: DailyWriteDetail | null;
}

/**
 * Mirror of `DailyWriteAuditDetail` in `dispatcher-types.ts`. Re-declared
 * here rather than imported to keep the appender's import graph stable
 * (it sits below the dispatcher in the dep order today). The fields
 * are read defensively — `parseDailyWriteDetail` validates the shape
 * before consumption so a malformed row degrades to "field absent"
 * rather than corrupting the audit line.
 */
export type DailyWriteDetail =
  | {
      ok: "complete";
      bytesWritten?: number;
      wroteMode?: "put" | "append_revision";
    }
  | {
      ok: "partial";
      bytesWritten?: number;
      wroteMode?: "put" | "append_revision";
      partialReason:
        | "frontmatter_tag_missing"
        | "frontmatter_invalid_json"
        | "frontmatter_schema_invalid";
    }
  | {
      ok: false;
      reason:
        | "stage_b_null"
        | "empty_output"
        | "body_tag_missing"
        | "write_failed";
    };

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
   * agent-side footprint (`journal/agent.md`) gains a single inline
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
              metadata AS metadata,
              detail AS detail
         FROM agent_actions
        WHERE event_id = ?
          AND action_type IN (?, ?)
        ORDER BY id ASC`,
    )
    .all(correlationId, STAGE_A_ACTION_TYPE, STAGE_B_ACTION_TYPE) as Array<{
    actionType: string;
    result: StageActionRow["result"];
    metadata: string | null;
    detail: string | null;
  }>;

  let stageA: StageActionRow | null = null;
  let stageB: StageActionRow | null = null;
  for (const row of rows) {
    const dailyWrite =
      row.actionType === STAGE_B_ACTION_TYPE
        ? parseDailyWriteDetail(row.detail)
        : null;
    const parsed: StageActionRow = {
      result: row.result,
      metadata: parseJsonObject(row.metadata),
      ...(dailyWrite ? { dailyWrite } : {}),
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

/**
 * Pull `dailyWrite` out of an `agent_actions.detail` JSON column.
 * Returns null when the column is null, malformed, or carries an
 * unrecognised shape. Strict validation: every required field must be
 * present with the right type — a partial-shape row degrades to
 * "field absent" so the appender falls back to file-presence
 * detection rather than rendering a half-broken line.
 */
function parseDailyWriteDetail(raw: string | null): DailyWriteDetail | null {
  if (raw === null) return null;
  let parsed: unknown;
  // SQLite's `detail` column has a CHECK(json_valid) constraint, so a
  // malformed JSON string cannot reach this branch via the INSERT
  // path. The try/catch is kept as a defence-in-depth guard for a
  // future migration that relaxes the constraint.
  /* c8 ignore start */
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  /* c8 ignore stop */
  if (parsed === null || typeof parsed !== "object") return null;
  const dw = (parsed as { dailyWrite?: unknown }).dailyWrite;
  if (dw === null || typeof dw !== "object") return null;
  const obj = dw as Record<string, unknown>;
  const ok = obj.ok;
  if (ok === "complete") {
    return {
      ok: "complete",
      ...(typeof obj.bytesWritten === "number" ? { bytesWritten: obj.bytesWritten } : {}),
      ...(obj.wroteMode === "put" || obj.wroteMode === "append_revision"
        ? { wroteMode: obj.wroteMode }
        : {}),
    };
  }
  if (ok === "partial") {
    const partialReason = obj.partialReason;
    if (
      partialReason !== "frontmatter_tag_missing"
      && partialReason !== "frontmatter_invalid_json"
      && partialReason !== "frontmatter_schema_invalid"
    ) {
      return null;
    }
    return {
      ok: "partial",
      partialReason,
      ...(typeof obj.bytesWritten === "number" ? { bytesWritten: obj.bytesWritten } : {}),
      ...(obj.wroteMode === "put" || obj.wroteMode === "append_revision"
        ? { wroteMode: obj.wroteMode }
        : {}),
    };
  }
  if (ok === false) {
    const reason = obj.reason;
    if (
      reason !== "stage_b_null"
      && reason !== "empty_output"
      && reason !== "body_tag_missing"
      && reason !== "write_failed"
    ) {
      return null;
    }
    return { ok: false, reason };
  }
  return null;
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
  /**
   * Whether Stage B was attempted (i.e. `yesterday.md` existed when the
   * orchestrator built Stage B's inputs — `buildStageBInputs` returns
   * non-null iff yesterday.md is on disk). The end-to-end
   * `appendMorningRoutineJournalEntry` derives this from a live
   * `existsSync(yesterday.md)` check.
   *
   * Disambiguates two states that previously rendered identically as
   * `Journal synthesis: skipped (no prior-day data)`:
   *   - `false` → first-run / no prior-day data: legitimate skip.
   *   - `true` AND `stageB === null` → Stage B was dispatched but its
   *     `agent_actions` row never landed. This is a defence-in-depth
   *     anomaly path: with the orchestrator-side failure-row write in
   *     place (`recordStageFailure` → `audit.logError`), the only way
   *     to reach this state is a rare SQLite write failure inside
   *     `audit.logError` itself. Surface it as `Journal synthesis:
   *     failed (audit row missing — see daemon log)` instead of
   *     masking the failure as a first-run.
   *
   * Optional so unit tests that don't care about the disambiguation
   * stay terse; when omitted the composer falls back to the legacy
   * heuristic (`stageB === null` → first-run), preserving the
   * pre-disambiguation behaviour for callers that haven't been
   * updated.
   */
  stageBAttempted?: boolean;
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
    inputs.stageBAttempted ?? false,
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
 * Append the composed entry to `journal/agent.md`. Mirrors the write
 * chokepoint that `PATCH /api/context/journal/agent?mode=append_to_file`
 * exposes to the agent: snapshot the existing file into
 * `md_file_snapshots`, write the new content atomically, then notify
 * the write tracker + indexer so observers don't tag the write as a
 * user-actor change.
 */
export async function appendMorningRoutineJournalEntry(
  deps: AgentJournalAppenderDeps,
  args: AgentJournalAppenderArgs,
): Promise<AgentJournalAppenderResult> {
  const { stageA, stageB } = loadMorningRoutineActionRows(deps.db, args.correlationId);
  if (stageA === null) {
    return { ok: false, reason: "stage_a_row_missing" };
  }
  const dailyPath = join(deps.contextDir, dailyJournalPath(args.yesterdayDateStr));
  const dailyContent = existsSync(dailyPath) ? readFileSync(dailyPath, "utf-8") : null;

  // `stageBAttempted` discriminates "first-run / no prior-day" from
  // "Stage B was attempted but no audit row exists" — the latter is a
  // defence-in-depth anomaly that the previous renderer masked as a
  // legit skip. The orchestrator's `buildStageBInputs` gates Stage B
  // dispatch on `existsSync(yesterday.md)`; mirroring that check here
  // (after `rotateDayFiles` has run and before the next day's rotation
  // touches the file) gives us the same predicate without threading
  // new state through the orchestrator → runner → appender chain.
  const yesterdayMdPath = join(deps.contextDir, "state", "yesterday.md");
  const stageBAttempted = existsSync(yesterdayMdPath);

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
    stageBAttempted,
  });

  const journalRelative = CONTEXT_RELATIVE_PATHS.agent.journal;
  const journalAbs = join(deps.contextDir, journalRelative);

  // Read AND write inside the daemon-wide per-path serializer so a
  // concurrent HTTP PATCH (`/api/context/journal/agent` append_to_file),
  // a roadmap-maintenance journal-line append, or the weekly-interests
  // appender cannot race this read-modify-write. Without the fence,
  // two writers reading the same pre-state would each rename their
  // own "next" over the file, silently dropping the loser's block.
  return await serializeContextFileWrite(journalAbs, () => {
    const original = existsSync(journalAbs)
      ? readFileSync(journalAbs, "utf-8")
      : null;
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
  });
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
  stageBAttempted: boolean,
): string {
  // daily-journal-daemon-write.md §4.7 — preferred signal is the
  // structured `detail.dailyWrite.ok` discriminant the §4.11 wiring
  // lands on the Stage B row. When present, branch by `ok` and skip the
  // file-presence heuristic entirely. The `dailyContent` branch below
  // remains the fallback for (a) rows written before §4.11 (no
  // dailyWrite key) and (b) future migrations where the composer is
  // bypassed but the file is still on disk.
  const dailyWrite = stageB?.dailyWrite;
  if (dailyWrite) {
    if (dailyWrite.ok === "complete") {
      if (dailyContent !== null) {
        const stats = inspectDailyJournal(dailyContent);
        return `Journal: daily/${yesterdayDateStr}.md (${stats.bodyLineCount} lines, ${stats.projectsCount} projects referenced)`;
      }
      // Composer reported complete but file is no longer on disk —
      // tail-risk shape (manual delete / vault move between settle and
      // appender). Surface explicitly so a missing file isn't masked as
      // a benign first-run.
      return "Journal synthesis: failed (composer reported complete but daily file is missing)";
    }
    if (dailyWrite.ok === "partial") {
      if (dailyContent !== null) {
        const stats = inspectDailyJournal(dailyContent);
        const reasonLabel = formatPartialReason(dailyWrite.partialReason);
        return `Journal: daily/${yesterdayDateStr}.md (${stats.bodyLineCount} lines, **partial — ${reasonLabel}**)`;
      }
      // Partial extract means the body landed; missing file is the
      // same tail-risk shape as above. Surface loudly.
      return "Journal synthesis: failed (composer reported partial but daily file is missing)";
    }
    // ok === false — composer terminated without writing. Map the
    // reason to a human-readable suffix so `pnpm audit` filters on it.
    return `Journal synthesis: failed (${formatFailureReason(dailyWrite.reason)})`;
  }

  // Legacy fallback — rows that pre-date §4.11 have no dailyWrite key.
  // Use file-presence + Stage B result to render the right verb.
  if (dailyContent !== null) {
    if (stageB !== null && stageB.result !== "success") {
      // Mismatch — daily file is on disk (likely from a prior-attempt
      // PUT) but the latest Stage B row is non-success. Surfaces as
      // `failed` so the verb matches reality (`skipped` would imply the
      // stage didn't run, which is wrong); the parenthetical preserves
      // the terminal state for operators triaging via `pnpm audit`.
      return `Journal synthesis: failed (Stage B ${stageB.result})`;
    }
    const stats = inspectDailyJournal(dailyContent);
    return `Journal: daily/${yesterdayDateStr}.md (${stats.bodyLineCount} lines, ${stats.projectsCount} projects referenced)`;
  }
  // dailyContent === null
  //
  // Disambiguate the missing-file branch by Stage B state so the audit
  // trail surfaces real anomalies instead of masking them as "no prior
  // day". Four sub-cases:
  //   1. Stage B was not attempted (`!stageBAttempted` — i.e. yesterday.md
  //      was absent at run start) — first-run / no-prior-day. Rendering
  //      "skipped (no prior-day data)" is correct.
  //   2. Stage B was attempted but produced no audit row (the
  //      defence-in-depth anomaly the `stageBAttempted` discriminator
  //      surfaces — see `JournalEntryComposeInputs.stageBAttempted`.
  //      Renders as "failed (audit row missing — see daemon log)" so
  //      the failure is loud rather than masked as first-run.
  //   3. Stage B ran and failed (`result !== 'success'`) — render the
  //      terminal state with the `failed` verb so the audit-trail line
  //      matches reality.
  //   4. Stage B ran and succeeded but the file is not on disk — a real
  //      anomaly (atomic PUT lost, fs race, or the appender ran before
  //      the PUT settled). Surface explicitly so `pnpm audit` can
  //      filter on it; the original "no prior-day data" string silently
  //      masked this as a benign first-run condition.
  if (stageB === null) {
    if (stageBAttempted) {
      return "Journal synthesis: failed (audit row missing — see daemon log)";
    }
    return "Journal synthesis: skipped (no prior-day data)";
  }
  if (stageB.result !== "success") {
    return `Journal synthesis: failed (Stage B ${stageB.result})`;
  }
  return "Journal synthesis: failed (Stage B success but daily file missing)";
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

function formatPartialReason(
  reason:
    | "frontmatter_tag_missing"
    | "frontmatter_invalid_json"
    | "frontmatter_schema_invalid",
): string {
  switch (reason) {
    case "frontmatter_tag_missing":
      return "frontmatter tag missing";
    case "frontmatter_invalid_json":
      return "frontmatter JSON parse error";
    case "frontmatter_schema_invalid":
      return "frontmatter schema mismatch";
  }
}

function formatFailureReason(
  reason: "stage_b_null" | "empty_output" | "body_tag_missing" | "write_failed",
): string {
  switch (reason) {
    case "stage_b_null":
      return "Stage B did not run";
    case "empty_output":
      return "LLM output empty";
    case "body_tag_missing":
      return "extraction: no body";
    case "write_failed":
      return "write error";
  }
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
