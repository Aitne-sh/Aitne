import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDateStr } from "@aitne/shared";
import { writeFileAtomically } from "./atomic-write.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { stripRoadmapIdComment } from "./roadmap-ids.js";
import type { RoadmapWriteLockManager } from "./roadmap-write-lock.js";
import {
  findSectionLineBounds,
  validateRoadmap,
  validateRoadmapTransition,
} from "./roadmap-validate.js";
import { createLogger } from "../logging.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";

const logger = createLogger("roadmap-maintenance");

/**
 * Substep 2d — `[stale since YYYY-MM-DD]` marker is appended once the
 * Source date is older than this many days. Pure mechanical mark; the
 * agent is NOT notified.
 */
export const STALE_THRESHOLD_DAYS = 90;

/**
 * Substep 2d — `[awaiting-reply YYYY-MM-DD]` marker is appended once
 * the Source date is older than this many days, AND the line already
 * carries a `[stale since ...]` marker. Pure mechanical mark.
 */
export const AWAITING_REPLY_THRESHOLD_DAYS = 180;

/**
 * Substep 2d — once a line has carried `[awaiting-reply YYYY-MM-DD]`
 * for this many days with no reply surfaced (i.e. nothing has bumped
 * the line's Source date), drop the line entirely. Matches the
 * task-flow §2d "remove the line via PATCH replace" branch.
 */
export const AWAITING_REPLY_DROP_DAYS = 7;

/**
 * Substep 2b — entries whose canonical date is more than this many
 * days in the future are pruned (the daily refresh will re-derive them
 * when their lead time arrives). Mirrors the evening-review task-flow
 * §2b sweep horizon.
 */
export const AGENT_PLAN_FUTURE_HORIZON_DAYS = 180;

/**
 * Substep 2b — past entries (canonical date < today) whose latest
 * `completed YYYY-MM-DD:` Preparation Timeline row is older than this
 * many days are pruned (the prep was wrapped up; the entry's purpose
 * is exhausted). Entries inside the `[today - N, today + 180d]` window
 * are always preserved even when no prep rows fired.
 */
export const AGENT_PLAN_COMPLETED_RETENTION_DAYS = 7;

const AGENT_PLAN_DATE_RE = /^### (\d{4}-\d{2}-\d{2})(?: ~ \d{2}-\d{2})?: /;
const SCHEDULED_HEADING_RE = /^### Scheduled: .+\s+\(task #(\d+)\)\s*(?:<!--.*-->)?\s*$/;
const SCHEDULED_WAKE_UP_RE =
  /^Source: scheduled\.task — wake-up (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}$/;
const STATUS_LINE_RE = /^Status:\s*\S/;
const COMPLETED_PREP_RE = /^- (?:✓ )?completed (\d{4}-\d{2}-\d{2}):/;
const STALE_MARKER_RE = /\s+\[stale since \d{4}-\d{2}-\d{2}\]/;
const AWAITING_MARKER_RE = /\s+\[awaiting-reply (\d{4}-\d{2}-\d{2})\]/;
const LONG_TERM_PLAN_SOURCE_DATE_RE =
  /\s—\s+Source: (?:dm|mail|observation|reading|dashboard|manual) (\d{4}-\d{2}-\d{2})/;

/**
 * Agent-action `action_type` emitted once per cron tick. Keep stable —
 * the dashboard's audit log filters on this exact value.
 */
export const ROADMAP_MAINTENANCE_ACTION_TYPE = "roadmap_mechanical_maintenance";

/**
 * Journal block heading. Written / appended to via the same in-process
 * chokepoint (`saveJournalSnapshot` + `writeFileAtomically` +
 * `writeTracker.markWriting`) as the roadmap write itself. See
 * `runRoadmapMechanicalMaintenance` `appendJournalLine`.
 */
const JOURNAL_SECTION_HEADER = "## Roadmap maintenance";

export interface RoadmapMaintenanceDeps {
  db: Database.Database;
  contextDir: string;
  roadmapWriteLock: RoadmapWriteLockManager;
  writeTracker?: AgentWriteTracker;
  timezone?: string;
  /** Test seam — frozen-clock fixtures pass a fixed Date. */
  now?: Date;
  onIndexableContextChange?: (path: string) => void;
}

