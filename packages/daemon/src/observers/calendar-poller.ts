import type Database from "better-sqlite3";
import {
  getSnapshotNormalizer,
  type IntegrationNormalizer,
  type SnapshotActorHint,
} from "@aitne/shared";
import type { Observer } from "./manager.js";
import type { CalendarService } from "../services/calendar.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import {
  CALENDAR_HORIZON_MS,
  type TriggerRoadmapRefresh,
} from "../core/roadmap-refresh-triggers.js";
import { createLogger } from "../logging.js";
import { reconcile, type ReconcileItem } from "../services/integrations/reconcile.js";
import { applyDriftEffects } from "../core/drift-effects.js";
import type { TodayWriteLockManager } from "../core/today-write-lock.js";
import { PollGuard, raceWithAbort } from "./poll-guard.js";

const logger = createLogger("calendar-poller");

/**
 * Wall-clock cap per tick. The Google Calendar `listEvents` round-trip
 * is normally <2s; the reconcile + drift-effects path is bounded by
 * `MAX_PAGES`-style invariants in the snapshot writer. A 2-minute cap
 * comfortably absorbs API slowness without letting a stuck tick block
 * the next interval — see {@link PollGuard} for the contract.
 */
const TICK_TIMEOUT_MS = 120_000;
const calendarNormalizer = getSnapshotNormalizer("google_calendar") as IntegrationNormalizer;

/**
 * CalendarPoller — polls Google Calendar for upcoming events.
 *
 * One responsibility: fetch the direct-mode Google Calendar horizon and
 * feed it into the integration drift reconcile chokepoint. Diffing,
 * observation coalescing, roadmap refreshes, and today.md refresh scheduling
 * live in `drift-effects.ts`; 15-minute `schedule.approaching` events are
 * emitted by ImminentEventScheduler from the shared snapshot table.
 *
 * The poll window must span at least `CALENDAR_HORIZON_MS` so (3) is
 * reachable; see the `timeMax` calculation in `poll()`.
 *
 * Delegates all Google Calendar API access to CalendarService (single client).
 */
export class CalendarPoller implements Observer {
  readonly name = "calendar";

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly guard = new PollGuard({
    name: "calendar-poller",
    tickTimeoutMs: TICK_TIMEOUT_MS,
  });

  constructor(
    private readonly calendarService: CalendarService,
    private readonly db: Database.Database,
    private readonly pollIntervalSeconds: number,
    private readonly calendarId: string,
    private readonly writeTracker?: AgentWriteTracker,
    /**
     * Optional roadmap-refresh trigger (ROADMAP-REDESIGN §3.4 RFC-C).
     * Fired on `created` events whose `start` is more than 14 days out and
     * whose actor is NOT `agent` (the AgentWriteTracker check above sets
     * `agent` for events the agent itself inserted into Google Calendar).
     */
    private readonly triggerRoadmapRefresh?: TriggerRoadmapRefresh,
    private readonly todayWriteLock?: TodayWriteLockManager,
    private readonly timezone?: string,
  ) {}

  async start(): Promise<void> {
    // Initial poll
    await this.tick();

    // Start periodic polling
    this.pollTimer = setInterval(
      () => void this.tick(),
      this.pollIntervalSeconds * 1000,
    );

    logger.info(
      { intervalSeconds: this.pollIntervalSeconds },
      "Calendar poller started",
    );
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.guard.abortInFlight(new Error("calendar_poller_stopped"));
    logger.info("Calendar poller stopped");
  }

  private async tick(): Promise<void> {
    try {
      await this.guard.run((signal) => this.poll(signal));
    } catch (err) {
      logger.error({ err }, "Calendar poll failed");
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const now = new Date();
    // Window must exceed CALENDAR_HORIZON_MS (14d) so newly created
    // far-future events become visible to the change-detection diff and
    // satisfy `shouldTriggerRefreshForCalendarEvent` (ROADMAP-REDESIGN
    // §3.4 RFC-C). 1 extra day of buffer covers events created right at
    // the boundary; the 15-min approaching scan is unaffected because it
    // filters with its own `minutesUntil <= 15` check below.
    const timeMax = new Date(
      now.getTime() + CALENDAR_HORIZON_MS + 24 * 60 * 60 * 1000,
    );

    // CalendarService.listEvents does not accept an AbortSignal natively
    // (the underlying googleapis client v144 ignores signal on the events
    // API). raceWithAbort bounds the wait on our side: the underlying
    // HTTP call leaks if it hangs, but PollGuard's inFlight flag can
    // reset and the next tick is unblocked.
    const events = await raceWithAbort(
      this.calendarService.listEvents(
        now.toISOString(),
        timeMax.toISOString(),
      ),
      signal,
    );
    const fetchedAt = now.toISOString();
    const items = events
      .filter((calEvent) => calEvent.id)
      .map((calEvent): ReconcileItem => {
        const payload = calendarNormalizer.payload(calEvent);
        const itemId = calendarNormalizer.itemId(calEvent);
        const actorHint = this.resolveActorHint(itemId);
        return {
          itemId,
          contentHash: calendarNormalizer.hash(payload),
          payload,
          itemStart: calendarNormalizer.itemStart(calEvent),
          ...(actorHint ? { actorHint } : {}),
        };
      });

    reconcile(
      this.db,
      {
        integration: "google_calendar",
        windowKey: "primary:14d",
        windowMin: fetchedAt,
        windowMax: timeMax.toISOString(),
        fetchedAt,
        items,
      },
      {
        normalizer: calendarNormalizer,
        resolveActorHint: (_integration, itemId) => this.resolveActorHint(itemId),
        onDiffInTransaction: (diff) => {
          applyDriftEffects(
            {
              integration: "google_calendar",
              windowKey: "primary:14d",
              windowMin: fetchedAt,
              windowMax: timeMax.toISOString(),
              fetchedAt,
              items,
            },
            diff,
            {
              db: this.db,
              calendarId: this.calendarId,
              timezone: this.timezone,
              todayWriteLock: this.todayWriteLock,
              triggerRoadmapRefresh: this.triggerRoadmapRefresh,
            },
          );
        },
      },
    );
  }

  private resolveActorHint(itemId: string): SnapshotActorHint | undefined {
    return this.writeTracker?.isMarked(`calendar:${itemId}`, null)
      ? "agent"
      : undefined;
  }
}
