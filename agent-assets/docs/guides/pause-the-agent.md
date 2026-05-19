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
  Stop the agent from acting (without uninstalling it) by disabling
  routines and entering an extended quiet hours window.
section: pause-the-agent
tags:
  - guide
  - operations
  - messaging
status: stable
ask_examples:
  - How do I pause the agent without uninstalling?
  - Can I disable everything for a week?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - pause agent
  - stop agent
  - !stop
  - !start
  - disable autonomous
  - go silent
related:
  - features/operations/quiet-hours
  - features/messaging/bang-commands
  - concepts/routines
---

# Pause the Agent

## Goal

Stop autonomous activity for a window — vacation, focus week — without
losing your install.

## Prerequisites

- Daemon running.

## Steps

1. **For a short pause from your phone**: DM `!stop` to the agent on
   any paired messaging app. Autonomous work pauses immediately; the
   daemon keeps running so you can `!start` to resume. See
   [Bang Commands](../features/messaging/bang-commands.md).
2. **Disable the hourly check** from `/settings/routines` — toggle
   `hourlyCheckEnabled` off. Morning, evening, and weekly reviews
   fire at fixed times in code, so they cannot be toggled from the
   dashboard; the most reliable mute is `aitne stop`.
3. **Set an extended quiet hours window** on `/settings/schedule` —
   e.g. `quietHoursStart: "00:00"`, `quietHoursEnd: "23:59"`. Both
   fields take an `HH:MM` string. This silences notifications while
   keeping routines running.
4. **Optionally** stop the daemon entirely with `aitne stop`. This is
   the only way to fully suppress the fixed-schedule routines.

## Verification

- The Activity feed shows no new routine fires.
- No notifications arrive.

## If It Fails

- A routine that still fires: confirm the toggle saved on
  `/settings/routines`. The dashboard's "Save" button must be clicked.

## Related

- [Bang Commands](../features/messaging/bang-commands.md) — `!stop` /
  `!start` from any paired DM.
- [Quiet Hours](../features/operations/quiet-hours.md)