export type RoadmapMaintenanceStep =
  | "2a_scheduled_status_sync"
  | "2b_action_plan_sweep"
  | "2d_long_term_plans_stale_mark"
  | "validate"
  | "transition_validate"
  | "write"
  | "journal";

export interface RoadmapMaintenanceErrorRecord {
  step: RoadmapMaintenanceStep;
  message: string;
}

export interface RoadmapMaintenanceResult {
  status: "success" | "skipped" | "failed";
  /** Count of `### Scheduled:` entries whose Status line was rewritten. */
  statusSynced: number;
  /** Count of `## Agent Action Plan` entries removed by the sweep. */
  swept: number;
  /**
   * Count of `## Long-term Plans` mutations (new `[stale since ...]`,
   * new `[awaiting-reply ...]`, or full-line removal at the 7-day
   * awaiting-reply cliff). One per line in any given run.
   */
  staleMarked: number;
  errors: RoadmapMaintenanceErrorRecord[];
  /** Populated when `status === "skipped"`. */
  skipReason?: string;
}

/**
 * Daily mechanical maintenance for `roadmap.md`. Extracts substeps
 * 2a / 2b / 2d of the legacy `routine.evening_review` Step 2 into a
 * typed in-process pass that does NOT spawn an LLM session — those
 * substeps are pure date math and table joins against
 * `agent_schedule`, and the LLM-rebuild discipline they require makes
 * them a costly and error-prone fit for a Sonnet routine. See
 * `docs/design/appendices/evening-review-slimdown.md` §2.2.
 *
 * Invariants:
 *  - Acquires the same `RoadmapWriteLockManager` singleton the
 *    dispatcher uses for `routine.roadmap_refresh`. If the lock is
 *    held, the maintenance tick is silently skipped and the next
 *    daily fire picks up the work.
 *  - Mutates only `## Agent Action Plan` and `## Long-term Plans`
 *    section bodies. Sibling sections (`## Annual Goals`,
 *    `## Quarterly Focus`, `## Recurring`) are preserved byte-for-byte
 *    by line-targeted splicing.
 *  - On any mutation, validates the rebuilt body with
 *    `validateRoadmap` before atomic-write. A validation failure
 *    aborts the write and surfaces in `errors[]` — partial state is
 *    never committed.
 *  - Records a snapshot of the previous body to `md_file_snapshots`
 *    before writing so the previous body is recoverable.
 *  - `writeTracker.markWriting` fires **before** the rename so
 *    downstream Obsidian / Git observers tag the resulting fs event
 *    `actor='agent'` rather than mis-attributing to the user. On
 *    write failure the mark is rolled back via `unmark()` to avoid
 *    suppressing a legitimate later user edit (C2).
 *  - Emits exactly one `agent_actions` audit row per fire (success,
 *    skipped, or failed), regardless of whether any mutation was
 *    actually written.
 *
 * Failure handling mirrors `runRepositoryManagementScan` — substep
 * failures are caught and accumulated, the run continues with the
 * remaining substeps, and a partial-result audit row records what
 * went wrong. The caller (`scheduler.ts` cron callback) does NOT
 * propagate failure into `routine.evening_review` 15 minutes later.
 */
