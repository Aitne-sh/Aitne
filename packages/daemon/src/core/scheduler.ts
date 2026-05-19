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
  type ScheduledDmEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import type { EventBus } from "./event-bus.js";
import { runRetentionCleanup } from "./retention.js";
import { cleanupSessionWorkdir, cleanupStaleWorkdirs, getSessionWorkdirPath } from "./workdir.js";
import { discardStalePendingSchedules } from "./schedule-maintenance.js";
import { createLogger } from "../logging.js";
import type { MessageDelivery } from "../adapters/message-hub.js";
import { reconcileRecurringSchedules } from "../db/recurring-schedules.js";
import {
  getStalledMorningRoutineWake,
  readMorningRoutineStallThresholdMinutes,
} from "../bootstrap/schedule-helpers.js";
import { readRuntimeState, writeRuntimeState } from "../db/runtime-state.js";
import { recordProactiveForwardDeliveries } from "./channel-timeline.js";

/**
 * Runtime-state key holding the agent-day date string (`YYYY-MM-DD`) on
 * which the watchdog last sent an owner DM about the morning routine
 * being stuck. Per-day dedup: the watchdog fires at most once per
 * agent-day even if the cron tick that owns it runs every minute.
 */
const MORNING_ROUTINE_STALL_ALERT_KEY = "morning_routine.stall_alert_day";

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
 * Build the cron expression that drives the hourly check.
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
 *    `shouldFireHourlyTickAt(...)`, which anchors the cadence to
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
 * is negligible compared to the actual hourly-check work.
 */
