import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";
import { validateContextFileFrontmatter } from "../context-frontmatter.js";
import type { PromptContextChangedCallback } from "../context-staleness.js";
import { writeRuntimeState, getDegradedMode } from "../../db/runtime-state.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger } from "../../logging.js";
import type {
  ReconcilerRunRecord,
  ReconcilerTrigger,
} from "./reconciler-runner.js";
import type { RecurringScheduleRow } from "../../db/recurring-schedules.js";
import type { RecurrenceRule } from "@aitne/shared";
import {
  deriveDefaultScheduleLabel,
  renderDefaultSchedulesSection,
  upsertManagementRulesDefaultSchedules,
  type DefaultScheduleSnapshotEntry,
} from "./default-schedules-reconciler.js";

const logger = createLogger("default-schedules-reconciler");

/** Runtime-state key for the default-schedules reconciler's last run. */
export const DEFAULT_SCHEDULES_RECONCILER_LAST_RUN_KEY =
  "reconciler.default_schedules.last_run";

/**
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §6.5 — drive one pass of the
 * `## Default Schedules` reconciler:
 *
 *   1. Read the `recurring_schedules` table → build snapshots.
 *   2. Render the desired section content.
 *   3. Compare against the existing on-disk `## Default Schedules`
 *      section; short-circuit on no-op.
 *   4. Snapshot prior content to `md_file_snapshots`, write the
 *      file, mark the agent-write tracker, notify the prompt-context
 *      sink.
 *   5. Persist a single `runtime_state` row regardless of outcome.
 *
 * Mirrors `policy-index-runner.ts` exactly. Runs under its own
 * per-process mutex so concurrent calls serialise.
 */
export interface RunDefaultSchedulesReconcilerOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onPromptContextChanged?: PromptContextChangedCallback;
  trigger: ReconcilerTrigger;
  /** Injectable clock for deterministic test output. */
  now?: () => Date;
}

let runnerMutex: Promise<void> = Promise.resolve();

export async function runDefaultSchedulesReconciler(
  opts: RunDefaultSchedulesReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const prev = runnerMutex;
  let releaseMutex!: () => void;
  runnerMutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  try {
    await prev;
    return await runOnce(opts);
  } finally {
    releaseMutex();
  }
}

async function runOnce(
  opts: RunDefaultSchedulesReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const now = opts.now ? opts.now() : new Date();
  const recordBase = {
    at: now.toISOString(),
    trigger: opts.trigger,
    added: 0,
    removed: 0,
    refreshedMtime: 0,
  };

  const degraded = getDegradedMode(opts.db);
  if (degraded) {
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "noop",
      error: `degraded_mode:${degraded.reason}`,
    };
    persistRunRecord(opts.db, record);
    return record;
  }

  try {
    const entries = buildDefaultSchedulesSnapshot(opts.db);
    const section = renderDefaultSchedulesSection(entries);

    const managementPath = join(
      opts.contextDir,
      CONTEXT_RELATIVE_PATHS.rules.management,
    );
    const previousManagement = readIfExists(managementPath);

    // We only write when management.md exists — first creation is the
    // setup wizard's job (see setup.ts:save-rules), the reconciler
    // only maintains. This mirrors policy-index-runner.ts's
    // skeleton-seeder boundary.
    if (previousManagement === null) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "noop",
        error: null,
      };
      persistRunRecord(opts.db, record);
      return record;
    }

    const desired = upsertManagementRulesDefaultSchedules(
      previousManagement,
      section,
    );

    if (desired === previousManagement) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "noop",
        error: null,
      };
      persistRunRecord(opts.db, record);
      return record;
    }

    // Re-validate frontmatter after the splice. The wizard's payload
    // is already validated on save; we don't change frontmatter here,
    // but the cheap re-check guards against future regressions in the
    // splice algorithm.
    const validation = validateContextFileFrontmatter(
      desired,
      CONTEXT_RELATIVE_PATHS.rules.management,
    );
    if (validation) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "error",
        error: `self_validation_failed:${validation.code}`,
      };
      persistRunRecord(opts.db, record);
      logger.error(
        { validation, trigger: opts.trigger },
        "Default-schedules render failed self-validation — leaving file untouched",
      );
      return record;
    }

    writeWithSnapshot(opts, managementPath, desired, previousManagement);
    opts.onPromptContextChanged?.(
      CONTEXT_RELATIVE_PATHS.rules.management,
      "default_schedules_reconciler",
      "quiet",
      { tierReason: "derived_default_schedules" },
    );

    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "applied",
      error: null,
      added: entries.filter((e) => e.enabled).length,
      removed: entries.filter((e) => !e.enabled).length,
      refreshedMtime: entries.length,
    };
    persistRunRecord(opts.db, record);
    logger.info(
      {
        trigger: opts.trigger,
        enabled: record.added,
        disabled: record.removed,
        total: entries.length,
      },
      "Default-schedules reconciler applied",
    );
    return record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "error",
      error: message.slice(0, 200),
    };
    persistRunRecord(opts.db, record);
    logger.error(
      { err, trigger: opts.trigger },
      "Default-schedules reconciler run failed",
    );
    return record;
  }
}

/**
 * Build a snapshot of the `recurring_schedules` table for rendering.
 * Exported so the setup wizard's save-rules handler can call it
 * directly (in-place splice without going through the runner).
 */
