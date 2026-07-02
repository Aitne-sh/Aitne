---
schema_version: 1
slug: troubleshooting/messaging-not-pairing
title: Messaging Not Pairing
id: messaging-not-pairing
aliases:
  - pairing failed
  - magic phrase not working
  - messaging not paired
  - pairing card stuck waiting
category: troubleshooting
summary: |
  Your messaging account won't pair: the dashboard's pairing card stays in
  "waiting". Usually the secret expired (5-minute window), the phrase was
  wrapped in a sentence instead of sent by itself, the bot can't see your
  DM, or the message landed in a group instead of a direct channel.
section: messaging
tags:
  - messaging
  - pairing
status: stable
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - magic phrase
  - owner channel
  - pairing
  - bot token
  - QR pairing
  - deep link
ui_anchors:
  - /connections/messaging
ask_examples:
  - Why isn't my magic phrase pairing?
  - Where do I send the magic phrase?
  - My Telegram QR isn't pairing, what's wrong?
  - The pairing card is stuck on waiting.
related:
  - features/messaging/pairing-and-magic-phrase
  - features/messaging/overview
---

# Messaging Not Pairing

## What you see

After you send the magic phrase (Slack / Discord) or scan/tap the QR or
deep link (Telegram / WhatsApp), the pairing card on
**Connections → Messaging** (`/connections/messaging`) stays in the
"waiting" state and never flips to "paired".

## Know which secret your platform uses

Not every platform uses a typed phrase, so the right fix depends on which
one you are pairing:

| Platform | Secret | How you send it |
|---|---|---|
| **Slack** | Magic phrase | DM the 4-word phrase (e.g. `apple-banana-cherry-date`) to the bot, by itself. |
| **Discord** | Magic phrase | Same as Slack — DM the displayed phrase to the bot. |
| **Telegram** | QR / deep link | Tap **START** so the bot receives `/start <token>`. |
| **WhatsApp** | Device QR | Scan the dashboard QR from your phone (Linked Devices). |

All secrets are single-use and expire after **5 minutes**.

## Most likely causes

1. **The secret expired.** The phrase or token is only valid for 5
   minutes. If you took longer, it has lapsed — regenerate a fresh one.
2. **You wrapped the phrase in a sentence (Slack / Discord).** The four
   words have to be the **only** thing in the message. Sending "my phrase
   is apple-banana-cherry-date" is turned down on purpose, and the agent
   replies asking you to send the phrase on its own. Aside from that, the
   check ignores capitalization, punctuation, and emoji.
3. **You sent it in a group or channel.** Pairing — and all agent
   messaging — works only in a one-to-one DM. Group chats are out of
   scope.
4. **The bot can't see your DM.** On Discord and Slack the bot needs
   permission to receive direct messages from you; without it your
   message never reaches the daemon.
5. **A token is wrong.** A mistyped or stale bot token means the daemon
   isn't connected at all. Re-paste it in the platform's card.

## Diagnostic steps

1. On `/connections/messaging`, click **Generate pairing phrase** (Slack /
   Discord) or re-open the QR / deep link (Telegram / WhatsApp) so you
   start a fresh 5-minute window.
2. For Slack / Discord, send **only** the four words — no surrounding
   text — from a direct chat with the bot, not a channel.
3. For Telegram, tap **START** so the bot gets `/start <token>`. For
   WhatsApp, set the owner phone number first, then click **Pair device**
   and scan.
4. If the card still doesn't react at all, confirm the bot's tokens and
   DM permissions in the messaging app, then re-paste any token on the
   card.

## Confirming the fix

The pairing card flips to "paired" and shows your owner identity. A DM to
that channel now reaches the agent.

## Related

- [Pairing and Magic Phrase](../features/messaging/pairing-and-magic-phrase.md)
- [Messaging Overview](../features/messaging/overview.md)