export function runRoadmapMechanicalMaintenance(
  deps: RoadmapMaintenanceDeps,
): RoadmapMaintenanceResult {
  const result: RoadmapMaintenanceResult = {
    status: "success",
    statusSynced: 0,
    swept: 0,
    staleMarked: 0,
    errors: [],
  };

  // Outer try/finally guarantees a single `agent_actions` audit row per
  // fire regardless of which path terminates the run (skip, validate
  // fail, transition fail, write fail, journal fail, full success). The
  // design (§2.2 "Audit row") calls for one row per cron tick — without
  // this guard, an early return from inside the lock-bearing block
  // skipped `emitAudit` and the operator's dashboard audit log silently
  // lost the failure.
  try {
    const now = deps.now ?? new Date();
    const today = localDateStr(now, deps.timezone);
    const roadmapPath = join(deps.contextDir, CONTEXT_RELATIVE_PATHS.roadmap);

    if (!existsSync(roadmapPath)) {
      result.status = "skipped";
      result.skipReason = "roadmap_not_found";
      logger.info({ roadmapPath }, "roadmap.md not found — skipping maintenance");
      return result;
    }

    const lock = deps.roadmapWriteLock.acquire();
    if (!lock.ok) {
      result.status = "skipped";
      result.skipReason = "roadmap_write_lock_held";
      logger.info(
        { holder: lock.holder },
        "Roadmap write lock held — skipping maintenance",
      );
      return result;
    }

    try {
      const original = readFileSync(roadmapPath, "utf-8");
      let working = original;

      try {
        const out = applyScheduledStatusSync(working, deps.db);
        working = out.content;
        result.statusSynced = out.statusSynced;
      } catch (err) {
        logger.error({ err }, "Substep 2a (scheduled status sync) failed");
        result.errors.push({
          step: "2a_scheduled_status_sync",
          message: (err as Error).message,
        });
      }

      try {
        const out = applyAgentActionPlanSweep(working, today);
        working = out.content;
        result.swept = out.swept;
      } catch (err) {
        logger.error({ err }, "Substep 2b (action plan sweep) failed");
        result.errors.push({
          step: "2b_action_plan_sweep",
          message: (err as Error).message,
        });
      }

      try {
        const out = applyLongTermPlansStaleMark(working, today);
        working = out.content;
        result.staleMarked = out.staleMarked;
      } catch (err) {
        logger.error({ err }, "Substep 2d (long-term plans stale-mark) failed");
        result.errors.push({
          step: "2d_long_term_plans_stale_mark",
          message: (err as Error).message,
        });
      }

      if (working !== original) {
        const validation = validateRoadmap(working);
        if (!validation.ok) {
          result.errors.push({
            step: "validate",
            message:
              validation.error?.message ??
              "validateRoadmap rejected the maintained body",
          });
          result.status = "failed";
          return result;
        }

        // Defence in depth: mirror the chokepoint's transition guard. A
        // direct `writeFileAtomically` bypass below skips the HTTP
        // PATCH plumbing that runs `validateRoadmapTransition` on every
        // LLM-driven roadmap write — without this call, a regression in
        // a substep (e.g. dropping a `### Scheduled:` entry whose status
        // is still `pending`, or removing a future-far event before its
        // retention window permits) could silently land on disk. The
        // transition validator catches the same removal-rule violations
        // the chokepoint catches, and aborts the write with the original
        // bytes intact.
        const transition = validateRoadmapTransition(original, working, {
          today,
          timezone: deps.timezone,
        });
        if (!transition.ok) {
          result.errors.push({
            step: "transition_validate",
            message:
              transition.error?.message ??
              "validateRoadmapTransition rejected the maintained body",
          });
          result.status = "failed";
          return result;
        }

        try {
          saveSnapshot(deps.db, "roadmap", original, "roadmap_maintenance");
          // Mark before the rename so FS-watch consumers attribute the
          // resulting event to the agent. Roll back on failure (C2).
          deps.writeTracker?.markWriting(roadmapPath, working);
          try {
            writeFileAtomically(roadmapPath, working);
          } catch (writeErr) {
            deps.writeTracker?.unmark(roadmapPath);
            throw writeErr;
          }
          deps.onIndexableContextChange?.(CONTEXT_RELATIVE_PATHS.roadmap);
        } catch (err) {
          logger.error({ err }, "Failed to persist roadmap maintenance write");
          result.errors.push({
            step: "write",
            message: (err as Error).message,
          });
          result.status = "failed";
          return result;
        }
      }

      try {
        appendJournalLine(deps, result, now, today);
      } catch (err) {
        logger.warn({ err }, "Failed to append maintenance journal line");
        result.errors.push({
          step: "journal",
          message: (err as Error).message,
        });
      }
    } finally {
      deps.roadmapWriteLock.release(lock.lockId);
    }

    return result;
  } finally {
    // Promote any accumulated soft-failures into the final status, then
    // emit exactly one audit row for the tick. Run inside `finally` so
    // every termination path (including `return result` from inside the
    // lock try-block) is recorded.
    if (result.errors.length > 0 && result.status === "success") {
      result.status = "failed";
    }
    emitAudit(deps.db, result);
    logger.info(
      {
        status: result.status,
        statusSynced: result.statusSynced,
        swept: result.swept,
        staleMarked: result.staleMarked,
        errorCount: result.errors.length,
      },
      "Roadmap mechanical maintenance complete",
    );
  }
}

// ── Substep 2a ─────────────────────────────────────────────────────────────

interface ScheduledStatusSyncResult {
  content: string;
  statusSynced: number;
}

