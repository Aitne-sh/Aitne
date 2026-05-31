---
schema_version: 1
slug: features/messaging/pairing-and-magic-phrase
title: Pairing and Magic Phrase
id: pairing-and-magic-phrase
aliases:
  - magic phrase
  - pairing
  - owner pairing
  - pair my messaging account
category: features
summary: |
  Pair a messaging account to Aitne so the daemon knows which DM channel
  belongs to you, the owner. Slack and Discord use a one-time "magic
  phrase" you DM from the app; Telegram uses a QR / deep-link token;
  WhatsApp links the device by scanning a QR. All of them bind the channel
  to your owner identity so nobody else can impersonate you.
section: messaging
tags:
  - core
  - messaging
  - pairing
  - safety
  - setup
status: stable
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - pairing
  - magic phrase
  - owner channel
  - QR pairing
  - impersonation
ask_examples:
  - How do I pair my Telegram account?
  - What is the magic phrase?
  - Can someone else impersonate me as the owner?
  - Why didn't my pairing DM work?
ui_anchors:
  - /connections/messaging
related:
  - features/messaging/overview
  - features/messaging/slack
  - features/messaging/telegram
  - features/messaging/discord
  - features/messaging/whatsapp
  - troubleshooting/messaging-not-pairing
---

# Pairing and Magic Phrase

## In one sentence

The dashboard hands you a one-time secret (a typed phrase, a QR code, or
a deep link, depending on the platform); you send or scan it from the
messaging app you want to pair; the daemon records that channel as your
owner channel.

## Why pairing exists

The agent only talks to one person — you, the owner. Pairing is how the
daemon learns which DM channel is yours.

- **Impersonation protection.** A random bot or stranger can't open a DM
  and claim the owner role without the secret. Only someone who can see
  the dashboard can complete the pairing.
- **One identity, many channels.** Pair Slack, Telegram, Discord, and
  WhatsApp separately; all of them map to the same owner identity. A DM
  to any paired channel reaches the agent, and notifications can go out on
  whichever channels you've configured.

## How each platform pairs

Pairing starts the same way everywhere — open
**Connections → Messaging** (`/connections/messaging`), find the
platform's card, and click its pairing button. What you do next depends
on the platform.

| Platform | Mechanism | What you do |
|---|---|---|
| **Slack** | Magic phrase | Dashboard shows a 4-word phrase (e.g. `apple-banana-cherry-date`). DM that phrase to the bot, by itself. |
| **Discord** | Magic phrase | Same as Slack — DM the displayed phrase to the bot. |
| **Telegram** | QR / deep link | Dashboard shows a QR code that opens a `https://t.me/<bot>?start=<token>` link. Tap **START** in Telegram. |
| **WhatsApp** | Device QR | Dashboard shows a QR code; scan it from WhatsApp on your phone (Linked Devices). |

### The magic phrase (Slack, Discord)

The dashboard generates a short, memorable phrase of four lowercase words
joined by hyphens, drawn from a 64-word list (24 bits of entropy). You DM
that exact phrase to the bot. Matching is tolerant — it ignores case,
punctuation, and emoji — but the phrase must be **sent by itself**. If you
wrap it in a sentence ("my phrase is apple-banana-cherry-date"), the agent
will reply asking you to send the phrase on its own.

The phrase is single-use and expires after **5 minutes**. If it lapses,
regenerate a fresh one from the dashboard.

### Token pairing (Telegram, WhatsApp)

Telegram and WhatsApp don't use a typed phrase:

- **Telegram** encodes a high-entropy, single-use token in a QR / deep
  link. Tapping **START** sends `/start <token>` to the bot, which
  promotes you to owner. The token is matched exactly and also expires
  after 5 minutes.
- **WhatsApp** uses WhatsApp's own linked-device flow — you scan a QR from
  your phone to attach the daemon as a device. Set the owner phone number
  first, then click **Pair device** and scan.

## Where in the dashboard

**Connections → Messaging** (`/connections/messaging`) is the single
pairing surface. Each platform has its own card with a step-by-step setup
(create the app / paste tokens / pair) and a live status indicator that
flips to "paired" once the channel is bound.

## When something goes wrong

- **Phrase or token expired.** The window is 5 minutes. Regenerate from the
  dashboard and try again.
- **"Send the pairing phrase by itself" reply.** You wrapped the phrase in
  other text. Send just the four words.
- **DM was sent in a group.** Pairing — and all agent messaging — only works
  in direct messages. Group chats are out of scope by design.
- **Still not pairing?** See
  [Messaging not pairing](../../troubleshooting/messaging-not-pairing.md).

## Related

- [Messaging Overview](overview.md)
- [Slack setup](slack.md)
- [Telegram setup](telegram.md)
- [Discord setup](discord.md)
- [WhatsApp setup](whatsapp.md)
- [Messaging not pairing (troubleshooting)](../../troubleshooting/messaging-not-pairing.md)
