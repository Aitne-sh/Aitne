import cron, { type ScheduledTask } from "node-cron";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  createEvent,
  EventPriority,
  formatSqliteDatetime,
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  isBackendId,
  isProcessTier,
  nowInTimezone,
  type RoutineEvent,
  type AgentTaskEvent,
  type ScheduledBrowserTaskEvent,
  type ScheduledBackgroundTaskEvent,
  type ScheduledDmEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import { evaluateSourceMaintenancePrefilter } from "./sources/maintenance-prefilter.js";
import type { EventBus } from "./event-bus.js";
import { runRetentionCleanup } from "./retention.js";
import { cleanupSessionWorkdir, cleanupStaleWorkdirs, getSessionWorkdirPath } from "./workdir.js";
import { discardStalePendingSchedules } from "./schedule-maintenance.js";
import { createLogger } from "../logging.js";
import type { MessageDelivery } from "../adapters/message-hub.js";
import { reconcileRecurringSchedules } from "../db/recurring-schedules.js";
import { recordAgentFiringBlocked } from "./agents/firing-blocked.js";
import type { AgentEnabledCache } from "./agents/loader.js";
import { resolveActivityScanCadence } from "./agents/activity-scan-cadence.js";
import { getRuntimeWindow } from "../db/agents-store.js";
import {
  getDueCatchupRoutines,
  getRecoverableStalledMorningWake,
  getStalledMorningRoutineWake,
  MORNING_MISSED_FIRE_GRACE_MINUTES,
  morningRoutineRanToday,
  readMorningRoutineStallThresholdMinutes,
  shouldCatchUpActivityScan,
  shouldQueueMissedMorningFire,
} from "../bootstrap/schedule-helpers.js";
import { WakeDetector } from "./wake-detector.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import { recordProactiveForwardDeliveries } from "./channel-timeline.js";
import { isInQuietHoursAt, nextQuietHoursEndMs } from "./quiet-hours.js";

/**
 * Runtime-state key holding the agent-day date string (`YYYY-MM-DD`) on
 * which the watchdog last sent an owner DM about the morning routine
 * being stuck. Per-day dedup: the watchdog fires at most once per
 * agent-day even if the cron tick that owns it runs every minute.
 */
const MORNING_ROUTINE_STALL_ALERT_KEY = "morning_routine.stall_alert_day";

/**
 * Cadence of the morning self-heal tick. The tick is cheap (three indexed
 * SQLite reads in the common healthy case), and 10 minutes bounds the
 * worst-case detection latency for a swallowed 04:00 cron fire at
 * `MORNING_MISSED_FIRE_GRACE_MINUTES + 10`. Deliberately a dedicated
 * interval rather than a rider on the activity-scan cron: the watchdog
 * historically rode that cron and went silently dead the moment an
 * operator set `activityScanEnabled=false` — exactly the configuration
 * where the morning routine has no other safety net.
 */
export const MORNING_SELF_HEAL_INTERVAL_MS = 10 * 60_000;

/**
 * Per-agent-day cap on hung-run recovery flips. Each flip re-runs the
 * morning pipeline (pre-pass + Stage A — real backend spend), so a
 * deterministically-wedging environment must not be retried every
 * stall-threshold window all day. Past the cap the self-heal degrades to
 * alert-only; the owner DM and a daemon restart are the escape hatches.
 */
export const MAX_SELFHEAL_REQUEUES_PER_AGENT_DAY = 2;

/**
 * Missed-fire suppression window after process start. Boot catchup owns
 * stale-today.md recovery at startup and runs the morning routine
 * INLINE — no wake row exists for `shouldQueueMissedMorningFire` to
 * dedup against, and its attempt audit row only appears once the
 * fetch-window pre-pass hands over to Stage A. A pathologically slow
 * pre-pass must not read as a missed fire, so the layer stays quiet
 * until the boot path has long since either produced attempt rows or
 * died (in which case the next tick after the window picks it up).
 */
export const MISSED_FIRE_BOOT_SUPPRESSION_MS = 30 * 60_000;

/**
 * Routine name → built-in Agent slug, for the per-agent enabled gate on the
 * wake catch-up path. Must match the slugs the corresponding cron callbacks
 * pass to `isAgentEnabledForFiring` so a disabled Agent is suppressed
 * identically whether its trigger arrives via cron or via wake catch-up.
 */
const WAKE_CATCHUP_AGENT_SLUGS: Record<string, string> = {
  evening_review: "evening-review",
  weekly_review: "weekly-review",
  monthly_review: "monthly-review",
};

const logger = createLogger("scheduler");

/**
 * True iff `intervalMinutes` cleanly fits inside an hour, so the firing
 * minutes are predictable across every hour of the active window. We use
 * this to decide whether to emit a tight minute-list cron expression vs.
 * a minute-tick cron + in-callback gate.
 */
function isDivisorOfHour(intervalMinutes: number): boolean {
  return intervalMinutes >= 1 && intervalMinutes <= 60 && 60 % intervalMinutes === 0;
}

/**
 * Build the cron expression that drives the activity scan.
 *
 * Two regimes:
 *
 * 1. **Divisor of 60** (`isDivisorOfHour(intervalMinutes)`, e.g. 1, 5, 15,
 *    20, 30, 60): the firing minutes are predictable within every hour, so
 *    we emit an exact minute list (`"0,15,30,45 4-23 * * *"`). The cron
 *    only wakes on the actual firing minutes — no in-callback gating
 *    needed.
 *
 * 2. **Arbitrary interval** (anything else, e.g. 7, 45, 90, 120, 720,
 *    1440): we emit `"* <hourRange> * * *"` (every minute within active
 *    hours). The caller is expected to gate each tick with
 *    `shouldFireActivityScanTickAt(...)`, which anchors the cadence to
 *    `activeStartHour` via `((h*60 + m) - activeStartHour*60) %
 *    intervalMinutes`. This anchor matters: a midnight-anchored modulo
 *    plus `activeStartHour > 0` would silently drop intervals where the
 *    only mod-zero point falls outside active hours (e.g. interval=1440
 *    with startHour=4 — mod-zero only at 00:00, never inside the window).
 *    Anchoring at `activeStartHour` guarantees the first fire of each
 *    agent-day lands at the start of the window, then every N minutes
 *    until the window closes.
 *
 * The minute-tick cron does fire 60× per hour even when most ticks are
 * no-ops, but the callback's first action is the modulo check — overhead
 * is negligible compared to the actual activity-scan work.
 */
export function buildActivityScanCronExpr(
  intervalMinutes: number,
  startHour: number,
  endHourExclusive: number,
): string {
  const endHour = Math.max(startHour, endHourExclusive - 1);
  const hourRange = startHour === endHour ? `${startHour}` : `${startHour}-${endHour}`;

  if (isDivisorOfHour(intervalMinutes)) {
    const minuteList: number[] = [];
    for (let minute = 0; minute < 60; minute += intervalMinutes) {
      minuteList.push(minute);
    }
    return `${minuteList.join(",")} ${hourRange} * * *`;
  }

  return `* ${hourRange} * * *`;
}

/**
 * Returns true when a minute-tick of the hourly cron should actually fire.
 *
 * Only meaningful for arbitrary (non-divisor-of-60) intervals — divisor
 * cases get exact firing minutes baked into the cron expression and don't
 * need this gate (handled by the early-return).
 *
 * The cadence is anchored at `activeStartHour` so the first slot of each
 * agent-day lies at the start of the active window. This is what allows
 * intervals up to 1440 (24h) to work correctly: a midnight anchor would
 * make `interval=1440` fire only at 00:00, which is excluded by typical
 * active-hour configs (4–24) and the day-boundary skip.
 *
 * Note: divisor-of-60 intervals always also divide `activeStartHour*60`
 * (since `activeStartHour` is an integer and `intervalMinutes` divides 60),
 * so the divisor early-return doesn't change behavior — it's just
 * explicit about which path the cron expression itself handles.
 */
export function shouldFireActivityScanTickAt(
  localHour: number,
  localMinute: number,
  intervalMinutes: number,
  activeStartHour: number,
): boolean {
  if (isDivisorOfHour(intervalMinutes)) return true;
  const minutesSinceMidnight = localHour * 60 + localMinute;
  const anchor = activeStartHour * 60;
  // localHour < activeStartHour can't happen in normal operation (cron's
  // hour range excludes those hours) but be defensive: a negative offset
  // mod a positive interval is implementation-defined in JS (returns a
  // negative or zero), which would falsely fire. Add a full day to keep
  // the offset non-negative regardless.
  const offset = (minutesSinceMidnight - anchor + 24 * 60) % (24 * 60);
  return offset % intervalMinutes === 0;
}

/**
 * Cron expression for the morning user-profile sweep: 10 min before the
 * day boundary, wrapping backward across midnight. For the default
 * `dayBoundaryHour = 4`, returns `"50 3 * * *"`. Extracted as a pure
 * helper so the arithmetic can be asserted without having to mock
 * node-cron.
 */
export function buildUserProfileSweepMorningCronExpr(
  dayBoundaryHour: number,
): string {
  const hour = (dayBoundaryHour - 1 + 24) % 24;
  return `50 ${hour} * * *`;
}

/**
 * Cron expression for the evening user-profile sweep: fixed at 17:50
 * local, which is 10 min before Evening Review's fixed 18:00. If
 * Evening Review ever becomes time-configurable, this expression must
 * track the same config knob in lockstep.
 */
export const USER_PROFILE_SWEEP_EVENING_CRON_EXPR = "50 17 * * *";

/**
 * Cron expression for the daemon-side roadmap mechanical maintenance
 * pass: fixed at 17:45 local — 15 min before Evening Review's fixed
 * 18:00 and 5 min before the evening user-profile sweep at 17:50.
 * The ordering matters: this job must release its lock before the
 * surviving evening_review Step 2 (Long-term Plans promotion + Review:
 * fire) acquires `roadmap_write_lock`. See
 * `docs/design/appendices/evening-review-slimdown.md` §2.2.
 */
export const ROADMAP_MAINTENANCE_CRON_EXPR = "45 17 * * *";

/**
 * SELF_IMPROVEMENT_PHASE2 §2.1/§2.3 — daily mechanical lessons sweep, 5 min
 * before the roadmap pass so both finish before evening_review at 18:00.
 * Must match the `lesson-maintenance` builtin-registry cronExpression.
 */
export const LESSON_MAINTENANCE_CRON_EXPR = "40 17 * * *";

/**
 * Cron expression for the BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a
 * pre-morning digest: 60 min before the day boundary, wrapping
 * backward across midnight (so `dayBoundaryHour = 4` → "0 3 * * *",
 * `dayBoundaryHour = 0` → "0 23 * * *"). Extracted as a pure helper
 * so the wrap arithmetic — identical in shape to
 * `buildUserProfileSweepMorningCronExpr` but at the top of the hour —
 * is asserted without standing up node-cron in tests.
 */
export function buildBrowserHistoryPreMorningDigestCronExpr(
  dayBoundaryHour: number,
): string {
  const hour = (dayBoundaryHour - 1 + 24) % 24;
  return `0 ${hour} * * *`;
}

interface ScheduleRow {
  id: number;
  scheduled_for: string;
  task_type: string;
  task_description: string;
  /** Optional override for the agent task body. NULL = use task_description. */
  task_prompt: string | null;
  task_context: string | null;
  correlation_id: string | null;
  model: string | null;
  /** Abstract tier override ('lite' | 'medium' | 'high'). NULL = no
   *  operator override — dispatch resolves the tier from the process
   *  key (medium for agent.task / agent.dm_task). When set, the
   *  scheduler propagates it as `event.requestedTier` and the
   *  dispatcher hands it to `resolveBinding` ahead of the legacy
   *  model-derived tier. See `schema.ts` table comment. */
  tier_override: string | null;
  /** SCHEDULE_API_REDESIGN_PLAN §4.3a — captured backend (engine) pin.
   *  Two valid shapes: (a) companioned by a registered full model id in
   *  `model` (e.g. 'claude-opus-4-8') → the dispatcher emits both and the
   *  override pins an exact model; (b) standalone (`model` NULL) → the
   *  dispatcher emits `requestedBackendId` alone and resolveBinding's
   *  backend-only branch resolves the model from the row's tier / the
   *  backend default. Engine-only Agent pins ("run this on codex") use
   *  shape (b); before 2026-06-01 a standalone backend_id was silently
   *  dropped at dispatch (AGENT_DEFINITIONS_KNOWN_LIMITATIONS §1). */
  backend_id: string | null;
  status: string;
  recurring_schedule_id: number | null;
}

