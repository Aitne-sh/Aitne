---
schema_version: 1
slug: features/operations/quiet-hours
title: Quiet Hours
id: quiet-hours
aliases:
  - do not disturb
  - dnd
  - notifications off
  - silent hours
category: features
summary: |
  A nightly silent window during which the agent suppresses
  notifications. Routines still run, but their output queues until
  morning instead of waking you.
section: operations
tags:
  - operations
  - notifications
  - core
status: stable
ask_examples:
  - How do I stop notifications at night?
  - When does the agent go silent?
  - Will routines still run during quiet hours?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - quiet hours
  - dnd
  - quietHoursStart
  - quietHoursEnd
related:
  - features/operations/notifications
  - features/operations/approvals
  - concepts/agent-day
ui_anchors:
  - /settings/schedule
config_keys:
  - quietHoursStart
  - quietHoursEnd
---

# Quiet Hours

## In One Sentence

Set a nightly window (default 22:00 → 08:00) during which the agent
batches notifications instead of pushing them to the messaging app
in real time.

## What It Does

During quiet hours:

- **Notifications** are queued, not sent. They flush at the end of the
  window or get folded into the morning routine's "good morning" message.
- **Routines** keep running. The morning routine fires at
  `dayBoundaryHour` (the same time the agent-day rolls over) — even
  if that falls inside quiet hours, the routine runs and its output
  is batched until the window ends.
- **Reactive DMs** still respond. Quiet hours only suppress
  *agent-initiated* messages.

## When It Runs / How It Is Triggered

Continuously. Every notification dispatcher checks `quietHoursStart`
and `quietHoursEnd` against the current local time before sending.
The window is allowed to wrap midnight (22:00 → 08:00 is the default
shape).

## What It Outputs

- An empty notification queue during the window.
- A consolidated "while you were away" summary at flush time when
  many notifications batched up.

## Where in the Dashboard

- **Settings → Schedule** holds `quietHoursStart` and `quietHoursEnd`.
  The form refuses windows that overlap the active hours.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `quietHoursStart` | `"22:00"` | `HH:MM` local time string. |
| `quietHoursEnd` | `"08:00"` | `HH:MM` local time string. |
| `batchIntervalMinutes` | `15` | How often the batched flush runs once awake. |

## When Something Goes Wrong

- An **important** notification that you expected to wake you
  during quiet hours: Aitne does not have a notify-anyway
  override yet (Approvals are the only thing that bypass quiet hours).
  If you need real-time night alerts for, say, a critical mail label,
  the workaround is to disable quiet hours.
- A notification that fired *after* the window ended but feels stale:
  check `batchIntervalMinutes` — if you set it long, the flush can
  lag the window end by several minutes.

## Related

- [Notifications](notifications.md) — the broader notification model.
- [Approvals](approvals.md) — the only tier that bypasses quiet hours.
