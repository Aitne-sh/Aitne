import type Database from "better-sqlite3";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { resolve, extname } from "node:path";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import {
  expireStalePurchaseTokens,
  scrubRotatedPurchaseTokens,
  sweepOrphanedConsumedPurchaseTokens,
} from "../db/browser-automation-purchase-tokens-store.js";
import { deletePurchaseRepliesOlderThan } from "../db/browser-automation-purchase-replies-store.js";
import { deleteWorkflowRunsOlderThan } from "../db/browser-automation-store.js";
import { deleteTerminalBrowserTasksOlderThan } from "../db/browser-task-store.js";
import { deleteTerminalBackgroundTasksOlderThan } from "../db/background-task-store.js";
import {
  expireStaleLiteFinalConfirmTokens,
  scrubRotatedLiteFinalConfirmTokens,
} from "../db/browser-task-final-confirm-tokens-store.js";
import {
  cleanupConsumedObservations,
  getStalePendingObservationStats,
} from "../db/observations.js";
import { pruneOldMcpToolCalls } from "../services/mcp/tool-audit.js";
import { AttachmentStore } from "../services/attachments/store.js";
import { tracesRootDir } from "../services/browser-history/automation/trace-store-paths.js";
import { TRACE_RETENTION_DAYS } from "../services/browser-history/automation/trace-store.js";
import { createLogger } from "../logging.js";

const logger = createLogger("retention");

/** Retention policies — days to keep each data type */
const RETENTION_DAYS = {
  mdFileSnapshots: 30,
  messages: 90,
  agentActions: 90,
  notificationLog: 60,
  conversationSessions: 7, // inactive sessions only
  dmConversationLog: 90,
  observations: 7,
  agentSchedule: 30, // completed/failed/skipped rows only
  mcpToolCalls: 90,
  authTelemetryCounters: 90,
  mailMessagesIndex: 365,
  deletedMailMessagesIndex: 30,
  /**
   * Phase B-2 audit rows (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.14).
   * The audit table mirrors `browser_automation_workflows`; the per-run
   * `trace_path` references the FS trace dir below, so SQL deletes and
   * trace prunes run with the SAME cutoff to keep the two side-by-side.
   * Matches the design's §8.7 `TRACE_RETENTION_DAYS` (14 d).
   */
  browserAutomationWorkflows: TRACE_RETENTION_DAYS,
  /**
   * Phase B-4 (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.6 / §13 step
   * 60). The raw `!~xxxxxxxx` string is rotated to NULL 1 day after
   * the row reaches a terminal state — bounding the window in which a
   * stale DM-history token could be replayed against a daemon bug.
   * Reply audit rows live 90 days (longer than B-3 approvals because
   * the spoofing / replay analysis surfaces the hashed history).
   */
  browserAutomationPurchaseTokenScrub: 1,
  browserAutomationPurchaseReplies: 90,
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §6.5 deferred follow-up + §14.7.
   * Terminal `browser_task` rows age out at 30 days — mirroring the
   * trace-store screenshot window so a row never references missing
   * screenshots. Children (`browser_task_action_log`,
   * `browser_task_clarifications`, `browser_task_final_confirm_tokens`)
   * cascade via FK ON DELETE CASCADE.
   *
   * Non-terminal rows (`pending` / `running` / `awaiting_user` /
   * `final_confirm`) are NEVER deleted by retention — the boot-recovery
   * sweep is the only path that mutates them past their owner's
   * daemon-restart, so retention seeing one of them means the boot
   * sweep itself is broken and we should not paper over it.
   */
  browserTask: TRACE_RETENTION_DAYS,
  /**
   * BACKGROUND_TASK_RUNNER_DESIGN.md §6 — terminal `background_task` rows
   * age out at 30 days. Unlike browser_task there are no trace
   * screenshots to keep in sync; 30 days keeps a month of completed-task
   * history so a late "what did that find?" follow-up can still
   * `GET /api/background-task/:id`. Children
   * (`background_task_clarifications`) cascade via FK. Non-terminal rows
   * are NEVER deleted — boot re-dispatch owns them.
   */
  backgroundTask: 30,
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §14.11 Q#6 — lite-final-confirm tokens
   * carry the same `!~xxxxxxxx` shape as B-4 purchase tokens. Mirror the
   * 1-day scrub window so a terminal row's raw token is rotated to NULL
   * shortly after redemption / cancel / expiry. Reduces at-rest footprint
   * without touching the row itself (which gets pruned via `browserTask`
   * once the parent task ages out).
   */
  browserTaskFinalConfirmTokenScrub: 1,
  mailParseFailures: 30,
  managementParseFailures: 30,
  skillCurationSignals: 180,
  skillCurationConsumedSignals: 90,
  skillCurationProposals: 180,
  skillCurationRuns: 180,
  skillCurationRunningMaxHours: 24,
  tempFiles: 1,
  /**
   * Pending observations are NEVER deleted by retention (the activity_scan
   * dispatcher owns consumption). After this many days unconsumed, retention
   * logs a warning so the operator notices a stalled pipeline.
   */
  stalePendingObservationsWarn: 14,
  // B-007 §5.9 / §6.5 — synthesized daily/ is persistent by design. The
  // retention value here is only used as a safety net when the
  // `daily/` folder is explicitly enabled for pruning (it is not); kept
  // for backwards-compatible config reads.
  dailyMd: 36500,
  weeklyMd: 365,
  /**
   * Per-day git journal entries under `git/<slug>/journal/<YYYY-MM-DD>.md`.
   * One year matches the design (docs/design/appendices/unified-repositories.md
   * §4.5). Long-arc evolution lives in `git/<slug>/overview.md`'s
   * `## Lifecycle Phases` and `## Notable Changes`; the journal is the
   * granular per-day record we can afford to drop after a year.
   */
  gitJournalMd: 365,
} as const;

/**
 * Retention policy for `journal/agent.md` content-level rollup.
 *
 * The journal is append-only — Weekly/Monthly Review routines add new
 * `## Weekly YYYY-Www` and `## Monthly YYYY-MM` sections over time. Without
 * pruning it grows unbounded. The policy:
 *
 *   - Keep the most recent `keepMonthlySections` `## Monthly YYYY-MM`
 *     sections (default 24 = 2 years). Older monthlies are pruned to
 *     bound file size over multi-year operation.
 *   - Keep only the most recent `keepWeeklySections` `## Weekly YYYY-Www`
 *     sections; older weeklies are considered superseded by the monthly
 *     rollup that covers them.
 *   - Collapse duplicate `## Weekly YYYY-Www` and `## Monthly YYYY-MM`
 *     sections (last-write-wins): if the review routine ran twice in the
 *     same period, keep only the most recently appended section. This makes
 *     the append-only write path structurally idempotent.
 *   - Warn (non-destructively) when any single kept section exceeds
 *     `sectionSizeWarnBytes`. Bloat indicates the review prompt's bullet
 *     caps are being ignored; the operator should investigate rather than
 *     silently truncate information mid-sentence.
 *   - Never delete the file itself — if nothing qualifies for pruning the
 *     file is left untouched (no disk write, no snapshot noise).
 *
 * Invariant with the weekly_review / monthly_review prompts:
 *   `keepWeeklySections >= 4`, because `routine.monthly_review` reads the
 *   last ~4 weekly sections via `GET /api/context/agent-journal` when
 *   synthesizing its retrospective. If you lower this below 4, update the
 *   prompt in core/prompts.ts as well.
 */
