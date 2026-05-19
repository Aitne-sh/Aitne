import { createLogger } from "../logging.js";

const logger = createLogger("roadmap-refresh-triggers");

/**
 * Pure predicates for the three event-driven roadmap refresh hooks
 * (ROADMAP-REDESIGN.md §3.4):
 *
 *   - travel_bookings INSERT → refresh when start_date > now + 3d
 *   - new calendar event    → refresh when start > now + 14d
 *   - agent_schedule INSERT → handled by `schedule-insert-helper.ts`
 *
 * Each call-site (mail-ingestion, calendar-poller) owns its own INSERT /
 * recordObservation and calls `maybeTriggerRefreshFor*` after a qualifying
 * row lands. The 5-minute dedup on `Dispatcher.emitRoadmapRefresh` collapses
 * bursts such as a flight + hotel confirmation arriving in the same minute
 * into a single refresh.
 */

export type ObservationActor = "user" | "agent" | "system" | "unknown";

export interface TravelBookingTriggerInput {
  startDate: string | null;
  now?: number;
}

const TRAVEL_HORIZON_MS = 3 * 24 * 60 * 60 * 1000;

export function shouldTriggerRefreshForTravelBooking(
  input: TravelBookingTriggerInput,
): boolean {
  if (!input.startDate) return false;
  const startMs = Date.parse(input.startDate);
  if (!Number.isFinite(startMs)) return false;
  const now = input.now ?? Date.now();
  return startMs - now > TRAVEL_HORIZON_MS;
}

export interface CalendarEventTriggerInput {
  startIso: string | null;
  actor: ObservationActor;
  changeType: "created" | "modified" | "deleted";
  now?: number;
}

export const CALENDAR_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

export function shouldTriggerRefreshForCalendarEvent(
  input: CalendarEventTriggerInput,
): boolean {
  if (input.changeType !== "created") return false;
  if (input.actor === "agent") return false;
  if (!input.startIso) return false;
  const startMs = Date.parse(input.startIso);
  if (!Number.isFinite(startMs)) return false;
  const now = input.now ?? Date.now();
  return startMs - now > CALENDAR_HORIZON_MS;
}

export type TriggerRoadmapRefresh = (source: string) => void;

export function maybeTriggerRefreshForTravelBooking(
  input: TravelBookingTriggerInput,
  trigger: TriggerRoadmapRefresh | null | undefined,
): void {
  if (!trigger) return;
  if (!shouldTriggerRefreshForTravelBooking(input)) return;
  try {
    trigger("travel_booking_detected");
  } catch (err) {
    logger.warn({ err }, "triggerRoadmapRefresh threw — continuing");
  }
}

export function maybeTriggerRefreshForCalendarEvent(
  input: CalendarEventTriggerInput,
  trigger: TriggerRoadmapRefresh | null | undefined,
): void {
  if (!trigger) return;
  if (!shouldTriggerRefreshForCalendarEvent(input)) return;
  try {
    trigger("calendar_event_detected");
  } catch (err) {
    logger.warn({ err }, "triggerRoadmapRefresh threw — continuing");
  }
}
