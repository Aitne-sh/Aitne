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
  - mail
  - integrations
status: stable
ask_examples:
  - How do I add another Gmail account?
  - What mail providers does Aitne support?
  - How do I connect an Outlook mailbox?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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

The mail registry supports exactly four provider kinds — `gmail`,
`outlook`, `yahoo`, `icloud`. It sticks to these hosted providers on
purpose, so there is no separate "generic IMAP server" kind. Each kind
signs in differently:

| Provider | How it connects |
|---|---|
| **Gmail** | Uses the same primary Google sign-in you set up for the app (`/config/google-auth`). Adding extra Gmail accounts beyond that main Google identity isn't supported yet. |
| **Outlook** | OAuth (a browser sign-in flow). A headless machine — one with no browser, such as a server you reach over SSH — falls back to a device code you type in instead. |
| **Yahoo** | App password (connects over IMAP). |
| **iCloud** | App password (connects over IMAP). |

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
     connections flow (`/config/google-auth`). It then shows up in your
     mail view automatically; you do not add it as a separate mail
     account.
   - **Outlook** — step through the OAuth browser flow. On a headless
     machine (one you reach over SSH or WSL, with no browser of its
     own), use the device-code fallback, which shows a code to type in
     at a verification URL.
   - **Yahoo / iCloud** — paste the email address and the app password.
4. Save. The account saves whether or not its provider is turned on in
   the enabled-providers setting (`enabledMailProviders`); it goes live
   only when you flip its **Enable** toggle on the mail card.
5. The agent picks up the account on the next mail poll (by default
   every 180 seconds, which you can change with
   `mailPollIntervalSeconds`).

## Verification

- The account row turns healthy (green) on the auth-health card.
- The mail count updates on `/connections/mail`.

## If It Fails

- **Outlook OAuth never returns** — the sign-in flow opens a temporary
  local port on `127.0.0.1`, so a fixed-port redirect mismatch isn't
  the cause. Check that the browser actually opened and finished the
  redirect; on a headless host, switch to the device-code flow instead.
- **Outlook add returns "client config missing"** — set the Outlook
  client config (`PUT /api/config/mail/outlook/client-config`) before
  you add the account.
- **Yahoo / iCloud login rejected** — re-check the address and the app
  password (not your normal account password); generate a fresh app
  password if it still fails.
- **Adding a second Gmail account fails** — only the primary Google
  identity is supported today; extra Gmail accounts aren't available
  yet.

## Related

- [Mail](../features/integrations/mail.md)
