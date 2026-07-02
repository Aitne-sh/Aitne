---
schema_version: 1
slug: features/messaging/whatsapp
title: WhatsApp
id: whatsapp
aliases:
  - whatsapp bot
  - whatsapp adapter
  - whatsapp pairing
  - whatsapp linked device
category: features
summary: |
  Link WhatsApp by scanning a QR code with your phone, the same way the
  WhatsApp desktop app links. No Cloud API, business account, or webhook
  is involved. Once linked, DMs to your own number are owner messages and
  flow exactly like Telegram.
section: messaging
tags:
  - messaging
  - integrations
  - pairing
status: stable
ask_examples:
  - Can I use WhatsApp with Aitne?
  - How do I link WhatsApp by scanning a QR code?
  - Why does WhatsApp say the device is unlinked?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - whatsapp
  - qr code
  - linked devices
  - owner phone
  - e.164
  - messaging adapter
  - baileys
related:
  - features/messaging/overview
  - features/messaging/pairing-and-magic-phrase
config_keys:
  - whatsappEnabled
  - whatsappOwnerPhone
  - whatsappAuthDir
ui_anchors:
  - /connections/messaging
---

# WhatsApp

## In One Sentence

Link WhatsApp by scanning a QR code with your phone — the same flow as
WhatsApp's own desktop/web app — and DMs to your number become owner
messages that flow exactly like Telegram.

## How It Works

Aitne connects to WhatsApp as a **linked device** — the same "linked
devices" feature in the WhatsApp mobile app that powers WhatsApp Web. It does
not use the WhatsApp Cloud API or a paid bridge such as Twilio. There is no
business account, no bot token, and no inbound webhook (a public URL that
WhatsApp would call) to expose:

- You scan a QR code once to link the daemon as a device on your account.
- Incoming WhatsApp messages arrive over the linked-device connection.
- The agent replies and sends notifications back through the same channel.
- It is **owner-only**: only DMs involving your one configured number are
  accepted. Self-DMs you send from another linked device are also accepted,
  so you can talk to the agent from your own number without a second account.
  All other senders are dropped.

## Setup

You configure WhatsApp from the dashboard — there is no `aitne` CLI command
for it.

1. Go to **Connections → Messaging → WhatsApp**.
2. Set the **Owner phone** in E.164 format (e.g. `+818012345678`). This is
   required before you can enable WhatsApp.
3. (Optional) Set the **Auth dir** — where the linked-device credentials are
   stored. Defaults to `~/.personal-agent/whatsapp/auth`.
4. Click **Enable WhatsApp**, then **Pair device**. A QR code appears.
5. On your phone: open **WhatsApp → Settings → Linked Devices → Link a
   device**, and scan the QR code.

Once the status shows connected, message your own number and the agent
responds.

### Configuration keys

| Key | Meaning |
|---|---|
| `whatsappEnabled` | Master on/off (default `false`). |
| `whatsappOwnerPhone` | Owner number in E.164 format. Validated; must start with `+` and 8–15 digits. |
| `whatsappAuthDir` | Directory holding linked-device credentials. |

## When Something Goes Wrong

- **QR code expired.** Each QR is short-lived and rotates. Click **Refresh
  QR** in the dashboard to get a new one, then scan it.
- **WhatsApp says the device is unlinked**, or pairing keeps failing. Click
  **Reset connection** in the dashboard. This wipes the cached pairing data
  in the auth dir so you can scan a fresh QR from scratch.
- **Session logged out.** If WhatsApp logs the device out (account banned,
  device conflict, or you unlinked it from the phone), the connection stops
  retrying and surfaces an error. Use **Reset connection**, then **Pair
  device** again.

## Related

- [Messaging Overview](overview.md)
- [Pairing and the Magic Phrase](pairing-and-magic-phrase.md)
