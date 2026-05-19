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
  Pair a Slack workspace by installing a bot user, pasting tokens
  into Aitne, and DMing the magic phrase.
section: messaging
tags:
  - messaging
  - integrations
  - slack
status: stable
ask_examples:
  - How do I pair Slack?
  - Can the agent listen in shared channels?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - slack
  - OAuth
  - bot token
  - owner channel
  - messaging adapter
related:
  - features/messaging/overview
  - features/messaging/pairing-and-magic-phrase
---

# Slack

## In One Sentence

A Slack bot user becomes the agent's surface in your workspace; DMs
to the bot are owner messages, mentions in channels are mention events.

## What It Does

- Listens for DMs (owner reactive path).
- Listens for `@personalagent` mentions in shared channels.
- Sends notifications to the owner DM.

## Where in the Dashboard

- **Connections → Messaging → Slack** holds bot tokens, channel info,
  and the magic-phrase pairing flow.

## When Something Goes Wrong

- Bot does not respond: check that the workspace bot has been added
  to the channel where the DM is happening.

## Related

- [Messaging Overview](overview.md)
