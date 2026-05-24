import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type Database from "better-sqlite3";
import { writeFileAtomically } from "../../core/atomic-write.js";
import { writeRuntimeState } from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { acquireInterestsReflectionLock } from "./interests-reflection-lock.js";
import {
  escapeForHtmlComment,
  renderIndexEntryBlock,
  renderProfileBlock,
  renderProjectBlock,
  renderResearchThemesFile,
  replaceAutoBlock,
} from "./pipeline/interests-block.js";
import { loadProjectKeywords } from "./pipeline/project-matcher.js";
import {
  buildWeeklyInterestsSummary,
  weekStartFromDate,
  type AgentDayBoundary,
  type ClusterSnapshot,
  type ProjectKeywords,
} from "./pipeline/weekly-interests-summary.js";

/**
 * WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.3 — internal helper that
 * composes the three pure pipeline modules (`weekly-interests-summary`,
 * `interests-block`, `project-matcher`) into a single deterministic
 * refresh pass.
 *
 * Run as a pre-hook of `routine.weekly_review` (§10.4) and as the
 * dashboard's "Refresh now" button.
 *
 * Six steps per call (§10.3):
 *
 *   1. Build the Layer-1 cluster summary for the supplied week.
 *   2. Bail out with `{ skipped: 'fewer_than_min_themes' }` if < 3
 *      qualifying clusters surfaced — the bullet list would be
 *      under-spec and we don't want to ship a half-empty block.
 *   3. Select 3-7 themes for `profile.md` via the deterministic
 *      `selectProfileMdThemes` ranking + bias function.
 *   4. Render the four target files from `interests-block.ts`.
 *   5. Write each target through `writeFileAtomically`. `profile.md`
 *      and `_index.md` and project files are skipped (with a recorded
 *      reason) if absent — they're user-authored. `research-themes.md`
 *      is daemon-owned and auto-created.
 *   6. Emit a single `agent_actions` audit row + record
 *      `runtime_state` markers for the cleanup endpoint.
 *
 * The helper is failure-isolated by the *caller* — the pre-hook in
 * `dispatcher-scheduled-tasks.ts` wraps the call in try/catch so a
 * throw here doesn't abort the user-facing weekly artifact.
 */

const logger = createLogger("refresh-interests-reflection");

export const RUNTIME_STATE_LAST_RUN_AT_KEY =
  "browser_history.weekly_interests_last_run_at";
export const RUNTIME_STATE_LAST_RUN_TARGETS_KEY =
  "browser_history.weekly_interests_last_run_targets";

export const MIN_PROFILE_MD_THEMES = 3;
export const MAX_PROFILE_MD_THEMES = 7;

/**
 * 04:00 local — matches the `dayBoundaryHour` invariant documented in
 * CLAUDE.md and used by the `getAgentDayBoundsUtc` helper. `timezone`
 * is left undefined so `Intl.DateTimeFormat` resolves to the daemon's
 * runtime timezone (the same convention every other call site uses).
 */
