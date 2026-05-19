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
  Lightweight pre-event nudges fire when a calendar event is close
  enough to remind the operator about. The 15-minute lead time is
  fixed in code today.
section: operations
tags:
  - operations
  - calendar
  - notifications
status: stable
ask_examples:
  - How does the agent remind me about meetings?
  - What is the pre-event reminder lead time?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - schedule approaching
  - pre-event reminder
  - departure time
  - ETA reminder
related:
  - features/integrations/calendar
  - features/operations/notifications
---

# Schedule Approaching

## In One Sentence

Pre-event reminders fire 15 minutes before each calendar event.

## What It Does

- Watches the calendar event queue.
- Fires a notification ~15 minutes before each event (fixed in
  `imminent-event-scheduler.ts`; not currently a config key).
- Optionally includes the travel-time estimate when the event has
  a location and the travel-time skill is enabled.
- Deduplicates via the `imminent_event_notifications` table so the
  same event never fires twice across reschedules / poll cycles.

## When It Runs / How It Is Triggered

The scheduler keeps a sorted view of upcoming events from the
`integration_snapshots` table and emits one `schedule.approaching`
event per item via the EventBus when the event is ≤ 15 minutes away.

## Where in the Dashboard

- Reminders surface on the connected messaging app and in the
  Activity feed. There is no dashboard setting for lead time today.

## When Something Goes Wrong

- A reminder you expected: confirm the calendar integration is
  reading the right calendar (some operators have multiple), and
  that the calendar is running in `direct` mode — in `delegated` /
  `native` / `disabled` modes the daemon does not emit approaching
  reminders.

## Related

- [Calendar](../integrations/calendar.md)
