---
kind: reference
name: recurrence-rule
description: recurrenceRule grammar — hourly / daily / weekly / monthly. Engine accepts all four; the managed-tasks consumer specifically refuses sub-daily for app-fetch correctness (template below).
---

# recurrenceRule grammar

The daemon's recurrence engine accepts four frequencies: `hourly`,
`daily`, `weekly`, `monthly`. Each frequency requires its own set of
fields and rejects fields that don't apply — the daemon's Zod
refinements return a `schedule.frequency_field_mismatch` issue (with
the offending field path) when the shape disagrees with the chosen
frequency. Pre-validate to save a round-trip.

Times are `HH:MM` 24-hour local; `timezone` is IANA (auto-fills from
daemon config when omitted, but explicit is safer so a roaming laptop
does not surprise the user).

## Engine — per-frequency field rules

| `frequency` | Required | Allowed | Forbidden |
|---|---|---|---|
| `hourly` | — | `intervalHours` (1..23, default 1), `minuteOfHour` (0..59, default 0), `timezone` | `time`, `daysOfWeek`, `daysOfMonth`, `onMissingDay` |
| `daily` | `time` | `timezone` | `intervalHours`, `minuteOfHour`, `daysOfWeek`, `daysOfMonth`, `onMissingDay` |
| `weekly` | `time`, `daysOfWeek` | `timezone` | `intervalHours`, `minuteOfHour`, `daysOfMonth`, `onMissingDay` |
| `monthly` | `time`, `daysOfMonth` | `timezone`, `onMissingDay` (default `lastDayOfMonth`) | `intervalHours`, `minuteOfHour`, `daysOfWeek` |

- `daysOfWeek` is `0=Sun..6=Sat`; 1..7 distinct entries, dupes rejected.
- `daysOfMonth` is `1..31`; 1..31 distinct entries, dupes rejected.
  Days 29-31 may not exist in a given month — see `onMissingDay`.
- `onMissingDay`: `"skip"` (don't fire that month) or
  `"lastDayOfMonth"` (fire on the actual last day, preserving the
  pre-redesign clamp behavior). Default `"lastDayOfMonth"` for
  back-compat. The engine also de-duplicates calendar dates that
  collapse to the same fire (e.g. `[28,31]` in non-leap Feb with
  `"lastDayOfMonth"` fires Feb 28 once, not twice).
- `intervalHours=N` fires when `(localHour % N) == 0` at
  `minuteOfHour` local, anchored at midnight in the rule's
  `timezone`.

## Mapping table

| User said | `cadence` | `recurrenceRule` |
|---|---|---|
| every hour | `hourly :00 (UTC)` | `{frequency:"hourly"}` |
| every 2 hours at :30 | `hourly /2 :30 (UTC)` | `{frequency:"hourly", intervalHours:2, minuteOfHour:30}` |
| every day at 10am (Asia/Tokyo) | `daily 10:00 (Asia/Tokyo)` | `{frequency:"daily", time:"10:00", timezone:"Asia/Tokyo"}` |
| every Monday 9am | `weekly Mon 09:00` | `{frequency:"weekly", time:"09:00", timezone:<user tz>, daysOfWeek:[1]}` |
| every weekday at 8am | `weekdays 08:00` | `{frequency:"weekly", time:"08:00", timezone:<user tz>, daysOfWeek:[1,2,3,4,5]}` |
| 1st of every month at noon | `monthly day 1 12:00` | `{frequency:"monthly", time:"12:00", timezone:<user tz>, daysOfMonth:[1]}` |
| 25th of every month at 21:00 | `monthly day 25 21:00` | `{frequency:"monthly", time:"21:00", timezone:<user tz>, daysOfMonth:[25]}` |
| last day of every month at 21:00 | `monthly last 21:00` | `{frequency:"monthly", time:"21:00", timezone:<user tz>, daysOfMonth:[31], onMissingDay:"lastDayOfMonth"}` |
| every 5 minutes | _not representable_ | _refuse — sub-hour cadences are not supported_ |

## Consumer-specific refusal — managed-tasks only

The managed-tasks skill (`mt_<n>` rows) refuses sub-daily cadences
because app-fetch correctness requires a daily-or-coarser window to
amortise rate limits and to map cleanly onto the entity-mirror's
daily granularity. Schedule callers (`/api/schedule`,
`/api/recurring-schedules`) have no such constraint and may use any
of the four frequencies the engine accepts.

### managed-tasks sub-daily refusal — DM template

> Managed tasks only support daily, weekly, or monthly cadences.
> "every hour" / "every 5 minutes" is too tight for a recurring app
> fetch — pick `daily` or coarser. (If you want a daemon-internal
> hourly check, use `/api/recurring-schedules` via the `schedule`
> skill.)

Same template applies to "every 5 minutes", "every 30 minutes",
"every 2 hours", etc. when the registering surface is managed-tasks.

## Cadence string vs structured rule

Always send both `cadence` (human-readable, rendered in
`policies/management.md` §B) and `recurrenceRule` (structured, what the
scheduler executes). They must agree — if they drift, the rendered
file misleads the user about what the scheduler will actually do.

When the user modifies just the time (`"9am instead of 10am"`),
send the new `cadence` and new `recurrenceRule` together in the same
PATCH so the §B label matches the executable schedule in one
transition.
