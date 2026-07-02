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
  - messaging
  - integrations
  - pairing
  - notifications
status: stable
ask_examples:
  - How do I pair my phone with the agent?
  - Which messaging apps does the agent support?
  - Why didn't I get a notification?
  - Can I send the agent a voice note?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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
  - /settings/commands
  - /settings/hours
process_keys:
  - message.dm
  - message.mention
config_keys:
  - primaryPlatform
  - quietHoursStart
  - quietHoursEnd
---

# Messaging Overview

Direct messages (DMs) from a paired messaging app are Aitne's main way
to talk with you: you message it, it answers; it messages you back when
a notification fires. Voice notes are transcribed locally with Whisper,
so you can talk to the agent the same way you'd type.

## What It Does

- **Reactive DMs**: the agent answers every direct message you send.
- **@-mentions (Slack and Discord)**: @-mentioning the agent inside a
  shared channel routes to the `message.mention` process key and is
  answered the same way as a DM. Telegram and WhatsApp ignore all non-DM
  traffic (no group support).
- **Outbound notifications**: routines and observations fire alerts
  back through the same channel.
- **Voice attachments**: when the platform attaches audio (Telegram
  voice notes, WhatsApp voice messages, etc.), the daemon transcribes
  it locally with Whisper before handing the turn to the agent.
  Transcription runs entirely on your machine — no audio is shipped
  to a cloud API. Tune it with the `PA_VOICE_TRANSCRIPTION_*` env
  vars: `ENABLED`, `MODEL`, `LANGUAGE`, `PRIMARY_LANGUAGE`, and
  `MAX_DURATION_SEC`.
- **Magic-phrase pairing**: the operator types a one-time phrase to
  bind their account to the agent (anti-impersonation).

## Single-Owner by Design

Aitne serves exactly one owner. Any message that does not come from a
paired owner channel is dropped — group chats, multi-user Slack DMs
(`mpim`), and unrecognized senders never reach the agent. Two layers
enforce this independently (defense in depth): the messaging adapter
and the dispatcher each check the owner channel on their own.

## When It Runs / How It Is Triggered

- The messaging adapter for each connected platform watches for
  incoming messages — Telegram by long-polling (repeatedly asking the
  server for updates), Slack, Discord, and WhatsApp by holding an
  always-open WebSocket connection.
- An incoming DM dispatches to the `message.dm` process key.
- An incoming mention dispatches to `message.mention`.
- Notifications fire as a side-effect of routines and observations
  reaching the notifier (subject to quiet hours and rate limits).

## What It Outputs

- Replies in the operator's chosen messaging app.
- Notification messages — suppressed during quiet hours; a pending
  batch is deferred and delivered when the window ends (see
  [Quiet Hours](../operations/quiet-hours.md)).

## Where in the Dashboard

- **Connections (`/connections`)** is the unified pairing page.
- **Connections → Messaging (`/connections/messaging`)** lists each
  app's status, owner pairing, and notification destinations.

## Configuration

- Per-app: bot token / OAuth, owner channel, optional default channel.
- Global: `primaryPlatform` (default `slack`) — the platform the agent
  prefers for outbound notifications when more than one app is paired.
- Outbound rate limits and quiet hours live on `/settings/hours`
  ("Hours & Notifications" — see
  [Quiet Hours](../operations/quiet-hours.md)).

## When Something Goes Wrong

- An **un-paired DM**: the agent ignores it. Pair the app from
  `/connections/messaging` first (see
  [Pairing & Magic Phrase](pairing-and-magic-phrase.md)).
- A **notification you expected but did not get**: check quiet hours
  and rate limits on `/settings/hours`.

## Related

- [Pairing & Magic Phrase](pairing-and-magic-phrase.md)
- [Bang Commands](bang-commands.md) — `!stop` / `!start` / `!cost` /
  `!report` / `!help` for mobile-first daemon control.
- [Dashboard Chat](dashboard-chat.md) — the in-browser equivalent.
- [Notifications](../operations/notifications.md)
