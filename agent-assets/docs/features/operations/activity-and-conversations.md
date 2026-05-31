---
schema_version: 1
slug: features/operations/activity-and-conversations
title: Activity and Conversations
id: activity-and-conversations
aliases:
  - activity feed
  - conversations
  - history
  - audit log
category: features
summary: |
  The Activity view is the audit timeline of everything the agent did;
  Conversations is the per-session message transcript. Together they
  answer "what happened" and "what was said".
section: operations
tags:
  - core
  - operations
  - audit
  - dashboard
status: stable
ask_examples:
  - Where can I see what the agent did today?
  - Where do I read the morning routine's full reply?
  - How do I find why a routine failed?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - activity
  - conversations
  - audit
  - timeline
  - sessions
related:
  - features/operations/notifications
  - features/operations/cost-tracking
  - features/operations/backend-routing
config_keys:
  - executeTimeoutMinutes
process_keys:
  - routine.morning_routine
api_endpoints:
  - POST /api/system/purge-history
ui_anchors:
  - /
  - /activity
  - /conversations
---

# Activity and Conversations

## In One Sentence

Every agent session, action, and outcome is logged to SQLite and
surfaced as the Activity timeline; the matching message-by-message
detail lives one click deeper under Conversations.

## What It Does

Activity is the unified view of:

- **Routines**: morning, evening, weekly, hourly fires.
- **Reactive sessions**: DMs, dashboard chat, mentions.
- **Background actions**: notifications sent, mail labeled, schedule
  files written.
- **Failures**: timeouts, fallbacks, blocked tool calls, quota errors.

Each row links to the underlying conversation when one exists.

## How It Works

Activity has no trigger of its own — it is a read-only projection.
Every other event in the system writes to it as a side effect, landing
in three SQLite tables: `agent_actions` (what happened), and
`conversation_sessions` + `messages` (what was said).

## What You See

- A timeline filterable by event type, ProcessKey, backend, and outcome.
- Per-row cost, token counts, and turn count.
- A direct link to the message transcript for any session.

## Where in the Dashboard

- **Overview (`/`)** shows the most recent few activity rows.
- **Activity (`/activity`)** is the full searchable timeline.
- **Conversations (`/conversations/<id>`)** opens a single session's
  message-by-message transcript.

To read the morning routine's full reply, open Activity, filter to the
`routine.morning_routine` row, and click through to its conversation —
the transcript holds the agent's complete output, not just the summary
that reached your DM.

## Configuration

There is nothing to configure on the Activity view itself; what shows
up is a function of which routines are enabled and which integrations
are connected.

Retention is unlimited locally — the SQLite database keeps every row
forever. To prune history without losing your configuration, use
`POST /api/system/purge-history` (it clears `agent_actions`,
`conversation_sessions`, and `messages` but leaves settings and the
context vault intact). To wipe everything, `aitne uninstall --wipe-data`
removes the whole `~/.personal-agent` data directory after a `WIPE`
confirmation.

## When Something Goes Wrong

To find why a routine failed, open Activity, filter the outcome to
**failed**, and open the offending row. Its outcome label tells you the
failure class; the linked conversation shows the exact error and the
turn it happened on.

Common outcome labels:

- **"timed out"** — a backend or SDK hang. `executeTimeoutMinutes`
  (`/settings/models`) is the wall-clock cap.
- **"fallback"** — the main backend failed and routing moved to the
  fallback; the detail carries the `BackendQuotaError` or
  `BackendDecisiveFailure` that triggered it.
- **"blocked_absolute"** — the absolute-block layer refused a tool call.
  The detail names which tool and why (logged as
  `agent_actions.action_type='blocked_absolute'`).

## Related

- [Notifications](notifications.md) — what the agent told you about,
  separate from what it did.
- [Cost Tracking](cost-tracking.md) — the cost-rollup view.
- [Backend Routing](backend-routing.md) — how main → fallback resolves.