export function buildDefaultSchedulesSnapshot(
  db: Database.Database,
): DefaultScheduleSnapshotEntry[] {
  // Guard: table may not exist when a test hand-crafts a partial
  // schema. Mirrors `reconcileRecurringSchedules`'s tableExists check.
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recurring_schedules'",
    )
    .get();
  if (!tableExists) return [];

  const rows = db
    .prepare(
      "SELECT * FROM recurring_schedules ORDER BY id ASC",
    )
    .all() as RecurringScheduleRow[];

  return rows.map((row) => {
    const ctx = safeJsonObject(row.task_context);
    const subFlow =
      typeof ctx.sub_flow === "string" ? (ctx.sub_flow as string) : null;
    const pinnedToQuietHours = ctx.pin_to_quiet_hours_end === true;
    return {
      id: row.id,
      label: deriveDefaultScheduleLabel(subFlow, row.task_description ?? ""),
      recurrenceRule: parseRecurrenceRule(row.recurrence_rule),
      enabled: row.enabled === 1,
      pinnedToQuietHours,
      subFlow,
    };
  });
}

/**
 * Parse a stored `recurrence_rule` JSON string into a RecurrenceRule.
 * Hands back a coercion-friendly object: malformed JSON or a missing
 * column yields a placeholder `daily —` rule that `formatRecurrenceLabel`
 * still renders without throwing. The full input shape (incl. day
 * arrays) is preserved so weekly/monthly cadences render correctly.
 */
function parseRecurrenceRule(raw: string | null | undefined): RecurrenceRule {
  const obj = safeJsonObject(raw) as Partial<RecurrenceRule> & {
    frequency?: unknown;
    time?: unknown;
    timezone?: unknown;
    daysOfWeek?: unknown;
    daysOfMonth?: unknown;
    intervalHours?: unknown;
    minuteOfHour?: unknown;
    onMissingDay?: unknown;
  };
  // SCHEDULE_API_REDESIGN_PLAN §6.1 — whitelist must include `hourly`
  // alongside weekly/monthly. Without it, a stored hourly rule renders
  // as `daily —` in rules/management.md §B and breaks the round-trip
  // property the runner relies on.
  const frequency: RecurrenceRule["frequency"] =
    obj.frequency === "hourly"
      || obj.frequency === "weekly"
      || obj.frequency === "monthly"
      ? obj.frequency
      : "daily";

  // hourly has no `time`; daily/weekly/monthly do. Fall back to "—" to
  // keep formatRecurrenceLabel safe on malformed rows.
  const out: RecurrenceRule = { frequency };
  if (typeof obj.time === "string") {
    out.time = obj.time;
  } else if (frequency !== "hourly") {
    out.time = "—";
  }
  if (typeof obj.timezone === "string" && obj.timezone.length > 0) {
    out.timezone = obj.timezone;
  }
  if (frequency === "hourly") {
    if (
      typeof obj.intervalHours === "number"
      && Number.isInteger(obj.intervalHours)
      && obj.intervalHours >= 1
      && obj.intervalHours <= 23
    ) {
      out.intervalHours = obj.intervalHours;
    }
    if (
      typeof obj.minuteOfHour === "number"
      && Number.isInteger(obj.minuteOfHour)
      && obj.minuteOfHour >= 0
      && obj.minuteOfHour <= 59
    ) {
      out.minuteOfHour = obj.minuteOfHour;
    }
  }
  if (Array.isArray(obj.daysOfWeek)) {
    const days = obj.daysOfWeek.filter(
      (d): d is number => typeof d === "number" && d >= 0 && d <= 6,
    );
    if (days.length > 0) out.daysOfWeek = days;
  }
  if (Array.isArray(obj.daysOfMonth)) {
    const days = obj.daysOfMonth.filter(
      (d): d is number => typeof d === "number" && d >= 1 && d <= 31,
    );
    if (days.length > 0) out.daysOfMonth = days;
  }
  if (
    frequency === "monthly"
    && (obj.onMissingDay === "skip" || obj.onMissingDay === "lastDayOfMonth")
  ) {
    out.onMissingDay = obj.onMissingDay;
  }
  return out;
}

function safeJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readIfExists(absolutePath: string): string | null {
  if (!existsSync(absolutePath)) return null;
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err) {
    logger.warn({ err, file: absolutePath }, "Reconciler could not read file");
    return null;
  }
}

function writeWithSnapshot(
  opts: RunDefaultSchedulesReconcilerOptions,
  absolutePath: string,
  content: string,
  previousContent: string | null,
): void {
  const directory = dirname(absolutePath);
  mkdirSync(directory, { recursive: true });
  if (previousContent !== null) {
    try {
      const relativePath = relativizeToContext(opts.contextDir, absolutePath);
      opts.db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
        )
        .run(
          relativePath,
          previousContent,
          "default_schedules_reconciled",
          null,
        );
    } catch (err) {
      logger.warn(
        { err, file: absolutePath },
        "Failed to snapshot prior content before default-schedules write",
      );
    }
  }
  // Mark before the visible-write boundary (writeFileSync) so FS-watch
  // consumers attribute the resulting event to the agent. Roll back on
  // failure (C2).
  opts.writeTracker?.markWriting(absolutePath, content);
  try {
    writeFileSync(absolutePath, content, "utf-8");
  } catch (writeErr) {
    opts.writeTracker?.unmark(absolutePath);
    throw writeErr;
  }
}

function relativizeToContext(contextDir: string, absolutePath: string): string {
  if (absolutePath.startsWith(contextDir)) {
    return absolutePath.slice(contextDir.length).replace(/^[\\/]+/, "");
  }
  return absolutePath;
}

function persistRunRecord(
  db: Database.Database,
  record: ReconcilerRunRecord,
): void {
  try {
    writeRuntimeState(db, DEFAULT_SCHEDULES_RECONCILER_LAST_RUN_KEY, record);
  } catch (err) {
    logger.warn(
      { err, record },
      "Default-schedules reconciler run record persistence failed",
    );
  }
}
