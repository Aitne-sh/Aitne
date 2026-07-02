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
status: stable
ask_examples:
  - How do I connect my Gmail to the agent?
  - Can the agent send mail on my behalf?
  - How do I add a second mail account?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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

Connect one or more mailboxes (Gmail, Outlook, Yahoo, or iCloud). Aitne
then polls them, sorts incoming threads, and lets the agent search,
label, and read your mail through the `mail` skill. Search runs locally,
backed by a SQLite full-text index (FTS5), so the agent doesn't have to
call the provider every time you ask about your inbox.

## What It Does

- **Read & search** existing threads (from the local FTS5 index).
- **Classify** incoming messages — for example, a travel booking, a
  receipt attachment, or a Kindle notebook export.
- **Label** threads so you and the agent agree on where each one stands.
- **Surface** the few mail items in the morning routine that actually
  need your attention.

The agent **prefers drafts** over sending. By default it writes a draft
(`POST /mail/:account/drafts`) and leaves it for you to review and send
yourself. Direct send (`POST /mail/:account/messages/send`) is *not*
blocked — it counts as an autonomous action, so the daemon does not DM
you for approval first. The agent only sends on its own when it's clear
you'd want it to, and it tells you afterward. During the activity scan
the `mail` skill is strictly read-only: no sending, drafting, labeling,
or filing.

## When It Runs / How It Is Triggered

- In `direct` mode a poller checks for new messages on a set interval.
  Gmail uses `gmailPollIntervalSeconds` (default 600); all other accounts
  (Outlook, Yahoo, iCloud) use `mailPollIntervalSeconds` (default 180).
  You can adjust the Gmail interval under **Settings → Infrastructure**.
- The morning routine reads the labeled queue and picks which threads to
  bring to your attention.
- When you ask directly (you DM "what's in my mail?"), the agent uses the
  `mail` skill on demand.

## Integration Modes

Gmail and Outlook support all four integration modes
(`direct | delegated | native | disabled`), and each account can sit in
a different mode. Yahoo and iCloud have no integration-registry entry, so
they are direct-only by design.

| Provider | Direct | Delegated | Native | Notes |
|---|---|---|---|---|
| Gmail | ✓ | ✓ | ✓ (descriptor-driven) | Native mode uses the main backend's own Gmail MCP connector (Claude's hosted connector, the Codex apps connector, or Gemini's google-workspace extension); the backend POSTs observations back via `/api/observations`. |
| Outlook | ✓ | ✓ | ✓ (user-managed) | Native mode requires you to install your own MCP / skill harness on the main backend (`userManagedConnector: true`); the probe synthesises a user-managed result and skips the missing-variant gate. |
| Yahoo | ✓ | — | — | IMAP transport. Direct-only; never enters the delegated surface. |
| iCloud | ✓ | — | — | IMAP transport. Direct-only; never enters the delegated surface. |

Switching a provider between modes goes through the §14.7 live probe and
a per-key lock (`runtime_state.integration_flip_lock:<key>`). If you
change the main backend, any `native` rows it no longer matches fall back
to `disabled`.

See [Delegated Mode](../../concepts/delegated-mode.md) for the full
mode lifecycle.

## What It Outputs

- New threads land in the local `mail_messages_index` table
  (full-text indexed via `fts_mail_messages`).
- Labels and tags are written back through the provider API when the
  agent applies them (`POST /mail/:account/messages/:id/tags`).
- A short "mail" section in `state/today.md` when items qualify.

## Where in the Dashboard

- **Connections → Mail** is the per-account configuration: providers,
  credentials, per-account active toggles, and the Gmail classification
  model.

## Configuration

For each account you choose a provider kind (`gmail` / `outlook` /
`yahoo` / `icloud`), plus credentials and an optional display label. You
pick the kind, not the transport — Yahoo and iCloud connect over IMAP
behind the scenes, but that's an implementation detail you don't manage.
The list of enabled providers is `enabledMailProviders` (default
`["gmail"]`).

## When Something Goes Wrong

- An **auth failure** usually means the credentials have expired. The
  dashboard's auth-health card turns to a warning. See
  [Auth Failed](../../troubleshooting/auth-failed.md).
- A **classifier that keeps guessing wrong** — switch the model behind it
  from the Gmail Classification Model card on `/connections/mail`.

## Related

- [Connect a new mail account](../../guides/connect-a-new-mail-account.md)
- [Morning Routine](../routines/morning-routine.md)
- [Delegated Mode](../../concepts/delegated-mode.md)
