---
schema_version: 1
slug: features/integrations/mail
title: Mail
id: mail
aliases:
  - email
  - gmail
  - outlook
  - mail integration
category: features
summary: |
  Mail integration lets the agent read, label, classify, and search
  your inbox across Gmail, Outlook, Yahoo, and iCloud. Mail is
  proxied through the daemon — no provider library lives in the
  agent. (Yahoo / iCloud connect via IMAP under the hood; IMAP is the
  transport, not a separately exposed provider kind.)
section: integrations
tags:
  - integrations
  - mail
  - core
status: stable
ask_examples:
  - How do I connect my Gmail to the agent?
  - Can the agent send mail on my behalf?
  - How do I add a second mail account?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - mail
  - gmail
  - outlook
  - yahoo
  - icloud
  - inbox
  - labels
  - native mode
  - delegated
  - direct
  - fts5
related:
  - guides/connect-a-new-mail-account
  - features/routines/morning-routine
  - concepts/delegated-mode
ui_anchors:
  - /connections/mail
api_endpoints:
  - /api/mail
  - /api/mail/accounts
  - /api/mail/search
config_keys:
  - enabledMailProviders
  - mailPollIntervalSeconds
  - gmailPollIntervalSeconds
context_files:
  - state/today.md
---

# Mail

Connect one or more mailboxes (Gmail, Outlook, Yahoo, iCloud, or any
IMAP server) and Aitne polls them, classifies incoming threads, and
lets the agent search / label / read via the `mail` skill. Search is
local — backed by SQLite FTS5 — so the agent doesn't need to round-trip
the provider for every query.

## What It Does

- **Read & search** existing threads (FTS5-backed local index).
- **Classify** incoming messages — does this need owner attention,
  is it a marketing list, is it a receipt.
- **Label** threads so the operator and the agent agree on triage state.
- **Surface** the small set of mail items in the morning routine that
  actually need owner action.

The agent **prefers drafts** over sending. By convention it creates a
draft (`POST /mail/:account/drafts`) and lets you review and hit send
yourself. Direct send (`POST /mail/:account/messages/send`) is *not*
blocked — it is classified as an autonomous action, so the daemon does
not DM you for approval first. The agent only sends directly when it
judges you'd clearly want it to, and it tells you afterward; during the
hourly check the `mail` skill is hard read-only (no sending, drafting,
labeling, or filing).

## When It Runs / How It Is Triggered

- In `direct` mode a poller pulls new messages on a cadence. Gmail uses
  `gmailPollIntervalSeconds` (default 600); IMAP-backed accounts (Yahoo,
  iCloud, generic IMAP) use `mailPollIntervalSeconds` (default 180).
  Adjust both under **Settings → Advanced**.
- The morning routine reads the labeled queue and decides which need
  surfacing.
- Reactive turns (you DM "what's in my mail?") use the `mail` skill on
  demand.

## Integration Modes

Mail supports all four integration modes
(`direct | delegated | native | disabled`); each provider may sit in a
different mode.

| Provider | Direct | Delegated | Native | Notes |
|---|---|---|---|---|
| Gmail | ✓ | ✓ | ✓ (descriptor-driven) | Native mode uses Google's official Gmail MCP connector on the main backend; the connector POSTs observations back via `/api/observations`. |
| Outlook | ✓ | ✓ | ✓ (user-managed) | Native mode requires you to install your own MCP / skill harness on the main backend (`userManagedConnector: true`); the probe synthesises a user-managed result and skips the missing-variant gate. |
| Yahoo | ✓ | ✓ | — | IMAP transport. No native MCP variant. |
| iCloud | ✓ | ✓ | — | IMAP transport. No native MCP variant. |
| Generic IMAP | ✓ | ✓ | — | IMAP transport. No native MCP variant. |

Mode flips run through the §14.7 live probe + the per-key
`runtime_state.integration_flip_lock:<key>`. Changing the main
backend cascades unmatched `native` rows to `disabled`.

See [Delegated Mode](../../concepts/delegated-mode.md) for the full
mode lifecycle.

## What It Outputs

- New threads land in the local `messages` table (FTS-indexed).
- Classification labels are written via the provider API.
- A short "mail" section in `state/today.md` when items qualified.

## Where in the Dashboard

- **Connections → Mail** is the per-account configuration: providers,
  credentials, polling, label setup.

## Configuration

Per account you choose a provider kind (`gmail` / `outlook` / `yahoo` /
`icloud`) plus credentials, label conventions, and polling interval. You
pick the kind, not the transport — Yahoo and iCloud connect over IMAP
under the hood, but that is an implementation detail. The set of enabled
providers is `enabledMailProviders` (default `["gmail"]`).

## When Something Goes Wrong

- An **auth failure** points at expired credentials. The dashboard's
  auth-health card flips to a warning. See [Auth Failed](../../troubleshooting/auth-failed.md).
- A **classifier that misses** a sender consistently — add a manual
  label rule on `/connections/mail`.

## Related

- [Connect a new mail account](../../guides/connect-a-new-mail-account.md)
- [Morning Routine](../routines/morning-routine.md)
- [Delegated Mode](../../concepts/delegated-mode.md)
