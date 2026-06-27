---
schema_version: 1
slug: features/lifestyle/receipts
title: Receipts
id: receipts
aliases:
  - receipts
  - invoices
  - expenses
  - receipt files
category: features
summary: |
  A SQLite-backed log of receipt and invoice attachments the mail
  observer detects, plus an export path that saves them into the
  operator's external Obsidian vault for tax / reimbursement tracking.
section: lifestyle
tags:
  - lifestyle
  - receipts
  - mail
  - integrations
status: stable
ask_examples:
  - Where are my receipts stored?
  - How do I save a receipt to my Obsidian vault?
  - What does the receipts table track?
  - What receipts haven't I saved yet?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - receipt
  - invoice
  - expense
  - attachment
  - PDF
  - gmail receipts
api_endpoints:
  - GET /api/receipts
  - GET /api/receipts/summary
  - POST /api/receipts/:id/download
  - PATCH /api/receipts/:id
related:
  - features/lifestyle/reading
  - features/lifestyle/travel-bookings
  - features/integrations/mail
---

# Receipts

## In One Sentence

Receipts are attachments (typically PDFs or images) the mail observer
detects while scanning your mail; their metadata lives in the
`receipts` SQLite table, and the agent can save the original file into
your external Obsidian vault on request.

## How Detection Works

The mail observer scans travel-booking emails across every connected
mail account and records each attachment it finds. Each detected
attachment inserts a row into the `receipts` table, keyed uniquely on
`(account_id, provider_msg_id, attachment_id)` so re-scans are
idempotent. Columns:

- `category` — `travel` at detection time; reclassify to `document`
  via PATCH (nullable on legacy rows)
- `provider_msg_id`, `attachment_id`, `account_id` — locate the source
  attachment in the unified mail registry
- `filename`, `mime_type`, `size_bytes` — attachment metadata
- `obsidian_path`, `saved_at` — `NULL` until you save the file to your
  vault (see below)
- `id`, `created_at` — row identity and detection time

There is no Markdown context file for receipts; the durable record is
the SQLite row plus the optional Obsidian copy.

## Saving a Receipt to Your Vault

Saving is a two-step flow — the download endpoint never writes to the
vault by itself:

1. The agent downloads the original bytes via
   `POST /api/receipts/:id/download`, which streams the raw attachment
   (resolved through the mail registry by `account_id`; oversized files
   over 100 MB and orphaned rows with a null `account_id` are rejected).
2. The agent writes the file into your **external** Obsidian vault — not
   the primary management vault — under the convention
   `receipts/YYYY/MM/<merchant>-<date>.<ext>` (e.g.
   `receipts/2026/04/amazon-2026-04-12.pdf`), then records that path
   with `PATCH /api/receipts/:id` (body `{"obsidianPath": "..."}`),
   which also stamps `saved_at`.

To reclassify a receipt, the agent PATCHes `{"category": "travel"}`
(or `"document"`).

## Where in the Dashboard

There is no dedicated tab today. Receipts surface inline when you ask
for them in chat (e.g. "what receipts haven't I saved yet?"). List and
filter them with `GET /api/receipts` (`category`, `saved`, `limit`
params) and pull totals from `GET /api/receipts/summary`. The full API
is documented in
`agent-assets/skills/gmail-lifestyle/references/receipts-api.md`
(loaded by the `gmail-lifestyle` skill).

## Configuration

Detection runs as part of the mail observer; see
[Mail](../integrations/mail.md). The save target follows the external
vault convention `receipts/YYYY/MM/<merchant>-<date>.<ext>`.

## Related

- [Reading](reading.md)
- [Travel Bookings](travel-bookings.md)
- [Mail](../integrations/mail.md) — the source observer.