/**
 * AgentScheduler — manages recurring cron jobs and the DB-driven ScheduleWatcher.
 *
 * Cron jobs:
 * - 04:00 daily: Morning Routine + daily cleanup + retention
 * - 18:00 daily: Evening Review
 * - 18:00 Friday: Weekly Review
 * - 18:00 last day of month: Monthly Review
 *
 * ScheduleWatcher:
 * - Polls agent_schedule table every N seconds for pending tasks
 * - Handles agent-scheduled wake-ups and DMs
 * - Uses optimistic locking to prevent duplicate execution
 */
export class AgentScheduler {
  private readonly eventBus: EventBus;
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private shutdown = false;
  private readonly cronJobs: ScheduledTask[] = [];
  private noFutureTasksWarned = false;
  private onDayBoundary: (() => Promise<void>) | null = null;
  private sendDm: ((message: string, platforms?: string[]) => Promise<MessageDelivery[]>) | null = null;
  private onActivityScan: ((source: string) => Promise<unknown>) | null = null;
  /**
   * Phase 4 auth probe hook — fired on every hourly cron tick BEFORE
   * `onActivityScan` so the probe gets a chance to refresh DB cache +
   * emit DMs even when the observation-threshold gate would skip the
   * activity scan itself. The AuthHealthMonitor.checkAll() method owns
   * its own kill-switch and morning-routine skip; the scheduler only
   * applies the same `autonomousGate` short-circuit that protects the
   * other cron callbacks.
   *
   * See `docs/design/09-safety-cost.md` §9.5.4 for the gate
   * ordering: morning-routine → hourly-already-running → auth probe
   * → observation-threshold. Steps 1 + 2 are handled inside
   * `triggerActivityScan`; step 3 is this callback; step 4 is the
   * threshold gate inside `triggerActivityScan`.
   */
  private onAuthProbe: (() => Promise<unknown>) | null = null;
  /**
   * SELF_TUNING_REVIEW_CYCLE_DESIGN.md §3.4 Phase 3 — auto-revert monitor.
   * Piggybacks the hourly cron tick (P2 — zero new scheduled sessions),
   * fired AHEAD of the per-agent enabled gate and the autonomous setup
   * gate so rollback safety survives the owner disabling the activity-scan
   * Agent or a setup-gated daemon; the callback owns its own 1/day
   * throttle, per-entry isolation, and DM emission. Remaining coupling:
   * with `activityScanEnabled=false` this cron is never registered and
   * applied changes stay unverified until the check is re-enabled —
   * acceptable because R1/R3 govern the (now-idle) hourly pipeline
   * itself; an applied R5 (`feedbackLessonMaxBytesGlobal`) change would
   * sit unverified, with `!revert tuning` as the manual escape hatch.
   */
  private onSelfTuningRevertMonitor: (() => Promise<unknown>) | null = null;
  /**
   * B-004 Phase 2a — nightly context-index reconciler callback (§4.1).
   * Fires at 03:45 local (dayBoundaryHour - 15 min) via an internal cron
   * job, BEFORE the morning routine so the index is fresh when the
   * morning flow reads it. The observer owns the run-once guard.
   */
  private onContextIndexReconcile: (() => void) | null = null;
  /**
   * Evening-review slimdown §2.2 — daily mechanical roadmap.md
   * maintenance pass at 17:45 local, 15 min before evening_review.
   * Wraps `runRoadmapMechanicalMaintenance` so substeps 2a / 2b / 2d
   * run in-process inside the daemon rather than inside a Sonnet
   * routine that would otherwise re-derive the same date math. The
   * callback is fire-and-forget (no return value contract): the
   * implementation owns its own lock acquisition, audit emission, and
   * agent/journal.md append.
   */
  private onRoadmapMaintenance: (() => void) | null = null;
  /**
   * SELF_IMPROVEMENT_PHASE2 §2.1/§2.3 — daily mechanical lessons sweep at
   * 17:40 local, 5 min before the roadmap pass and 20 min before
   * evening_review. Wraps `runLessonMechanicalMaintenance` so the graduated
   * expiration (demote → archive → re-promote) and cf re-stamping run even
   * on nights with zero feedback signals (no worksheet → no write-path
   * normalization) and over hand-edited files. Fire-and-forget like the
   * roadmap callback; the implementation owns audit emission.
   */
  private onLessonMaintenance: (() => void) | null = null;
  /**
   * BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a — pre-morning digest
   * builder. Fires at `dayBoundaryHour − 1` local each night so the
   * morning Stage B journal reads a static `context/browser/yesterday-<date>.md`
   * file (pre-warmed) rather than calling `GET /api/browser-history/
   * yesterday-summary` at 04:00. The callback is deterministic Node
   * code (no LLM in the path); the scheduler treats it as
   * fire-and-forget like the roadmap-maintenance and context-index
   * callbacks above. A failure here logs but never cascades into the
   * 04:00 morning routine — the journal task-flow has a documented
   * fallback to the `/api/browser-history/pre-morning-digest/{date}`
   * endpoint.
   */
  private onBrowserHistoryPreMorningDigest: (() => void) | null = null;
  /**
   * Setup gate — returns a skip reason when autonomous work should be
   * paused (initial setup incomplete, or setup conversation active).
   * Returns null when autonomous work may proceed. Wired from EventDispatcher
   * via setAutonomousGate() so the scheduler doesn't take a hard dependency
   * on the dispatcher.
   */
  private autonomousGate: (() => null | string) = () => null;
  private lastGateBlockLoggedAt = 0;
  /**
   * AGENT_DEFINITIONS_DESIGN.md §7.1 — per-built-in enabled gate. Wired from
   * the Phase-7 boot path via {@link setAgentEnabledCache}; until then (and in
   * tests that construct a bare scheduler) it is `null` and the gate is a
   * no-op, so disabling is opt-in and never accidentally stops a routine.
   */
  private agentEnabledCache: AgentEnabledCache | null = null;
  /**
   * Single source of truth for the ScheduleWatcher's between-poll wake
   * signaling, unifying what was previously a (pollAbort: AbortController
   * + hasPendingNudge: boolean) pair (v4.14 audit, Task #3).
   *
   * Mechanics:
   *   - `nudgeSeq` is monotonically incremented by every `nudgeWatcher()`
   *     call (and `stop()` reuses it to break the sleep too).
   *   - `observedSeq` is advanced when a nudge has been consumed —
   *     either at the top of `sleepInterruptible` (between-sleep case)
   *     or by the resolver path inside `nudgeWatcher()` / `stop()` when
   *     they wake an in-flight sleep.
   *   - `sleepWaiter` holds the resolver + timer for the currently-pending
   *     sleep, if any. The ScheduleWatcher loop awaits sequentially, so
   *     at most one waiter exists at a time.
   *
   * Why this replaces the AbortController pair: with a monotonic counter
   * we cannot lose a nudge across a sleep boundary — a `nudgeWatcher()`
   * call that arrives between two sleeps simply leaves `nudgeSeq >
   * observedSeq`, and the next sleep entry consumes it. The two-stage
   * (flag + signal) scheme was correct on paper but required readers to
   * trace the precise synchronous ordering of three branches in
   * `sleepInterruptible`; the counter compresses that to one branch.
   */
  private nudgeSeq = 0;
  private observedSeq = 0;
  private sleepWaiter: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /**
   * Detects machine sleep / forward clock jumps and replays the cron
   * triggers the sleep swallowed (node-cron never fires missed ticks).
   * See {@link runWakeCatchup}.
   */
  private readonly wakeDetector = new WakeDetector({
    onWake: (gapMs) => this.runWakeCatchup(gapMs),
  });
  /**
   * Independent self-heal tick for the morning routine (alert + recover +
   * missed-fire re-queue). See {@link runMorningSelfHeal}. Kept off the
   * activity-scan cron on purpose — that cron is operator-disableable.
   */
  private morningSelfHealTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Wall-clock instant this scheduler instance was constructed (one
   * instance per daemon process). Drives the missed-fire boot
   * suppression; tests override via cast to simulate a long-lived
   * process.
   */
  private startedAtMs = Date.now();

  constructor(eventBus: EventBus, db: Database.Database, config: AgentConfig) {
    this.eventBus = eventBus;
    this.db = db;
    this.config = config;
  }

  /**
   * Register a callback that runs at the day boundary (4 AM) BEFORE
   * the morning routine and daily cleanup. Used for DM session summarization.
   */
  setDayBoundaryCallback(fn: () => Promise<void>): void {
    this.onDayBoundary = fn;
  }

  /**
   * Register a callback for sending direct DMs (scheduled via POST /api/schedule/dm).
   * When a task_type='dm' row is due, the message is sent directly without an agent.
   */
  setSendDmCallback(fn: (message: string, platforms?: string[]) => Promise<MessageDelivery[]>): void {
    this.sendDm = fn;
  }

  setActivityScanCallback(fn: (source: string) => Promise<unknown>): void {
    this.onActivityScan = fn;
  }

  /**
   * Register the Phase 4 auth probe callback. Called on each hourly
   * cron tick BEFORE the activity-scan observation threshold gate so
   * the probe continues to run even when the activity scan itself
   * would be skipped for lack of pending observations.
   */
  setAuthProbeCallback(fn: () => Promise<unknown>): void {
    this.onAuthProbe = fn;
  }

  /**
   * Register the Phase 3 self-tuning auto-revert monitor. Called on each
   * hourly cron tick alongside the auth probe; the monitor throttles
   * itself to one pass per day and is a no-op until the actuator has
   * written ledger entries.
   */
  setSelfTuningRevertMonitorCallback(fn: () => Promise<unknown>): void {
    this.onSelfTuningRevertMonitor = fn;
  }

  /**
   * Register the context-index reconciler cron callback. Called every
   * night at 03:45 local; the callback is expected to be fire-and-forget
   * and enqueue a reconcile via the observer's run-once guard.
   */
  setContextIndexReconcilerCallback(fn: () => void): void {
    this.onContextIndexReconcile = fn;
  }

  /**
   * Register the daily roadmap mechanical maintenance callback. Called
   * at 17:45 local; the callback is fire-and-forget — it owns its own
   * lock acquisition, validation, audit emission, and journal append.
   * Failures are logged but do NOT cascade into the 18:00
   * evening_review.
   */
  setRoadmapMaintenanceCallback(fn: () => void): void {
    this.onRoadmapMaintenance = fn;
  }

  /**
   * Register the daily lessons mechanical maintenance callback
   * (SELF_IMPROVEMENT_PHASE2 §2.1/§2.3). Called at 17:40 local, before
   * the 17:45 roadmap pass and the 18:00 evening_review so the evening
   * worksheet reads freshly-normalized stores. Fire-and-forget; failures
   * are logged but never cascade into the evening review.
   */
  setLessonMaintenanceCallback(fn: () => void): void {
    this.onLessonMaintenance = fn;
  }

  /**
   * Register the BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a
   * pre-morning digest cron callback. Fires at `dayBoundaryHour − 1`
   * local; the callback is fire-and-forget — it builds the digest
   * from `browser_visits` / `browser_research_clusters` /
   * `browser_pending_offers` and writes the markdown + JSON sidecar
   * into the daemon-owned `context/browser/` directory. Failures
   * inside the callback log but do not throw outward.
   */
  setBrowserHistoryPreMorningDigestCallback(fn: () => void): void {
    this.onBrowserHistoryPreMorningDigest = fn;
  }

  /**
   * Register the autonomous-work gate. Returning null allows autonomous work;
   * any non-null string is treated as a skip reason and surfaced in logs.
   */
  setAutonomousGate(fn: () => null | string): void {
    this.autonomousGate = fn;
  }