const AGENT_JOURNAL_ROLLUP = {
  keepWeeklySections: 12,
  /**
   * Monthly sections are the durable rollup of weekly reviews and should be
   * kept for a long time, but not forever — after several years the file
   * would grow into hundreds of KB, inflating prompt token costs each time
   * the journal is loaded as context. 24 months keeps two full years of
   * retrospectives, which is enough for long-range trend analysis while
   * bounding file size to ~96 KB worst-case (24 × 4 KB cap).
   */
  keepMonthlySections: 24,
  /**
   * ~4000 bytes ≈ 1000 tokens — the soft cap a weekly or monthly section
   * should respect. Above this we log a warning so the operator sees prompt
   * compliance drift. We never truncate content mid-section because that
   * would corrupt the agent's own reflection history in unpredictable ways.
   */
  sectionSizeWarnBytes: 4000,
} as const;

export interface AgentJournalRollupResult {
  /** Weekly sections removed by age-based pruning (after dedup). */
  weeklyPruned: number;
  /** Monthly sections removed by age-based pruning (after dedup). */
  monthlyPruned: number;
  /**
   * Duplicate weekly or monthly sections removed. When the same
   * `YYYY-Www` or `YYYY-MM` key appears more than once, the section with
   * the highest original index (most recent append) is kept; the earlier
   * copies are counted here.
   */
  duplicatesCollapsed: number;
  /**
   * Kept sections that exceeded `sectionSizeWarnBytes`. Non-destructive —
   * the file is not truncated, but a warning is logged per offending
   * section so operators see prompt compliance drift.
   */
  oversizedSections: number;
}