export function buildHourlyCronExpr(
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
export function shouldFireHourlyTickAt(
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
  /** SCHEDULE_API_REDESIGN_PLAN §4.3a — captured backend pin that
   *  companions `model`. Non-NULL only when the operator pinned a
   *  registered full model id (e.g. 'claude-opus-4-7'). The dispatcher's
   *  override block guards on BOTH `requestedBackendId` AND
   *  `requestedModelId` together; without this companion, a stored
   *  full-id `model` value is silently dropped at dispatch. */
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
  private onHourlyCheck: ((source: string) => Promise<unknown>) | null = null;
  /**
   * Phase 4 auth probe hook — fired on every hourly cron tick BEFORE
   * `onHourlyCheck` so the probe gets a chance to refresh DB cache +
   * emit DMs even when the observation-threshold gate would skip the
   * hourly check itself. The AuthHealthMonitor.checkAll() method owns
   * its own kill-switch and morning-routine skip; the scheduler only
   * applies the same `autonomousGate` short-circuit that protects the
   * other cron callbacks.
   *
   * See `docs/design/09-safety-cost.md` §9.5.4 for the gate
   * ordering: morning-routine → hourly-already-running → auth probe
   * → observation-threshold. Steps 1 + 2 are handled inside
   * `triggerHourlyCheck`; step 3 is this callback; step 4 is the
   * threshold gate inside `triggerHourlyCheck`.
   */
  private onAuthProbe: (() => Promise<unknown>) | null = null;
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
   * Setup gate — returns a skip reason when autonomous work should be
   * paused (initial setup incomplete, or setup conversation active).
   * Returns null when autonomous work may proceed. Wired from EventDispatcher
   * via setAutonomousGate() so the scheduler doesn't take a hard dependency
   * on the dispatcher.
   */
  private autonomousGate: (() => null | string) = () => null;
  private lastGateBlockLoggedAt = 0;
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

  setHourlyCheckCallback(fn: (source: string) => Promise<unknown>): void {
    this.onHourlyCheck = fn;
  }

  /**
   * Register the Phase 4 auth probe callback. Called on each hourly
   * cron tick BEFORE the hourly-check observation threshold gate so
   * the probe continues to run even when the hourly check itself
   * would be skipped for lack of pending observations.
   */
  setAuthProbeCallback(fn: () => Promise<unknown>): void {
    this.onAuthProbe = fn;
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
   * Register the autonomous-work gate. Returning null allows autonomous work;
   * any non-null string is treated as a skip reason and surfaced in logs.
   */
  setAutonomousGate(fn: () => null | string): void {
    this.autonomousGate = fn;
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
   * `pending`/`running` and the hourly-check pre-routine gate silently
   * skips every subsequent autonomous tick. The user gets no morning
   * brief, no evening review, no hourly check, and no error — the
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
        + `(wake #${stalled.id}, status=${stalled.status}). Hourly check + `
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

  start(): void {
    this.setupRecurringJobs();
    this.startScheduleWatcher();
    logger.info("Scheduler started");
  }

  stop(): void {
    this.shutdown = true;
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
    // Default OFF pre-release (see runtime-settings.ts:monthlyReviewEnabled).
    // The cron is always registered, but the callback consults
    // `this.config.monthlyReviewEnabled` at fire time so a runtime PATCH
    // takes effect on the next month-end without restart — that is also
    // why this key is intentionally absent from SCHEDULE_KEYS in
    // dashboard/config.ts (no cron rebuild needed). The routine itself
    // (task-flow, context-builder branch, retention coupling) stays in
    // tree as a concept pending the Mirror+Prune redesign.
    const monthlyJob = cron.schedule(
      "0 18 * * *",
      () => {
        if (!this.config.monthlyReviewEnabled) return;
        // Check if tomorrow (in configured timezone) is the 1st
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowLocal = nowInTimezone(tz, tomorrow);
        if (tomorrowLocal.day === 1) {
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

    if (this.config.hourlyCheckEnabled) {
      const hourlyExpr = buildHourlyCronExpr(
        this.config.hourlyCheckIntervalMinutes,
        this.config.hourlyCheckActiveStartHour,
        this.config.hourlyCheckActiveEndHour,
      );
      const hourlyJob = cron.schedule(
        hourlyExpr,
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
            !shouldFireHourlyTickAt(
              local.hours,
              local.minutes,
              this.config.hourlyCheckIntervalMinutes,
              this.config.hourlyCheckActiveStartHour,
            )
          ) {
            return;
          }
          // triggerHourlyCheck has its own setup gate, but short-circuit
          // here to avoid the in-progress flag toggling for no reason.
          const gateReason = this.autonomousGate();
          if (gateReason !== null) {
            this.logGateBlock(gateReason, { cron: "hourly_check" });
            return;
          }
          // Phase 4 auth probe runs BEFORE the hourly check so that the
          // observation-threshold gate (which can skip `onHourlyCheck`
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
          // when the hourly check itself gets gated (e.g., the gate
          // skip is the *symptom* the watchdog needs to catch).
          void this.checkMorningRoutineStall(now).catch((err: unknown) => {
            logger.warn({ err }, "Morning routine stall watchdog threw");
          });
          if (this.onHourlyCheck) {
            void this.onHourlyCheck("cron");
          }
        },
        { timezone: tz },
      );
      this.cronJobs.push(hourlyJob);
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

    logger.info(
      {
        morningHour: this.config.dayBoundaryHour,
        timezone: tz ?? "system",
        hourlyCheckEnabled: this.config.hourlyCheckEnabled,
        hourlyCheckIntervalMinutes: this.config.hourlyCheckIntervalMinutes,
      },
      "Recurring cron jobs configured",
    );
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
    options?: { postCatchupRoutines?: string[]; postCatchupHourlyCheck?: boolean },
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
      postCatchupHourlyCheck: options?.postCatchupHourlyCheck ?? false,
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
          postCatchupHourlyCheck?: boolean;
        };
        const mergedRoutines = Array.from(
          new Set([
            ...(Array.isArray(existingContext.postCatchupRoutines)
              ? existingContext.postCatchupRoutines
              : []),
            ...(options?.postCatchupRoutines ?? []),
          ]),
        );
        const mergedHourlyCheck =
          existingContext.postCatchupHourlyCheck === true ||
          options?.postCatchupHourlyCheck === true;
        const mergedContext = {
          routine: "morning_routine",
          source: existingContext.source ?? source,
          postCatchupRoutines: mergedRoutines,
          postCatchupHourlyCheck: mergedHourlyCheck,
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

      this.db
        .prepare(
          `INSERT INTO agent_schedule
             (scheduled_for, task_type, task_description, task_context, correlation_id, model, status)
           VALUES (?, 'wake', ?, ?, ?, NULL, 'pending')`,
        )
        .run(
          scheduledFor,
          "Morning routine. Generate today.md and register the day schedule.",
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
                  // task_prompt overrides task_description as the agent body
                  // when set; falls back to the description otherwise.
                  task: row.task_prompt ?? row.task_description,
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
                  // `agent_schedule.model` is operator-supplied. Three
                // resolution branches (SCHEDULE_API_REDESIGN_PLAN §4.3a):
                //   1. legacy alias 'sonnet' / 'opus' → `requestedModel`
                //   2. registered model id paired with backend_id →
                //      emit BOTH `requestedBackendId` and
                //      `requestedModelId` so the dispatcher's override
                //      block (which guards on both fields together)
                //      actually fires. Without the backend companion the
                //      pin is silently dropped.
                //   3. model present but backend_id NULL (legacy rows or
                //      pure-tier rows) → fall through to no-override so
                //      the row resolves via process-key defaults.
                ...(row.model === "sonnet" || row.model === "opus"
                  ? { requestedModel: row.model as "sonnet" | "opus" }
                  : row.model && row.backend_id && isBackendId(row.backend_id)
                  ? { requestedBackendId: row.backend_id, requestedModelId: row.model }
                  : {}),
                } as ScheduledDmEvent;

                await this.eventBus.put(event);
                logger.info(
                  { taskId: row.id, taskType: row.task_type },
                  "Scheduled DM session dispatched",
                );
                continue;
              }

              const base = createEvent({
                type: "scheduled.task",
                source: row.task_type,
                priority: EventPriority.NORMAL,
              });
              const parsedTaskContext = JSON.parse(row.task_context ?? "{}") as Record<
                string,
                unknown
              >;
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
                // task_prompt overrides task_description as the agent body
                // when set; falls back to the description otherwise.
                task: row.task_prompt ?? row.task_description,
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
                // §4.3a) for the three resolution branches. Same shape —
                // a registered full model id requires the `backend_id`
                // companion or it falls through to process-key defaults.
                ...(row.model === "sonnet" || row.model === "opus"
                  ? { requestedModel: row.model as "sonnet" | "opus" }
                  : row.model && row.backend_id && isBackendId(row.backend_id)
                  ? { requestedBackendId: row.backend_id, requestedModelId: row.model }
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