  /**
   * Wire the live built-in enabled cache (AGENT_DEFINITIONS_DESIGN.md §7.1).
   * The loader watcher + the `PATCH /api/agents/:slug` handler call
   * `cache.invalidate()` so the next firing re-queries the DB.
   */
  setAgentEnabledCache(cache: AgentEnabledCache): void {
    this.agentEnabledCache = cache;
  }

  /**
   * Per-built-in enabled gate (§7.1), checked BEFORE `autonomousGate()` in
   * every built-in routine's cron callback. Returns `true` to proceed; on a
   * disabled Agent returns `false` and records a throttled `agent.firing_blocked`
   * audit row (one per agent-day, then `detail.suppressed_count++` — §12.3). It
   * is placed AFTER each callback's runtime gates (monthly last-day, hourly
   * interval, skill-curation cadence) so a per-minute hourly tick that is not a
   * real firing never inflates the suppressed count. A `null` cache (unwired /
   * tests) always proceeds.
   */
  private isAgentEnabledForFiring(slug: string, cronLabel: string): boolean {
    if (this.agentEnabledCache === null) return true;
    if (this.agentEnabledCache.isEnabled(slug)) return true;
    try {
      const agentDay = getAgentDayDateStr(
        this.config.timezone || undefined,
        this.config.dayBoundaryHour,
        new Date(),
      );
      recordAgentFiringBlocked(this.db, { slug, agentDay, reason: "disabled" });
    } catch (err) {
      logger.warn({ err, slug, cron: cronLabel }, "Failed to record agent.firing_blocked");
    }
    logger.debug({ slug, cron: cronLabel }, "Agent disabled — routine firing blocked");
    return false;
  }

