/**
 * Quiet-hours helpers — pure predicates shared by NotificationManager
 * (proactive DM gating) and the ScheduleWatcher (BROWSER_TASK_REDESIGN_PLAN
 * §12 Q#5 `scheduled.browser_task` deferral). Extracted so the two
 * call sites cannot drift on the overnight-window math (00:00 wraparound
 * is the only non-trivial branch) and so the runtime-settings keys
 * `quietHoursStart` / `quietHoursEnd` have a single source of truth.
 *
 * 100% covered. The notification-manager + scheduler integrations
 * remain excluded from the coverage gate as I/O-heavy; this helper is
 * the pure leg they share.
 */
import { nowInTimezone } from "@aitne/shared";

export interface QuietHoursWindow {
  /** `"HH:MM"` 24-hour. Default `"22:00"`. */
  start: string;
  /** `"HH:MM"` 24-hour. Default `"08:00"`. May be earlier than `start`
   *  in clock terms — an overnight window (`22:00` → `08:00`) is
   *  supported. */
  end: string;
  /** IANA tz identifier (e.g. `"Asia/Tokyo"`). Empty / undefined
   *  falls back to the system timezone via `nowInTimezone`. */
  timezone?: string;
}

/**
 * True when `at` falls inside the quiet-hours window.
 *
 * Same-day window (e.g. `09:00`–`17:00`) is interpreted as
 * `start <= now < end`. Overnight window (e.g. `22:00`–`08:00`) is
 * `now >= start OR now < end`. The half-open upper bound matches the
 * NotificationManager's prior shipping behavior.
 *
 * Returns `false` when `start === end` — that's the "quiet hours
 * disabled" idiom (e.g. notification-manager tests use `00:00`/`00:00`).
 */
export function isInQuietHoursAt(
  at: Date,
  window: QuietHoursWindow,
): boolean {
  const local = nowInTimezone(window.timezone || undefined, at);
  const currentMinutes = local.hours * 60 + local.minutes;
  const startMinutes = parseHhMm(window.start);
  const endMinutes = parseHhMm(window.end);
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    // Same-day range.
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range.
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Returns ms-since-epoch when the quiet-hours window that contains
 * `from` ends, or `null` when `from` is not inside quiet hours.
 *
 * Walks forward minute-by-minute (capped at 24 h) so configured
 * timezone + overnight windows stay correct without re-deriving the
 * boundary math. Cost is at most ~1440 cheap `nowInTimezone` calls;
 * the scheduler calls this at most once per row dispatch tick, and the
 * NotificationManager only calls it when scheduling a deferred batch
 * flush — neither path is hot enough to warrant a closed-form variant.
 */
export function nextQuietHoursEndMs(
  from: Date,
  window: QuietHoursWindow,
): number | null {
  if (!isInQuietHoursAt(from, window)) return null;
  const startMs = from.getTime();
  // Bounded probe: walk forward minute-by-minute until we find a
  // non-quiet moment. Upper bound (24 h) is defence-in-depth — by
  // construction `start !== end` short-circuits the predicate above
  // so the loop ALWAYS returns from the body. The while-true shape
  // (vs. a bounded for-loop) avoids a loop-exit branch the line
  // counter would otherwise flag as unreachable.
  let minutes = 1;
  while (true) {
    const probeMs = startMs + minutes * 60_000;
    if (!isInQuietHoursAt(new Date(probeMs), window)) return probeMs;
    minutes++;
    /* c8 ignore start -- impossible-tail safety net; the inner check
     * always returns first by construction. */
    if (minutes > 24 * 60) return probeMs;
    /* c8 ignore stop */
  }
}

function parseHhMm(value: string): number {
  // Defensive — the runtime-settings schema constrains the shape but a
  // hand-crafted config could land here with garbage. NaN segments
  // collapse to 0 so the predicate degrades gracefully (quiet hours
  // effectively disabled) rather than misclassifying mid-day as quiet.
  //
  // `split(":")` always returns at least one element, so `hStr` is
  // never undefined — only `mStr` is (the "HH-only" shape, e.g.
  // `"22"`). Defaulting `mStr` lets `Number.parseInt("0", 10)` return
  // 0 cleanly; bare `Number.parseInt(undefined as any, 10)` returns
  // `NaN` which the finite-check below would then reject. Both
  // branches are pinned by the peer test.
  const parts = value.split(":");
  const hStr = parts[0];
  const mStr = parts[1] ?? "0";
  const h = Number.parseInt(hStr, 10);
  const m = Number.parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}
