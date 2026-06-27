---
schema_version: 1
slug: features/operations/schedule-approaching
title: Schedule Approaching
id: schedule-approaching
aliases:
  - schedule reminders
  - approaching event
category: features
summary: |
  Lightweight pre-event nudges fire ~15 minutes before each calendar
  event. The lead time is fixed in code today (no config key). Works
  in direct, delegated, and native integration modes; only disabled
  mode suppresses reminders.
section: operations
tags:
  - operations
  - calendar
  - notifications
  - scheduler
  - observations
status: stable
ask_examples:
  - How does the agent remind me about meetings?
  - What is the pre-event reminder lead time?
  - Why didn't I get a reminder before my meeting?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - schedule approaching
  - pre-event reminder
  - imminent event
  - meeting reminder
  - lead time
process_keys:
  - schedule.approaching
related:
  - features/integrations/calendar
  - features/operations/notifications
  - concepts/observations
---

# Schedule Approaching

## In One Sentence

Pre-event reminders fire 15 minutes before each calendar event.

## What It Does

- Watches upcoming calendar events and fires a notification ~15
  minutes before each one. The lead time is fixed in
  `imminent-event-scheduler.ts` (not a config key today).
- Emits one `schedule.approaching` event per item via the EventBus
  when the event is `≤ 15 minutes` away. The event is handled at the
  `medium` tier.
- Deduplicates via the `imminent_event_notifications` table, keyed on
  the provider's stable event id, so the same event never fires twice
  across reschedules, restarts, or repeated poll cycles. Rows are
  pruned after 24 hours.

## How It Is Triggered

The scheduler ticks every 60 seconds and reads two sources for events
in the `[now, now + 15min]` window, depending on the calendar
integration mode:

- **`direct` and `delegated` modes** — events come from the
  `integration_snapshots` table (written by the calendar poller in
  direct mode and the delegated-sync worker in delegated mode).
- **`native` mode** — the daemon does not poll, so it reads
  `observations` rows instead. These are posted by the agent's
  native-mode `routine.fetch_window` pre-pass. Because that pre-pass
  refreshes on the activity-scan tick (~60-minute cadence), events
  scheduled with less than ~60 minutes of lead time may miss their
  reminder. Direct mode (5-minute poll) does not have this limit.

Cross-source dedup is automatic: snapshot and observation rows for the
same event share the provider's event id, so they collapse into one
`imminent_event_notifications` entry.

## Where in the Dashboard

Reminders surface on the connected messaging app and in the Activity
feed. There is no dashboard setting for the lead time today.

## When Something Goes Wrong

If a reminder you expected never arrived:

- Confirm the calendar integration is reading the right calendar —
  some operators connect several.
- Check the integration mode. Reminders fire in `direct`, `delegated`,
  and `native` modes; only `disabled` mode suppresses them entirely.
- In `native` mode, short-notice events (< ~60 min lead time) can be
  missed because observations refresh on the activity-scan cadence.

## Related

- [Calendar](../integrations/calendar.md)
- [Notifications](notifications.md)
- [Observations](../../concepts/observations.md)
