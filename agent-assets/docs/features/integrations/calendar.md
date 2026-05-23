---
schema_version: 1
slug: features/integrations/calendar
title: Calendar
id: calendar
aliases:
  - google calendar
  - calendar integration
  - events
category: features
summary: |
  The calendar integration pulls your events into Aitne so the
  morning routine and schedule files can reason about your day.
  The Connections → Calendar page also picks the
  backend that handles approaching-event notifications and observed
  calendar changes (Calendar Event Model) — that picker only applies
  when the integration runs in direct mode.
section: integrations
tags:
  - integrations
  - calendar
  - core
status: stable
ask_examples:
  - How do I connect my Google Calendar?
  - Why doesn't my calendar event show up in today's schedule?
  - Can the agent create calendar events?
  - What is the Calendar Event Model setting on the Connections page?
  - Why is the Calendar Event Model card missing when my calendar is delegated?
  - Will Aitne notice calendar changes while my calendar is delegated?
  - Which model handles approaching-event reminders?
locale: en-US
created: 2026-04-25
updated: 2026-04-28
keywords:
  - calendar
  - google calendar
  - events
  - calendar event model
  - calendar.change
  - approaching event
  - reminder
  - change observation
  - calendar poller
  - delegated mode
  - direct mode
related:
  - features/routines/morning-routine
  - features/memory-files/schedule
  - concepts/delegated-mode
  - concepts/process-keys
  - concepts/observations
ui_anchors:
  - /connections/calendar
api_endpoints:
  - /api/calendar
config_keys:
  - calendarPollIntervalSeconds
process_keys:
  - calendar.change
---

# Calendar

## In One Sentence

Pull events from one or more calendars (Google Calendar today, more
backends planned) so Aitne can plan your day around them.

## What It Does

- **Polls** the connected calendar(s) on `calendarPollIntervalSeconds`.
- **Records observations** when events change (add / move / remove),
  consumed by the hourly check.
- **Surfaces today's events** to the morning routine so they land in
  `today.md` and the day's schedule file.
- **Reads** events on demand for reactive turns ("am I free at 3?").

The agent can create events when the operator asks (a `notify`-tier
action). It does not auto-schedule on its own.

## When It Runs / How It Is Triggered

- The poller is continuous in the background.
- The morning routine reads today's events as part of its plan.
- Reactive DMs trigger on-demand reads.

## What It Outputs

- Events written into the schedule files.
- Observations recorded for any change between polls.

## Where in the Dashboard

- **Connections → Calendar** holds OAuth, scope, and polling.
- The same page hosts the **Calendar Event Model** card (see below)
  when Google Calendar is in direct mode.

## Calendar Event Model

The Calendar Event Model picker chooses the backend and model that
runs when the agent reacts to a calendar event. It binds the
`calendar.change` ProcessKey, which fires from the calendar poller in
three situations:

- An event is about to start (the operator gets an approaching-event
  reminder).
- An event was added, moved, or deleted between polls (recorded as a
  change observation; the hourly check picks it up).
- An event was created far in advance (long-horizon events nudge the
  roadmap-refresh routine so `roadmap.md` can build a preparation
  timeline).

Light tier is the default and almost always sufficient — these flows
are classification and scheduling, not generation. The default backend
is whichever you picked as your main backend during setup; you can
override per-process here if you want a different mix.

The picker is **only meaningful when Google Calendar runs in direct
mode.** In delegated mode the daemon hands off all Google Calendar
work to the connector inside your agent's backend, so:

- No approaching-event reminders fire from the daemon.
- No change observations are recorded between polls.
- The hourly check has no calendar-side observations to react to.
- Long-horizon roadmap-refresh nudges from calendar do not fire.

The agent only learns about calendar state in delegated mode when it
asks the connector itself inside a session (for example, while
running the morning routine). It is a pull-only model — the daemon
does not push.

To avoid presenting a setting that does nothing, the dashboard hides
the Calendar Event Model card whenever Google Calendar is delegated.
If you want approaching-event reminders and change observations back,
switch the integration mode to direct on the same page.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `calendarPollIntervalSeconds` | 300 | How often to poll for changes (direct mode only). |

The Calendar Event Model is configured through its dashboard card
rather than an env-style setting; the underlying state lives in the
`process_backend_config` table for the `calendar.change` row.

## When Something Goes Wrong

- A **stale calendar** in `/schedule` after a real-world add usually
  means the poll has not yet run. Check the next-fire timestamp.
- An **OAuth-expired** state reports on the auth-health card.
- **No reminders or change observations** while in delegated mode is
  expected behavior, not a bug — switch to direct mode to restore the
  daemon-side flows. See "Calendar Event Model" above.

## Related

- [Morning Routine](../routines/morning-routine.md)
- [daily/ files](../memory-files/schedule.md)
- [Delegated Mode](../../concepts/delegated-mode.md)
- [ProcessKeys](../../concepts/process-keys.md)
- [Observations](../../concepts/observations.md)
