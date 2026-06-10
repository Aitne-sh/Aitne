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
  A nightly silent window during which the agent holds back its own
  proactive notifications. Routines still run, reactive DMs still
  reply, and safety-category alerts still wake you.
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
updated: 2026-06-10
keywords:
  - quiet hours
  - dnd
  - quietHoursStart
  - quietHoursEnd
  - batchIntervalMinutes
  - safety category
related:
  - features/operations/notifications
  - features/operations/approvals
  - features/routines/morning-routine
  - concepts/agent-day
ui_anchors:
  - /settings/schedule
config_keys:
  - quietHoursStart
  - quietHoursEnd
  - batchIntervalMinutes
---

# Quiet Hours

## In One Sentence

Set a nightly window (default 22:00 → 08:00) during which the agent
holds back its proactive notifications instead of pushing them to your
messaging app in real time — while reactive replies and safety-category
alerts still get through.

## What It Does

Quiet hours only gate *agent-initiated* proactive notifications. During
the window:

- **A normal proactive notification is suppressed.** If nothing of the
  same event type was sent recently, the message goes straight to the
  notification path, sees that it is quiet hours, and is logged as
  `suppressed` — it is **dropped, not held**. You will not receive it
  later.
- **An explicit agent notification (`POST /api/notify`) is deferred,
  not dropped.** When an agent session calls the notify endpoint inside
  the window, the full message is queued as a scheduled DM that fires
  the moment the window ends (visible under Schedule). Repeat calls
  from the same agent overnight coalesce into one combined DM at the
  edge instead of a morning pile-up. `critical` priority bypasses the
  gate and sends immediately. If you change the quiet-hours window
  while deferred DMs are pending, they are retimed to the new window
  end (or released immediately when the new window no longer covers
  the current time).
- **A notification already in a batch queue is deferred, not dropped.**
  Aitne batches repeat notifications of the same event type within
  `batchIntervalMinutes`. When a batch is pending and quiet hours are
  active, the flush is pushed to the wall-clock moment the window ends,
  so that combined message arrives when you wake instead of being
  suppressed.
- **Reactive DMs still respond.** A direct reply to your message
  bypasses quiet hours, rate limits, and batching entirely.
- **Safety-category alerts still wake you.** Notifications tagged
  `security`, `deadline`, `error`, or `critical` (and any `critical`-
  priority event) bypass the quiet-hours gate. There is no separate
  "notify anyway" toggle — the category *is* the override.
- **Routines keep running.** The morning routine fires at
  `dayBoundaryHour` (the same time the agent-day rolls over). With the
  defaults — boundary `04`, quiet hours `22:00`→`08:00` — that 04:00 run
  lands inside quiet hours, so it runs normally but its proactive output
  is held back or suppressed like any other notification.
- **A custom Agent can opt its whole run out of the window.** A user
  Agent created with `schedule.defer_in_quiet_hours: true` (the
  "Respect quiet hours" toggle in the New Agent form) does not run
  inside the window at all — the firing itself is pushed to the moment
  quiet hours end, so a DM-producing Agent delivers fresh results right
  at the edge instead of burning a 3 AM session whose message would be
  held anyway. Each deferral is recorded in the action log
  (`agent.task.deferred_for_quiet_hours`). The default is off, so a
  silent file-writing Agent deliberately scheduled overnight stays put.
  Built-in routines never defer. Scheduled browser tasks get the same
  treatment via `browserTaskRespectQuietHours` (default on). Like
  deferred DMs, already-deferred runs are retimed when you change the
  quiet-hours window — shrinking or disabling it releases them at the
  new edge instead of holding them until the old one.

## When It Runs / How It Is Triggered

Continuously. Every proactive notification checks `quietHoursStart` and
`quietHoursEnd` against the current local time (in the configured
timezone) before sending. The window may wrap midnight — the default
`22:00` → `08:00` is an overnight shape. Setting start equal to end
(e.g. `00:00` / `00:00`) disables quiet hours.

## Where in the Dashboard

**Settings → Schedule** holds `quietHoursStart` and `quietHoursEnd`,
shown as a red arc on the same 24-hour ring (dial) as the hourly-check
active window — drag the handles to adjust either band. There is **no
overlap validation** — quiet hours and the
active window are allowed to overlap, and the morning routine fires
regardless of where the bands sit.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `quietHoursStart` | `"22:00"` | `HH:MM` 24-hour local-time string. Set equal to `quietHoursEnd` to disable. |
| `quietHoursEnd` | `"08:00"` | `HH:MM` 24-hour local-time string. May be earlier than start (overnight window). |
| `batchIntervalMinutes` | `15` | How often a pending batch flushes. During quiet hours the flush is deferred to the window end. |

## When Something Goes Wrong

- **You expected an important alert to wake you but nothing came.**
  Only the safety categories (`security`, `deadline`, `error`,
  `critical`) bypass quiet hours. A regular routine-output notification
  that isn't already batched is dropped, not delayed (explicit
  `/api/notify` messages are deferred to the window end instead). If
  you need real-time night alerts for, say, a critical mail label,
  either ensure that path emits a safety-category notification or
  disable quiet hours.
- **A notification fired after the window ended but feels stale.**
  Check `batchIntervalMinutes` — a long interval means a deferred batch
  flush can lag the window end by several minutes. The deferral targets
  the exact window-end minute, then the cooldown applies on top.

## Related

- [Notifications](notifications.md) — the broader notification model.
- [Approvals](approvals.md) — the bearer-token approval tier (distinct
  from the safety-category bypass above).
- [Morning Routine](../routines/morning-routine.md) — why the 04:00 run
  lands inside the default quiet window.
