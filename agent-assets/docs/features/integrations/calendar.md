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
  The Connections → Calendar page also picks the backend that handles
  observed calendar changes (the Calendar Event Model card, binding
  calendar.change) — that picker only applies when the integration runs
  in direct mode.
section: integrations
tags:
  - integrations
  - calendar
  - core
  - observations
  - polling
status: stable
ask_examples:
  - How do I connect my Google Calendar?
  - Why doesn't my calendar event show up in today's schedule?
  - Can the agent create calendar events?
  - What is the Calendar Event Model setting on the Connections page?
  - Why is the Calendar Event Model card missing when my calendar is delegated?
  - Will Aitne notice calendar changes while my calendar is delegated?
  - Which model handles detected calendar changes?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
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
  - features/operations/schedule-approaching
  - concepts/delegated-mode
  - concepts/process-keys
  - concepts/observations
ui_anchors:
  - /connections/calendar
api_endpoints:
  - /api/calendar/calendars
  - /api/calendar/events
  - /api/calendar/freebusy
config_keys:
  - calendarPollIntervalSeconds
process_keys:
  - calendar.change
  - schedule.approaching
---

# Calendar

Aitne pulls events from one or more calendars (Google Calendar,
Outlook Calendar, and Apple Calendar) so it can build today's plan
around them and DM you ahead of meetings that matter.

## What It Does

- **Polls** Google Calendar on `calendarPollIntervalSeconds`; Outlook
  and Apple calendars are read on demand rather than polled.
- **Records observations** when events change (add / move / remove),
  consumed by the activity scan.
- **Surfaces today's events** to the morning routine so they land in
  `state/today.md` and the day's schedule file.
- **Reads** events on demand for reactive turns ("am I free at 3?").

The agent can create, move, or delete events when the operator asks
(`POST`/`PATCH`/`DELETE /api/calendar/events`, all Autonomous-tier — no
approval prompt). It does not auto-schedule on its own; it acts only on
an explicit request.

## When It Runs / How It Is Triggered

- The poller is continuous in the background.
- The morning routine reads today's events as part of its plan.
- Reactive DMs trigger on-demand reads.

## What It Outputs

- Events written into the schedule files.
- Observations recorded for any change between polls.

## Where in the Dashboard

- **Connections → Calendar** holds OAuth, scope, and the integration
  mode; the poll interval itself is edited on Settings → Infrastructure.
- The same page hosts the **Calendar Event Model** card (see below)
  unless Google Calendar runs in delegated mode.

## Calendar Event Model

The Calendar Event Model picker chooses the backend and model that
runs when the **daemon-side poller detects a calendar change**. It binds
the `calendar.change` ProcessKey. The poller's change detection reacts
in two situations:

- An event was added, moved, or deleted between polls (recorded as a
  change observation; the activity scan picks it up).
- An event was created far in advance (long-horizon events more than 14
  days out nudge the roadmap-refresh routine so `plans/roadmap.md` can
  build a preparation timeline).

Approaching-event reminders are a separate flow: they fire on the
`schedule.approaching` ProcessKey, not `calendar.change`, and are not
configured by this card. See [Schedule Approaching](../operations/schedule-approaching.md).

Light tier (Haiku 4.5 / gpt-5.4-mini) is the default and almost always
sufficient — these flows are event classification at low cost, not
generation. The default backend is whichever you picked as your main
backend during setup; you can override per-process here if you want a
different mix.

The picker is **only meaningful when Google Calendar runs in direct
mode.** In delegated mode the daemon hands off all Google Calendar
work to the connector inside your agent's backend, so, by default:

- No approaching-event reminders fire from the daemon.
- No change observations are recorded between polls.
- The activity scan has no calendar-side observations to react to.
- Long-horizon roadmap-refresh nudges from calendar do not fire.

The agent only learns about calendar state in delegated mode when it
asks the connector itself inside a session (for example, while
running the morning routine). It is a pull-only model — the daemon
does not push. The exception is **Background Sync** (Settings → Hours
& Notifications): two opt-in cadences, off by default, poll the
calendar through the backend's connector while delegated — the
imminent cadence (next 1 h) restores the 15-minute reminders, and the
day-ahead cadence (next 24 h) restores change observations and
far-future roadmap-refresh detection.

To avoid presenting a setting that does nothing, the dashboard hides
the Calendar Event Model card whenever Google Calendar is delegated.
If you want approaching-event reminders and change observations back,
switch the integration mode to direct on the same page, or enable the
calendar Background Sync cadences.

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
- An **OAuth-expired** state reports on the Google card's connection
  status on Connections → Calendar.
- **No reminders or change observations** while in delegated mode is
  expected behavior, not a bug — switch to direct mode or enable the
  Background Sync cadences to restore the daemon-side flows. See
  "Calendar Event Model" above.

## Related

- [Morning Routine](../routines/morning-routine.md)
- [Schedule files](../memory-files/schedule.md)
- [Schedule Approaching](../operations/schedule-approaching.md)
- [Delegated Mode](../../concepts/delegated-mode.md)
- [Process Keys](../../concepts/process-keys.md)
- [Observations](../../concepts/observations.md)
