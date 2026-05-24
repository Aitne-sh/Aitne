---
schema_version: 1
slug: features/messaging/overview
title: Messaging Overview
id: messaging-overview
aliases:
  - messaging
  - dms
  - direct messages
  - messaging apps
  - notifications
category: features
summary: |
  Pair Aitne with one or more messaging apps (Telegram, Slack,
  Discord, WhatsApp). DMs become the primary reactive channel; the
  agent uses the same channel to send notifications back.
section: messaging
tags:
  - core
  - messaging
  - integrations
status: stable
ask_examples:
  - How do I pair my phone with the agent?
  - Which messaging apps does the agent support?
  - Why didn't I get a notification?
locale: en-US
created: 2026-04-25
updated: 2026-05-04
keywords:
  - messaging
  - dm
  - pairing
  - telegram
  - slack
  - discord
  - whatsapp
  - voice
  - audio
related:
  - features/messaging/pairing-and-magic-phrase
  - features/messaging/telegram
  - features/messaging/slack
  - features/messaging/discord
  - features/messaging/whatsapp
  - features/messaging/dashboard-chat
  - features/messaging/bang-commands
  - features/operations/notifications
  - features/operations/quiet-hours
ui_anchors:
  - /connections
  - /connections/messaging
  - /settings/connections
  - /settings/commands
---

# Messaging Overview

Aitne treats DMs from a paired messaging app as its primary reactive
surface — you message it, it answers; it messages you when a
notification fires. Voice notes are transcribed locally with Whisper
so you can talk to the agent the same way you'd type.

## What It Does

- **Reactive DMs**: the agent answers every direct message you send.
- **@-mentions**: in Slack, @-mentioning the agent inside a shared
  channel routes to `message.mention` and is answered the same way
  as a DM. Telegram, Discord, and WhatsApp drop all non-DM traffic
  (no group support); multi-user DMs (Slack `mpim`) are also
  filtered out — Aitne is single-owner by design.
- **Outbound notifications**: routines and observations fire alerts
  back through the same channel.
- **Voice attachments**: when the platform attaches audio (Telegram
  voice notes, WhatsApp voice messages, etc.), the daemon transcribes
  it locally with Whisper before handing the turn to the agent.
  Transcription runs entirely on your machine — no audio is shipped
  to a cloud API. Configurable via the `PA_VOICE_TRANSCRIPTION_*`
  env vars (model, language, duration cap).
- **Magic-phrase pairing**: the operator types a one-time phrase to
  bind their account to the agent (anti-impersonation).

Aitne is **single-owner** by design. Any DM that does not
match a paired owner channel is dropped (defense in depth — the
adapter and the dispatcher both check).

## When It Runs / How It Is Triggered

- The messaging adapter for each connected platform polls / receives
  webhooks for incoming messages.
- An incoming DM dispatches to the `message.dm` ProcessKey.
- An incoming mention dispatches to `message.mention`.
- Notifications fire as a side-effect of routines and observations
  reaching the notifier (subject to quiet hours and rate limits).

## What It Outputs

- Replies in the operator's chosen messaging app.
- Notification messages, batched during quiet hours.

## Where in the Dashboard

- **Connections (`/connections`)** is the unified pairing page.
- **Connections → Messaging (`/connections/messaging`)** lists each
  app's status, owner channel, and rate limit settings.

## Configuration

- Per-app: bot token / OAuth, owner channel, optional default channel.
- Global: `primaryPlatform` (the fallback when multiple apps are paired).

## When Something Goes Wrong

- An **un-paired DM**: the agent ignores it. Pair the app from
  `/connections/messaging` first.
- A **notification you expected but did not get**: check quiet hours
  on `/settings/schedule`.

## Related

- [Pairing & Magic Phrase](pairing-and-magic-phrase.md)
- [Bang Commands](bang-commands.md) — `!stop` / `!start` / `!cost` /
  `!report` / `!help` for mobile-first daemon control.
- [Dashboard Chat](dashboard-chat.md) — the in-browser equivalent.
- [Notifications](../operations/notifications.md)