  /** Log gate blocks at most once every 5 minutes to avoid spam. */
  private logGateBlock(reason: string, context: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastGateBlockLoggedAt < 5 * 60 * 1000) return;
    this.lastGateBlockLoggedAt = now;
    logger.info({ ...context, reason }, "Autonomous work paused (setup gate)");
  }

  /**
   * In-process re-entrance mutex for the stall watchdog. The hourly cron
   * fires the watchdog as a fire-and-forget promise; a slow `sendDm`
   * (DM hub latency, owner channel reconnect) could overlap with the
   * next hourly tick. Without serialization both invocations would pass
   * the dedup-marker read (the marker isn't written until AFTER the DM
   * succeeds, see below) and emit duplicate alerts. The mutex is
   * process-local — fine, since a single scheduler instance is the only
   * watchdog firing path.
   */
  private morningStallWatchdogRunning = false;

  /**
   * Watchdog for the silent-stall pattern documented in the v4.14 audit
   * (CLAUDE.md "morning_routine wake stall"). When the morning routine
   * never writes an `agent_actions.result='success'` row, the dedup
   * inside `queueMorningRoutineWake` keeps the stuck wake row pinned in
   * `pending`/`running` and the activity-scan pre-routine gate silently
   * skips every subsequent autonomous tick. The user gets no morning
   * brief, no evening review, no activity scan, and no error — the
   * system is functionally dead until the wake row clears.
   *
   * Detection: oldest `task_type='wake'` row tied to
   * `routine='morning_routine'` older than the configured threshold (see
   * `readMorningRoutineStallThresholdMinutes`) with no matching
   * `agent_actions.result='success'` row in the current agent-day window.
   *
   * Delivery & dedup: DM-then-mark, NOT mark-then-DM. A failed DM (DM
   * hub error, missing owner channel) leaves the marker empty so the
   * next hourly tick retries. Repeat alerts on a chronically-broken DM
   * channel are accepted as the lesser evil vs. a silent miss. The
   * `morningStallWatchdogRunning` mutex serialises overlapping
   * invocations so a slow DM cannot produce duplicate alerts.
   *
   * Fire-and-forget: returns nothing, surfaces all failures via logger.
   * The owner DM is best-effort — a sendDm failure logs and does NOT
   * re-throw, so a missing or broken message hub cannot cascade into a
   * cron-callback exception.
   */
  private async checkMorningRoutineStall(now: Date): Promise<void> {
    if (this.morningStallWatchdogRunning) {
      logger.debug("Morning routine stall watchdog already running — skipping overlap");
      return;
    }
    this.morningStallWatchdogRunning = true;
    try {
      let stalled;
      try {
        const thresholdMinutes = readMorningRoutineStallThresholdMinutes(this.db);
        stalled = getStalledMorningRoutineWake(
          this.db,
          this.config,
          thresholdMinutes,
          now,
        );
      } catch (err) {
        logger.warn({ err }, "Morning routine stall watchdog query failed");
        return;
      }
      if (!stalled) return;

      let today: string;
      try {
        today = getAgentDayDateStr(
          this.config.timezone || undefined,
          this.config.dayBoundaryHour,
          now,
        );
      } catch (err) {
        // getAgentDayDateStr can throw on invalid timezone config. Surface
        // and bail rather than mis-key the dedup marker.
        logger.warn({ err }, "Morning routine stall watchdog: agent-day resolution failed");
        return;
      }
      const lastAlertDay = readRuntimeState<string>(
        this.db,
        MORNING_ROUTINE_STALL_ALERT_KEY,
      );
      if (lastAlertDay === today) {
        logger.debug(
          { today, stalledRowId: stalled.id, ageMinutes: stalled.ageMinutes },
          "Morning routine stall watchdog already alerted today",
        );
        return;
      }

      logger.warn(
        {
          stalledRowId: stalled.id,
          ageMinutes: stalled.ageMinutes,
          status: stalled.status,
          scheduledFor: stalled.scheduledFor,
        },
        "Morning routine stall detected — alerting owner",
      );

      if (!this.sendDm) {
        logger.warn(
          { stalledRowId: stalled.id },
          "Morning routine stall watchdog: sendDm callback not registered; will retry next tick",
        );
        return;
      }

      const message =
        `Aitne: morning routine stalled ${stalled.ageMinutes} min `
        + `(wake #${stalled.id}, status=${stalled.status}). Activity scan + `
        + `evening review blocked. Check logs or \`aitne restart\`.`;

      try {
        await this.sendDm(message);
      } catch (err) {
        logger.warn(
          { err, stalledRowId: stalled.id },
          "Morning routine stall watchdog: sendDm failed; dedup marker NOT set — next tick will retry",
        );
        return;
      }

      // Mark dedup ONLY after a successful DM. A persistence failure here
      // would produce one duplicate DM on the next tick — acceptable, and
      // strictly better than the alternative (alert lost forever on
      // transient sendDm failures).
      try {
        writeRuntimeState(this.db, MORNING_ROUTINE_STALL_ALERT_KEY, today);
      } catch (err) {
        logger.warn(
          { err },
          "Morning routine stall watchdog: failed to persist dedup marker; next tick may re-alert",
        );
      }
    } finally {
      this.morningStallWatchdogRunning = false;
    }
  }

  /**
   * Self-heal tick for the morning routine. Three layers:
   *
   * 1. **Recover** — a wake row stuck in `running` whose claim
   *    (`task_context.claimedAt`) is ≥ stall-threshold minutes old with
   *    no success today (machine slept mid-run, the backend stream died)
   *    is flipped back to `pending` so the ScheduleWatcher re-claims it.
   *    Without this, `queueMorningRoutineWake` dedups into the corpse
   *    forever and the day stays frozen until a daemon restart. Runs
   *    BEFORE the alert so a stall the self-heal is about to fix doesn't
   *    burn the once-per-day DM budget on a misleading "restart the
   *    daemon" message; if the re-run wedges too, the next tick still
   *    alerts (the row's created_at age keeps growing). Capped at
   *    {@link MAX_SELFHEAL_REQUEUES_PER_AGENT_DAY} re-runs per agent-day
   *    so a deterministic hang cannot burn backend spend every
   *    threshold-window all day. Worst case if the original execution is
   *    alive after all: one duplicate morning run, serialized by the
   *    today-write-lock.
   * 2. **Alert** — the stall watchdog ({@link checkMorningRoutineStall}).
   *    Previously this only ran on activity-scan cron ticks, so
   *    `activityScanEnabled=false` silently disabled it; this timer is the
   *    guaranteed host now (the cron-tick invocation remains, made safe
   *    by the watchdog's mutex + per-day DM dedup).
   * 3. **Missed fire** — no attempt, no wake row, agent-day older than the
   *    grace window: the boundary cron tick was swallowed (sleep shorter
   *    than the WakeDetector's gap threshold straddling 04:00, or a
   *    detector failure) — open the day exactly the way the cron and the
   *    wake catch-up do (day-boundary callback → daily cleanup → wake row
   *    with due reviews riding the post-catchup context). Never resurrects
   *    an exhausted retry chain: failed attempts leave audit rows, which
   *    `shouldQueueMissedMorningFire` treats as "attempted". Suppressed
   *    during the first {@link MISSED_FIRE_BOOT_SUPPRESSION_MS} of process
   *    life: that window belongs to the boot catchup, whose INLINE morning
   *    run leaves no wake row for the predicate to dedup against (a slow
   *    pre-pass there must not look like a missed fire).
   *
   * Fire-and-forget; each layer owns its own error containment.
   */
  private async runMorningSelfHeal(now: Date): Promise<void> {
    const gateReason = this.autonomousGate();
    if (gateReason !== null) {
      this.logGateBlock(gateReason, { timer: "morning_self_heal" });
      return;
    }

    const agentDayConfig = {
      timezone: this.config.timezone || undefined,
      dayBoundaryHour: this.config.dayBoundaryHour,
    };

    // Layer 1 — hung-claim recovery.
    try {
      const thresholdMinutes = readMorningRoutineStallThresholdMinutes(this.db);
      const recoverable = getRecoverableStalledMorningWake(
        this.db,
        agentDayConfig,
        thresholdMinutes,
        now,
      );
      if (
        recoverable
        && this.countSelfHealRequeuesToday(now) < MAX_SELFHEAL_REQUEUES_PER_AGENT_DAY
      ) {
        const flipped = this.db
          .prepare(
            `UPDATE agent_schedule
                SET status = 'pending', scheduled_for = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(formatSqliteDatetime(now), recoverable.id);
        if (flipped.changes > 0) {
          logger.warn(
            {
              scheduleId: recoverable.id,
              claimedAgeMinutes: recoverable.claimedAgeMinutes,
              thresholdMinutes,
            },
            "Morning routine wake stuck in 'running' — flipped back to pending for re-claim",
          );
          try {
            this.db
              .prepare(
                `INSERT INTO agent_actions
                   (action_type, detail, result, started_at, completed_at)
                 VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              )
              .run(
                "morning_routine.selfheal_requeued",
                JSON.stringify({
                  scheduleId: recoverable.id,
                  claimedAgeMinutes: recoverable.claimedAgeMinutes,
                  thresholdMinutes,
                }),
              );
          } catch (auditErr) {
            logger.warn(
              { err: auditErr, scheduleId: recoverable.id },
              "Failed to record morning_routine.selfheal_requeued audit",
            );
          }
          this.nudgeWatcher();
          // Skip the alert for this tick — the recovery is the response.
          // The missed-fire layer cannot apply (a wake row exists).
          return;
        }
      }
      // Recoverable-but-capped (or lost the flip race) falls through to
      // the alert so the operator hears about a hang the self-heal is no
      // longer allowed to chase.
    } catch (err) {
      logger.warn({ err }, "Morning self-heal recovery step failed");
    }

    // Layer 2 — alert-only watchdog.
    await this.checkMorningRoutineStall(now).catch((err: unknown) => {
      logger.warn({ err }, "Morning routine stall watchdog threw (self-heal tick)");
    });

    // Layer 3 — missed boundary fire.
    try {
      if (Date.now() - this.startedAtMs < MISSED_FIRE_BOOT_SUPPRESSION_MS) {
        return;
      }
      if (
        !shouldQueueMissedMorningFire(
          this.db,
          agentDayConfig,
          MORNING_MISSED_FIRE_GRACE_MINUTES,
          now,
        )
      ) {
        return;
      }
      if (!this.isAgentEnabledForFiring("morning-routine", "morning_self_heal")) {
        return;
      }
      // Mirror runWakeCatchup's morning branch: open the day properly and
      // let any due reviews / activity scan ride the wake row's
      // post-catchup context instead of being skipped by the dispatcher's
      // morning-pending gate.
      const tz = this.config.timezone || undefined;
      const { start, end } = getAgentDayBoundsUtc(
        tz,
        this.config.dayBoundaryHour,
        now,
      );
      const dueRoutines = getDueCatchupRoutines(
        this.db,
        this.config,
        start,
        end,
        now,
      ).filter((routine) =>
        this.isAgentEnabledForFiring(
          WAKE_CATCHUP_AGENT_SLUGS[routine] ?? routine,
          `${routine}_self_heal`,
        ),
      );
      const needsActivityScan =
        shouldCatchUpActivityScan(this.db, this.config, now)
        && this.isAgentEnabledForFiring("activity-scan", "activity_scan_self_heal");
      try {
        if (this.onDayBoundary) {
          await this.onDayBoundary();
        }
      } catch (err) {
        logger.error({ err }, "Day boundary callback failed during morning self-heal");
      }
      this.dailyCleanup();
      const queued = this.queueMorningRoutineWake("missed_cron_selfheal", {
        postCatchupRoutines: dueRoutines,
        postCatchupActivityScan: needsActivityScan,
      });
      this.nudgeWatcher();
      logger.warn(
        { queued, dueRoutines, needsActivityScan },
        "Morning routine fire was missed (sleep swallowed the boundary cron tick) — self-heal queued wake",
      );
    } catch (err) {
      logger.warn({ err }, "Morning self-heal missed-fire step failed");
    }
  }

  /**
   * Number of self-heal re-queues already performed this agent-day,
   * counted from the `morning_routine.selfheal_requeued` audit rows the
   * recovery layer writes. Throws propagate to the recovery layer's
   * catch (fail-closed: an unreadable counter must not unlock unlimited
   * re-runs).
   */
  private countSelfHealRequeuesToday(now: Date): number {
    const { start } = getAgentDayBoundsUtc(
      this.config.timezone || undefined,
      this.config.dayBoundaryHour,
      now,
    );
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
           FROM agent_actions
          WHERE action_type = 'morning_routine.selfheal_requeued'
            AND started_at >= ?`,
      )
      .get(start) as { cnt: number };
    return row.cnt;
  }

  /**
   * Replay cron triggers swallowed by a machine sleep (or forward clock
   * jump). node-cron does not fire ticks whose time passed while the
   * process was suspended, so without this a daemon that sleeps through
   * 04:00 / 18:00 / a Friday 19:00 recovers those routines only on the
   * next daemon RESTART (`bootstrap/catchup.ts`) — possibly days later.
   *
   * Reuses the boot-time catchup's decision predicates so the two paths
   * cannot drift: `getDueCatchupRoutines` dedups against `agent_actions`,
   * `shouldCatchUpActivityScan` replays at most the current slot, and the
   * morning routine goes through `queueMorningRoutineWake`'s DB-backed
   * dedup. Downstream dispatch-time gates (autonomous setup gate,
   * morning-pending review gate) still apply.
   *
   * Ordering: when the morning routine has not completed for the current
   * agent-day, the review routines and the activity scan ride along on the
   * wake row's `postCatchupRoutines` / `postCatchupActivityScan` context
   * (same replay mechanism the boot catchup uses) so they run AFTER the
   * day is opened instead of being skipped by the dispatcher's
   * pre-routine gate.
   */
  private async runWakeCatchup(gapMs: number): Promise<void> {
    const gapMinutes = Math.round(gapMs / 60_000);
    const gateReason = this.autonomousGate();
    if (gateReason !== null) {
      this.logGateBlock(gateReason, { cron: "wake_catchup", gapMinutes });
      return;
    }

    const now = new Date();
    const tz = this.config.timezone || undefined;
    const { start, end } = getAgentDayBoundsUtc(
      tz,
      this.config.dayBoundaryHour,
      now,
    );

    const dueRoutines = getDueCatchupRoutines(
      this.db,
      this.config,
      start,
      end,
      now,
    ).filter((routine) =>
      this.isAgentEnabledForFiring(
        WAKE_CATCHUP_AGENT_SLUGS[routine] ?? routine,
        `${routine}_wake_catchup`,
      ),
    );
    const needsActivityScan =
      shouldCatchUpActivityScan(this.db, this.config, now)
      && this.isAgentEnabledForFiring("activity-scan", "activity_scan_wake_catchup");

    if (
      !morningRoutineRanToday(
        this.db,
        { timezone: tz, dayBoundaryHour: this.config.dayBoundaryHour },
        now,
      )
    ) {
      // Slept across the day boundary (or the morning routine never
      // succeeded today) — re-run the full 04:00 flow. The wake row
      // dedups against an already-pending/running morning run, merging
      // the post-catchup context instead of double-firing.
      if (!this.isAgentEnabledForFiring("morning-routine", "morning_routine_wake_catchup")) {
        return;
      }
      try {
        if (this.onDayBoundary) {
          await this.onDayBoundary();
        }
      } catch (err) {
        logger.error({ err }, "Day boundary callback failed during wake catch-up");
      }
      this.dailyCleanup();
      const queued = this.queueMorningRoutineWake("wake_catchup", {
        postCatchupRoutines: dueRoutines,
        postCatchupActivityScan: needsActivityScan,
      });
      this.nudgeWatcher();
      logger.info(
        { gapMinutes, queued, dueRoutines, needsActivityScan },
        "Wake catch-up queued morning routine",
      );
      return;
    }

    for (const routine of dueRoutines) {
      logger.info({ routine, gapMinutes }, "Wake catch-up replaying missed routine");
      this.emitRoutine(routine);
    }
    if (needsActivityScan && this.onActivityScan) {
      logger.info({ gapMinutes }, "Wake catch-up triggering missed activity scan");
      void Promise.resolve(this.onActivityScan("wake_catchup")).catch(
        (err: unknown) => {
          logger.warn({ err }, "Wake catch-up activity scan failed");
        },
      );
    }
    if (dueRoutines.length === 0 && !needsActivityScan) {
      logger.info({ gapMinutes }, "Wake catch-up: nothing missed");
    }
  }

  start(): void {
    this.setupRecurringJobs();
    this.startScheduleWatcher();
    this.wakeDetector.start();
    this.morningSelfHealTimer = setInterval(() => {
      void this.runMorningSelfHeal(new Date()).catch((err: unknown) => {
        logger.warn({ err }, "Morning self-heal tick threw");
      });
    }, MORNING_SELF_HEAL_INTERVAL_MS);
    this.morningSelfHealTimer.unref?.();
    logger.info("Scheduler started");
  }

  stop(): void {
    this.shutdown = true;
    this.wakeDetector.stop();
    if (this.morningSelfHealTimer) {
      clearInterval(this.morningSelfHealTimer);
      this.morningSelfHealTimer = null;
    }
    // Wake up the ScheduleWatcher's poll sleep so the loop returns
    // immediately instead of waiting for the next interval tick. The
    // sleepInterruptible body re-checks `shutdown` before re-entering
    // its `new Promise` block, so simply resolving any in-flight waiter
    // is enough — no need to broadcast through the nudge counter.
    this.consumeWaiter();
    this.stopCronJobs();
    logger.info("Scheduler stopped");
  }

  /**
   * Wake the ScheduleWatcher's between-poll sleep so a freshly-inserted
   * `agent_schedule` row scheduled for "now" is claimed on the next event-loop
   * tick instead of after up to a full `schedulePollIntervalSeconds` wait.
   *
   * Safe to call any time after `start()` (and a no-op before): the public
   * surface is idempotent — multiple rapid calls coalesce into a single
   * extra wake at the next sleep boundary. Between-sleep nudges land on
   * the monotonic `nudgeSeq` counter and are consumed at the top of the
   * next `sleepInterruptible`; in-flight nudges resolve the active
   * waiter directly. Both paths advance `observedSeq` so a single nudge
   * skips exactly one sleep, never two.
   *
   * Wired today from `queueMorningRoutineWake` (post-setup, post-Google-auth,
   * catchup); other `INSERT INTO agent_schedule` sites use future-dated rows
   * and do not need a nudge.
   */
  nudgeWatcher(): void {
    this.nudgeSeq += 1;
    if (this.sleepWaiter) {
      this.observedSeq = this.nudgeSeq;
      this.consumeWaiter();
    }
  }

  /**
   * Resolve and clear the active `sleepWaiter`, if any. Used by both
   * `stop()` and `nudgeWatcher()` to break a running sleep. Safe to call
   * when no waiter exists — it's a no-op.
   */
  private consumeWaiter(): void {
    const waiter = this.sleepWaiter;
    if (!waiter) return;
    this.sleepWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  /** Hot-reload cron schedules (e.g. after dayBoundaryHour changes) */
  reloadCrons(): void {
    this.stopCronJobs();
    this.setupRecurringJobs();
    logger.info("Cron jobs reloaded");
  }

  private stopCronJobs(): void {
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.length = 0;
  }

  private setupRecurringJobs(): void {
    const tz = this.config.timezone || undefined;

    // Morning Routine: daily at dayBoundaryHour (default 04:00)
    // Order: day boundary callback (DM summarize) → morning routine → cleanup
    const morningJob = cron.schedule(
      `0 ${this.config.dayBoundaryHour} * * *`,
      () => {
        if (!this.isAgentEnabledForFiring("morning-routine", "morning_routine")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "morning_routine" });
          return;
        }
        void (async () => {
          try {
            if (this.onDayBoundary) {
              await this.onDayBoundary();
            }
          } catch (err) {
            logger.error({ err }, "Day boundary callback failed");
          }
          this.dailyCleanup();
          this.queueMorningRoutineWake("cron");
        })();
      },
      { timezone: tz },
    );
    this.cronJobs.push(morningJob);

    // Evening Review: daily at 18:00
    const eveningJob = cron.schedule(
      "0 18 * * *",
      () => {
        if (!this.isAgentEnabledForFiring("evening-review", "evening_review")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "evening_review" });
          return;
        }
        this.emitRoutine("evening_review");
      },
      { timezone: tz },
    );
    this.cronJobs.push(eveningJob);

    // User-profile sweep (morning phase): 10 min before the day boundary.
    // For dayBoundaryHour = 4 this is "50 3 * * *". Fires before the
    // morning routine so the morning routine reads a freshly up-to-date
    // user/profile.md when it loads <user>. See USER-PROFILE-CAPTURE-PLAN.md
    // §Phase 2.
    const sweepMorningJob = cron.schedule(
      buildUserProfileSweepMorningCronExpr(this.config.dayBoundaryHour),
      () => {
        if (!this.isAgentEnabledForFiring("user-profile-sweep-morning", "user_profile_sweep_morning")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "user_profile_sweep_morning" });
          return;
        }
        this.emitRoutine("user_profile_sweep", { phase: "morning" });
      },
      { timezone: tz },
    );
    this.cronJobs.push(sweepMorningJob);

    // User-profile sweep (evening phase): 10 min before Evening Review.
    // Evening Review's cron is fixed at 18:00, so this is always "50 17
    // * * *". If Evening Review ever becomes time-configurable, this
    // cron must track the same config knob in lockstep.
    const sweepEveningJob = cron.schedule(
      USER_PROFILE_SWEEP_EVENING_CRON_EXPR,
      () => {
        if (!this.isAgentEnabledForFiring("user-profile-sweep-evening", "user_profile_sweep_evening")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "user_profile_sweep_evening" });
          return;
        }
        this.emitRoutine("user_profile_sweep", { phase: "evening" });
      },
      { timezone: tz },
    );
    this.cronJobs.push(sweepEveningJob);

    // Lesson mechanical maintenance (SELF_IMPROVEMENT_PHASE2 §2.1/§2.3):
    // 17:40 local — 5 min before the roadmap pass and 20 min before
    // evening_review — so the evening consolidation reads
    // freshly-normalized lesson stores. Same gating posture as the
    // roadmap pass below: autonomousGate applies, the morning-routine
    // pending skip deliberately does not.
    const lessonMaintenanceJob = cron.schedule(
      LESSON_MAINTENANCE_CRON_EXPR,
      () => {
        if (!this.isAgentEnabledForFiring("lesson-maintenance", "lesson_maintenance")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "lesson_maintenance" });
          return;
        }
        try {
          this.onLessonMaintenance?.();
        } catch (err) {
          logger.warn({ err }, "Lesson maintenance callback threw");
        }
      },
      { timezone: tz },
    );
    this.cronJobs.push(lessonMaintenanceJob);

    // Roadmap mechanical maintenance (evening-review slimdown §2.2):
    // 17:45 local, 15 min before evening_review's 18:00 fire. Runs the
    // typed in-process pass (substeps 2a / 2b / 2d) that legacy
    // evening_review used to do via a Sonnet routine. The job is gated
    // by `autonomousGate` like every other autonomous cron, but
    // intentionally does NOT inherit the `morning_routine_pending_for_today`
    // skip — mechanical roadmap maintenance is independent of whether
    // the morning routine ran, and inheriting the gate would block
    // maintenance on the very days the operator needs roadmap.md to
    // stay clean.
    const roadmapMaintenanceJob = cron.schedule(
      ROADMAP_MAINTENANCE_CRON_EXPR,
      () => {
        if (!this.isAgentEnabledForFiring("roadmap-maintenance", "roadmap_maintenance")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "roadmap_maintenance" });
          return;
        }
        try {
          this.onRoadmapMaintenance?.();
        } catch (err) {
          logger.warn({ err }, "Roadmap maintenance callback threw");
        }
      },
      { timezone: tz },
    );
    this.cronJobs.push(roadmapMaintenanceJob);

    // Weekly Review: Friday at 19:00 (one hour after evening_review)
    // Emits a separate routine event so the prompt can generate weekly/YYYY-Www.md
    const weeklyJob = cron.schedule(
      "0 19 * * 5",
      () => {
        if (!this.isAgentEnabledForFiring("weekly-review", "weekly_review")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "weekly_review" });
          return;
        }
        this.emitRoutine("weekly_review");
      },
      { timezone: tz },
    );
    this.cronJobs.push(weeklyJob);

    // Monthly Review: last day of month at 18:00
    // node-cron doesn't directly support "last day of month",
    // so we run daily at 18:00 and check if tomorrow is the 1st.
    //
    // Default OFF pre-release: the monthly-review AGENT row ships
    // `enabled: false`, and `isAgentEnabledForFiring` below is the single
    // fire-time switch (AGENTS_HUB_REDESIGN_PLAN.md §2 — the legacy
    // `monthlyReviewEnabled` config gate was unified into it; a one-time
    // boot reconcile carries an operator's old `true` forward). A toggle
    // takes effect on the next month-end without restart or cron rebuild.
    // The routine itself (task-flow, context-builder branch, retention
    // coupling) stays in tree as a concept pending the Mirror+Prune
    // redesign.
    const monthlyJob = cron.schedule(
      "0 18 * * *",
      () => {
        // Check if tomorrow (in configured timezone) is the 1st
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowLocal = nowInTimezone(tz, tomorrow);
        if (tomorrowLocal.day === 1) {
          if (!this.isAgentEnabledForFiring("monthly-review", "monthly_review")) return;
          const gateReason = this.autonomousGate();
          if (gateReason !== null) {
            this.logGateBlock(gateReason, { cron: "monthly_review" });
            return;
          }
          this.emitRoutine("monthly_review");
        }
      },
      { timezone: tz },
    );
    this.cronJobs.push(monthlyJob);

    // Context-index reconciler (B-004 Phase 2a). Run 15 minutes before
    // the day boundary so the index is fresh when the morning routine
    // reads it. The callback's morning-routine lock gate defers the run
    // if this cron happens to fire while a retrying morning routine still
    // holds the lock.
    const reconcilerHour = (this.config.dayBoundaryHour + 23) % 24;
    const reconcilerCron = `45 ${reconcilerHour} * * *`;
    const reconcilerJob = cron.schedule(
      reconcilerCron,
      () => {
        if (!this.isAgentEnabledForFiring("context-index-reconcile", "context_index_reconcile")) return;
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "context_index_reconcile" });
          return;
        }
        try {
          this.onContextIndexReconcile?.();
        } catch (err) {
          logger.warn({ err }, "Context-index reconcile callback threw");
        }
      },
      { timezone: tz },
    );
    this.cronJobs.push(reconcilerJob);

    // BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 Stage 1 — pre-morning
    // digest at `dayBoundaryHour − 1` (default 03:00 when
    // `dayBoundaryHour=4`). Same hour as the context-index reconciler
    // above (03:45) but at :00 instead of :45 so the digest's snapshot
    // is taken BEFORE the reconciler nudges the prompt context — the
    // morning routine's task-flow then sees both the reconciled index
    // AND the freshly-written digest in its first turn.
    //
    // Gated by `autonomousGate` like every other autonomous cron;
    // setup-incomplete + setup-active states pause the build.
    // Fire-and-forget: the callback handles its own failure logging
    // (see `safeRunPreMorningDigestJob`), and any uncaught throw lands
    // in the local catch block here rather than escaping the cron.
    const browserDigestCron = buildBrowserHistoryPreMorningDigestCronExpr(
      this.config.dayBoundaryHour,
    );
    const browserDigestJob = cron.schedule(
      browserDigestCron,
      () => {
        const gateReason = this.autonomousGate();
        if (gateReason !== null) {
          this.logGateBlock(gateReason, { cron: "browser_history_pre_morning_digest" });
          return;
        }
        try {
          this.onBrowserHistoryPreMorningDigest?.();
        } catch (err) {
          logger.warn(
            { err },
            "browser-history pre-morning digest callback threw",
          );
        }
      },
      { timezone: tz },
    );
    this.cronJobs.push(browserDigestJob);

    {
      // Cadence is owned by the activity-scan AGENT ROW (metadata_json.
      // runtime_window, edited via PATCH /api/agents/activity-scan) with the
      // legacy `activityScan*` config keys as per-field fallback —
      // AGENTS_HUB_REDESIGN_PLAN.md §2. Resolved once at registration; the
      // agents PATCH route triggers `reloadCrons()` on a cadence change, so
      // the closure below never goes stale. The job is registered
      // UNCONDITIONALLY: `agents.enabled` (fire-time `isAgentEnabledForFiring`
      // gate below) is the single on/off switch — the legacy
      // `activityScanEnabled` registration gate was unified into it.
      const activityScanCadence = resolveActivityScanCadence(
        getRuntimeWindow(this.db, "activity-scan"),
        this.config,
      );
      const activityScanExpr = buildActivityScanCronExpr(
        activityScanCadence.intervalMinutes,
        activityScanCadence.activeStartHour,
        activityScanCadence.activeEndHour,
      );
      const activityScanJob = cron.schedule(
        activityScanExpr,
        () => {
          const now = new Date();
          // Pull both hour and minute from the canonical timezone helper
          // so the day-boundary skip and the interval gate observe the
          // same local time. (The earlier inline `Intl.DateTimeFormat`
          // calls were equivalent for 60-min intervals but obscured the
          // fact that minute-extraction needs to round-trip through the
          // same timezone.)
          const local = nowInTimezone(tz, now);
          if (local.hours === this.config.dayBoundaryHour) {
            return;
          }
          // Arbitrary intervals run on a `* <hours> * * *` cron and must
          // be gated here. Anchor at `activeStartHour` so the first slot
          // of each agent-day lands at the start of the active window —
          // critical for intervals near or equal to the window length.
          // Divisor-of-60 cases short-circuit inside the helper.
          if (
            !shouldFireActivityScanTickAt(
              local.hours,
              local.minutes,
              activityScanCadence.intervalMinutes,
              activityScanCadence.activeStartHour,
            )
          ) {
            return;
          }
          // Self-tuning auto-revert monitor — ahead of BOTH the per-agent
          // enabled gate and the autonomous setup gate below: rollback
          // safety must survive the owner disabling the activity-scan
          // Agent (a plausible cost-saving move while a tuned knob sits
          // unverified) and a degraded/setup-gated daemon. It is pure
          // daemon code (no LLM dispatch), owns its own 1/day throttle,
          // and is a no-op until the actuator has written ledger entries.
          if (this.onSelfTuningRevertMonitor) {
            void this.onSelfTuningRevertMonitor().catch((err: unknown) => {
              logger.warn({ err }, "Self-tuning revert monitor failed");
            });
          }
          // Per-built-in enabled gate, AFTER the interval gate so a
          // per-minute non-firing tick never inflates the suppressed count.
          if (!this.isAgentEnabledForFiring("activity-scan", "activity_scan")) return;
          // triggerActivityScan has its own setup gate, but short-circuit
          // here to avoid the in-progress flag toggling for no reason.
          const gateReason = this.autonomousGate();
          if (gateReason !== null) {
            this.logGateBlock(gateReason, { cron: "activity_scan" });
            return;
          }
          // Phase 4 auth probe runs BEFORE the activity scan so that the
          // observation-threshold gate (which can skip `onActivityScan`
          // entirely when there's no pending user activity) does not
          // also stall auth health detection. The probe owns its own
          // morning-routine / probe-disabled gating; we only respect
          // the autonomous setup gate here.
          if (this.onAuthProbe) {
            void this.onAuthProbe().catch((err: unknown) => {
              logger.warn({ err }, "Auth probe callback failed");
            });
          }
          // Morning-routine stall watchdog. Runs alongside the auth probe
          // because both are observability hooks that should fire even
          // when the activity scan itself gets gated (e.g., the gate
          // skip is the *symptom* the watchdog needs to catch).
          void this.checkMorningRoutineStall(now).catch((err: unknown) => {
            logger.warn({ err }, "Morning routine stall watchdog threw");
          });
          if (this.onActivityScan) {
            void this.onActivityScan("cron");
          }
        },
        { timezone: tz },
      );
      this.cronJobs.push(activityScanJob);
    }

    // P22 §6.3, §6.4 — skill curation. Registered only when the operator
    // has opted in via /settings/self-learning (`enabled=true`). Always
    // fires daily at 03:00; the gate inside the handler checks whether
    // the cadence interval (daily=24 h, weekly=7 d, monthly=30 d) has
    // elapsed since the last run's `started_at`. This makes manual runs
    // (P22 §6.4) push the next auto-run forward by exactly one cadence
    // interval — clicking "Run now" today on a daily cadence means the
    // next auto-run fires tomorrow rather than today's 03:00. The
    // dashboard PATCH that flips `enabled` calls `reloadCrons()` so this
    // job is added live without a daemon restart.
    if (isSkillCurationEnabled(this.db)) {
      const skillCurationJob = cron.schedule(
        "0 3 * * *",
        () => {
          // Re-check on tick so a runtime disable suppresses the next run
          // even before the next reloadCrons().
          if (!isSkillCurationEnabled(this.db)) return;
          const cadence = readSkillCurationCadence(this.db);
          if (!isCadenceIntervalElapsed(this.db, cadence)) {
            logger.debug({ cadence }, "skill_curation cadence interval not elapsed yet");
            return;
          }
          if (!this.isAgentEnabledForFiring("skill-curation", "skill_curation")) return;
          const gateReason = this.autonomousGate();
          if (gateReason !== null) {
            this.logGateBlock(gateReason, { cron: "skill_curation" });
            return;
          }
          this.emitRoutine("skill_curation", { cadence });
        },
        { timezone: tz },
      );
      this.cronJobs.push(skillCurationJob);
    }

    // SOURCE_LIBRARY_DESIGN.md — weekly source-librarian pass (Sat 09:00).
    // The prefilter is a no-LLM DB+fs scan: zero unfiled sources, zero
    // library↔vault inconsistencies, and no unconsumed `sources`-skill
    // drift signals ⇒ skip the whole session (most weeks cost nothing).
    {
      const sourceLibrarianJob = cron.schedule(
        "0 9 * * 6",
        () => {
          if (!this.isAgentEnabledForFiring("source-librarian", "source_maintenance")) return;
          const gateReason = this.autonomousGate();
          if (gateReason !== null) {
            this.logGateBlock(gateReason, { cron: "source_maintenance" });
            return;
          }
          const prefilter = evaluateSourceMaintenancePrefilter(
            this.db,
            getContextDir(this.config, this.db),
          );
          if (!prefilter.shouldRun) {
            logger.info(prefilter, "source_maintenance skipped — nothing to do");
            return;
          }
          this.emitRoutine("source_maintenance", {
            unfiledCount: prefilter.unfiledCount,
            inconsistencyCount: prefilter.inconsistencyCount,
            driftSignalCount: prefilter.driftSignalCount,
          });
        },
        { timezone: tz },
      );
      this.cronJobs.push(sourceLibrarianJob);
    }

    {
      const cadence = resolveActivityScanCadence(
        getRuntimeWindow(this.db, "activity-scan"),
        this.config,
      );
      logger.info(
        {
          morningHour: this.config.dayBoundaryHour,
          timezone: tz ?? "system",
          activityScanIntervalMinutes: cadence.intervalMinutes,
          activityScanActiveHours: `${cadence.activeStartHour}-${cadence.activeEndHour}`,
        },
        "Recurring cron jobs configured",
      );
    }
  }

  private emitRoutine(
    routineName: string,
    data?: Record<string, unknown>,
  ): void {
    const event = {
      ...createEvent({
        type: `routine.${routineName}`,
        source: "scheduler",
        priority: EventPriority.HIGH,
        ...(data ? { data } : {}),
      }),
      routine: routineName,
    } as RoutineEvent;

    void this.eventBus.put(event);
    logger.info({ routine: routineName }, "Routine event emitted");
  }

  /**
   * Queue the morning routine as a durable wake task.
   *
   * This serializes all morning-routine entry points (cron, startup catchup,
   * Google auth hot-load) behind a single DB-backed dedup guard so we don't
   * run multiple overlapping full-day regenerations.
   */
  queueMorningRoutineWake(
    source: string,
    options?: { postCatchupRoutines?: string[]; postCatchupActivityScan?: boolean },
  ): { inserted: boolean; existingId?: number } {
    const scheduledFor = formatSqliteDatetime(new Date());
    const wakeEvent = createEvent({
      type: "routine.morning_routine",
      source,
      priority: EventPriority.HIGH,
    });
    // `importance: "low"` keeps morning-routine wake tasks out of the
    // roadmap refresh trigger — they fire within hours and the morning
    // routine itself is the visible surface, not a roadmap entry.
    const taskContext = JSON.stringify({
      routine: "morning_routine",
      source,
      postCatchupRoutines: options?.postCatchupRoutines ?? [],
      postCatchupActivityScan: options?.postCatchupActivityScan ?? false,
      importance: "low",
    });

    const insertTxn = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id, task_context
             FROM agent_schedule
            WHERE task_type = 'wake'
              AND status IN ('pending', 'running')
              AND json_extract(task_context, '$.routine') = 'morning_routine'
            LIMIT 1`,
        )
        .get() as { id: number; task_context: string | null } | undefined;

      if (existing) {
        const existingContext = JSON.parse(existing.task_context ?? "{}") as {
          source?: string;
          postCatchupRoutines?: string[];
          postCatchupActivityScan?: boolean;
        };
        const mergedRoutines = Array.from(
          new Set([
            ...(Array.isArray(existingContext.postCatchupRoutines)
              ? existingContext.postCatchupRoutines
              : []),
            ...(options?.postCatchupRoutines ?? []),
          ]),
        );
        const mergedActivityScan =
          existingContext.postCatchupActivityScan === true ||
          options?.postCatchupActivityScan === true;
        // Spread the existing context FIRST so keys this merge doesn't
        // know about survive — in particular the ScheduleWatcher's
        // `claimedAt` stamp on a running row: dropping it would blind
        // the self-heal recovery predicate exactly when the 04:00 cron
        // merges into a hung overnight run.
        const mergedContext = {
          ...existingContext,
          routine: "morning_routine",
          source: existingContext.source ?? source,
          postCatchupRoutines: mergedRoutines,
          postCatchupActivityScan: mergedActivityScan,
          importance: "low",
        };
        // Bump `scheduled_for` forward when the new caller's NOW lies
        // after the existing row's stored timestamp. Closes a narrow but
        // silent race around the agent-day boundary:
        //
        //   - existing wake row was inserted just before the boundary
        //     (e.g. 03:59:59 local) with `scheduled_for = 03:59:59`;
        //   - this caller (the 04:00 cron, or any post-boundary trigger)
        //     dedup-merges instead of inserting;
        //   - without bumping `scheduled_for`, the merged row keeps the
        //     pre-boundary timestamp and the next ScheduleWatcher tick
        //     marks it `skipped` via `discardStalePendingSchedules`
        //     (which discards `pending` rows with `scheduled_for <
        //     currentAgentDayStartUtc`), silently losing the wake.
        //
        // `MAX(scheduled_for, ?)` keeps legitimate future-dated retry
        // rows (scheduleMorningRetry inserts with a +5/10/15 min back-
        // off) at their original time — the retry chain's exponential
        // back-off is preserved. Only past-dated rows get pulled forward,
        // which is exactly the boundary-race shape this guards against.
        // Both timestamps are produced by `formatSqliteDatetime` (the
        // `YYYY-MM-DD HH:MM:SS` zero-padded form), so SQLite's string
        // comparison ranks them chronologically.
        this.db
          .prepare(
            `UPDATE agent_schedule
                SET task_context = ?,
                    scheduled_for = MAX(scheduled_for, ?)
              WHERE id = ?`,
          )
          .run(JSON.stringify(mergedContext), scheduledFor, existing.id);
        return { inserted: false as const, existingId: existing.id };
      }

      const morningInstruction =
        "Morning routine. Generate today.md and register the day schedule.";
      this.db
        .prepare(
          `INSERT INTO agent_schedule
             (scheduled_for, task_type, task_description, task_prompt, task_context, correlation_id, model, status)
           VALUES (?, 'wake', ?, ?, ?, ?, NULL, 'pending')`,
        )
        .run(
          scheduledFor,
          // task_description (list label) doubles as task_prompt (agent
          // instruction) for this system-generated row.
          morningInstruction,
          morningInstruction,
          taskContext,
          wakeEvent.correlationId,
        );

      return { inserted: true as const };
    });

    const result = insertTxn();
    if (result.inserted) {
      logger.info({ source, scheduledFor }, "Morning routine wake queued");
      // The row is due NOW. Wake the watcher's between-poll sleep so we
      // pick it up on the next tick instead of waiting up to a full
      // `schedulePollIntervalSeconds` window. Most painful on the
      // setup-complete path where the user is staring at the dashboard
      // waiting for today.md to populate.
      this.nudgeWatcher();
    } else {
      logger.info(
        { source, existingScheduleId: result.existingId },
        "Morning routine wake deduped",
      );
    }
    return result;
  }

  /**
   * ScheduleWatcher — polls agent_schedule for pending tasks.
   *
   * Handles agent-scheduled wake-ups and DMs. Uses optimistic locking:
   * only processes rows where
   * UPDATE ... SET status='running' WHERE status='pending' succeeds.
   */
  private startScheduleWatcher(): void {
    const loop = async () => {
      while (!this.shutdown) {
        try {
          const agentDayStartUtc = getAgentDayBoundsUtc(
            this.config.timezone || undefined,
            this.config.dayBoundaryHour,
          ).start;
          const discarded = discardStalePendingSchedules(
            this.db,
            agentDayStartUtc,
          );
          if (discarded > 0) {
            logger.info({ discarded }, "Discarded stale pending schedules");
          }

          // Setup gate — leave due rows in 'pending' so ScheduleWatcher
          // picks them up on the next tick after setup completes. Direct DMs
          // (row.task_type === "dm") are also gated since the user cannot
          // have scheduled them before completing initial setup; any DMs
          // that happened to roll over a day boundary while setup was in
          // progress wait for setup to finish before sending.
          const gateReason = this.autonomousGate();
          if (gateReason !== null) {
            this.logGateBlock(gateReason, { poll: "schedule_watcher" });
            await this.sleepInterruptible(
              this.config.schedulePollIntervalSeconds * 1000,
            );
            continue;
          }

          // Reconcile recurring schedules: generate next agent_schedule
          // rows for any enabled recurring schedule with no pending/running row.
          try {
            const reconciled = reconcileRecurringSchedules(this.db);
            if (reconciled > 0) {
              logger.info({ reconciled }, "Reconciled recurring schedules");
            }
          } catch (err) {
            logger.error({ err }, "Recurring schedule reconciliation failed");
          }

          const nowUtc = formatSqliteDatetime(new Date());
          const rows = this.db
            .prepare(
              "SELECT * FROM agent_schedule WHERE status = 'pending' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT 3",
            )
            .all(nowUtc) as ScheduleRow[];

          for (const row of rows) {
            // Optimistic lock: only proceed if we successfully claim the row
            const result = this.db
              .prepare(
                "UPDATE agent_schedule SET status = 'running' WHERE id = ? AND status = 'pending'",
              )
              .run(row.id);

            if (result.changes === 0) continue;

            // Stamp the claim time on morning-routine wake rows. This is
            // the staleness signal the self-heal recovery predicate
            // (`getRecoverableStalledMorningWake`) measures from —
            // `created_at` and `scheduled_for` both lie after sleeps and
            // dedup merges. Best-effort and morning-scoped: a failure
            // here only demotes that row from auto-recovery to the
            // alert-only watchdog path.
            try {
              this.db
                .prepare(
                  `UPDATE agent_schedule
                      SET task_context = json_set(COALESCE(task_context, '{}'), '$.claimedAt', ?)
                    WHERE id = ?
                      AND json_valid(COALESCE(task_context, '{}'))
                      AND json_extract(task_context, '$.routine') = 'morning_routine'`,
                )
                .run(formatSqliteDatetime(new Date()), row.id);
            } catch (stampErr) {
              logger.warn(
                { err: stampErr, taskId: row.id },
                "Failed to stamp claimedAt on claimed schedule row",
              );
            }

            // Per-row try/catch: if the row body throws (e.g. malformed
            // task_context JSON), flip the claim to 'failed' so the row
            // doesn't stay 'running' forever and the watcher can move on.
            try {
              // Direct DM: send message without running an agent
              if (row.task_type === "dm") {
                await this.handleDirectDm(row);
                continue;
              }

              // SCHEDULED-DM-IMPLEMENTATION-PLAN §5.5 — DM-tone scheduled
              // session. Same shape as scheduled.task; the type field is
              // the routing axis that downstream uses to pick the
              // conversational profile + DM-flavored context blocks.
              if (row.task_type === "dm_session") {
                const base = createEvent({
                  type: "scheduled.dm",
                  source: row.task_type,
                  priority: EventPriority.NORMAL,
                });
                const event = {
                  ...base,
                  // task_prompt is the agent body. Every insert site sets it
                  // (and a backfill migration filled legacy rows), so the old
                  // `?? task_description` fallback is gone; `?? ""` is only a
                  // null-type guard that never fires in practice.
                  task: row.task_prompt ?? "",
                  taskContext: JSON.parse(row.task_context ?? "{}"),
                  correlationId: row.correlation_id ?? base.correlationId,
                  scheduleId: row.id,
                  // Tier override takes precedence over the legacy model
                  // field at dispatch (the dispatcher inspects
                  // requestedTier ahead of requestedModel). The schema
                  // CHECK already constrains the column to lite/medium/high,
                  // so the in-cast is safe.
                  ...(isProcessTier(row.tier_override)
                    ? { requestedTier: row.tier_override }
                    : {}),
                  // `agent_schedule.model` is operator-supplied. Four
                // resolution branches (SCHEDULE_API_REDESIGN_PLAN §4.3a;
                // branch 3 added 2026-06-01 —
                // AGENT_DEFINITIONS_KNOWN_LIMITATIONS §1):
                //   1. legacy alias 'sonnet' / 'opus' → `requestedModel`
                //   2. registered model id paired with backend_id →
                //      emit BOTH `requestedBackendId` and
                //      `requestedModelId` so the dispatcher's override
                //      block fires with an exact model pin.
                //   3. backend_id WITHOUT a model → emit
                //      `requestedBackendId` alone. resolveBinding's
                //      backend-only branch resolves the model from the
                //      row's tier / the backend default, so an engine-only
                //      pin ("run this on codex") routes to that engine
                //      instead of being silently dropped.
                //   4. model present but backend_id NULL (legacy rows or
                //      pure-tier rows) → fall through to no-override so
                //      the row resolves via process-key defaults.
                ...(row.model === "sonnet" || row.model === "opus"
                  ? { requestedModel: row.model as "sonnet" | "opus" }
                  : row.model && row.backend_id && isBackendId(row.backend_id)
                  ? { requestedBackendId: row.backend_id, requestedModelId: row.model }
                  : row.backend_id && isBackendId(row.backend_id)
                  ? { requestedBackendId: row.backend_id }
                  : {}),
                } as ScheduledDmEvent;

                await this.eventBus.put(event);
                logger.info(
                  { taskId: row.id, taskType: row.task_type },
                  "Scheduled DM session dispatched",
                );
                continue;
              }

              // BROWSER_TASK_REDESIGN_PLAN.md §6.2 + §12 Q#5 — open-ended
              // browser sub-agent firing at its scheduled time. The body
              // of the original POST lives in `task_context` (frozen at
              // schedule time); the dispatcher's `scheduled.browser_task`
              // handler is responsible for creating the `browser_task`
              // row at fire time and handing off to the runner.
              //
              // Quiet-hours deferral: when `browserTaskRespectQuietHours`
              // is true (default) and the current wall-clock instant is
              // inside the configured quiet-hours window, the row is
              // pushed forward to the next quiet-hours-end boundary
              // instead of being dispatched. One `agent_actions` audit
              // row is written per deferral so the user can see the
              // delay; the row's status is reverted to `pending` so
              // the next ScheduleWatcher tick re-evaluates.
              if (row.task_type === "browser_task") {
                const respectQuietHours =
                  this.config.browserTaskRespectQuietHours !== false;
                if (
                  respectQuietHours &&
                  this.deferClaimedRowForQuietHours(
                    row,
                    "browser_task.deferred_for_quiet_hours",
                  )
                ) {
                  continue;
                }

                const base = createEvent({
                  type: "scheduled.browser_task",
                  source: row.task_type,
                  priority: EventPriority.NORMAL,
                });
                let parsedContext: Record<string, unknown>;
                try {
                  parsedContext = JSON.parse(row.task_context ?? "{}");
                } catch (parseErr) {
                  logger.error(
                    { err: parseErr, scheduleId: row.id },
                    "scheduled.browser_task: task_context JSON parse failed — marking row failed",
                  );
                  this.db
                    .prepare(
                      "UPDATE agent_schedule SET status = 'failed' WHERE id = ? AND status = 'running'",
                    )
                    .run(row.id);
                  continue;
                }
                const event = {
                  ...base,
                  taskContext: parsedContext,
                  correlationId: row.correlation_id ?? base.correlationId,
                  scheduleId: row.id,
                } as ScheduledBrowserTaskEvent;
                await this.eventBus.put(event);
                logger.info(
                  { scheduleId: row.id, taskType: row.task_type },
                  "Scheduled browser-task dispatched",
                );
                continue;
              }

              // BACKGROUND_TASK_RUNNER_DESIGN.md §4.2 — generic background
              // task firing at its scheduled time. Body lives in
              // `task_context` (frozen at schedule time); the dispatcher's
              // `scheduled.background_task` handler creates the row at fire
              // time and hands off to the runner. No quiet-hours deferral
              // on dispatch — the worker may run at any hour; the DELIVERY
              // boundary quiet-hours-gates the owner-facing DM (§10.6).
              if (row.task_type === "background_task") {
                const base = createEvent({
                  type: "scheduled.background_task",
                  source: row.task_type,
                  priority: EventPriority.NORMAL,
                });
                let parsedContext: Record<string, unknown>;
                try {
                  parsedContext = JSON.parse(row.task_context ?? "{}");
                } catch (parseErr) {
                  logger.error(
                    { err: parseErr, scheduleId: row.id },
                    "scheduled.background_task: task_context JSON parse failed — marking row failed",
                  );
                  this.db
                    .prepare(
                      "UPDATE agent_schedule SET status = 'failed' WHERE id = ? AND status = 'running'",
                    )
                    .run(row.id);
                  continue;
                }
                const event = {
                  ...base,
                  taskContext: parsedContext,
                  correlationId: row.correlation_id ?? base.correlationId,
                  scheduleId: row.id,
                } as ScheduledBackgroundTaskEvent;
                await this.eventBus.put(event);
                logger.info(
                  { scheduleId: row.id, taskType: row.task_type },
                  "Scheduled background-task dispatched",
                );
                continue;
              }

              const parsedTaskContext = JSON.parse(row.task_context ?? "{}") as Record<
                string,
                unknown
              >;

              // QUIET_HOURS_HARDENING_PLAN.md §6 — per-row opt-in quiet-hours
              // deferral for user-Agent firings. The Agent loader copies the
              // definition's `schedule.defer_in_quiet_hours: true` into the
              // recurring row's task_context and `generateNextScheduleRow`
              // spreads it into every materialised row, so the check is
              // row-local (no `agents` join). The whole RUN moves past the
              // quiet window (fresh data at delivery time, no wasted 03:00
              // session), mirroring the browser_task deferral above. Built-ins
              // fire outside `recurring_schedules` and never carry the flag;
              // manual run-now rows omit it too (an explicit "run now" click
              // must fire immediately).
              if (
                row.task_type === "agent.task" &&
                parsedTaskContext.defer_in_quiet_hours === true &&
                this.deferClaimedRowForQuietHours(
                  row,
                  "agent.task.deferred_for_quiet_hours",
                  typeof parsedTaskContext.agent_id === "string"
                    ? parsedTaskContext.agent_id
                    : null,
                )
              ) {
                continue;
              }

              const base = createEvent({
                type: "scheduled.task",
                source: row.task_type,
                priority: EventPriority.NORMAL,
              });
              // WIKI_BUILDER_DESIGN.md §3.4-bis — bang-spawned approval rows
              // (today: wiki.compile via `!compile full` above threshold;
              // generalisable to any future bang→approval path) carry a
              // `replyTarget` tuple in their `taskContext`. Lift it onto the
              // event's `data.reply_target` so the ResultProcessor can route
              // the completion DM back to the originating channel rather
              // than the user's proactive destinations. Cron-only schedule
              // rows (recurring/wake/repository_run/...) omit `replyTarget`
              // and the field stays absent.
              const liftedReplyTarget =
                parsedTaskContext && typeof parsedTaskContext.replyTarget === "object"
                  ? parsedTaskContext.replyTarget
                  : undefined;
              const event = {
                ...base,
                // task_prompt is the agent body. Every insert site sets it
                // (and a backfill migration filled legacy rows), so the old
                // `?? task_description` fallback is gone; `?? ""` is only a
                // null-type guard that never fires in practice.
                task: row.task_prompt ?? "",
                taskContext: parsedTaskContext,
                correlationId: row.correlation_id ?? base.correlationId,
                scheduleId: row.id,
                ...(liftedReplyTarget
                  ? { data: { ...base.data, reply_target: liftedReplyTarget } }
                  : {}),
                // Tier override takes precedence over the legacy model
                // field at dispatch (the dispatcher inspects
                // requestedTier ahead of requestedModel). The schema
                // CHECK already constrains the column to lite/medium/high.
                ...(isProcessTier(row.tier_override)
                  ? { requestedTier: row.tier_override }
                  : {}),
                // `agent_schedule.model` is operator-supplied. See the
                // scheduled.dm branch above (SCHEDULE_API_REDESIGN_PLAN
                // §4.3a) for the four resolution branches. Same shape — a
                // registered full model id pairs with `backend_id`; a
                // standalone `backend_id` (no model) emits `requestedBackendId`
                // alone (resolveBinding fills the model from tier / default);
                // a model with no backend_id falls through to defaults.
                ...(row.model === "sonnet" || row.model === "opus"
                  ? { requestedModel: row.model as "sonnet" | "opus" }
                  : row.model && row.backend_id && isBackendId(row.backend_id)
                  ? { requestedBackendId: row.backend_id, requestedModelId: row.model }
                  : row.backend_id && isBackendId(row.backend_id)
                  ? { requestedBackendId: row.backend_id }
                  : {}),
              } as AgentTaskEvent;

              await this.eventBus.put(event);
              logger.info(
                { taskId: row.id, taskType: row.task_type },
                "Scheduled task dispatched",
              );
            } catch (rowErr) {
              // Without this catch the row stays 'running' forever (claim
              // already committed) and the watcher silently never retries.
              logger.error(
                { err: rowErr, taskId: row.id, taskType: row.task_type },
                "Scheduled row dispatch failed — marking failed",
              );
              try {
                this.db
                  .prepare(
                    "UPDATE agent_schedule SET status = 'failed' WHERE id = ? AND status = 'running'",
                  )
                  .run(row.id);
              } catch (markErr) {
                logger.error(
                  { err: markErr, taskId: row.id },
                  "Failed to mark scheduled row as failed",
                );
              }
            }
          }
          // Health check: warn once when no pending or running tasks exist
          const activeCount = this.db
            .prepare("SELECT COUNT(*) as cnt FROM agent_schedule WHERE status IN ('pending', 'running')")
            .get() as { cnt: number };

          if (activeCount.cnt === 0 && !this.noFutureTasksWarned) {
            this.noFutureTasksWarned = true;
            logger.warn("No pending tasks in schedule — next execution relies on cron routines");
          } else if (activeCount.cnt > 0) {
            this.noFutureTasksWarned = false;
          }
        } catch (err) {
          logger.error({ err }, "ScheduleWatcher error");
        }

        // Wait before next poll. Aborts immediately on stop() so SIGTERM
        // doesn't have to wait up to schedulePollIntervalSeconds.
        await this.sleepInterruptible(
          this.config.schedulePollIntervalSeconds * 1000,
        );
      }
    };

    void loop();
  }

  /**
   * Quiet-hours deferral for a claimed `agent_schedule` row (shared by the
   * `browser_task` always-on-by-config path and the `agent.task` per-row
   * opt-in, QUIET_HOURS_HARDENING_PLAN.md §6). When the current wall-clock
   * instant falls inside the configured quiet-hours window, the row is pushed
   * forward to the next quiet-hours-end boundary (status reverted to
   * `pending` so the next ScheduleWatcher tick re-evaluates), one
   * `agent_actions` audit row is written per deferral so the user can see the
   * delay, and `true` is returned. Returns `false` when outside the window —
   * or when `nextQuietHoursEndMs` cannot resolve a boundary, which inside a
   * quiet-hours predicate that just returned true would mean a 24-hour
   * window; the runtime-settings schema disallows this (equal start/end
   * short-circuits the predicate), so it cannot occur in normal operation.
   * Falling through to dispatch beats re-deferring forever.
   *
   * `agentId` (the owning user Agent's slug from `task_context.agent_id`)
   * stamps the audit row's `agent_id` column so the deferral is attributable
   * per Agent; the browser_task path has no owning Agent and passes none.
   */
  private deferClaimedRowForQuietHours(
    row: ScheduleRow,
    actionType: string,
    agentId: string | null = null,
  ): boolean {
    const fireAt = new Date();
    const quietHoursWindow = {
      start: this.config.quietHoursStart,
      end: this.config.quietHoursEnd,
      timezone: this.config.timezone || undefined,
    };
    if (!isInQuietHoursAt(fireAt, quietHoursWindow)) return false;
    const deferUntilMs = nextQuietHoursEndMs(fireAt, quietHoursWindow);
    if (deferUntilMs === null) return false;

    const deferredFor = formatSqliteDatetime(new Date(deferUntilMs));
    // `quiet_hours_deferred` marks the row as ACTUALLY deferred (vs merely
    // carrying the `defer_in_quiet_hours` opt-in on a future cron slot) so a
    // quiet-hours config change can retime exactly these rows
    // (`retimeDeferredRunRows` in db/deferred-dm.ts, the sibling of the
    // Phase-1 deferred-DM retime). Invalid task_context JSON is left
    // untouched — stamping must never destroy a browser_task's frozen body.
    this.db
      .prepare(
        `UPDATE agent_schedule
            SET scheduled_for = ?, status = 'pending',
                task_context = CASE
                  WHEN task_context IS NULL
                    THEN json_object('quiet_hours_deferred', json('true'))
                  WHEN json_valid(task_context)
                    THEN json_set(task_context, '$.quiet_hours_deferred', json('true'))
                  ELSE task_context
                END
          WHERE id = ?`,
      )
      .run(deferredFor, row.id);
    try {
      this.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, detail, result, agent_id, started_at, completed_at)
           VALUES (?, ?, 'success', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run(
          actionType,
          JSON.stringify({
            scheduleId: row.id,
            originalScheduledFor: row.scheduled_for,
            deferredUntil: deferredFor,
            quietHoursStart: this.config.quietHoursStart,
            quietHoursEnd: this.config.quietHoursEnd,
          }),
          agentId,
        );
    } catch (auditErr) {
      /* c8 ignore start -- defensive against schema partials */
      logger.warn(
        { err: auditErr, scheduleId: row.id, actionType },
        "Failed to record quiet-hours deferral audit",
      );
      /* c8 ignore stop */
    }
    logger.info(
      {
        scheduleId: row.id,
        taskType: row.task_type,
        deferredUntil: deferredFor,
        quietHoursStart: this.config.quietHoursStart,
        quietHoursEnd: this.config.quietHoursEnd,
      },
      "Scheduled row deferred for quiet hours",
    );
    return true;
  }

  /**
   * Sleep for `ms` milliseconds, but resolve early when `stop()` or
   * `nudgeWatcher()` fire. Used by the ScheduleWatcher between polls so
   * shutdown / "wake now" signals interrupt the wait.
   *
   * Resolution order (single linear sequence — no branch fan-out):
   *   1. `shutdown` → immediate resolve.
   *   2. `nudgeSeq > observedSeq` → consume + immediate resolve. Covers
   *      every nudge that arrived while no sleep was active (before the
   *      first sleep ever ran, or between two consecutive sleeps).
   *   3. otherwise install a `sleepWaiter` with a setTimeout and wait;
   *      the resolver is invoked either by the timer or by a subsequent
   *      `stop()` / `nudgeWatcher()` via `consumeWaiter()`.
   *
   * Invariant: `observedSeq` only advances on consumption, so a `nudgeSeq`
   * bump that arrives during the active sleep is observed by the caller
   * (`nudgeWatcher`) which advances `observedSeq` AND resolves the waiter
   * in the same synchronous block. A bump that arrives between sleeps is
   * still visible (`nudgeSeq > observedSeq`) on the next entry and gets
   * consumed there. The counter therefore cannot lose a nudge across the
   * sleep boundary that the previous AbortController scheme had to guard
   * against with a separate `hasPendingNudge` flag.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    if (this.shutdown) return Promise.resolve();
    if (this.nudgeSeq > this.observedSeq) {
      this.observedSeq = this.nudgeSeq;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Natural timer expiry. Clear the waiter ONLY if it still points
        // at this resolver — defensive against a `nudgeWatcher()` /
        // `stop()` that interleaved between `setTimeout` firing and this
        // callback running (the race window is microscopic but real).
        if (this.sleepWaiter?.resolve === resolve) {
          this.sleepWaiter = null;
        }
        resolve();
      }, ms);
      this.sleepWaiter = { resolve, timer };
    });
  }

  /**
   * Handle a direct DM task: send the message directly via the registered
   * callback, bypassing the agent pipeline entirely. This is zero-cost
   * compared to running an AI agent for a pre-composed message.
   *
   * Quiet hours and rate limits are intentionally skipped — the user
   * explicitly scheduled this DM, so it should fire at the requested time.
   */
  private async handleDirectDm(row: ScheduleRow): Promise<void> {
    try {
      if (!this.sendDm) {
        logger.warn({ taskId: row.id }, "sendDm callback not registered, cannot send direct DM");
        this.db
          .prepare("UPDATE agent_schedule SET status = 'failed' WHERE id = ?")
          .run(row.id);
        return;
      }

      const ctx = JSON.parse(row.task_context ?? "{}");
      const delivery = await this.sendDm(
        row.task_description,
        Array.isArray(ctx.platforms)
          ? ctx.platforms
          : typeof ctx.platform === "string"
            ? [ctx.platform]
            : undefined,
      );

      const dispatchId = randomUUID();
      const summary = (row.task_description ?? "").slice(0, 200);
      const insert = this.db.prepare(
        `INSERT INTO notification_log (
           dispatch_id,
           notification_type,
           priority,
           platform,
           delivery_channel,
           delivery_message_id,
           content_summary,
           status,
           created_at,
           delivered_at
         )
         VALUES (?, 'scheduled_dm', 'normal', ?, ?, ?, ?, 'delivered', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      for (const item of delivery) {
        insert.run(
          dispatchId,
          item.platform,
          item.channel,
          item.messageId ?? null,
          summary,
        );
      }

      // DM-HISTORY-CONTINUITY-FIX H-1 — also record the dispatch into
      // `messages` via the shared channel-timeline path. `notification_log`
      // remains the source of truth for delivery telemetry / retry dedup;
      // `messages` is the source of truth for conversational continuity
      // (consumed by `<conversation_history>` and the cross-session bridge
      // when the owner replies). Wrapped in its own try/catch so a
      // messages-write failure cannot mask an otherwise-successful DM:
      // the user already received the message, we only lose history
      // continuity for this single turn.
      try {
        recordProactiveForwardDeliveries({
          db: this.db,
          config: this.config,
          deliveries: delivery,
          content: row.task_description ?? "",
          dispatchId,
          dispatchIds: [dispatchId],
          originSessionIds: [],
          notificationType: "scheduled_dm",
        });
      } catch (recErr) {
        logger.warn(
          { err: recErr, taskId: row.id, dispatchId },
          "Failed to record scheduled DM into messages — delivery already succeeded",
        );
      }

      this.db
        .prepare("UPDATE agent_schedule SET status = 'completed' WHERE id = ?")
        .run(row.id);
      logger.info({ taskId: row.id }, "Direct DM sent");
    } catch (err) {
      this.db
        .prepare("UPDATE agent_schedule SET status = 'failed' WHERE id = ?")
        .run(row.id);
      logger.error(
        { err, taskId: row.id },
        "Failed to send direct DM",
      );
    }
  }

  /** Daily cleanup: expire sessions, run retention */
  private dailyCleanup(): void {
    try {
      const agentDayStartUtc = getAgentDayBoundsUtc(
        this.config.timezone || undefined,
        this.config.dayBoundaryHour,
      ).start;
      const discarded = discardStalePendingSchedules(
        this.db,
        agentDayStartUtc,
      );
      if (discarded > 0) {
        logger.info({ discarded }, "Discarded previous-agent-day pending schedules");
      }

      // Idle-expire long-silent sessions.
      //
      // Scope matrix:
      //   - THREAD            (is_dm=0, Slack/Discord channel mentions) →
      //                       channel safety timeout
      //   - DASHBOARD_CHAT    (is_dm=1, scope='dashboard_chat')         →
      //                       dashboard safety timeout (workdir preserved
      //                       so the expired row remains resumable from the
      //                       sidebar until retention prunes it)
      //   - OWNER_DM          (is_dm=1, scope='owner_dm', messaging apps) →
      //                       NOT idle-expired here. Messaging DMs persist
      //                       all day and are ended at the 4 AM day-boundary
      //                       summarization callback.
      //
      // We use a single `max(channel, dashboard)` safety window because the
      // per-session expiry already happens in `getOrCreateDm` /
      // `getOrCreateThread` on the next inbound event; this path only
      // catches sessions that never see another event before retention
      // deletes their row.
      const idleSafetyTimeout = Math.max(
        this.config.sessionTimeoutChannelMinutes,
        this.config.sessionTimeoutDashboardMinutes,
      );
      const expiredRows = this.db
        .prepare(
          `SELECT id, scope FROM conversation_sessions
           WHERE status = 'active'
             AND (
               is_dm = 0
               OR (is_dm = 1 AND scope = 'dashboard_chat')
             )
             AND last_message_at < datetime('now', '-' || ? || ' minutes')`,
        )
        .all(idleSafetyTimeout) as { id: number; scope: string }[];

      if (expiredRows.length > 0) {
        this.db
          .prepare(
            `UPDATE conversation_sessions SET status = 'expired'
             WHERE status = 'active'
               AND (
                 is_dm = 0
                 OR (is_dm = 1 AND scope = 'dashboard_chat')
               )
               AND last_message_at < datetime('now', '-' || ? || ' minutes')`,
          )
          .run(idleSafetyTimeout);

        // Clean up workdirs for expired sessions — but preserve dashboard
        // workdirs so the row stays resumable from the dashboard sidebar.
        // The preservation logic mirrors `SessionManager.shouldPreserveResumeState`.
        for (const row of expiredRows) {
          if (row.scope === "dashboard_chat") continue;
          cleanupSessionWorkdir(
            getSessionWorkdirPath(this.config.dataDir, row.id),
          );
        }
      }

      // Run data retention cleanup
      const result = runRetentionCleanup(this.db, this.config);

      // Clean up orphaned session workdirs left behind by daemon crashes or
      // retention deletes. Inactive conversation rows may remain resumable
      // from dashboard history until retention prunes them, so only remove
      // dirs whose DB row no longer exists at all.
      const existingRows = this.db
        .prepare("SELECT id FROM conversation_sessions")
        .all() as { id: number }[];
      const existingIds = new Set(existingRows.map((r) => r.id));
      cleanupStaleWorkdirs(this.config.dataDir, existingIds);

      logger.info(result, "Daily cleanup completed");
    } catch (err) {
      logger.error({ err }, "Daily cleanup failed");
    }
  }
}

// ── P22 — skill curation cron helpers ───────────────────────────────────

function readSkillCurationCadence(db: import("better-sqlite3").Database): "daily" | "weekly" | "monthly" {
  // Tolerate test DBs that don't apply the full schema. The scheduler is
  // re-instantiated across many small test setups; missing table → default.
  try {
    const row = db
      .prepare(`SELECT value_json FROM runtime_state WHERE key = 'skill_curation.config'`)
      .get() as { value_json: string } | undefined;
    if (!row) return "weekly";
    const v = JSON.parse(row.value_json) as { cadence?: "daily" | "weekly" | "monthly" };
    return v.cadence ?? "weekly";
  } catch {
    return "weekly";
  }
}

function isSkillCurationEnabled(db: import("better-sqlite3").Database): boolean {
  try {
    const row = db
      .prepare(`SELECT value_json FROM runtime_state WHERE key = 'skill_curation.config'`)
      .get() as { value_json: string } | undefined;
    if (!row) return false;
    const v = JSON.parse(row.value_json) as { enabled?: boolean };
    return v.enabled === true;
  } catch {
    return false;
  }
}

/** P22 §6.3 — interval since the most recent run's `started_at`, used by
 *  the daily 03:00 cron to gate auto-fires. Manual runs land in the same
 *  table with `is_manual=1` and naturally push this forward, satisfying
 *  the contract "manual click resets the cadence timer". */
function cadenceIntervalMs(cadence: "daily" | "weekly" | "monthly"): number {
  switch (cadence) {
    case "daily":   return 24 * 60 * 60 * 1000;
    case "weekly":  return 7 * 24 * 60 * 60 * 1000;
    case "monthly": return 30 * 24 * 60 * 60 * 1000;
  }
}

function isCadenceIntervalElapsed(
  db: import("better-sqlite3").Database,
  cadence: "daily" | "weekly" | "monthly",
): boolean {
  try {
    const row = db
      .prepare(`SELECT MAX(started_at) AS last FROM skill_curation_runs`)
      .get() as { last: number | null };
    if (row.last === null) return true; // never run before
    // Tolerance: cron fires at 03:00 every day; a daily cadence run started
    // at 03:00:01 yesterday should be eligible at 03:00:00 today. Without a
    // tolerance the second run would slip a day on every cycle.
    const tolerance = 5 * 60 * 1000; // 5 minutes
    return Date.now() - row.last >= cadenceIntervalMs(cadence) - tolerance;
  } catch {
    // Missing table (test bootstrap that skipped the schema apply) → run.
    return true;
  }
}