/**
 * Reconcile every `### Scheduled: <desc>  (task #<id>)` entry under
 * `## Agent Action Plan` against the latest `agent_schedule.status`
 * row for that id. `pending → running → completed / failed` flips are
 * applied by rewriting the entry's `Status:` line in place. Sibling
 * lines (Source, Preparation Timeline, etc.) are preserved verbatim.
 *
 * Mapping notes:
 *   - `skipped` rows are surfaced as `failed`. From the operator's
 *     perspective a skipped scheduled.task means the dispatcher chose
 *     not to run it (paused daemon, autonomous gate, quota out) — the
 *     loop did not close, and the roadmap should reflect that.
 *   - Entries whose `(task #<id>)` does not resolve in `agent_schedule`
 *     (row deleted post-retention) are left untouched. Removal is the
 *     sweep's job (2b's `[today - 7d, today + 180d]` window already
 *     handles those naturally) — not 2a's.
 *
 * Pure: no I/O outside the `db.prepare(...).get(id)` lookup.
 */
export function applyScheduledStatusSync(
  content: string,
  db: Database.Database,
): ScheduledStatusSyncResult {
  const lines = content.split("\n");
  const bounds = findSectionLineBounds(lines, "Agent Action Plan");
  if (!bounds) return { content, statusSynced: 0 };

  const stmt = db.prepare<[number], { status: string }>(
    "SELECT status FROM agent_schedule WHERE id = ?",
  );

  let statusSynced = 0;
  let cursor = bounds.bodyStart;
  while (cursor < bounds.bodyEnd) {
    const heading = lines[cursor];
    if (!heading.startsWith("### ")) {
      cursor += 1;
      continue;
    }

    const entryEnd = findEntryEnd(lines, cursor, bounds.bodyEnd);
    const taskIdMatch = SCHEDULED_HEADING_RE.exec(stripRoadmapIdComment(heading).line);
    if (!taskIdMatch) {
      cursor = entryEnd;
      continue;
    }

    const taskId = Number(taskIdMatch[1]);
    if (!Number.isFinite(taskId)) {
      cursor = entryEnd;
      continue;
    }
    const row = stmt.get(taskId);
    if (!row) {
      cursor = entryEnd;
      continue;
    }

    const mapped = mapAgentScheduleStatus(row.status);
    for (let i = cursor + 1; i < entryEnd; i += 1) {
      if (STATUS_LINE_RE.test(lines[i])) {
        if (lines[i] !== `Status: ${mapped}`) {
          lines[i] = `Status: ${mapped}`;
          statusSynced += 1;
        }
        break;
      }
    }

    cursor = entryEnd;
  }

  return { content: lines.join("\n"), statusSynced };
}

function mapAgentScheduleStatus(status: string): "pending" | "running" | "completed" | "failed" {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed" || status === "skipped") return "failed";
  return "pending";
}

// ── Substep 2b ─────────────────────────────────────────────────────────────

interface AgentActionPlanSweepResult {
  content: string;
  swept: number;
}

/**
 * Sweep `## Agent Action Plan` entries that have aged out:
 *
 *   - Event header date > today + 180d  →  remove
 *   - Header date < today - 7d AND the entry's latest `completed
 *     YYYY-MM-DD:` Preparation Timeline row exists AND is itself
 *     older than 7 days  →  remove (only when the entry is in a
 *     terminal state — see "Scheduled-entry safety" below)
 *
 * Entries inside the `[today - 7d, today + 180d]` window are
 * preserved unconditionally — even when their prep rows fired and
 * completed inside that window, the daily refresh prunes them when
 * the header date rolls off the back of the window. That preserves
 * the "shows up the day of and the morning after" surface contract.
 *
 * For Scheduled entries, the canonical date is the `wake-up
 * YYYY-MM-DD` extracted from the `Source: scheduled.task — wake-up
 * YYYY-MM-DD HH:MM` line that follows the heading. Without that
 * line the entry is held (defensive — never drop a malformed entry
 * we can't date-reason about).
 *
 * Scheduled-entry safety: mirror `validateRoadmapTransition`'s
 * `isEntryRemovalAllowed` rule for `### Scheduled:` entries — never
 * remove one unless its `Status:` line is terminal (`completed` or
 * `failed`). Without this guard the maintenance pass could drop a
 * still-`pending` row (e.g. an `agent_schedule` row that was deleted
 * by retention while the roadmap kept its `pending` status), which is
 * exactly what the chokepoint transition validator blocks. Future-
 * dated scheduled entries (`wakeUp > today + 180d`) are also
 * preserved — the validator does not permit their removal at all, and
 * the eventual fire of the scheduled task is the natural cleanup
 * trigger.
 *
 * Section-rebuild discipline: the function splices out the exact line
 * ranges of removed entries and keeps every other byte of the file
 * identical. Sibling sections are never touched.
 */
