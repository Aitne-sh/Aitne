---
schema_version: 1
slug: pages/activity
title: "Agent Log Page"
id: page-activity
aliases:
  - agent log page
  - activity page
  - log page
  - conversations page
category: pages
summary: |
  The Agent Log is the historical record of everything the agent has seen
  or done — invocations (Events), daemon output (System Logs), completed
  chat threads (Conversations), and proactive outbound messages
  (Notifications).
tags:
  - audit
  - notifications
  - operations
status: stable
ask_examples:
  - What can I do on the Agent Log page?
  - Where do I see why a routine failed?
  - Where do I read a full conversation transcript?
  - Where are the daemon's system logs?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - agent log
  - activity
  - events
  - system logs
  - conversations
  - notifications
related:
  - features/operations/activity-and-conversations
  - features/operations/notifications
  - features/operations/backend-routing
  - pages/analytics
ui_anchors:
  - /activity
  - /conversations
---

# Agent Log Page

The `/activity` page is the agent's audit trail — a permanent record you can
look back on of everything the agent has seen or done, split across four tabs.

## What you can do here

- **Events** — one row each time the agent ran (an "invocation"): what
  triggered the run, which backend served it, and whether it succeeded or
  failed. This is where you diagnose a routine that didn't do what you expected.
- **System Logs** — output from the daemon itself: startup messages, errors,
  and warnings from the Hono server.
- **Conversations** — completed chat threads from every messaging platform,
  each of which you can open as a full transcript.
- **Notifications** — messages the agent sent you on its own, without you
  asking.

## Where to go deeper

- [Activity & Conversations](../features/operations/activity-and-conversations.md)
  — the audit timeline and per-session transcripts in detail.
- [Notifications](../features/operations/notifications.md) — when and how
  the agent reaches out.
- [Backend routing](../features/operations/backend-routing.md) — how to
  read the "which backend served it" column.

## Related

- [Analytics page](analytics.md) — the aggregated view of this same data.
- [Overview page](overview.md) — the recent-events feed is a slice of Events.
