---
schema_version: 1
slug: features/messaging/discord
title: Discord
id: discord
aliases:
  - discord bot
  - discord adapter
  - discord pairing
category: features
summary: |
  Pair Discord by creating a bot in the developer portal, pasting the
  token into Aitne, and DMing the magic phrase from your
  Discord account.
section: messaging
tags:
  - messaging
  - integrations
  - pairing
status: stable
ask_examples:
  - How do I pair Discord?
  - Why won't my Discord bot reply to DMs?
  - Does the agent respond to mentions in Discord servers?
ui_anchors:
  - /connections/messaging
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - discord
  - bot token
  - DM
  - owner channel
  - messaging adapter
  - magic phrase
  - message content intent
related:
  - features/messaging/overview
  - features/messaging/pairing-and-magic-phrase
---

# Discord

## In One Sentence

A Discord bot becomes the agent's surface; pair via DM after
installing the bot in the developer portal.

## How to Set Up

1. Create an application and bot at the
   [Discord Developer Portal](https://discord.com/developers).
2. Under **Bot** settings, copy the bot token.
3. In the bot's **Privileged Gateway Intents**, enable the
   **Message Content Intent**. This is required — the agent cannot read
   DM or mention text without it.
4. Invite the bot to any servers where you want mentions to work.
5. Paste the token under **Connections → Messaging → Discord**.
6. DM the magic phrase from your own Discord account to complete
   pairing.

## What It Does

- Listens for DMs from the paired owner.
- Listens for mentions in shared servers.
- Sends notifications back via DM.

## Configuration

| Field | Notes |
| --- | --- |
| Bot Token | From the Discord Developer Portal (Bot settings). |
| Owner Channel | Auto-set on successful magic-phrase pairing. |

## Where in the Dashboard

- **Connections → Messaging → Discord**.

## When Something Goes Wrong

- Bot connects but never responds to DMs/mentions: confirm the
  **Message Content Intent** is enabled under the bot's Privileged
  Gateway Intents in the developer portal.
- Bot cannot DM you: in Discord, open the server where the bot lives →
  **Privacy Settings** and enable "Allow direct messages from server
  members". Discord blocks bot DMs to users who have this off.

## Related

- [Messaging Overview](overview.md)
- [Pairing & Magic Phrase](pairing-and-magic-phrase.md)
