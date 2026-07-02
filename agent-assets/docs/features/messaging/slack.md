---
schema_version: 1
slug: features/messaging/slack
title: Slack
id: slack
aliases:
  - slack bot
  - slack adapter
  - slack pairing
  - slack DM
category: features
summary: |
  Connect a Slack workspace by creating a bot app with Socket Mode,
  pasting a bot token and an app-level token into Aitne, then DMing
  the magic phrase to pair yourself as owner.
section: messaging
tags:
  - messaging
  - integrations
  - pairing
status: stable
ask_examples:
  - How do I pair Slack?
  - Why does the agent need two Slack tokens?
  - Can the agent listen in shared channels?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - slack
  - socket mode
  - bot token
  - app token
  - magic phrase
  - owner channel
  - messaging adapter
related:
  - features/messaging/overview
  - features/messaging/pairing-and-magic-phrase
ui_anchors:
  - /connections/messaging
config_keys:
  - primaryPlatform
  - slackOwnerUserId
---

# Slack

## In One Sentence

You add a Slack bot user to your workspace, and that bot is how you talk
to the agent: DMs you send the bot are treated as owner messages, and
`@`-mentions of the bot in channels are treated as mentions — but only
when they come from the one paired owner.

## What It Does

- Listens for **DMs** to the bot — your direct messages to the agent.
- Listens for **`@`-mentions of the bot** in channels you've added it to.
- Sends notifications back to your owner DM.

The adapter connects to Slack over **Socket Mode**, a WebSocket (a
persistent two-way link Slack opens to Aitne). Because Slack does the
reaching-out, Aitne needs no public inbound URL or webhook endpoint.

## Single-Owner Scope

Aitne is a single-owner agent by design. Only messages from the paired
owner are processed; everything else is dropped silently. Multi-person
DMs (`mpim`) are rejected outright, so a mention inside a group thread
never produces a reply visible to non-owners.

A channel mention only fires when the message text contains the bot's
actual user reference (e.g. `<@U0123ABCD>`, rendered as `@YourBotName`).
A plain text string like `@personalagent` is not a real Slack mention and
will not trigger anything.

## Setup

Everything happens under **Connections → Messaging** in the dashboard
(the Slack card). There are three steps:

1. **Create the Slack app.** Click *Open Slack app builder* — Aitne
   pre-fills the manifest with the right scopes and Socket Mode enabled.
   Create the app and install it to your workspace.
2. **Paste two tokens.** Slack issues two tokens for a Socket Mode app:
   - a **bot token** (`xoxb-...`) — the bot's identity and API access, and
   - an **app-level token** (`xapp-...`) — authorizes the Socket Mode
     WebSocket connection.

   Paste both, then use *Test token* to confirm Aitne can reach the bot.
3. **Pair with the magic phrase.** Click *Generate pairing phrase*, then
   DM that exact phrase to the bot from your own Slack account. The first
   account that sends the matching phrase becomes the owner. See
   [Pairing and the Magic Phrase](pairing-and-magic-phrase.md) for how
   the challenge works.

To route notifications to Slack by default, set Slack as your primary
platform (`primaryPlatform`). The owner's Slack user id is stored as
`slackOwnerUserId` once pairing succeeds.

## When Something Goes Wrong

- **Bot never responds to a DM.** Confirm both tokens are saved and *Test
  token* succeeds. A failing app-level token (`xapp-`) means the Socket
  Mode connection never opens, so no events arrive.
- **Mentions in a channel are ignored.** Make sure the bot has been added
  to that channel, and that you're mentioning the bot itself (autocomplete
  `@YourBotName`), not typing a plain word.
- **Pairing phrase isn't accepted.** Send the phrase by itself, with no
  surrounding sentence — a wrapped phrase won't match. See the pairing
  doc for the full rules.

## Related

- [Messaging Overview](overview.md)
- [Pairing and the Magic Phrase](pairing-and-magic-phrase.md)
