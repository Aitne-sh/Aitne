---
schema_version: 1
slug: guides/pause-the-agent
title: Pause the Agent
id: pause-the-agent
aliases:
  - stop notifications
  - disable routines
category: guides
summary: |
  Stop the agent from acting without uninstalling it — DM !stop to pause
  every routine, or use dashboard toggles and quiet hours for finer control.
section: pause-the-agent
tags:
  - guides
  - operations
  - messaging
  - autonomous
  - scheduler
status: stable
ask_examples:
  - How do I pause the agent without uninstalling?
  - Can I disable everything for a week?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - pause agent
  - stop agent
  - "!stop"
  - "!start"
  - disable autonomous
  - go silent
related:
  - features/operations/quiet-hours
  - features/messaging/bang-commands
  - concepts/routines
ui_anchors:
  - /settings/schedule
  - /settings/routines
config_keys:
  - hourlyCheckEnabled
  - monthlyReviewEnabled
  - quietHoursStart
  - quietHoursEnd
---

# Pause the Agent

## Goal

Stop autonomous activity for a window — vacation, focus week — without
losing your install.

## Prerequisites

- Daemon running.

## The fastest pause: `!stop`

DM `!stop` to the agent on any paired messaging app. This is the
recommended way to go silent and the only one you need for most cases:

- It pauses **every** cron-driven routine — morning, evening, weekly,
  monthly, and the hourly check — not just one of them.
- Non-command DMs are declined with a paused notice (no LLM cost)
  until you resume.
- The paused state is persisted, so a daemon restart does **not**
  silently resume autonomous work.
- In-flight runs are not aborted; the pause takes effect from the next
  scheduled tick.

Resume with `!start` whenever you want the agent active again. See
[Bang Commands](../features/messaging/bang-commands.md).

## Finer-grained control from the dashboard

If you want to mute specific behaviour rather than pause everything, use
`/settings/schedule`:

1. **Disable the hourly check** — toggle `hourlyCheckEnabled` off. This
   leaves the morning, evening, weekly, and monthly routines running.
2. **Disable the monthly review** — toggle `monthlyReviewEnabled` off
   (it ships off by default).
3. **Silence notifications without pausing work** — set an extended
   quiet hours window: e.g. `quietHoursStart: "00:00"`,
   `quietHoursEnd: "23:59"`. Both fields take an `HH:MM` string.
   Routines still run; they just don't notify you.

Morning (fires at the day boundary, default 04:00), evening (18:00),
and weekly (Fri 18:00) reviews have no per-routine enable toggle in the
dashboard — to stop them, use `!stop` above. You can still edit each
routine's instructions on `/settings/routines`, but that page does not
turn them on or off.

## Last resort: stop the daemon

`aitne stop` shuts the daemon down entirely (graceful SIGTERM, then
SIGKILL after 10 seconds). Nothing runs — no routines, no messaging, no
dashboard. Use this only when you want the agent fully offline; for a
temporary pause that survives across days, prefer `!stop`. Restart with
`aitne start`.

## Verification

- The Activity feed shows no new routine fires.
- No notifications arrive.
- A DM to a paused agent is declined with a "paused" notice.

## If It Fails

- A routine still fires after `!stop`: confirm the pause registered by
  checking `!help` or the dashboard banner; re-send `!stop`.
- A toggle on `/settings/schedule` did not take effect: confirm it
  saved — the dashboard's "Save" button must be clicked.

## Related

- [Bang Commands](../features/messaging/bang-commands.md) — `!stop` /
  `!start` from any paired DM.
- [Quiet Hours](../features/operations/quiet-hours.md)
