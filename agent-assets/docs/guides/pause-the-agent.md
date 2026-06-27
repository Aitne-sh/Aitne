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
updated: 2026-06-10
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
  - /settings/hours
  - /agents
config_keys:
  - activityScanEnabled
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
  monthly, and the activity scan — not just one of them.
- Non-command DMs are declined with a paused notice (no LLM cost)
  until you resume.
- The paused state is persisted, so a daemon restart does **not**
  silently resume autonomous work.
- In-flight runs are not aborted; the pause takes effect from the next
  scheduled tick.

Resume with `!start` whenever you want the agent active again. See
[Bang Commands](../features/messaging/bang-commands.md).

## Finer-grained control from the dashboard

If you want to mute specific behaviour rather than pause everything:

1. **Disable the activity scan** — open `/agents/activity-scan` and click
   **Disable**. This leaves the morning, evening, weekly, and monthly
   routines running. (The agent's enable switch replaced the legacy
   `activityScanEnabled` config key, now a deprecated fallback.)
2. **Disable the monthly review** — open `/agents/monthly-review` and
   click **Disable** (it ships disabled by default; the agent's enable
   switch replaced the legacy `monthlyReviewEnabled` config key).
3. **Silence notifications without pausing work** — on `/settings/hours`
   ("Hours & Notifications"), set an extended quiet hours window: e.g.
   `quietHoursStart: "00:00"`, `quietHoursEnd: "23:59"`. Both fields
   take an `HH:MM` string. Routines still run; they just don't notify
   you.

Morning (fires at the day boundary, default 04:00), evening (18:00),
and weekly (Fri 19:00) reviews each have a per-routine Enable/Disable
toggle on the `/agents` page — open `/agents/<slug>` (e.g.
`/agents/weekly-review`) and click Disable (a stop-warning confirmation
appears for these system agents). To halt all of them at once, use
`!stop` above instead. Each routine's instructions (its rulebook) are
edited on the same page's **Rulebook** tab
(`/agents/<slug>?tab=rulebook`).

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
- A setting on `/settings/hours` did not take effect: confirm it
  saved — the dashboard's "Save" button must be clicked.

## Related

- [Bang Commands](../features/messaging/bang-commands.md) — `!stop` /
  `!start` from any paired DM.
- [Quiet Hours](../features/operations/quiet-hours.md)
