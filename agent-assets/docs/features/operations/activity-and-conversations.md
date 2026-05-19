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
status: stable
ask_examples:
  - Where can I see what the agent did today?
  - Where do I read the morning routine's full reply?
  - How do I find why a routine failed?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
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

## When It Runs / How It Is Triggered

There is no trigger — Activity is a read-only projection. It is
written to as a side-effect of every other event in the system
(`agent_actions` / `conversation_sessions` / `messages`).

## What It Outputs

- A timeline filterable by event type, ProcessKey, backend, outcome.
- Per-row cost, token counts, and turn count.
- A direct link to the message transcript for any session.

## Where in the Dashboard

- **Overview (`/`)** shows the most recent few activity rows.
- **Activity (`/activity`)** is the full searchable timeline.
- **Conversations (`/conversations/<id>`)** opens a single session's
  message-by-message transcript.

## Configuration

There is nothing to configure on the Activity view itself; what shows
up is a function of which routines are enabled and which integrations
are connected. Retention is unlimited locally — the SQLite database
keeps everything until you `aitne stop && rm ~/.personal-agent/data/personal_agent.db*` (the `*` also clears the `-shm`/`-wal` companions).

## When Something Goes Wrong

- A row showing **"timed out"** points at a backend or SDK hang.
  `executeTimeoutMinutes` (`/settings/models`) is the wall-clock cap.
- A row showing **"fallback"** means main backend failed; check the
  detail for the `BackendQuotaError` / `BackendDecisiveFailure`.
- A row showing **"blocked_absolute"** means the absolute-block layer
  refused a tool call. The detail names which tool and why.

## Related

- [Notifications](notifications.md) — what the agent told you about,
  separate from what it did.
- [Cost Tracking](cost-tracking.md) — the cost-rollup view.
- [Backend Routing](backend-routing.md) — how main → fallback resolves.