const DEFAULT_BOUNDARY: AgentDayBoundary = {
  timezone: undefined,
  dayBoundaryHour: 4,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Return the agent-day YYYY-MM-DD string for the most recent Monday
 * at-or-before `nowMs`. `weekStartFromDate` returns whichever weekday
 * `nowMs` lands in; the helper's design contract is an ISO-Monday
 * window start, so we snap back from there.
 */
function mostRecentMondayFromDate(
  nowMs: number,
  boundary: AgentDayBoundary,
): string {
  const todayLabel = weekStartFromDate(nowMs, boundary);
  // `weekStartFromDate` returns a stable label; parse it back via
  // noon-UTC anchoring (same trick as `weekWindowMs`) so DST cannot
  // flip the day-of-week we read.
  const anchor = new Date(`${todayLabel}T12:00:00Z`);
  const dow = anchor.getUTCDay(); // 0 = Sun, 1 = Mon, … 6 = Sat
  const daysBack = (dow + 6) % 7; // Mon → 0, Tue → 1, … Sun → 6
  if (daysBack === 0) return todayLabel;
  const monday = new Date(anchor.getTime() - daysBack * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

export type RefreshTrigger = "scheduler" | "dashboard" | "test";

export interface RefreshOptions {
  /**
   * Override the agent-day boundary. Defaults to the codebase invariant
   * (`{ timezone: undefined, dayBoundaryHour: 4 }` — local time with the
   * 04:00 day-boundary defined in CLAUDE.md). The dispatcher pre-hook is
   * expected to pass the daemon's configured timezone explicitly; this
   * default is for tests and the dashboard manual-trigger path.
   */
  readonly boundary?: AgentDayBoundary;
  /**
   * Override the `weekStart`. Defaults to the most recent ISO Monday in
   * the current agent-day (snap-back from `nowMs`). Per §10.2 the HTTP
   * route also rejects non-Monday values; this default applies the same
   * convention at the helper level so a caller omitting `weekStart`
   * never lands on a misaligned 7-day window.
   */
  readonly weekStart?: string;
  /**
   * Provenance tag for the audit row. `"scheduler"` for the cron
   * pre-hook, `"dashboard"` for the bearer-authed admin button,
   * `"test"` for vitest integration tests.
   */
  readonly trigger: RefreshTrigger;
  /** Override for deterministic tests; defaults to `Date.now()`. */
  readonly nowMs?: number;
  /**
   * Inject the project-keyword set instead of scanning `<contextDir>/
   * projects/*.md`. Used by callers that already have the matcher
   * loaded (e.g. the dashboard preview) and by tests that need to
   * exercise the post-load `project_missing` race.
   */
  readonly projectKeywordsOverride?: readonly ProjectKeywords[];
  /**
   * FS-watcher attribution channel. When supplied, the helper marks
   * each target file via `markWriting(path, content)` (content-hash
   * mode) before the atomic rename, and rolls the mark back via
   * `unmark` if the write throws. Without it, downstream observers —
   * `context-index-reconciler-observer`, `entity-mirror.ts`, future
   * obsidian/git watchers — would attribute the reflection's writes to
   * the user, fire redundant reconciler passes, or (worst case) treat
   * the auto-block churn as user input. The dispatcher pre-hook passes
   * `ScheduledTaskRunner.writeTracker`; tests typically pass
   * `undefined` and assert the helper is a no-op then.
   */
  readonly writeTracker?: AgentWriteTracker;
  /**
   * Originating event identifier — written into the `agent_actions.
   * event_id` column so the dashboard's audit log can join the
   * reflection row to its triggering `routine.weekly_review` event.
   * The dispatcher pre-hook passes `event.correlationId`; HTTP-route
   * callers pass `undefined` because the dashboard refresh button is
   * not bound to an `Event` in the bus sense.
   */
  readonly eventId?: string;
  /**
   * When `true`, the helper short-circuits with
   * `skipped='no_browser_history'` before reading any cluster data and
   * without taking the lock. The dispatcher pre-hook sets this to
   * reflect `readIntegrationState(db, "browser_history").mode ===
   * "disabled"`; the dashboard route never sets it (the UI itself
   * gates on the integration card's enable state).
   *
   * Hoisting the disabled gate INTO the helper keeps the audit-row
   * schema uniform — both skip reasons emit the same row shape and the
   * dashboard's `data.skipped.reason` enum has both arms with no dead
   * code (WEEKLY_INTERESTS_REFLECTION_PLAN.md §22).
   */
  readonly integrationDisabled?: boolean;
}

/**
 * Discriminated skip-result. Both arms emit identical
 * `agent_actions(action_type='browser_interests_reflection_applied',
 * result='skipped')` rows; the `reason` discriminator lets the
 * dashboard display a precise badge and gives operators a queryable
 * field for "why isn't my reflection running" debug.
 */
export interface RefreshSkipReason {
  reason: "fewer_than_min_themes" | "no_browser_history";
}

export interface RefreshResult {
  weekStart: string;
  generatedAt: string;
  targetsWritten: string[];
  targetsSkipped: { path: string; reason: string }[];
  themesSelected: string[];
  clustersInSnapshot: number;
  clustersDormantSinceLastWeek: number;
  projectsAnnotated: number;
  projectsSkippedNoMatch: number;
  skipped?: RefreshSkipReason;
}

/**
 * Deterministic theme selector — §10.3 step 3. Replaces the LLM
 * judgement step in earlier drafts. Encoded biases:
 *
 *   - Baseline = meaningful foreground seconds in the window.
 *   - New themes get a small (×1.20) freshness bump so a topic the
 *     user just started doesn't get drowned by a multi-week thread.
 *   - Accepted research offers (×1.30) signal explicit user
 *     engagement — they should rank higher than passive browsing.
 *   - Already-concluded topics (wiki summary written, no recent
 *     activity) drop by ×0.50 — the cluster has been "shipped"; the
 *     user has moved on.
 *
 * The function is pure of the input list ordering — `pickTopClusters`
 * has already sorted by foreground_sec desc, so ties resolve
 * deterministically.
 */
export function selectProfileMdThemes(
  clusters: readonly ClusterSnapshot[],
  nowMs: number,
  maxThemes: number = MAX_PROFILE_MD_THEMES,
): string[] {
  const FRESHNESS_BONUS = 1.2;
  const ACCEPTED_BONUS = 1.3;
  const CONCLUDED_DECAY = 0.5;
  const STALE_THRESHOLD_DAYS = 5;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const scored = clusters.map((c) => {
    let score = c.meaningfulForegroundSec;
    if (c.statusChange === "new") score *= FRESHNESS_BONUS;
    if (c.hasAcceptedResearch) score *= ACCEPTED_BONUS;
    const daysSinceActivity =
      c.lastActivityMs > 0 ? (nowMs - c.lastActivityMs) / DAY_MS : Infinity;
    if (c.hasWikiSummary && daysSinceActivity > STALE_THRESHOLD_DAYS) {
      score *= CONCLUDED_DECAY;
    }
    return { slug: c.slug, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slug.localeCompare(b.slug);
  });
  return scored.slice(0, maxThemes).map((s) => s.slug);
}

/**
 * Top-level entry consumed by the dispatcher pre-hook and the
 * dashboard route.
 */
export function refreshInterestsReflection(
  db: Database.Database,
  contextDir: string,
  options: RefreshOptions,
): RefreshResult {
  const boundary = options.boundary ?? DEFAULT_BOUNDARY;
  const nowMs = options.nowMs ?? Date.now();
  const weekStart =
    options.weekStart ?? mostRecentMondayFromDate(nowMs, boundary);
  const isoNow = new Date(nowMs).toISOString();

  // Disabled-integration short-circuit — the gate lives in the helper
  // so the audit row shape is uniform across both skip reasons. No lock
  // needed; nothing is written and the helper returns
  // before any disk or DB read beyond the audit insert. The dispatcher
  // pre-hook supplies this flag via `readIntegrationState`; HTTP-route
  // callers (dashboard) never set it.
  if (options.integrationDisabled) {
    const skippedResult: RefreshResult = {
      weekStart,
      generatedAt: isoNow,
      targetsWritten: [],
      targetsSkipped: [],
      themesSelected: [],
      clustersInSnapshot: 0,
      clustersDormantSinceLastWeek: 0,
      projectsAnnotated: 0,
      projectsSkippedNoMatch: 0,
      skipped: { reason: "no_browser_history" },
    };
    // `undefined` (not `null`) signals "no error" to emitAuditRow —
    // null would stringify to the literal "null" and land in the error
    // column. Pass undefined so the row's `error` is SQLite NULL.
    emitAuditRow(db, skippedResult, options.trigger, options.eventId, undefined);
    return skippedResult;
  }

  // Courtesy mutex — see `interests-reflection-lock.ts`. Contention
  // throws `InterestsReflectionLockBusyError` for the caller (the
  // dispatcher catches it as a routine error; the dashboard route
  // surfaces it as 409). Held until the `finally` block — without that
  // unlock, every future call would throw.
  const release = acquireInterestsReflectionLock(
    `refresh:${options.trigger}`,
  );

  // Eagerly-allocated result so the `finally` audit-row emit can
  // capture whatever state we reached, even if a write throws partway.
  const result: RefreshResult = {
    weekStart,
    generatedAt: isoNow,
    targetsWritten: [],
    targetsSkipped: [],
    themesSelected: [],
    clustersInSnapshot: 0,
    clustersDormantSinceLastWeek: 0,
    projectsAnnotated: 0,
    projectsSkippedNoMatch: 0,
  };
  let caught: unknown = undefined;
  try {
    const projectKeywords =
      options.projectKeywordsOverride ?? loadProjectKeywords(contextDir);
    const summary = buildWeeklyInterestsSummary(db, weekStart, {
      boundary,
      projectKeywords,
      nowMs,
    });
    result.weekStart = summary.weekStart;
    result.generatedAt = summary.generatedAt;
    result.clustersInSnapshot = summary.clusters.length;
    result.clustersDormantSinceLastWeek = summary.dormantSinceLastWeek.length;

    if (summary.clusters.length < MIN_PROFILE_MD_THEMES) {
      result.projectsSkippedNoMatch = projectKeywords.length;
      result.skipped = { reason: "fewer_than_min_themes" };
      return result;
    }

    const themesSelected = selectProfileMdThemes(summary.clusters, nowMs);
    result.themesSelected = themesSelected;
    const themeSet = new Set(themesSelected);
    const themedClusters = summary.clusters.filter((c) => themeSet.has(c.slug));

    const writeTracker = options.writeTracker;

    // 1. profile.md (Mode A — only if it exists; user-authored)
    const profilePath = join(contextDir, "user", "profile.md");
    if (existsSync(profilePath)) {
      const newBlock = renderProfileBlock({
        clusters: themedClusters,
        weekStart: summary.weekStart,
        generatedAt: summary.generatedAt,
      });
      writeWithReplacement(profilePath, newBlock, null, writeTracker);
      result.targetsWritten.push(relativePath(contextDir, profilePath));
    } else {
      result.targetsSkipped.push({
        path: relativePath(contextDir, profilePath),
        reason: "profile_md_missing",
      });
    }

    // 2. user/research-themes.md (Mode B — daemon-owned, auto-create)
    const themesPath = join(contextDir, "user", "research-themes.md");
    ensureDirExists(themesPath);
    const themesContent = renderResearchThemesFile(summary);
    markedAtomicWrite(themesPath, themesContent, writeTracker);
    result.targetsWritten.push(relativePath(contextDir, themesPath));

    // 3. user/_index.md (Mode A — only if it exists)
    const indexPath = join(contextDir, "user", "_index.md");
    if (existsSync(indexPath)) {
      const indexEntry = renderIndexEntryBlock({
        generatedAt: summary.generatedAt,
      });
      writeWithReplacement(indexPath, indexEntry, "target=research-themes", writeTracker);
      result.targetsWritten.push(relativePath(contextDir, indexPath));
    } else {
      result.targetsSkipped.push({
        path: relativePath(contextDir, indexPath),
        reason: "_index_missing",
      });
    }

    // 4. project annotations (Mode A — only existing project files)
    const matchedProjectPaths = new Set(
      summary.projectMatches.map((m) => m.projectPath),
    );

    for (const project of projectKeywords) {
      if (!existsSync(project.projectPath)) {
        // The project disappeared between `loadProjectKeywords` and now
        // (unlikely but cheap to defend); skip with a structured reason.
        result.targetsSkipped.push({
          path: relativePath(contextDir, project.projectPath),
          reason: "project_missing",
        });
        continue;
      }
      if (matchedProjectPaths.has(project.projectPath)) {
        const match = summary.projectMatches.find(
          (m) => m.projectPath === project.projectPath,
        )!;
        // `match.clusters` always references entries already present in
        // `summary.clusters` — `buildWeeklyInterestsSummary` builds the
        // match set by iterating that same array — so the find below
        // never returns undefined.
        const clustersForProject = match.clusters.map(
          (entry) => summary.clusters.find((c) => c.slug === entry.slug)!,
        );
        const block = renderProjectBlock({
          projectSlug: project.projectSlug,
          clusters: clustersForProject,
          weekStart: summary.weekStart,
          generatedAt: summary.generatedAt,
        })!;
        writeWithReplacement(
          project.projectPath,
          block,
          // Mirror the renderer's HTML-comment escape so a slug
          // containing `-->` produces a regex that matches the BEGIN/END
          // markers it actually wrote.
          `project=${escapeForHtmlComment(project.projectSlug)}`,
          writeTracker,
        );
        result.targetsWritten.push(relativePath(contextDir, project.projectPath));
        result.projectsAnnotated += 1;
        continue;
      }
      // No match this week — strip any prior block for THIS project's
      // disambiguator. We can't rely on `stripAllAutoBlocks` because
      // other plug-ins may share the v1 namespace in the future.
      const content = readFileSync(project.projectPath, "utf-8");
      const stripped = removeProjectBlock(content, project.projectSlug);
      if (stripped !== content) {
        markedAtomicWrite(project.projectPath, stripped, writeTracker);
        result.targetsWritten.push(relativePath(contextDir, project.projectPath));
      }
      result.projectsSkippedNoMatch += 1;
    }

    // runtime-state markers reflect successful completion only — a
    // partial-then-throw run leaves the prior `last_run_at` so the
    // cleanup endpoint and any future "stale snapshot" detection work
    // off the last fully-applied refresh.
    writeRuntimeState(db, RUNTIME_STATE_LAST_RUN_AT_KEY, nowMs);
    writeRuntimeState(db, RUNTIME_STATE_LAST_RUN_TARGETS_KEY, result.targetsWritten);

    return result;
  } catch (err) {
    caught = err;
    throw err;
  } finally {
    // Single audit row per invocation. `success` on the clean path,
    // `partial` when we threw mid-write but had already pushed at least
    // one targetsWritten entry, `failed` when we threw before any
    // write, `skipped` for the < min-themes case. The `error` column
    // is populated when `caught !== undefined`; the dashboard's audit
    // log surfaces that field directly.
    emitAuditRow(db, result, options.trigger, options.eventId, caught);
    release();

    if (caught === undefined) {
      logger.info(
        {
          weekStart: result.weekStart,
          trigger: options.trigger,
          targetsWritten: result.targetsWritten.length,
          themesSelected: result.themesSelected.length,
          projectsAnnotated: result.projectsAnnotated,
          skipped: result.skipped?.reason,
        },
        "Weekly interests reflection applied",
      );
    } else {
      logger.warn(
        {
          weekStart: result.weekStart,
          trigger: options.trigger,
          targetsWritten: result.targetsWritten.length,
          err: caught,
        },
        "Weekly interests reflection threw — partial state recorded in audit row",
      );
    }
  }
}

function ensureDirExists(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function relativePath(contextDir: string, fullPath: string): string {
  return relative(contextDir, fullPath).split("\\").join("/");
}

function writeWithReplacement(
  fullPath: string,
  newBlockContent: string,
  disambiguator: string | null,
  writeTracker: AgentWriteTracker | undefined,
): void {
  const existing = readFileSync(fullPath, "utf-8");
  const updated = replaceAutoBlock(existing, newBlockContent, disambiguator);
  if (updated !== existing) {
    markedAtomicWrite(fullPath, updated, writeTracker);
  }
}

/**
 * Atomic-write wrapper that pre-marks the path on the agent-write
 * tracker so FS-watch consumers attribute the resulting event to the
 * agent — matches the convention `core/atomic-write.ts` callers around
 * the codebase use (roadmap-maintenance, context/write.ts, agent-
 * journal-appender). The `unmark` rollback fires only on a write
 * throw, so a successful write leaves the mark in place long enough
 * for chokidar's debounced fs event to be classified.
 */
function markedAtomicWrite(
  fullPath: string,
  content: string,
  writeTracker: AgentWriteTracker | undefined,
): void {
  writeTracker?.markWriting(fullPath, content);
  try {
    writeFileAtomically(fullPath, content);
  } catch (err) {
    writeTracker?.unmark(fullPath);
    throw err;
  }
}

const BEGIN_MARKER = "<!-- BEGIN aitne:browser-interests v1";
const END_MARKER = "<!-- END aitne:browser-interests v1";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeProjectBlock(content: string, projectSlug: string): string {
  // Mirror of `interests-block.ts:buildBlockRegex` for the
  // project-disambiguated form. The block delimiter pattern uses the
  // same `project=<slug>` form on BEGIN and END, and the slug runs
  // through `escapeForHtmlComment` so `-->` cannot escape the
  // comment — we apply the same transform here before regex-quoting.
  //
  // The trailing literal space after the disambiguator on the BEGIN
  // side mirrors `buildBlockRegex`'s prefix-collision guard: without
  // it, removing `project=aitne` would also match a `project=aitne-foo`
  // BEGIN line in passing and (paired with a later `project=aitne` END)
  // fuse multiple blocks into one replacement.
  const slugForMarkers = escapeForHtmlComment(projectSlug);
  const escapedSlug = escapeRegex(slugForMarkers);
  const pattern = new RegExp(
    `\\s*${escapeRegex(BEGIN_MARKER)} project=${escapedSlug} [^]*?${escapeRegex(END_MARKER)} project=${escapedSlug} -->\\s*`,
    "m",
  );
  if (!pattern.test(content)) return content;
  // Restore a single trailing newline so the file ends cleanly.
  return content.replace(pattern, "\n").replace(/\n{3,}$/, "\n\n");
}

function emitAuditRow(
  db: Database.Database,
  result: RefreshResult,
  trigger: RefreshTrigger,
  eventId: string | undefined,
  caught: unknown,
): void {
  // Four terminal states. `partial` lands only when we threw mid-write
  // but had already written ≥1 file (the operator can replay
  // the run safely; the next refresh idempotently re-applies the
  // same content from the same SQLite snapshot).
  const finalResult: "success" | "skipped" | "partial" | "failed" =
    result.skipped
      ? "skipped"
      : caught === undefined
        ? "success"
        : result.targetsWritten.length > 0
          ? "partial"
          : "failed";
  const errorMessage =
    caught === undefined
      ? null
      : caught instanceof Error
        ? caught.message
        : String(caught);
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, trigger, result, detail, completed_at, source_kind, error, metadata)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
    ).run(
      // `event_id` joins this audit row to the originating event in
      // the dashboard's audit log. Scheduler pre-hook passes
      // `event.correlationId`; dashboard / test callers pass null.
      eventId ?? null,
      "browser_interests_reflection_applied",
      `weekly_interests_reflection:${trigger}`,
      finalResult,
      JSON.stringify({
        week_start: result.weekStart,
        trigger,
        targets_written: result.targetsWritten,
        targets_skipped: result.targetsSkipped,
        themes_selected: result.themesSelected,
        clusters_in_full_snapshot: result.clustersInSnapshot,
        clusters_dormant_since_last_week: result.clustersDormantSinceLastWeek,
        projects_annotated: result.projectsAnnotated,
        projects_skipped_no_match: result.projectsSkippedNoMatch,
        ...(result.skipped ? { skipped: result.skipped } : {}),
        ...(errorMessage !== null ? { error_message: errorMessage } : {}),
      }),
      trigger === "scheduler" ? "cron" : "manual",
      errorMessage,
      // Explicit `metadata: '{}'`. Daemon-write rows leave the
      // structured-metadata side-channel empty (per `agent_actions`
      // schema comment: metadata is the agent-self-report channel,
      // detail is the daemon-write telemetry). Passing the literal
      // `'{}'` here documents that intent at the call site so a
      // future reader doesn't read the DEFAULT and assume metadata
      // population was simply missed.
      "{}",
    );
  } catch (err) {
    // Audit-row failure must not abort the refresh — the file writes
    // are the load-bearing side-effect. Log loudly so an operator can
    // notice the audit gap.
    logger.error({ err }, "Failed to write reflection audit row");
  }
}