export function applyAgentActionPlanSweep(
  content: string,
  todayYmd: string,
): AgentActionPlanSweepResult {
  const lines = content.split("\n");
  const bounds = findSectionLineBounds(lines, "Agent Action Plan");
  if (!bounds) return { content, swept: 0 };

  const futureCutoff = addDays(todayYmd, AGENT_PLAN_FUTURE_HORIZON_DAYS);
  const pastCutoff = addDays(todayYmd, -AGENT_PLAN_COMPLETED_RETENTION_DAYS);

  type Span = { start: number; end: number };
  const removals: Span[] = [];

  let cursor = bounds.bodyStart;
  while (cursor < bounds.bodyEnd) {
    const line = lines[cursor];
    if (!line.startsWith("### ")) {
      cursor += 1;
      continue;
    }
    const entryEnd = findEntryEnd(lines, cursor, bounds.bodyEnd);
    const entryLines = lines.slice(cursor, entryEnd);
    const heading = stripRoadmapIdComment(entryLines[0]).line;
    const isScheduled = SCHEDULED_HEADING_RE.test(heading);

    const date = extractEntryDate(heading, entryLines);
    if (!date) {
      cursor = entryEnd;
      continue;
    }

    if (date > futureCutoff) {
      // Future-dated scheduled entries stay until the scheduled task
      // itself fires — the chokepoint transition validator blocks
      // their removal, and the maintenance pass must match that rule.
      // Event entries (calendar / planned), in contrast, may legitimately
      // be promoted-then-dropped from the roadmap before the date.
      if (!isScheduled) {
        removals.push({ start: cursor, end: entryEnd });
      }
    } else if (date < pastCutoff) {
      const latestCompleted = extractLatestCompletedPrepDate(entryLines);
      if (latestCompleted && latestCompleted < pastCutoff) {
        if (!isScheduled || hasTerminalStatusLine(entryLines)) {
          removals.push({ start: cursor, end: entryEnd });
        }
      }
    }

    cursor = entryEnd;
  }

  if (removals.length === 0) {
    return { content, swept: 0 };
  }

  const next: string[] = [];
  let copyCursor = 0;
  for (const span of removals) {
    for (let i = copyCursor; i < span.start; i += 1) next.push(lines[i]);
    copyCursor = span.end;
  }
  for (let i = copyCursor; i < lines.length; i += 1) next.push(lines[i]);

  return {
    content: collapseTrailingBlanks(next, bounds.headerLine).join("\n"),
    swept: removals.length,
  };
}

/**
 * After a span removal inside a section, the leftover content can
 * contain `\n\n\n` runs that fail no validator but read as drift. We
 * collapse interior runs of 2+ blank lines within the same section
 * (starting from the section header) to a single blank line. Lines
 * outside the section are untouched.
 *
 * We use the headerLine to scope this; if it's the last section, we
 * also tail-trim trailing blanks so the file does not grow a blank
 * suffix on every sweep.
 */
