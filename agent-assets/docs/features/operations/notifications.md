---
schema_version: 1
slug: features/operations/notifications
title: Notifications
id: notifications
aliases:
  - notify
  - notification
  - alerts
category: features
summary: |
  Notifications are the agent's outbound DMs to the operator. They
  fire from routines, observations, and approvals. Quiet hours and
  rate limits gate the flow.
section: operations
tags:
  - core
  - notifications
  - operations
status: stable
ask_examples:
  - When does the agent send me a notification?
  - How do I limit how often it notifies me?
locale: en-US
created: 2026-04-25
updated: 2026-06-10
keywords:
  - notification
  - notify
  - quiet hours
  - rate limit
  - notification batch
  - safety category
related:
  - features/operations/quiet-hours
  - features/operations/approvals
  - features/messaging/overview
ui_anchors:
  - /activity?tab=notifications
  - /connections/messaging
config_keys:
  - maxNotificationsPerHour
  - maxNotificationsPerDay
  - batchIntervalMinutes
  - primaryPlatform
  - defaultNotificationPlatforms
  - quietHoursStart
  - quietHoursEnd
api_endpoints:
  - POST /api/notify
---

# Notifications

## In One Sentence

Outbound DMs the agent sends through the paired messaging app, gated
by quiet hours and rate limits.

## What It Does

- Routines, observations, and approvals enqueue notifications.
- Quiet hours hold notifications until the window ends.
- Per-hour and per-day rate limits cap the volume.
- Batching folds multiple small alerts of the same event type into a
  single message.

## How a Notification Flows

1. A routine, observation, or approval enqueues a notification.
2. Quiet hours and rate limits decide whether it is suppressed.
3. If it survives, batching may hold it briefly to merge with siblings
   of the same event type; otherwise it is delivered immediately.
4. It is sent to the operator over `primaryPlatform` (or, when set, the
   exact channels in `defaultNotificationPlatforms`).

Explicit agent notifications (`POST /api/notify`) ride the same gates
with one difference: inside quiet hours they are **deferred, not
dropped** — the full message is queued as a scheduled DM that fires
when the window ends (visible under Schedule), and repeat sends from
the same agent overnight coalesce into one combined DM. Outside quiet
hours the per-hour / per-day caps apply; a capped call is rejected
(`rate_limited`) rather than silently queued, so the agent can adapt.

### Safety categories always get through

Notifications tagged `security`, `deadline`, `error`, or `critical`
**bypass quiet hours, rate limits, and batching** — they are delivered
immediately on at least one paired channel. So even during a quiet-hours
window or after the hourly cap is spent, a genuine alert still reaches
you. Replies to a direct message you sent also bypass these gates.

## Configuration

`PATCH /api/config` keys (defaults shown):

| Setting | Default | What it controls |
|---|---|---|
| `maxNotificationsPerHour` | 3 | Per-hour cap on non-safety notifications. |
| `maxNotificationsPerDay` | 12 | Per-day cap on non-safety notifications. |
| `batchIntervalMinutes` | 15 | Window for folding same-type alerts into one message. |
| `quietHoursStart` | `"22:00"` | Start of the hold window (local time). |
| `quietHoursEnd` | `"08:00"` | End of the hold window (local time). |
| `primaryPlatform` | `"slack"` | Default channel notifications are delivered to. |
| `defaultNotificationPlatforms` | `[]` (empty) | When non-empty, deliver only to these exact channels instead of the default fan-out. |

The agent can also emit a one-off notification via `POST /api/notify`
(a module capability, not directly agent-forgeable).

## When Something Goes Wrong

- **A notification you expected never arrived:** check the rate-limit
  counters (`maxNotificationsPerHour` / `maxNotificationsPerDay`) and the
  quiet-hours window — a non-safety alert can be suppressed by either.
  Explicit `/api/notify` messages caught by quiet hours are not lost —
  look for a pending scheduled DM under Schedule.
  Safety-category alerts (`error`/`critical`/`security`/`deadline`) are
  never suppressed, so a missing one points at delivery/pairing instead.
- **Too many notifications:** lower the per-hour / per-day caps or widen
  the batch window so more small alerts collapse into one message.

## Related

- [Quiet Hours](quiet-hours.md)
- [Approvals](approvals.md)
- [Messaging Overview](../messaging/overview.md)
