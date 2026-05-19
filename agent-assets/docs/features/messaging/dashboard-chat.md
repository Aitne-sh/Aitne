---
schema_version: 1
slug: features/messaging/dashboard-chat
title: Dashboard Chat
id: dashboard-chat
aliases:
  - chat
  - in-browser chat
  - dashboard chat
  - /chat
category: features
summary: |
  The /chat page is an in-browser DM channel. It uses its own
  ProcessKey (dashboard.chat) and binds to whichever backend the
  operator picked on /settings/models — independent of the paired
  messaging app.
section: messaging
tags:
  - core
  - messaging
  - dashboard
status: stable
ask_examples:
  - What does /chat do that DMs don't?
  - How is dashboard chat different from a Telegram DM?
  - Why are my dashboard chat replies different from my Telegram replies?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - chat
  - dashboard
  - in-browser
related:
  - features/messaging/overview
  - concepts/backends-and-tiers
  - features/operations/activity-and-conversations
ui_anchors:
  - /chat
---

# Dashboard Chat

## In One Sentence

`/chat` is a browser-mounted DM with the agent — a fully featured
conversational surface separate from any paired messaging app.

## What It Does

- **Real-time** message stream over SSE.
- **Tool progress** rendered inline (which tool, which file, which
  endpoint) so you can watch the agent work.
- **Session history** persisted to SQLite (`scope='dashboard_chat'`)
  and visible from Activity → Conversations.
- **Independent backend binding** — `dashboard.chat` is its own
  ProcessKey, so the model used here can differ from the one your
  Telegram DM uses.

## When It Runs / How It Is Triggered

Whenever you press send. The page connects to `POST /api/chat/messages`
to enqueue and `GET /api/chat/stream` to listen.

## What It Outputs

- Inline tool calls and replies.
- Persisted messages under the chat session.

## Where in the Dashboard

- **Chat (`/chat`)** is the live surface.
- **Conversations** lets you re-open a past session.

## Configuration

- **Settings → Models** lets you pick which backend `dashboard.chat`
  binds to (default: same as `message.dm`, but operator-overridable).
- **Settings → Models → Session Timeouts → Dashboard Timeout** is the
  per-session wall-clock cap for `/chat`.

## When Something Goes Wrong

- A **stalled session** with no progress: check Activity for the
  session row — it may be waiting for an SSE event the daemon
  dropped.
- A **chat that uses the wrong model**: check `/settings/models` —
  `dashboard.chat`'s row is independent from `message.dm`'s.

## Related

- [Messaging Overview](overview.md)
- [Backends and Tiers](../../concepts/backends-and-tiers.md)