function collapseTrailingBlanks(lines: string[], headerLine: number): string[] {
  const out = lines.slice(0, headerLine);
  let blankRun = 0;
  for (let i = headerLine; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      blankRun += 1;
      if (blankRun <= 1) out.push(line);
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  return out;
}

function extractEntryDate(heading: string, entryLines: string[]): string | null {
  const eventMatch = AGENT_PLAN_DATE_RE.exec(heading);
  if (eventMatch) return eventMatch[1];
  if (!SCHEDULED_HEADING_RE.test(heading)) return null;
  for (let i = 1; i < entryLines.length; i += 1) {
    const wake = SCHEDULED_WAKE_UP_RE.exec(entryLines[i]);
    if (wake) return wake[1];
  }
  return null;
}

function extractLatestCompletedPrepDate(entryLines: string[]): string | null {
  let latest: string | null = null;
  for (const line of entryLines) {
    const match = COMPLETED_PREP_RE.exec(line);
    if (!match) continue;
    if (latest === null || match[1] > latest) latest = match[1];
  }
  return latest;
}

/**
 * Match the `Status:` line of a `### Scheduled:` entry against the
 * transition validator's terminal-state criterion. Returns true when
 * the status value is `completed` or `failed`; anything else
 * (`pending`, `running`, missing line) is non-terminal. Used by 2b to
 * keep the sweep aligned with `isEntryRemovalAllowed` in
 * `roadmap-validate.ts`.
 */
function hasTerminalStatusLine(entryLines: string[]): boolean {
  for (const line of entryLines) {
    if (!STATUS_LINE_RE.test(line)) continue;
    const value = line.slice("Status:".length).trim().toLowerCase();
    return value === "completed" || value === "failed";
  }
  return false;
}

// ── Substep 2d ─────────────────────────────────────────────────────────────

interface LongTermPlansStaleMarkResult {
  content: string;
  staleMarked: number;
}

/**
 * Apply mechanical staleness markers to `## Long-term Plans` lines:
 *
 *   - `[awaiting-reply YYYY-MM-DD]` present AND awaiting-reply date is
 *     < today - 7d  →  remove the line entirely.
 *   - Source date < today - 180d AND `[stale since ...]` already
 *     present AND `[awaiting-reply ...]` not present  →  append
 *     `[awaiting-reply <today>]`.
 *   - Source date < today - 90d AND `[stale since ...]` not present
 *     →  append `[stale since <today>]`.
 *
 * The promotion / removal logic intentionally honours the existing
 * marker layout (`[stale since ...]` first, `[awaiting-reply ...]`
 * second) so the rebuilt line round-trips through `validateRoadmap`'s
 * `TRAILING_MARKERS_RE`.
 *
 * Pure: parses Source date directly off the line text via
 * `LONG_TERM_PLAN_SOURCE_DATE_RE`. Lines without a parseable Source
 * are held untouched.
 */
export function applyLongTermPlansStaleMark(
  content: string,
  todayYmd: string,
): LongTermPlansStaleMarkResult {
  const lines = content.split("\n");
  const bounds = findSectionLineBounds(lines, "Long-term Plans");
  if (!bounds) return { content, staleMarked: 0 };

  const staleCutoff = addDays(todayYmd, -STALE_THRESHOLD_DAYS);
  const awaitingCutoff = addDays(todayYmd, -AWAITING_REPLY_THRESHOLD_DAYS);
  const dropCutoff = addDays(todayYmd, -AWAITING_REPLY_DROP_DAYS);

  let staleMarked = 0;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i < bounds.bodyStart || i >= bounds.bodyEnd) {
      kept.push(lines[i]);
      continue;
    }
    const line = lines[i];
    if (line.trim() === "" || !line.startsWith("- ")) {
      kept.push(line);
      continue;
    }
    const sourceMatch = LONG_TERM_PLAN_SOURCE_DATE_RE.exec(line);
    if (!sourceMatch) {
      kept.push(line);
      continue;
    }

    // Detach the `<!-- id: rm-... -->` suffix so the canonical
    // Long-term Plans regex (`[stale since ...]` and
    // `[awaiting-reply ...]` BEFORE the id comment, when present) is
    // preserved. We re-append the same comment after mutation.
    const stripped = stripRoadmapIdComment(line);
    const base = stripped.line;
    const idSuffix = stripped.id ? `  <!-- id: ${stripped.id} -->` : "";

    const sourceDate = sourceMatch[1];
    const awaitingMatch = AWAITING_MARKER_RE.exec(base);
    if (awaitingMatch && awaitingMatch[1] < dropCutoff) {
      staleMarked += 1;
      continue;
    }
    const hasStale = STALE_MARKER_RE.test(base);
    if (sourceDate < awaitingCutoff && hasStale && !awaitingMatch) {
      kept.push(`${base} [awaiting-reply ${todayYmd}]${idSuffix}`);
      staleMarked += 1;
      continue;
    }
    if (sourceDate < staleCutoff && !hasStale) {
      if (awaitingMatch) {
        const head = base.slice(0, awaitingMatch.index);
        const tail = base.slice(awaitingMatch.index);
        kept.push(`${head} [stale since ${todayYmd}]${tail}${idSuffix}`);
      } else {
        kept.push(`${base} [stale since ${todayYmd}]${idSuffix}`);
      }
      staleMarked += 1;
      continue;
    }
    kept.push(line);
  }

  return { content: kept.join("\n"), staleMarked };
}

