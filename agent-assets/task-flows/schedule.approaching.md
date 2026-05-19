{context}

## Calendar Event Approaching
Event: {event_data[event_title]}
Calendar event id: {event_data[calendarEventId]}
Start: {event_data[start_time]}
End: {event_data[end_time]}
Minutes until start: {event_data[minutesUntil]}

### Decision Framework

The user already knows their own calendar (notify skill § Universal
user-facing message discipline § Awareness gate). The default for an
upcoming-event signal is therefore: append to today.md and stay
silent. Notification is only warranted when the agent has new context
the user could not see by glancing at their calendar app.

1. **Default: do NOT notify.** Append a heads-up to today.md
   ## Agent Notes per the context skill ("Observer event formats →
   schedule.approaching"). If a task in <today> is affected by this
   event (blocked by, needs prep, scheduled against), note the
   dependency in the same entry.

2. **Notify ONLY if at least one positive trigger holds and its
   detection mechanism is implemented.** A trigger without a concrete
   detection path is a vacuous rule — the LLM can never honestly
   satisfy it, so it either gets ignored or gets fabricated. Each
   trigger below names its detection mechanism; unverified ones are
   scoped out.

   | Trigger | Priority | Detection mechanism |
   |---|---|---|
   | (a) reschedule arrived in the past 24 hours | `high` | See **Detection mechanism — trigger (a)** section below the table. |
   | (d) travel-time concern | `critical` | `POST /api/travel-time` with the user's last-known location + the event venue. |

   #### Detection mechanism — trigger (a) calendar reschedule

   Issue the following call from this session:

   ```
   GET /api/observations?source=calendar:&pending=false&since=<UTC_24H_AGO>&limit=100
   ```

   Then filter the response client-side to:

   - `changeType === 'modified'`
   - `ref === <calendarEventId from prompt header>`

   If any row matches, trigger (a) clears. All five wiring points
   below matter; getting any one wrong silently zeros this trigger.

   1. **`source=calendar:`** — the API does a SQL `LIKE 'source%'`
      prefix match (`packages/daemon/src/db/observations.ts:79-82`),
      so pass the literal prefix `calendar:` with NO wildcard.
      `calendar:*` is treated as a literal asterisk character and
      matches zero rows.

   2. **`pending=false`** — `routine.hourly_check` consumes
      `actor=user` observations every hour, and calendar mutations
      are tagged `actor='user'` (`calendar-poller.ts:210-212`). A
      `pending=true` query would miss any reschedule older than the
      latest hourly tick.

   3. **`since=<UTC_24H_AGO>`** — pass the timestamp 24 hours before
      the `utc=` attribute on the `<current_time>` block in your
      context, formatted as `YYYY-MM-DD HH:MM:SS` (UTC, **space
      separator, no `T`, no `Z`, no fractional seconds**). The DB
      layer compares with raw lexicographic string equality against
      `observed_at` storage (`db/observations.ts:87-90`);
      `observed_at` is SQLite `CURRENT_TIMESTAMP` which writes the
      space-separator format (`schema.ts:206`). An ISO `T`-separated
      value lexicographically *exceeds* a same-instant
      space-separated value (T 0x54 > space 0x20), so passing
      `2026-04-25T14:30:00Z` would silently exclude observations
      recorded the same calendar second. Worked example: if
      `<current_time utc="2026-04-26T14:30:00.000Z" .../>`, pass
      `since=2026-04-25 14:30:00`.

   4. **`limit=100`** (NOT the default 20) — the API sorts
      `ORDER BY observed_at ASC` (`db/observations.ts:100`), i.e.
      oldest-first. With the default `limit=20` and a busy 24h
      window (multiple calendars syncing, many recurring-event
      updates), the API returns the 20 *oldest* observations in the
      window — and the recent reschedule you're hunting for gets
      clipped off the end. 100 is the API maximum
      (`observations.ts:39` clamps higher values down). If a user's
      calendar produces more than ~100 mod observations per 24
      hours, this trigger needs a server-side `ORDER BY DESC` /
      `changeType` filter — tracked as a follow-up beyond
      agent-asset scope.

   5. **`ref === <calendarEventId>`** — the calendar poller writes
      `ref: event.id` (`calendar-poller.ts:214-215`), and the
      `Calendar event id` line at the top of this prompt is the
      exact value to match. The poller's payload also surfaces
      `summary`/`start`/`end` for sanity-checking the result.

   Triggers (b) conflict-with-another-event and (c) missing-prep are
   **out of scope** — neither has an implemented detection mechanism
   in this codebase. Do not notify on these heuristically; treat the
   event as the default-silent path.

   **Priority rationale.** `schedule.approaching` only fires inside
   the heads-up window (event starts within the next ~15 minutes by
   current daemon convention — see `calendar-poller.ts:125`'s
   `minutesUntil <= 15` gate; the precise figure is on the `Minutes
   until start:` line at the top of this prompt), so anything that
   clears the awareness gate at this point is something the user
   must act on before the event starts. `high` on (a) reaches the
   user even in quiet hours; `critical` on (d) additionally bypasses
   rate limits because missing the trip makes the event
   unattendable. This overrides the notify skill's "`high` reserved
   for 8h-delay-matters" guidance — inside the heads-up window,
   every cleared trigger is by definition same-hour-matters.

   Send via `POST /api/notify` per the notify skill at the priority
   above. If multiple triggers fire for the same event, take the
   highest. Never send more than one notification per
   `schedule.approaching` event (observer.md "Boundaries").

3. **Always** log the decision to today.md ## Agent Log per the
   context skill ("Observer event formats → schedule.approaching") —
   even when skipping — so the user can audit calendar-triggered
   decisions.
