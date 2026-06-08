---
schema_version: 1
slug: guides/connect-a-new-mail-account
title: Connect a New Mail Account
id: connect-a-new-mail-account
aliases:
  - connect mail
  - add mail account
  - imap setup
  - gmail setup
  - outlook setup
category: guides
summary: |
  Add a Gmail, Outlook, Yahoo, or iCloud mailbox to the mail
  integration. Each provider authenticates differently: Gmail rides
  the primary Google sign-in, Outlook uses OAuth, and Yahoo/iCloud
  use an app password.
section: connect-a-new-mail-account
tags:
  - guide
  - mail
  - integrations
status: stable
ask_examples:
  - How do I add another Gmail account?
  - What mail providers does Aitne support?
  - How do I connect an Outlook mailbox?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - mail
  - imap
  - gmail
  - outlook
  - yahoo
  - icloud
  - mail provider
  - OAuth
  - app password
related:
  - features/integrations/mail
ui_anchors:
  - /connections/mail
api_endpoints:
  - /api/mail/accounts
  - /api/mail/accounts/device-code
  - /api/config/mail/app-password
config_keys:
  - enabledMailProviders
  - mailPollIntervalSeconds
context_files:
  - state/today.md
---

# Connect a New Mail Account

## Goal

Wire a new mailbox into Aitne so the agent can read, label, classify,
and search it.

## Supported providers

The mail registry recognizes exactly four provider kinds — `gmail`,
`outlook`, `yahoo`, `icloud`. It deliberately stops at hosted
providers, so there is no separate "generic IMAP server" kind. Each
kind authenticates differently:

| Provider | How it connects |
|---|---|
| **Gmail** | Rides the primary Google sign-in (`/config/google-auth`). Extra Gmail accounts beyond the primary identity are not implemented yet. |
| **Outlook** | OAuth — a browser loopback flow, with a device-code fallback for headless machines. |
| **Yahoo** | App password (IMAP). |
| **iCloud** | App password (IMAP). |

## Prerequisites

- For **Outlook**: the Outlook client config must already be set
  (`PUT /api/config/mail/outlook/client-config`).
- For **Yahoo / iCloud**: generate a provider-specific app password
  first — your regular login password will not work over IMAP.

## Steps

1. Open `/connections/mail`.
2. Click "Add account" and pick the provider kind.
3. Authenticate for that kind:
   - **Gmail** — connect the primary Google account from the setup or
     connections flow (`/config/google-auth`). It then appears on the
     unified mail surface automatically; you do not add it as a
     separate mail account.
   - **Outlook** — step through the OAuth browser flow. On a headless
     machine (SSH / WSL), use the device-code fallback, which prints a
     code to enter at a verification URL.
   - **Yahoo / iCloud** — paste the email address and the app password.
4. Save. Registration succeeds regardless of the enabled-providers
   setting (`enabledMailProviders`); the account goes live only when
   you flip its **Enable** toggle on the mail card.
5. The account is picked up on the next mail poll tick (default every
   180 seconds, configurable via `mailPollIntervalSeconds`).

## Verification

- The account row turns healthy on the auth-health card.
- The mail count updates on `/connections/mail`.

## If It Fails

- **Outlook OAuth never returns** — the loopback flow binds an
  ephemeral port on `127.0.0.1`, so a fixed-port redirect mismatch is
  not the cause. Confirm the browser actually opened and completed the
  redirect; on a headless host switch to the device-code flow instead.
- **Outlook add returns "client config missing"** — set the Outlook
  client config (`PUT /api/config/mail/outlook/client-config`) before
  adding the account.
- **Yahoo / iCloud login rejected** — re-check the address and the app
  password (not your normal account password); regenerate the app
  password if it still fails.
- **Adding a second Gmail account fails** — only the primary Google
  identity is supported today; additional Gmail accounts are not yet
  implemented.

## Related

- [Mail](../features/integrations/mail.md)