// ── Journal ────────────────────────────────────────────────────────────────

function appendJournalLine(
  deps: RoadmapMaintenanceDeps,
  result: RoadmapMaintenanceResult,
  now: Date,
  today: string,
): void {
  const journalPath = join(deps.contextDir, CONTEXT_RELATIVE_PATHS.agent.journal);
  const time = formatHm(now, deps.timezone);
  const summary =
    `- ${today} ${time}: status_synced=${result.statusSynced}, swept=${result.swept}, stale_marked=${result.staleMarked}` +
    (result.errors.length > 0
      ? `, errors=${result.errors.length} (${result.errors.map((e) => e.step).join(",")})`
      : "");

  let original: string | null = null;
  if (existsSync(journalPath)) {
    original = readFileSync(journalPath, "utf-8");
  }

  const next = appendToJournalSection(original, summary);
  if (original !== null) {
    saveSnapshot(deps.db, "agent/journal", original, "roadmap_maintenance_journal");
  }
  // Mark before the rename so FS-watch consumers attribute the
  // resulting event to the agent. Roll back on failure (C2).
  deps.writeTracker?.markWriting(journalPath, next);
  try {
    writeFileAtomically(journalPath, next);
  } catch (writeErr) {
    deps.writeTracker?.unmark(journalPath);
    throw writeErr;
  }
  deps.onIndexableContextChange?.(CONTEXT_RELATIVE_PATHS.agent.journal);
}

/**
 * Append `summary` to the `## Roadmap maintenance` section of
 * `agent/journal.md`, creating the section when absent. Exported for
 * unit tests so the fresh-file vs. existing-section vs. existing-file
 * branches can be pinned without standing up a sqlite + fs harness.
 */
export function appendToJournalSection(original: string | null, summary: string): string {
  if (original === null) {
    return `# Agent journal\n\n${JOURNAL_SECTION_HEADER}\n\n${summary}\n`;
  }
  const lines = original.split("\n");
  const bounds = findSectionLineBounds(lines, "Roadmap maintenance");
  if (bounds) {
    let insertAt = bounds.bodyEnd;
    while (insertAt > bounds.bodyStart && lines[insertAt - 1].trim() === "") {
      insertAt -= 1;
    }
    const next = [
      ...lines.slice(0, insertAt),
      summary,
      ...lines.slice(insertAt),
    ];
    let out = next.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    return out;
  }
  const trimmed = original.replace(/\n+$/, "");
  return `${trimmed}\n\n${JOURNAL_SECTION_HEADER}\n\n${summary}\n`;
}

// ── Audit / snapshot helpers ───────────────────────────────────────────────

function emitAudit(db: Database.Database, result: RoadmapMaintenanceResult): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, 'autonomous', ?, json(?), datetime('now'), datetime('now'))`,
    ).run(
      ROADMAP_MAINTENANCE_ACTION_TYPE,
      result.status === "success" ? "success" : result.status === "skipped" ? "skipped" : "failed",
      JSON.stringify({
        statusSynced: result.statusSynced,
        swept: result.swept,
        staleMarked: result.staleMarked,
        errors: result.errors,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
      }),
    );
  } catch (err) {
    logger.warn({ err }, "Failed to emit roadmap_mechanical_maintenance audit row");
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

// ── Date / parsing helpers ─────────────────────────────────────────────────

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatHm(now: Date, timezone?: string): string {
  if (!timezone) {
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Intl can emit "24" for midnight in some locales — guard against
  // that so the journal line is stable regardless of host locale.
  const normalizedHh = hh === "24" ? "00" : hh;
  return `${normalizedHh}:${mm}`;
}

/**
 * Find the line index just after the entry that begins at `start`
 * (heading row). The entry ends at the next `### ` heading inside the
 * section, the section boundary, or end of file — whichever comes
 * first. Used by both the 2a status-sync (to bound the Status: line
 * lookup) and the 2b sweep (to span the entry's prep rows).
 */
function findEntryEnd(lines: string[], start: number, bodyEnd: number): number {
  for (let i = start + 1; i < bodyEnd; i += 1) {
    if (lines[i].startsWith("### ")) return i;
  }
  return bodyEnd;
}
