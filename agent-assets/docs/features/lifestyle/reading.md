---
schema_version: 1
slug: features/lifestyle/reading
title: Reading
id: reading
aliases:
  - reading list
  - books
  - read later
category: features
summary: |
  Track books and Kindle highlights in a SQLite-backed reading list
  surfaced at /reading. The schema covers title/author/status plus a
  separate reading_highlights table populated from Kindle clipping
  imports.
section: lifestyle
tags:
  - lifestyle
  - reading
  - memory
status: stable
ask_examples:
  - How do I add a book to my reading list?
  - Can the agent recommend something from my reading list?
  - Where do reading-list items get stored?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - reading
  - books
  - articles
  - read later
related:
  - features/memory-files/user-profile
  - features/lifestyle/receipts
  - features/lifestyle/travel-bookings
ui_anchors:
  - /reading
---

# Reading

## In One Sentence

A reading list backed by the `books` and `reading_highlights` SQLite
tables: imports Kindle clippings, tracks status (`reading`/`finished`/etc.),
and surfaces the working set at `/reading`.

## What It Does

- **Add** items by DM ("agent, add 'The Soul of a New Machine' to my
  reading list") — the agent inserts into `books` via the daemon
  `/api/books` route.
- **Import Kindle highlights** via `POST /api/books/import-clippings`,
  which parses a `My Clippings.txt` paste and populates the
  `reading_highlights` table linked back to `books.id`.
- **List** what's outstanding on `/reading`.
- **Mark complete** — the agent updates the row's `status` and
  `completed_at` columns.
- **Recommend** from the list during reactive turns when context
  invites it.

There is no Markdown context file for the reading list; the durable
record is the SQLite row. If you want a parallel copy in your external
Obsidian or Notion vault, ask the agent to write one — the list itself
stays canonical in the database.

## When It Runs / How It Is Triggered

Reactive only. There is no autonomous reading-list routine in the
default install — the operator drives the list shape.

## What It Outputs

- Rows in the `books` table (with status, dates, optional rating /
  notes) and linked rows in `reading_highlights`.
- A clean operator-facing view on `/reading`.

## Where in the Dashboard

- **Reading (`/reading`)** is the operator surface.

## When Something Goes Wrong

- A **missing add**: check the Activity row's tool calls — the agent
  hits `/api/books`, so a network or quota error there will surface in
  the audit log even when the chat reply looked fine.

## Related

- [Receipts](receipts.md)
- [Travel Bookings](travel-bookings.md)
