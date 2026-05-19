---
schema_version: 1
slug: troubleshooting/messaging-not-pairing
title: Messaging Not Pairing
id: messaging-not-pairing
aliases:
  - pairing failed
  - magic phrase not working
  - messaging not paired
category: troubleshooting
summary: |
  The magic phrase isn't pairing your messaging account. Usually the
  bot can't see DMs, the phrase expired, or the message went to a
  group instead of a direct channel.
section: messaging-not-pairing
tags:
  - troubleshooting
  - messaging
  - pairing
status: stable
ask_examples:
  - Why isn't my magic phrase pairing?
  - Where do I send the magic phrase?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - magic phrase
  - owner channel
  - pairing
  - bot token
  - OAuth
related:
  - features/messaging/pairing-and-magic-phrase
  - features/messaging/overview
---

# Messaging Not Pairing

## What You See

- After DMing the magic phrase, the dashboard's pairing card stays in
  "waiting" state.

## Most Likely Causes

1. Phrase expired — generate a new one.
2. Bot does not have DM permission (Discord, Slack).
3. DM was sent in a group / channel by mistake.
4. Bot token wrong — paste it in again.

## Diagnostic Steps

1. Click "Regenerate phrase" on `/connections/messaging`.
2. Confirm bot privileges in the messaging app.
3. Send the phrase from a direct chat with the bot.

## Confirming the Fix

- The pairing card shows your owner identity.

## Related

- [Pairing & Magic Phrase](../features/messaging/pairing-and-magic-phrase.md)
