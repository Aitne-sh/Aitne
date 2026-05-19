---
schema_version: 1
slug: features/messaging/whatsapp
title: WhatsApp
id: whatsapp
aliases:
  - whatsapp bot
  - whatsapp adapter
  - whatsapp pairing
category: features
summary: |
  Pair WhatsApp via the Cloud API or a bridge service. Once paired, DMs
  to the configured number are owner messages.
section: messaging
tags:
  - messaging
  - integrations
  - whatsapp
status: stable
ask_examples:
  - Can I use WhatsApp with Aitne?
  - How do I set up the WhatsApp Cloud API?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - whatsapp
  - twilio
  - bot token
  - owner channel
  - messaging adapter
related:
  - features/messaging/overview
---

# WhatsApp

## In One Sentence

A WhatsApp Cloud API number can act as the agent's owner surface; DMs
flow exactly like Telegram.

## What It Does

- Receives WhatsApp messages routed through the configured number.
- Sends notifications back through the same channel.

## Where in the Dashboard

- **Connections → Messaging → WhatsApp**.

## When Something Goes Wrong

- WhatsApp's webhook timed out: check that the daemon is reachable
  from the WhatsApp side (the simplest way is a tunnel during dev).

## Related

- [Messaging Overview](overview.md)
