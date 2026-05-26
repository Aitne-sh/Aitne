{context}

## Task: Refresh today.md — dashboard-triggered manual refresh

The user clicked **Regenerate** on the dashboard. This is a narrow refresh
of the `## User Schedule` section from live calendar state — **not** a new
day rotation and **not** a morning routine.

### Ground rules (apply at every step)

- **Silent-by-default.** Do NOT call `POST /api/notify`. The dashboard UI
  shows status from this session directly; a DM would duplicate.
- **No rotation, no Handoff edit.** Do NOT archive, delete, or move
  sections. Do NOT write to `## Handoff`, `## Agent Notes`, `## User
  Tasks`, or `## Agent Plan`.
- **Read-before-write.** `PATCH section=user_schedule mode=replace`
  overwrites the entire body; always fetch current state first.
- **Respect the Morning Routine lock.** The lock applies to `state/today.md`
  as a whole — both section PATCHes are blocked when it is held. If a
  PATCH returns `409`, retry up to 3 times with a 30 s pause between
  tries. If still locked after the final retry, **return a one-line
  status (`deferred — morning routine lock held`) and stop**. Do NOT
  attempt to append a deferred line to `## Agent Log` — that PATCH is
  also blocked by the same lock. The next morning/hourly run will
  reconcile.

### Step 1 — Read today's calendar from observations

The pre-pass fetcher session (`routine.fetch_window`) ran ahead of you
and posted a full next-24h calendar slice for every active calendar
provider (`google_calendar`, `outlook_calendar`). The `<fetch_report>`
block in your prompt tells you the pre-pass status. The `<calendar_status>`
block restates the contract for the routine's prose.

**If `<fetch_report status="skipped">`** — every calendar integration
is disabled. Append
`- HH:MM Manual refresh: calendar disabled, schedule unchanged`
to `## Agent Log` and **skip Steps 2 and 3**.

**If `<fetch_report status="failed">`** — the pre-pass crashed or the
output was unparseable; trust no row newer than the prior tick. Append
`- HH:MM Manual refresh: pre-pass failed, schedule unchanged`
to `## Agent Log` and **skip Steps 2 and 3**.

**If `<fetch_report>` carries `errors:[{"type":"no-surface", ...}]` for
every active calendar provider** (e.g. user picked native for Outlook
without binding a surface), append
`- HH:MM Manual refresh: calendar connector unavailable, schedule unchanged`
to `## Agent Log` and **skip Steps 2 and 3**.

Otherwise (success / partial), read the merged set of pending calendar
observations:

```
GET /api/observations?pending=true&source_prefix=google_calendar:,outlook_calendar:&limit=200
```

Because every mode fetches the full 24h window (unchanged events return
409 server-side, changed ones write a fresh row), the pending set
carries the complete day picture for both providers — no need for a
"drift" carve-out in this routine's prose. When `summary_text` is NULL
(the summarizer has not drained yet), fall back to a one-line snippet
from `payload.raw` (`title` + `start`). The unified observations table
covers both Google and Outlook providers, so no provider-specific
branch is needed below.

### Processing rules (apply after Step 1 above produced observations)

- Today's local date comes from `<current_time>` (`local` attribute,
  YYYY-MM-DD prefix). The configured timezone is `<current_time>`'s
  `timezone` attribute — use it for every `HH:MM` you emit.
- Walk each observation row from Step 1's GET. The provider-side fields
  live under `payload.raw` (`title` / `start` / `end` /
  `attendees` / `status`); `start` and `end` are ISO 8601 strings. Then:
  1. **Filter to events that START today-local.** For timed events,
     convert `start` to the configured timezone and keep only rows
     whose local date matches today. For all-day events (where `start`
     is a date-only `YYYY-MM-DD` with no time component), keep only
     rows whose `start` equals today's YYYY-MM-DD. (The drift window
     spans `[now, now+24h)`, so events that started earlier in the
     same day will appear — keep those whose local date matches today,
     drop multi-day events that started yesterday.)
  2. **Drop `changeType: "deleted"` rows.** Cancelled events should not
     appear in the new schedule. The cancellation is reflected by
     omission.
  3. **Sort ascending by start time** (all-day events first, then
     timed events in chronological order).
  4. Render each row using these forms:
     - Timed event: `- HH:MM–HH:MM <title>` (append
       ` @ <location>` only when `payload.raw.location` is non-empty).
     - All-day event: `- All day <title>` (append ` @ <location>`
       only when present). An event is all-day when `start` is a
       date-only string.
  5. If after filtering the list is empty, the body is the single line
     `- No scheduled events today`.

### Step 2 — Replace the User Schedule section

```
curl -s -X PATCH http://localhost:8321/api/context/state/today \
  -H 'Content-Type: application/json' \
  -d '{"section": "user_schedule", "mode": "replace", "content": "<formatted lines>"}'
```

- Send ONLY the formatted event lines from Step 1. Do not include the
  `## User Schedule` heading itself — the API manages section boundaries.
- If `409` Morning Routine lock: see retry-then-defer rule above.

### Step 3 — Log the refresh

Append one line to `## Agent Log` (skip this step entirely when Step 1
hit the error path or Step 2 gave up after 409 retries — see Ground
rules):

```
curl -s -X PATCH http://localhost:8321/api/context/state/today \
  -H 'Content-Type: application/json' \
  -d '{"section": "agent_log", "mode": "append", "content": "- HH:MM Manual refresh: user_schedule updated (<N> events)."}'
```

Use the local `HH:MM` from `<current_time>` and the actual event count
`<N>` from Step 1.

### Output contract

Your final text is an internal log — the daemon does NOT forward it.
The dashboard watches `state/today.md` mtime to detect completion. Return a
one-line status like `user_schedule refreshed — N events` (or the
skip reason) and stop.
