---
schema_version: 1
slug: features/messaging/pairing-and-magic-phrase
title: Pairing and Magic Phrase
id: pairing-and-magic-phrase
aliases:
  - magic phrase
  - pairing
  - owner pairing
category: features
summary: |
  Pair your messaging account to Aitne by typing a one-time
  "magic phrase" the dashboard generates. The phrase binds the channel
  to your owner identity so impersonation is impossible.
section: messaging
tags:
  - core
  - messaging
  - pairing
  - safety
status: stable
ask_examples:
  - How do I pair my Telegram account?
  - What is the magic phrase?
  - Can someone else impersonate me?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - pairing
  - magic phrase
  - owner
related:
  - features/messaging/overview
---

# Pairing and Magic Phrase

## In One Sentence

The dashboard prints a one-time phrase; you DM that phrase to the
agent from the messaging app you want to pair; the daemon records the
channel as your owner channel.

## What It Does

- Prevents drive-by impersonation: a bot can't open a DM and pretend
  to be the operator without the phrase.
- Multiple paired channels (e.g. Telegram + Slack) all map to the
  same owner identity.

## When It Runs / How It Is Triggered

The phrase is generated when the operator clicks "Pair" on
`/connections/messaging`. The daemon listens for the phrase from any
incoming DM until paired or the phrase expires.

## Where in the Dashboard

- **Connections → Messaging** is the pairing surface.

## When Something Goes Wrong

- Phrase expired: regenerate it from the dashboard.
- DM was sent in a group: pairing only works in direct messages.

## Related

- [Messaging Overview](overview.md)