export interface RetentionResult {
  mdFileSnapshots: number;
  messages: number;
  agentActions: number;
  notificationLog: number;
  conversationSessions: number;
  dmConversationLog: number;
  observations: number;
  agentSchedule: number;
  /** Legacy field kept for API compatibility; always 0 post B-007. */
  scheduleFiles: number;
  weeklyFiles: number;
  /**
   * Per-day git journal files pruned (1-year retention; see
   * docs/design/appendices/unified-repositories.md §4.5).
   */
  gitJournalFiles: number;
  agentJournalWeeklyPruned: number;
  agentJournalMonthlyPruned: number;
  agentJournalDuplicatesCollapsed: number;
  agentJournalOversizedSections: number;
  mcpToolCalls: number;
  authTelemetryCounters: number;
  mailMessagesIndex: number;
  mailParseFailures: number;
  managementParseFailures: number;
  skillCurationSignals: number;
  skillCurationProposals: number;
  skillCurationRuns: number;
  skillCurationRunsAborted: number;
  attachmentOrphanRows: number;
  attachmentDanglingRows: number;
  attachmentUntrackedDirs: number;
  tempFiles: number;
  /** Expired `integration_writes` rows pruned. */
  integrationWrites: number;
  /** Stale `imminent_event_notifications` rows pruned (Phase 7 §3.2). */
  imminentEventNotifications: number;
  /**
   * Phase B-2 audit rows pruned from `browser_automation_workflows`
   * (`browserAutomationWorkflows` retention day count). Paired with
   * `browserAutomationTraceDirs` below; the SQL row goes first so a
   * partial failure does not leave a row pointing at a missing trace
   * dir.
   */
  browserAutomationWorkflows: number;
  /** Phase B-2 per-workflow trace directories pruned from
   *  `<PA_DATA_DIR>/automation-traces/`. Same retention horizon as
   *  `browserAutomationWorkflows`. */
  browserAutomationTraceDirs: number;
  /** Phase B-4 — pending purchase tokens past their 5-min TTL flipped
   *  to expired (and their `cancel_reason` set to `timeout`) during
   *  the sweep. */
  browserAutomationPurchaseTokensExpired: number;
  /** Phase B-4 — consumed-but-not-finalized rows older than the
   *  per-workflow grace window, flipped to cancelled with reason
   *  `supervisor_orphan_sweep`. Catches daemon-crash mid-flight + any
   *  post-consume Playwright stall that left the row stranded. */
  browserAutomationPurchaseTokensOrphaned: number;
  /** Phase B-4 — terminal purchase-token rows whose raw `token` was
   *  rotated to NULL during this sweep. */
  browserAutomationPurchaseTokensScrubbed: number;
  /** Phase B-4 — `_replies` audit rows older than the retention
   *  horizon, deleted during this sweep. */
  browserAutomationPurchaseRepliesDeleted: number;
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §6.5 — terminal `browser_task` rows
   * pruned during this sweep (children cascade via FK). Non-terminal
   * rows are never counted here; boot-recovery owns them.
   */
  browserTask: number;
  /**
   * BACKGROUND_TASK_RUNNER_DESIGN.md §6 — terminal `background_task` rows
   * pruned during this sweep (children cascade via FK).
   */
  backgroundTask: number;
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §5 — pending lite-final-confirm
   * tokens past their 5-min TTL flipped to `expired` during this sweep
   * (mirrors B-4's `browserAutomationPurchaseTokensExpired`).
   */
  browserTaskFinalConfirmTokensExpired: number;
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §14.11 Q#6 — terminal
   * lite-final-confirm token rows whose raw `token` was rotated to NULL
   * during this sweep (mirrors B-4's
   * `browserAutomationPurchaseTokensScrubbed`).
   */
  browserTaskFinalConfirmTokensScrubbed: number;
  /** Whether FTS5 segment optimization ran after content-table deletions. */
  ftsOptimized: boolean;
  /** Whether WAL checkpoint (TRUNCATE) succeeded after all DB operations. */
  walCheckpointed: boolean;
}

/**
 * Run data retention cleanup.
 *
 * Deletes expired data from both SQLite tables and context files
 * based on the retention policy defined in DESIGN.md §3.5.
 */
export function runRetentionCleanup(
  db: Database.Database,
  config: AgentConfig,
): RetentionResult {
  const result: RetentionResult = {
    mdFileSnapshots: 0,
    messages: 0,
    agentActions: 0,
    notificationLog: 0,
    conversationSessions: 0,
    dmConversationLog: 0,
    observations: 0,
    agentSchedule: 0,
    mcpToolCalls: 0,
    authTelemetryCounters: 0,
    mailMessagesIndex: 0,
    mailParseFailures: 0,
    managementParseFailures: 0,
    skillCurationSignals: 0,
    skillCurationProposals: 0,
    skillCurationRuns: 0,
    skillCurationRunsAborted: 0,
    attachmentOrphanRows: 0,
    attachmentDanglingRows: 0,
    attachmentUntrackedDirs: 0,
    tempFiles: 0,
    scheduleFiles: 0,
    weeklyFiles: 0,
    gitJournalFiles: 0,
    agentJournalWeeklyPruned: 0,
    agentJournalMonthlyPruned: 0,
    agentJournalDuplicatesCollapsed: 0,
    agentJournalOversizedSections: 0,
    integrationWrites: 0,
    imminentEventNotifications: 0,
    browserAutomationWorkflows: 0,
    browserAutomationTraceDirs: 0,
    browserAutomationPurchaseTokensExpired: 0,
    browserAutomationPurchaseTokensOrphaned: 0,
    browserAutomationPurchaseTokensScrubbed: 0,
    browserAutomationPurchaseRepliesDeleted: 0,
    browserTask: 0,
    backgroundTask: 0,
    browserTaskFinalConfirmTokensExpired: 0,
    browserTaskFinalConfirmTokensScrubbed: 0,
    ftsOptimized: false,
    walCheckpointed: false,
  };

  // ── SQLite table cleanup (transactional) ──
  //
  // All DELETE operations run inside a single transaction so a mid-cleanup
  // crash leaves the database in either the pre- or post-cleanup state,
  // never a partial mix. Deletion counts are accumulated into a local
  // object and only copied to `result` after the transaction commits —
  // if the transaction rolls back, `result` stays at zero rather than
  // reporting phantom deletions.
  const counts = {
    mdFileSnapshots: 0,
    messages: 0,
    agentActions: 0,
    notificationLog: 0,
    dmConversationLog: 0,
    observations: 0,
    conversationSessions: 0,
    agentSchedule: 0,
    mcpToolCalls: 0,
    authTelemetryCounters: 0,
    mailMessagesIndex: 0,
    mailParseFailures: 0,
    managementParseFailures: 0,
    skillCurationSignals: 0,
    skillCurationProposals: 0,
    skillCurationRuns: 0,
    skillCurationRunsAborted: 0,
    integrationWrites: 0,
    imminentEventNotifications: 0,
    browserAutomationWorkflows: 0,
    browserAutomationPurchaseTokensExpired: 0,
    browserAutomationPurchaseTokensOrphaned: 0,
    browserAutomationPurchaseTokensScrubbed: 0,
    browserAutomationPurchaseRepliesDeleted: 0,
    browserTask: 0,
    backgroundTask: 0,
    browserTaskFinalConfirmTokensExpired: 0,
    browserTaskFinalConfirmTokensScrubbed: 0,
  };
  db.transaction(() => {
    counts.mdFileSnapshots = deleteOlderThan(
      db,
      "md_file_snapshots",
      "created_at",
      RETENTION_DAYS.mdFileSnapshots,
    );

    counts.messages = deleteOlderThan(
      db,
      "messages",
      "timestamp",
      RETENTION_DAYS.messages,
    );

    counts.agentActions = deleteOlderThan(
      db,
      "agent_actions",
      "started_at",
      RETENTION_DAYS.agentActions,
    );

    counts.notificationLog = deleteOlderThan(
      db,
      "notification_log",
      "created_at",
      RETENTION_DAYS.notificationLog,
    );

    counts.dmConversationLog = deleteOlderThan(
      db,
      "dm_conversation_log",
      "created_at",
      RETENTION_DAYS.dmConversationLog,
    );

    counts.observations = cleanupConsumedObservations(
      db,
      RETENTION_DAYS.observations,
    );

    // Expired inactive sessions (status != 'active')
    // Must delete orphaned messages FIRST to satisfy FK constraint (foreign_keys = ON)
    db.prepare(
      `DELETE FROM messages WHERE session_id IN (
         SELECT id FROM conversation_sessions
         WHERE status != 'active'
           AND last_message_at < datetime('now', '-' || ? || ' days')
       )`,
    ).run(RETENTION_DAYS.conversationSessions);

    counts.conversationSessions = db
      .prepare(
        `DELETE FROM conversation_sessions
         WHERE status != 'active'
           AND last_message_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(RETENTION_DAYS.conversationSessions).changes;

    // Terminal schedule rows only — explicitly enumerate the statuses we
    // consider terminal so that a future new status (e.g. 'cancelled')
    // is not silently swept up until it is intentionally added here.
    counts.agentSchedule = db
      .prepare(
        `DELETE FROM agent_schedule
         WHERE status IN ('completed', 'skipped', 'failed')
           AND scheduled_for < datetime('now', '-' || ? || ' days')`,
      )
      .run(RETENTION_DAYS.agentSchedule).changes;

    // MCP audit log — `called_at` is epoch ms, not a datetime string, so
    // pruneOldMcpToolCalls uses integer arithmetic. Catches internally for
    // tests that hand-craft a DB without the mcp_tool_calls table.
    counts.mcpToolCalls = pruneOldMcpToolCalls(db, RETENTION_DAYS.mcpToolCalls);

    counts.authTelemetryCounters = deleteIsoOlderThanIfTableExists(
      db,
      "auth_telemetry_counters",
      "bucket_hour",
      RETENTION_DAYS.authTelemetryCounters,
    );

    counts.mailMessagesIndex = pruneMailMessagesIndex(db);

    counts.mailParseFailures = deleteOlderThanButKeepLatestIfTableExists(
      db,
      "parse_failures",
      "created_at",
      RETENTION_DAYS.mailParseFailures,
      500,
    );

    counts.managementParseFailures = deleteOlderThanButKeepLatestIfTableExists(
      db,
      "management_parse_failures",
      "created_at",
      RETENTION_DAYS.managementParseFailures,
      50,
    );

    counts.skillCurationRunsAborted = abortStaleSkillCurationRuns(db);
    const skillCuration = pruneSkillCurationTables(db);
    counts.skillCurationSignals = skillCuration.signals;
    counts.skillCurationProposals = skillCuration.proposals;
    counts.skillCurationRuns = skillCuration.runs;

    // INTEGRATION-DRIFT-DETECTION-PLAN.md §4.2 — `integration_writes` rows
    // are TTL-keyed; reconcile only honours rows whose expires_at is in the
    // future. Phase-2 has no insertion path yet (Phase 4 lands route
    // handlers that call markIntegrationWrite), but adding the sweep now
    // means Phase 4 won't have to revisit retention. The expires_at index
    // (idx_integration_writes_expires) keeps the prune cheap. Defensive
    // try/catch mirrors `pruneOldMcpToolCalls` for hand-rolled test
    // schemas that omit the table — production always has it.
    try {
      counts.integrationWrites = db
        .prepare(
          `DELETE FROM integration_writes
           WHERE expires_at < datetime('now')`,
        )
        .run().changes;
    } catch (err) {
      logger.warn(
        { err },
        "integration_writes prune skipped (table missing)",
      );
    }

    // INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.2 — imminent-meeting dedup
    // table. Rows older than 24 h are pruned; a calendar event cannot
    // stay imminent longer than 15 min so the safety margin is generous,
    // and the wider window absorbs clock jitter / DST transitions
    // without re-DMing a row that the scheduler has already emitted.
    try {
      counts.imminentEventNotifications = db
        .prepare(
          `DELETE FROM imminent_event_notifications
           WHERE notified_at < datetime('now', '-1 day')`,
        )
        .run().changes;
    } catch (err) {
      /* c8 ignore next 5 */
      logger.warn(
        { err },
        "imminent_event_notifications prune skipped (table missing)",
      );
    }

    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.7 / §8.14 — Phase B-2
    // audit rows. Stays inside the transaction so the SQL prune lands
    // atomically with the rest of the sweep; the paired FS prune runs
    // outside the transaction once we know the SQL cutoff committed.
    // try/catch mirrors the integration_writes / imminent_event_notifications
    // pattern for hand-rolled test schemas that omit the table —
    // production always has it.
    try {
      const cutoff =
        Date.now() - RETENTION_DAYS.browserAutomationWorkflows * 86_400_000;
      counts.browserAutomationWorkflows = deleteWorkflowRunsOlderThan(db, cutoff);
    } catch (err) {
      /* c8 ignore next 5 */
      logger.warn(
        { err },
        "browser_automation_workflows prune skipped (table missing)",
      );
    }

    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.6 / §13 step 60 —
    // Phase B-4 purchase-tokens sweep. Four passes:
    //   1. Expire PRE-consume pending tokens past their TTL (in case
    //      the supervisor restart did not catch them at boot OR the
    //      daemon ran past a token's 5-min window without the
    //      workflow's `awaitReply` reaching its own deadline check).
    //   2. Sweep POST-consume orphans — rows where the user typed the
    //      token but the click never landed (workflow died, daemon
    //      restarted mid-flight, post-consume Playwright stalled).
    //      Cutoff is "consumed_at older than ORPHAN_CONSUME_GRACE_MS"
    //      which is generous enough to never preempt a healthy
    //      in-flight workflow (its perWorkflowTimeoutMs is 6 min) but
    //      short enough to reap actual orphans on the next sweep.
    //   3. Rotate `token` -> NULL on terminal rows older than
    //      `browserAutomationPurchaseTokenScrub` days. Reduces at-rest
    //      raw-token footprint.
    //   4. Delete `_replies` rows older than the retention window.
    try {
      const now = Date.now();
      const expired = expireStalePurchaseTokens(db, now);
      counts.browserAutomationPurchaseTokensExpired = expired.length;
      // 10 min — workflow's perWorkflowTimeoutMs is 6 min; the extra
      // 4 min covers clock skew + a generous slack so an in-flight
      // workflow we just don't have a reference to is never preempted.
      const ORPHAN_CONSUME_GRACE_MS = 10 * 60 * 1000;
      const orphaned = sweepOrphanedConsumedPurchaseTokens(
        db,
        now - ORPHAN_CONSUME_GRACE_MS,
      );
      counts.browserAutomationPurchaseTokensOrphaned = orphaned.length;
      const purchaseScrubCutoff =
        now -
        RETENTION_DAYS.browserAutomationPurchaseTokenScrub * 86_400_000;
      counts.browserAutomationPurchaseTokensScrubbed =
        scrubRotatedPurchaseTokens(db, purchaseScrubCutoff);
      const replyCutoff =
        now - RETENTION_DAYS.browserAutomationPurchaseReplies * 86_400_000;
      counts.browserAutomationPurchaseRepliesDeleted =
        deletePurchaseRepliesOlderThan(db, replyCutoff);
    } catch (err) {
      /* c8 ignore next 5 */
      logger.warn(
        { err },
        "browser_automation_purchase_tokens sweep skipped (table missing)",
      );
    }

    // BROWSER_TASK_REDESIGN_PLAN.md §6.5 deferred follow-up — three
    // passes on the new browser_task surface:
    //   1. Expire pending lite-final-confirm tokens past their TTL.
    //      A daemon-restart sweep handles the cold-start case; this
    //      catches a daemon that ran past a token's 5-min window
    //      without the runner's own deadline check firing.
    //   2. Rotate `token` -> NULL on terminal lite-final-confirm rows
    //      older than the 1-day scrub window (B-4 parity).
    //   3. Delete terminal browser_task rows older than the
    //      browserTask retention window. Children cascade via FK.
    try {
      const now = Date.now();
      const expiredTokens = expireStaleLiteFinalConfirmTokens(db, now);
      counts.browserTaskFinalConfirmTokensExpired = expiredTokens.length;
      const tokenScrubCutoff =
        now - RETENTION_DAYS.browserTaskFinalConfirmTokenScrub * 86_400_000;
      counts.browserTaskFinalConfirmTokensScrubbed =
        scrubRotatedLiteFinalConfirmTokens(db, tokenScrubCutoff);
      const browserTaskCutoff =
        now - RETENTION_DAYS.browserTask * 86_400_000;
      counts.browserTask = deleteTerminalBrowserTasksOlderThan(
        db,
        browserTaskCutoff,
      );
      const backgroundTaskCutoff =
        now - RETENTION_DAYS.backgroundTask * 86_400_000;
      counts.backgroundTask = deleteTerminalBackgroundTasksOlderThan(
        db,
        backgroundTaskCutoff,
      );
    } catch (err) {
      /* c8 ignore next 5 */
      logger.warn(
        { err },
        "browser_task / background_task retention sweep skipped (tables missing)",
      );
    }
  })();
  // Transaction committed — safe to copy counts into result.
  result.mdFileSnapshots = counts.mdFileSnapshots;
  result.messages = counts.messages;
  result.agentActions = counts.agentActions;
  result.notificationLog = counts.notificationLog;
  result.browserAutomationPurchaseTokensExpired =
    counts.browserAutomationPurchaseTokensExpired ?? 0;
  result.browserAutomationPurchaseTokensOrphaned =
    counts.browserAutomationPurchaseTokensOrphaned ?? 0;
  result.browserAutomationPurchaseTokensScrubbed =
    counts.browserAutomationPurchaseTokensScrubbed ?? 0;
  result.browserAutomationPurchaseRepliesDeleted =
    counts.browserAutomationPurchaseRepliesDeleted ?? 0;
  result.dmConversationLog = counts.dmConversationLog;
  result.observations = counts.observations;
  result.conversationSessions = counts.conversationSessions;
  result.agentSchedule = counts.agentSchedule;
  result.mcpToolCalls = counts.mcpToolCalls;
  result.authTelemetryCounters = counts.authTelemetryCounters;
  result.mailMessagesIndex = counts.mailMessagesIndex;
  result.mailParseFailures = counts.mailParseFailures;
  result.managementParseFailures = counts.managementParseFailures;
  result.skillCurationSignals = counts.skillCurationSignals;
  result.skillCurationProposals = counts.skillCurationProposals;
  result.skillCurationRuns = counts.skillCurationRuns;
  result.skillCurationRunsAborted = counts.skillCurationRunsAborted;
  result.integrationWrites = counts.integrationWrites;
  result.imminentEventNotifications = counts.imminentEventNotifications;
  result.browserAutomationWorkflows = counts.browserAutomationWorkflows;
  result.browserTask = counts.browserTask;
  result.backgroundTask = counts.backgroundTask;
  result.browserTaskFinalConfirmTokensExpired =
    counts.browserTaskFinalConfirmTokensExpired;
  result.browserTaskFinalConfirmTokensScrubbed =
    counts.browserTaskFinalConfirmTokensScrubbed;

  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.7 — pair the SQL prune
  // above with the FS prune of `<PA_DATA_DIR>/automation-traces/`.
  // Runs AFTER the SQL transaction committed: a partial-failure that
  // leaves rows in the table but FS dirs gone is recoverable (the
  // dashboard renders the row with a "trace missing" badge); the
  // opposite — rows missing but FS bloat — silently fills disk.
  // Same cutoff as the SQL side so the row + dir lifetimes match.
  const traceCutoff =
    Date.now() - RETENTION_DAYS.browserAutomationWorkflows * 86_400_000;
  result.browserAutomationTraceDirs = cleanAutomationTraceDirs(
    tracesRootDir(config.dataDir),
    traceCutoff,
  );

  const attachmentCleanup = cleanupAttachments(db, config.dataDir);
  result.attachmentOrphanRows = attachmentCleanup.orphanRows;
  result.attachmentDanglingRows = attachmentCleanup.danglingRows;
  result.attachmentUntrackedDirs = attachmentCleanup.untrackedDirs;

  // Surface stale pending observations so a stalled activity_scan pipeline
  // becomes visible in daemon logs. Pending rows are intentionally not
  // deleted (see RETENTION_DAYS.stalePendingObservationsWarn comment).
  const stalePending = getStalePendingObservationStats(
    db,
    RETENTION_DAYS.stalePendingObservationsWarn,
  );
  if (stalePending.count > 0) {
    logger.warn(
      {
        stalePendingCount: stalePending.count,
        oldestObservedAt: stalePending.oldestObservedAt,
        thresholdDays: RETENTION_DAYS.stalePendingObservationsWarn,
      },
      "Stale pending observations detected — activity_scan may be skipping or stalled",
    );
  }

  // ── FTS5 segment optimization ──
  //
  // FTS5 content-sync tables receive DELETE commands via triggers, but the
  // internal segments are not merged until an explicit `optimize` command.
  // We only run this when rows were actually deleted from the parent
  // content tables — when nothing was deleted, the segments are already
  // optimal and the I/O would be wasted.
  // Each FTS table is optimized independently so a failure in one does not
  // skip the other, and the log identifies which table had the problem.
  const ftsTargets: Array<{ table: string; needed: boolean }> = [
    { table: "fts_actions", needed: counts.agentActions > 0 },
    { table: "fts_messages", needed: counts.messages > 0 || counts.conversationSessions > 0 },
    { table: "fts_mail_messages", needed: counts.mailMessagesIndex > 0 },
  ];
  let ftsFailures = 0;
  for (const { table, needed } of ftsTargets) {
    if (!needed) continue;
    try {
      db.exec(`INSERT INTO ${table}(${table}) VALUES('optimize')`);
    } catch (err) {
      ftsFailures++;
      logger.warn({ err, ftsTable: table }, "FTS5 optimization failed for table");
    }
  }
  const ftsAttempted = ftsTargets.some((t) => t.needed);
  result.ftsOptimized = ftsAttempted && ftsFailures === 0;

  // Ask SQLite to refresh query planner statistics if needed. This is a
  // no-op when statistics are already up to date and very cheap otherwise.
  db.pragma("optimize");

  // ── WAL checkpoint ──
  //
  // After bulk deletions the WAL file can grow large. A TRUNCATE
  // checkpoint writes all WAL frames back to the main DB file and resets
  // the WAL to zero length, reclaiming disk space immediately.
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    result.walCheckpointed = true;
  } catch (err) {
    logger.warn({ err }, "WAL checkpoint failed — WAL file may remain large");
  }

  // ── File cleanup ──

  // Retention sweeps should never touch stale fallback data if the user
  // is on obsidian mode with a healthy primary vault — pass `db` so
  // `getContextDir` returns the fallback only when actually degraded.
  const contextDir = getContextDir(config, db);
  // B-007 §5.9 — synthesized daily journals are persistent; no sweep.
  // weekly/ is still time-bounded because the monthly review rolls it up.
  result.weeklyFiles = cleanOldFiles(
    resolve(contextDir, "weekly"),
    RETENTION_DAYS.weeklyMd,
  );

  // Unified-repositories per-day journals — one year retention. Walk
  // every `git/<slug>/journal/` directory and prune `.md` entries
  // older than the cutoff. Overview files are NEVER pruned.
  result.gitJournalFiles = cleanGitJournals(
    resolve(contextDir, "git"),
    RETENTION_DAYS.gitJournalMd,
  );
  result.tempFiles = cleanTempFiles(
    resolve(config.dataDir, "tmp"),
    RETENTION_DAYS.tempFiles,
  ) + cleanAtomicTempFiles(contextDir, RETENTION_DAYS.tempFiles);

  // ── Content-level rollup: agent/journal.md (B-007 §5.1) ──
  const journalPath = resolve(contextDir, CONTEXT_RELATIVE_PATHS.agent.journal);
  const journalSnapshotKey = CONTEXT_RELATIVE_PATHS.agent.journal.replace(/\.md$/, "");
  const journalResult = rollupAgentJournal(
    journalPath,
    AGENT_JOURNAL_ROLLUP.keepWeeklySections,
    AGENT_JOURNAL_ROLLUP.sectionSizeWarnBytes,
    AGENT_JOURNAL_ROLLUP.keepMonthlySections,
    // Snapshot before destructive rollup so the pre-prune state is
    // recoverable from md_file_snapshots, just like API PUT/PATCH writes.
    (content) => {
      db.prepare(
        "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
      ).run(journalSnapshotKey, content, "retention_rollup");
    },
  );
  result.agentJournalWeeklyPruned = journalResult.weeklyPruned;
  result.agentJournalMonthlyPruned = journalResult.monthlyPruned;
  result.agentJournalDuplicatesCollapsed = journalResult.duplicatesCollapsed;
  result.agentJournalOversizedSections = journalResult.oversizedSections;

  logger.info(result, "Retention cleanup completed");
  return result;
}

/**
 * Compare two ISO week keys (`YYYY-Www` slugs) chronologically.
 *
 * Returns a negative number if `a` is older, a positive number if `a` is
 * newer, zero if equal. Suitable as a sort comparator.
 *
 * Why not a plain string comparison? The `## Weekly YYYY-Www` header in
 * `journal/agent.md` is written by an LLM following the review prompt.
 * The prompt asks for zero-padded ISO week numbers, but compliance is
 * probabilistic — the model may emit `2026-W5` instead of `2026-W05`,
 * or a backfill may use a different convention. Lexicographic compare
 * gets these wrong:
 *
 *   "2026-W05"  <  "2026-W14"   ✓ correct
 *   "2026-W14"  <  "2026-W5"    ✗ wrong — W5 is chronologically earlier
 *
 * Parsing into `(year, weekNumber)` integers and comparing numerically
 * fixes this without forcing the file to be rewritten into a canonical
 * form (which would churn mtime on every rollup even when nothing real
 * changed).
 *
 * ISO 8601 year boundaries are naturally handled: W52 of year N always
 * parses as `{year: N, week: 52}` and W01 of year N+1 as `{year: N+1,
 * week: 1}`, so the year field dominates the comparison. Years with 53
 * ISO weeks (e.g. 2020, 2026) are handled identically — week 53 sorts
 * after week 52 and before the next year's W01.
 *
 * If either key fails to parse (malformed input, unexpected format),
 * the comparator falls back to a plain lexicographic string compare so
 * sort still terminates with a stable ordering — it just may not be
 * chronologically meaningful for that pair. The size-warning pass and
 * dedup pass both still work correctly in that case.
 */
export function compareWeeklyKey(a: string, b: string): number {
  const pa = parseWeeklyKey(a);
  const pb = parseWeeklyKey(b);
  if (pa === null || pb === null) {
    // Defensive fallback — preserve sort stability for unexpected input
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.week - pb.week;
}

/**
 * Parse an ISO week key like `2026-W14` or `2026-W5` into its numeric
 * components. Returns null for anything that does not match the expected
 * shape. Accepts 1-to-2-digit week numbers to tolerate the non-padded
 * form; the week number is range-checked (1..53) to catch typos that
 * happen to lex as digits.
 */
function parseWeeklyKey(key: string): { year: number; week: number } | null {
  const match = key.match(/^(\d{4})-W(\d{1,2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const week = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/**
 * Compare two month keys (`YYYY-MM` slugs) chronologically.
 *
 * Same defensive parsing as `compareWeeklyKey` — the LLM may emit `2026-4`
 * instead of `2026-04`, which lexicographic compare handles wrong
 * (`"2026-4" > "2026-10"`). Falls back to lexicographic on parse failure.
 */
export function compareMonthlyKey(a: string, b: string): number {
  const pa = parseMonthlyKey(a);
  const pb = parseMonthlyKey(b);
  if (pa === null || pb === null) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.month - pb.month;
}

/**
 * Parse a month key like `2026-04` or `2026-4` into its numeric components.
 * Returns null for anything that does not match. Accepts 1-to-2-digit months
 * and range-checks (1..12).
 */
function parseMonthlyKey(key: string): { year: number; month: number } | null {
  const match = key.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const OPTIONAL_RETENTION_TABLES = new Set([
  "auth_telemetry_counters",
  "parse_failures",
  "management_parse_failures",
]);
const OPTIONAL_RETENTION_COLUMNS = new Set(["bucket_hour", "created_at"]);

function deleteIsoOlderThanIfTableExists(
  db: Database.Database,
  table: string,
  dateColumn: string,
  days: number,
): number {
  if (!OPTIONAL_RETENTION_TABLES.has(table) || !OPTIONAL_RETENTION_COLUMNS.has(dateColumn)) {
    throw new Error(`Invalid optional retention target: ${table}.${dateColumn}`);
  }
  if (!tableExists(db, table)) return 0;
  const stmt = db.prepare(`DELETE FROM ${table} WHERE ${dateColumn} < ?`);
  return stmt.run(daysAgoIso(days)).changes;
}

function deleteOlderThanButKeepLatestIfTableExists(
  db: Database.Database,
  table: string,
  dateColumn: string,
  days: number,
  keepLatest: number,
): number {
  if (!OPTIONAL_RETENTION_TABLES.has(table) || !OPTIONAL_RETENTION_COLUMNS.has(dateColumn)) {
    throw new Error(`Invalid optional retention target: ${table}.${dateColumn}`);
  }
  if (!tableExists(db, table)) return 0;
  const stmt = db.prepare(
    `DELETE FROM ${table}
     WHERE ${dateColumn} < datetime('now', '-' || ? || ' days')
       AND id NOT IN (
         SELECT id FROM ${table}
         ORDER BY id DESC
         LIMIT ?
       )`,
  );
  return stmt.run(days, keepLatest).changes;
}

function pruneMailMessagesIndex(db: Database.Database): number {
  if (!tableExists(db, "mail_messages_index")) return 0;
  return db
    .prepare(
      `DELETE FROM mail_messages_index
       WHERE (
           deleted_at_utc IS NOT NULL
           AND datetime(deleted_at_utc) < datetime('now', '-' || ? || ' days')
         )
         OR datetime(received_at_utc) < datetime('now', '-' || ? || ' days')`,
    )
    .run(
      RETENTION_DAYS.deletedMailMessagesIndex,
      RETENTION_DAYS.mailMessagesIndex,
    ).changes;
}

function abortStaleSkillCurationRuns(db: Database.Database): number {
  if (!tableExists(db, "skill_curation_runs")) return 0;
  const cutoff = Date.now() - RETENTION_DAYS.skillCurationRunningMaxHours * 60 * 60 * 1000;
  return db
    .prepare(
      `UPDATE skill_curation_runs
       SET status = 'aborted',
           finalized_at = ?,
           notes = TRIM(COALESCE(notes || char(10), '') || ?)
       WHERE status = 'running'
         AND started_at < ?`,
    )
    .run(
      Date.now(),
      "aborted by retention: stale running optimizer run",
      cutoff,
    ).changes;
}

function pruneSkillCurationTables(db: Database.Database): {
  signals: number;
  proposals: number;
  runs: number;
} {
  let signals = 0;
  let proposals = 0;
  let runs = 0;

  if (tableExists(db, "skill_curation_signals")) {
    const unconsumedCutoff = Date.now() - RETENTION_DAYS.skillCurationSignals * 86_400_000;
    const consumedCutoff = Date.now() - RETENTION_DAYS.skillCurationConsumedSignals * 86_400_000;
    signals = db
      .prepare(
        `DELETE FROM skill_curation_signals
         WHERE (
             consumed_at IS NOT NULL
             AND consumed_at < ?
           )
           OR (
             consumed_at IS NULL
             AND observed_at < ?
           )`,
      )
      .run(consumedCutoff, unconsumedCutoff).changes;
  }

  if (tableExists(db, "skill_curation_proposals")) {
    const proposalCutoff = Date.now() - RETENTION_DAYS.skillCurationProposals * 86_400_000;
    proposals = db
      .prepare(
        `DELETE FROM skill_curation_proposals
         WHERE proposed_at < ?`,
      )
      .run(proposalCutoff).changes;
  }

  if (tableExists(db, "skill_curation_runs")) {
    const runCutoff = Date.now() - RETENTION_DAYS.skillCurationRuns * 86_400_000;
    runs = db
      .prepare(
        `DELETE FROM skill_curation_runs
         WHERE status != 'running'
           AND started_at < ?`,
      )
      .run(runCutoff).changes;
  }

  return { signals, proposals, runs };
}

function cleanupAttachments(
  db: Database.Database,
  dataDir: string,
): {
  orphanRows: number;
  danglingRows: number;
  untrackedDirs: number;
} {
  if (!tableExists(db, "chat_attachments")) {
    return { orphanRows: 0, danglingRows: 0, untrackedDirs: 0 };
  }
  try {
    const store = new AttachmentStore(db, dataDir);
    const orphans = store.reapOrphans(24);
    const danglingRows = store.reapDanglingMessageRefs();
    const untrackedDirs = store.reapUntrackedDirs({ minAgeHours: 1 });
    return {
      orphanRows: orphans.inbound + orphans.outbound,
      danglingRows,
      untrackedDirs,
    };
  } catch (err) {
    logger.warn({ err }, "Attachment retention cleanup failed");
    return { orphanRows: 0, danglingRows: 0, untrackedDirs: 0 };
  }
}

/**
 * Roll up `journal/agent.md` in place. Three independent passes applied in
 * order to a single parsed section list:
 *
 *   1. **Dedup (last-write-wins).** If the same `## Weekly YYYY-Www` or
 *      `## Monthly YYYY-MM` appears more than once (e.g. the routine was
 *      re-run), keep only the section with the highest original index
 *      (most recent append) and drop the earlier copies.
 *   2. **Age-based pruning.** After dedup, keep only the
 *      `keepWeeklySections` most recent `## Weekly YYYY-Www` sections and
 *      the `keepMonthlySections` most recent `## Monthly YYYY-MM` sections,
 *      sorted by their respective chronological keys.
 *   3. **Size warning.** For each kept weekly or monthly section, if the
 *      UTF-8 byte length exceeds `sectionSizeWarnBytes`, log a warning.
 *      The content itself is never truncated — that would corrupt the
 *      agent's own reflection history mid-sentence. Operators should
 *      investigate the review prompt instead.
 *
 * Any H2 section that is neither `Weekly` nor `Monthly` is preserved
 * untouched — a stray user-added `## Scratchpad` does not get eaten.
 * Preamble above the first H2 (e.g. `# Agent Journal` header) is
 * preserved verbatim.
 *
 * If the file does not exist, the function returns a zero result without
 * touching the filesystem. If nothing would change (no dedup, no pruning),
 * the file is not rewritten — avoiding unnecessary snapshot noise and
 * mtime churn — but the size warning is still computed so the operator
 * still sees bloated sections.
 */
export function rollupAgentJournal(
  filePath: string,
  keepWeeklySections: number,
  sectionSizeWarnBytes: number = AGENT_JOURNAL_ROLLUP.sectionSizeWarnBytes,
  keepMonthlySections: number = AGENT_JOURNAL_ROLLUP.keepMonthlySections,
  /**
   * Optional callback invoked with the current file content just before
   * the rollup writes the pruned version. The caller can use this to save
   * a snapshot (e.g. to `md_file_snapshots`) so the pre-rollup state is
   * recoverable if the rollup logic has a bug. If the callback throws,
   * the rollup still proceeds — snapshot failure should not block cleanup.
   */
  onBeforeWrite?: (content: string) => void,
): AgentJournalRollupResult {
  const empty: AgentJournalRollupResult = {
    weeklyPruned: 0,
    monthlyPruned: 0,
    duplicatesCollapsed: 0,
    oversizedSections: 0,
  };

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return empty; // File does not exist
  }

  type Section = {
    kind: "weekly" | "monthly" | "other";
    /** For weekly/monthly: the raw YYYY-Www / YYYY-MM slug. Empty for "other". */
    key: string;
    /** Original index in the parsed section list — stable ordering + tiebreak. */
    originalIndex: number;
    text: string;
  };

  const lines = content.split("\n");
  const sectionStartLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) sectionStartLines.push(i);
  }

  if (sectionStartLines.length === 0) {
    return empty; // No H2 sections — nothing to roll up
  }

  const preamble = lines.slice(0, sectionStartLines[0]).join("\n");
  const sections: Section[] = [];
  for (let i = 0; i < sectionStartLines.length; i++) {
    const start = sectionStartLines[i];
    const end =
      i + 1 < sectionStartLines.length ? sectionStartLines[i + 1] : lines.length;
    const text = lines.slice(start, end).join("\n");
    const header = lines[start];

    const weeklyMatch = header.match(/^##\s+Weekly\s+(\S+)/);
    const monthlyMatch = header.match(/^##\s+Monthly\s+(\S+)/);

    if (weeklyMatch) {
      sections.push({
        kind: "weekly",
        key: weeklyMatch[1],
        originalIndex: i,
        text,
      });
    } else if (monthlyMatch) {
      sections.push({
        kind: "monthly",
        key: monthlyMatch[1],
        originalIndex: i,
        text,
      });
    } else {
      sections.push({ kind: "other", key: "", originalIndex: i, text });
    }
  }

  // ── Pass 1: dedup by (kind, key), last-write-wins ──
  //
  // Keep the highest originalIndex for each (kind, key). Drop the earlier
  // copies. "other" sections never participate in dedup.
  const latestByKey = new Map<string, number>();
  for (const s of sections) {
    if (s.kind === "other") continue;
    const k = `${s.kind}:${s.key}`;
    const prev = latestByKey.get(k);
    if (prev === undefined || s.originalIndex > prev) {
      latestByKey.set(k, s.originalIndex);
    }
  }

  let duplicatesCollapsed = 0;
  const afterDedup: Section[] = [];
  for (const s of sections) {
    if (s.kind === "other") {
      afterDedup.push(s);
      continue;
    }
    const k = `${s.kind}:${s.key}`;
    if (latestByKey.get(k) === s.originalIndex) {
      afterDedup.push(s);
    } else {
      duplicatesCollapsed++;
    }
  }

  // ── Pass 2: age-based pruning of weekly and monthly sections ──
  //
  // After dedup, each key appears at most once per kind. Sort
  // chronologically by parsed numeric keys and keep the most recent N.
  const dedupedWeeklies = afterDedup.filter((s) => s.kind === "weekly");
  let weeklyPruned = 0;
  let keepWeeklyIndices: Set<number>;
  if (dedupedWeeklies.length <= keepWeeklySections) {
    keepWeeklyIndices = new Set(dedupedWeeklies.map((s) => s.originalIndex));
  } else {
    const sortedWeeklies = [...dedupedWeeklies].sort((a, b) => {
      const cmp = compareWeeklyKey(a.key, b.key);
      if (cmp !== 0) return cmp;
      return a.originalIndex - b.originalIndex;
    });
    keepWeeklyIndices = new Set(
      sortedWeeklies.slice(-keepWeeklySections).map((s) => s.originalIndex),
    );
    weeklyPruned = dedupedWeeklies.length - keepWeeklyIndices.size;
  }

  // Monthly pruning — same logic as weekly but using YYYY-MM keys.
  const dedupedMonthlies = afterDedup.filter((s) => s.kind === "monthly");
  let monthlyPruned = 0;
  let keepMonthlyIndices: Set<number>;
  if (dedupedMonthlies.length <= keepMonthlySections) {
    keepMonthlyIndices = new Set(dedupedMonthlies.map((s) => s.originalIndex));
  } else {
    const sortedMonthlies = [...dedupedMonthlies].sort((a, b) => {
      const cmp = compareMonthlyKey(a.key, b.key);
      if (cmp !== 0) return cmp;
      return a.originalIndex - b.originalIndex;
    });
    keepMonthlyIndices = new Set(
      sortedMonthlies.slice(-keepMonthlySections).map((s) => s.originalIndex),
    );
    monthlyPruned = dedupedMonthlies.length - keepMonthlyIndices.size;
  }

  const finalKept = afterDedup.filter((s) => {
    if (s.kind === "weekly") return keepWeeklyIndices.has(s.originalIndex);
    if (s.kind === "monthly") return keepMonthlyIndices.has(s.originalIndex);
    return true; // "other" preserved
  });

  // ── Pass 3: size warning on kept weekly/monthly sections ──
  //
  // Non-destructive: we log, but never truncate. Mid-sentence truncation
  // of the agent's own self-reflection would be worse than the bloat.
  let oversizedSections = 0;
  for (const s of finalKept) {
    if (s.kind === "other") continue;
    const bytes = Buffer.byteLength(s.text, "utf-8");
    if (bytes > sectionSizeWarnBytes) {
      oversizedSections++;
      logger.warn(
        {
          file: filePath,
          sectionKind: s.kind,
          sectionKey: s.key,
          bytes,
          thresholdBytes: sectionSizeWarnBytes,
        },
        "agent-journal section exceeds size threshold — review prompt bullet caps may be ignored",
      );
    }
  }

  // ── Skip rewrite if nothing changed ──
  //
  // The file is only rewritten when dedup OR age-based pruning modified
  // the section list. The size warning alone never triggers a rewrite —
  // it is observability only. This avoids snapshot-table noise on quiet
  // days and keeps mtime stable for the dashboard's optimistic concurrency.
  if (duplicatesCollapsed === 0 && weeklyPruned === 0 && monthlyPruned === 0) {
    return {
      weeklyPruned: 0,
      monthlyPruned: 0,
      duplicatesCollapsed: 0,
      oversizedSections,
    };
  }

  const rebuilt = [
    preamble.length > 0 ? preamble.replace(/\n+$/, "") : "",
    ...finalKept.map((s) => s.text.replace(/\n+$/, "")),
  ]
    .filter((chunk, idx) => chunk.length > 0 || idx === 0)
    .join("\n\n")
    // Preserve a trailing newline if the original file had one
    + (content.endsWith("\n") ? "\n" : "");

  // Snapshot the pre-rollup content so the operator can restore if
  // the rollup logic over-prunes. This mirrors the snapshot behavior
  // of the Context API's PUT/PATCH paths — the rollup was previously
  // the only write path that bypassed the snapshot system.
  if (onBeforeWrite) {
    try {
      onBeforeWrite(content);
    } catch (err) {
      logger.warn(
        { err, file: filePath },
        "Pre-rollup snapshot failed — proceeding with rollup anyway",
      );
    }
  }

  try {
    writeFileSync(filePath, rebuilt, "utf-8");
    logger.debug(
      {
        file: filePath,
        weeklyPruned,
        monthlyPruned,
        duplicatesCollapsed,
        oversizedSections,
      },
      "Rolled up agent-journal",
    );
  } catch (err) {
    logger.warn(
      { err, file: filePath },
      "Failed to write rolled-up agent-journal — leaving file untouched",
    );
    return empty;
  }

  return { weeklyPruned, monthlyPruned, duplicatesCollapsed, oversizedSections };
}

/**
 * Read-only health check for `journal/agent.md`. Returns section counts and
 * any oversized sections without modifying the file. Intended for the health
 * endpoint so the dashboard can surface journal bloat without requiring the
 * operator to watch structured logs.
 */
export function checkAgentJournalHealth(
  filePath: string,
  sectionSizeWarnBytes: number = AGENT_JOURNAL_ROLLUP.sectionSizeWarnBytes,
): {
  exists: boolean;
  weeklySections: number;
  monthlySections: number;
  oversizedSections: string[];
} {
  const empty = { exists: false, weeklySections: 0, monthlySections: 0, oversizedSections: [] as string[] };
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return empty;
  }

  const lines = content.split("\n");
  let weeklySections = 0;
  let monthlySections = 0;
  const oversizedSections: string[] = [];

  // Find all H2 section boundaries
  const sectionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) sectionStarts.push(i);
  }

  for (let i = 0; i < sectionStarts.length; i++) {
    const start = sectionStarts[i];
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : lines.length;
    const header = lines[start];
    const sectionText = lines.slice(start, end).join("\n");

    const isWeekly = /^##\s+Weekly\s+/.test(header);
    const isMonthly = /^##\s+Monthly\s+/.test(header);

    if (isWeekly) weeklySections++;
    if (isMonthly) monthlySections++;

    if ((isWeekly || isMonthly) && Buffer.byteLength(sectionText, "utf-8") > sectionSizeWarnBytes) {
      const key = header.replace(/^##\s+/, "").trim();
      oversizedSections.push(key);
    }
  }

  return { exists: true, weeklySections, monthlySections, oversizedSections };
}

/** Allowed tables and columns for retention cleanup (defense-in-depth against SQL injection) */
const ALLOWED_TABLES = new Set([
  "md_file_snapshots",
  "messages",
  "agent_actions",
  "notification_log",
  "conversation_sessions",
  "dm_conversation_log",
]);
const ALLOWED_COLUMNS = new Set(["created_at", "timestamp", "started_at", "last_message_at"]);

/** Delete rows older than N days from a table */
function deleteOlderThan(
  db: Database.Database,
  table: string,
  dateColumn: string,
  days: number,
): number {
  // Whitelist validation — these values come from hardcoded constants above,
  // but we validate anyway as defense-in-depth
  if (!ALLOWED_TABLES.has(table) || !ALLOWED_COLUMNS.has(dateColumn)) {
    throw new Error(`Invalid retention target: ${table}.${dateColumn}`);
  }
  // table/dateColumn are whitelist-validated above (not user input), safe to interpolate.
  // days is parameterized to maintain prepared-statement discipline.
  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE ${dateColumn} < datetime('now', '-' || ? || ' days')`,
  );
  const { changes } = stmt.run(days);
  if (changes > 0) {
    logger.debug({ table, deleted: changes, retentionDays: days }, "Cleaned up table");
  }
  return changes;
}

/** Remove .md files older than N days from a directory */
function cleanOldFiles(dir: string, days: number): number {
  let deleted = 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // Directory doesn't exist
  }

  for (const entry of entries) {
    if (extname(entry) !== ".md") continue;

    const filePath = resolve(dir, entry);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(filePath);
        deleted++;
        logger.debug({ file: entry }, "Removed expired file");
      }
    } catch (err) {
      logger.warn({ err, file: entry, dir }, "Failed to stat/remove expired file — will retry next run");
    }
  }

  return deleted;
}

/** Remove files/directories from the daemon-owned tmp dir after a short TTL. */
function cleanTempFiles(dir: string, days: number): number {
  let deleted = 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const filePath = resolve(dir, entry);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      rmSync(filePath, { recursive: true, force: true });
      deleted++;
    } catch (err) {
      logger.warn({ err, file: entry, dir }, "Failed to remove expired tmp entry — will retry next run");
    }
  }

  return deleted;
}

const ATOMIC_WRITE_TEMP_RE = /\.tmp\.\d+\.[0-9a-f]{16}$/;
const ATOMIC_TEMP_RECURSIVE_CONTEXT_DIRS = [
  "agent",
  "daily",
  "git",
  "rules",
  "weekly",
] as const;

/**
 * Remove sidecar temp files left by writeFileAtomically after a failed unlink.
 * The pattern is intentionally exact so retention does not touch arbitrary
 * user-authored files under the context tree. We also keep the scan bounded:
 * the active context can be a user's primary knowledge vault, so retention only
 * scans the root plus known daemon-managed subtrees instead of walking the whole
 * vault.
 */
function cleanAtomicTempFiles(dir: string, days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = cleanAtomicTempFilesInner(dir, cutoff, false);
  for (const child of ATOMIC_TEMP_RECURSIVE_CONTEXT_DIRS) {
    deleted += cleanAtomicTempFilesInner(resolve(dir, child), cutoff, true);
  }
  return deleted;
}

function cleanAtomicTempFilesInner(
  dir: string,
  cutoff: number,
  recursive: boolean,
): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let deleted = 0;
  for (const entry of entries) {
    const filePath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        deleted += cleanAtomicTempFilesInner(filePath, cutoff, true);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!ATOMIC_WRITE_TEMP_RE.test(entry.name)) continue;
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      unlinkSync(filePath);
      deleted++;
    } catch (err) {
      logger.warn({ err, file: entry.name, dir }, "Failed to remove atomic temp file — will retry next run");
    }
  }
  return deleted;
}

/**
 * Sync prune of per-workflow trace directories under
 * `<PA_DATA_DIR>/automation-traces/`. Mirrors the async
 * `trace-store.ts:pruneTraceDirectory` (which the daily retention
 * cron cannot await — `runRetentionCleanup` is sync, matching every
 * sibling cleanup), but uses `fs` sync primitives so it slots into the
 * existing sync sweep without a refactor.
 *
 * `cutoffEpochMs` is the same cutoff fed to
 * `deleteWorkflowRunsOlderThan(db, ...)` above, so a workflow run's
 * audit row and its on-disk trace dir age out together.
 *
 * Each per-workflow directory's mtime is the freshest screenshot or
 * trace.zip the workflow wrote into it. Directories whose mtime is
 * BEFORE the cutoff are eligible. Errors on a single entry are logged
 * and skipped — the cron MUST NOT fail outright because one orphaned
 * dir refuses to delete.
 */
function cleanAutomationTraceDirs(root: string, cutoffEpochMs: number): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    logger.warn({ err, root }, "automation-traces readdir failed");
    return 0;
  }
  let pruned = 0;
  for (const entry of entries) {
    const dir = resolve(root, entry);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs >= cutoffEpochMs) continue;
      rmSync(dir, { recursive: true, force: true });
      pruned++;
    } catch (err) {
      logger.warn({ err, dir }, "automation-traces entry prune failed — will retry next run");
    }
  }
  return pruned;
}

/**
 * Walk `<contextDir>/git/<slug>/journal/` directories and prune `.md`
 * entries older than `days`. The `git/<slug>/overview.md` files are
 * permanent — never touched here. See
 * `docs/design/appendices/unified-repositories.md` §4.5.
 */
function cleanGitJournals(gitDir: string, days: number): number {
  let deleted = 0;
  let slugDirs: string[];
  try {
    slugDirs = readdirSync(gitDir);
  } catch {
    return 0;
  }
  for (const slug of slugDirs) {
    const journalDir = resolve(gitDir, slug, "journal");
    deleted += cleanOldFiles(journalDir, days);
  }
  return deleted;
}
