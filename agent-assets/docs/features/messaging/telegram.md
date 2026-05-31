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
  into Aitne, and DMing the magic phrase.
section: messaging
tags:
  - messaging
  - integrations
  - telegram
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
updated: 2026-05-28
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
token, type the magic phrase.

## What It Does

- Acts as the agent's reactive surface for your incoming direct messages (owner DMs only — group chats are ignored).
- Delivers the agent's outbound notifications and replies back to the same Telegram chat.

## When It Runs / How It Is Triggered

Before pairing, nothing listens. Once you paste the bot token and complete
magic-phrase pairing, Aitne long-polls Telegram's Bot API continuously for new
direct messages.

## Where in the Dashboard

- **Connections → Messaging → Telegram**.

## Configuration

| Field | Notes |
|---|---|
| Bot Token | From @BotFather. |
| Owner Channel | Auto-set on successful magic-phrase pairing. |

## When Something Goes Wrong

- Bot replied to in a group instead of a DM: group chats are filtered
  out by design; the agent only listens to direct messages.
- No reply at all after DMing the magic phrase: confirm the bot has a username
  set via @BotFather (/setname) — the daemon refuses to build the pairing deep
  link otherwise.
- Pairing never completes: re-check the token in Connections → Messaging →
  Telegram, then DM the magic phrase from your own account. See
  [Pairing & Magic Phrase](pairing-and-magic-phrase.md).

## Related

- [Pairing & Magic Phrase](pairing-and-magic-phrase.md)
- [Messaging Overview](overview.md)
