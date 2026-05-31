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
updated: 2026-05-28
keywords:
  - chat
  - dashboard
  - in-browser
  - sse
  - session
related:
  - features/messaging/overview
  - concepts/backends-and-tiers
  - concepts/process-keys
  - features/operations/activity-and-conversations
process_keys:
  - dashboard.chat
config_keys:
  - sessionTimeoutDashboardMinutes
api_endpoints:
  - POST /api/chat/messages
  - GET /api/chat/stream
ui_anchors:
  - /chat
  - /conversations
  - /settings/models
---

# Dashboard Chat

## In One Sentence

`/chat` is a browser-mounted DM with the agent — a fully featured
conversational surface separate from any paired messaging app.

## What It Does

- **Real-time** message stream over SSE — the same conversational
  experience as a paired DM, but in the browser.
- **Tool progress** rendered inline (which tool, which file, which
  endpoint) so you can watch the agent work.
- **Session history** persisted to SQLite (`scope='dashboard_chat'`)
  and re-openable from Conversations.
- **Independent backend binding** — `dashboard.chat` is its own
  ProcessKey, so the model used here can differ from the one your
  Telegram (or Slack/Discord) DM uses.

## How It Is Triggered

Whenever you press send. The page POSTs to `POST /api/chat/messages`
to enqueue your message, then listens on `GET /api/chat/stream` (SSE)
for the streamed reply and inline tool calls. Every send and reply is
persisted under the chat session.

Like a DM, `dashboard.chat` is a **reactive** ProcessKey: it runs on
demand when you send, never on a schedule. Its default tier is
**medium** (Claude Sonnet 4.6 by default) — the same tier as
`message.dm`.

## Where in the Dashboard

- **Chat (`/chat`)** is the live surface.
- **Conversations (`/conversations`)** lists past sessions; open one to
  re-read it.

## Configuration

- **Settings → Models** (`/settings/models`) lets you pick which backend
  `dashboard.chat` binds to. It defaults to the same medium-tier preset
  as `message.dm`, but you can override it independently — give `/chat`
  a faster model for quick questions, or a heavier one for deep work.
- **Settings → Models → Session Timeouts → Dashboard Timeout**
  (`sessionTimeoutDashboardMinutes`, default **120** minutes) is the
  per-session wall-clock cap for `/chat`. After it lapses, the next
  message starts a fresh session.

## When Something Goes Wrong

- **A stalled session with no progress** — check the session row under
  Conversations; it may be waiting for an SSE event the daemon dropped.
  Reloading `/chat` reconnects the stream.
- **A chat that uses the wrong model** — check `/settings/models`.
  `dashboard.chat`'s row is independent from `message.dm`'s, so an
  override there is the usual cause.

## Related

- [Messaging Overview](overview.md)
- [Backends and Tiers](../../concepts/backends-and-tiers.md)
- [Process Keys](../../concepts/process-keys.md)
