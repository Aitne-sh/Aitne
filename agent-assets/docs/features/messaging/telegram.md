---
schema_version: 1
slug: features/messaging/telegram
title: Telegram
id: telegram
aliases:
  - telegram bot
category: features
summary: |
  Pair Telegram by creating a bot via @BotFather, pasting the token
  into Aitne, and scanning the pairing QR code.
section: messaging
tags:
  - messaging
  - integrations
status: stable
config_keys:
  - telegramOwnerChatId
ui_anchors:
  - /connections/messaging
ask_examples:
  - How do I pair Telegram?
  - Where do I get a Telegram bot token?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - telegram
  - telegram bot
  - bot token
  - telegram pairing
  - messaging adapter
related:
  - features/messaging/pairing-and-magic-phrase
  - features/messaging/overview
---

# Telegram

## In One Sentence

The fastest messaging app to pair: create a Telegram bot, paste the
token, scan the pairing QR code.

## What It Does

- Receives your incoming direct messages so the agent can react to them (owner DMs only — group chats are ignored).
- Sends the agent's notifications and replies back to the same Telegram chat.

## When It Runs / How It Is Triggered

Before pairing, nothing listens. Once you paste the bot token and finish pairing
(scan the QR code or tap the deep link), Aitne continuously long-polls Telegram's
Bot API — it keeps an open request that returns the moment a new direct message
arrives.

## Where in the Dashboard

- **Connections → Messaging → Telegram**.

## Configuration

| Field | Notes |
|---|---|
| Bot Token | From @BotFather. |
| Owner Channel | Auto-set on successful QR / deep-link pairing. |

## When Something Goes Wrong

- Bot replied to in a group instead of a DM: group chats are filtered
  out by design; the agent only listens to direct messages.
- No reply at all after scanning the QR: confirm the bot has a username
  set via @BotFather (/setname or /newbot) — the daemon refuses to build the
  pairing deep link otherwise.
- Pairing never completes: re-check the token in Connections → Messaging →
  Telegram, generate a fresh QR, then scan it (or tap the deep link) and press
  START in Telegram from your own account. See
  [Pairing & Magic Phrase](pairing-and-magic-phrase.md).

## Related

- [Pairing & Magic Phrase](pairing-and-magic-phrase.md)
- [Messaging Overview](overview.md)
