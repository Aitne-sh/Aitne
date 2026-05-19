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
  A SQLite-backed log of receipt and invoice attachments the Gmail
  observer detects, plus an export path that saves them into the
  operator's external Obsidian vault for tax / reimbursement tracking.
section: lifestyle
tags:
  - lifestyle
  - receipts
  - mail
status: stable
ask_examples:
  - Where are my receipts stored?
  - How do I save a receipt to my Obsidian vault?
  - What does the receipts table track?
locale: en-US
created: 2026-04-25
updated: 2026-05-17
keywords:
  - receipt
  - invoice
  - expense
  - attachment
  - PDF
  - gmail receipts
related:
  - features/lifestyle/reading
  - features/lifestyle/travel-bookings
  - features/integrations/mail
---

# Receipts

## In One Sentence

Receipts are PDF / image attachments the Gmail observer flags as
receipts or invoices; their metadata lives in the `receipts` SQLite
table, and the agent can export the original file into your external
Obsidian vault on request.

## What It Does

- The Gmail observer auto-detects receipt / invoice attachments while
  scanning travel-booking and document mail.
- Each detection inserts a row into the `receipts` table
  (`provider_msg_id`, `attachment_id`, `filename`, `mime_type`,
  `size_bytes`, `category`, `obsidian_path`, `saved_at`, `account_id`).
- The agent surfaces summaries via the `/api/receipts` and
  `/api/receipts/summary` HTTP routes.
- On request, the agent downloads the attachment via
  `POST /api/receipts/:id/download`, writes it into the external
  Obsidian vault under `receipts/YYYY/MM/<merchant>-<date>.<ext>`, and
  patches the row's `obsidian_path` / `saved_at` columns.

There is no Markdown context file for receipts; the durable record is
the SQLite row plus the optional Obsidian copy.

## Where in the Dashboard

There is no dedicated tab today. Receipts surface inline when you ask
for them in chat (e.g. "what receipts haven't I saved yet?"). The
underlying API is documented in
`agent-assets/skills/gmail-lifestyle/references/receipts-api.md`
(loaded by the `gmail-lifestyle` skill).

## Configuration

The detection runs as part of the Gmail observer; see
[Mail](../integrations/mail.md). The Obsidian save path follows the
external vault convention `receipts/YYYY/MM/<merchant>-<date>.<ext>`.

## Related

- [Reading](reading.md)
- [Travel Bookings](travel-bookings.md)
- [Mail](../integrations/mail.md) — the source observer.
