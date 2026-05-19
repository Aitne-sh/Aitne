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
  Add a Gmail / Outlook / Yahoo / iCloud account to the mail
  integration. Each provider has its own credential shape.
section: connect-a-new-mail-account
tags:
  - guide
  - mail
  - integrations
status: stable
ask_examples:
  - How do I add another Gmail account?
  - What mail providers does Aitne support?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - mail
  - imap
  - gmail
  - outlook
  - yahoo
  - icloud
  - mail provider
  - OAuth
related:
  - features/integrations/mail
---

# Connect a New Mail Account

## Goal

Wire a new mailbox into Aitne so the agent can read, label,
and search it.

## Prerequisites

- The provider's OAuth or app password is available.

## Steps

1. Open `/connections/mail`.
2. Click "Add account".
3. Pick the provider kind. The supported set is `gmail`, `outlook`,
   `yahoo`, `icloud` — the registry deliberately stops at hosted
   providers, so a generic IMAP server is not a separate kind.
4. Step through the OAuth flow (Gmail / Outlook) or paste the
   provider-specific app password (Yahoo / iCloud).
5. Save. The first poll runs within a minute.

## Verification

- The account row turns green on the auth-health card.
- The mail count updates on `/connections/mail`.

## If It Fails

- OAuth that does not return: confirm the redirect URL matches the
  daemon's API port (default 8321).

## Related

- [Mail](../features/integrations/mail.md)
