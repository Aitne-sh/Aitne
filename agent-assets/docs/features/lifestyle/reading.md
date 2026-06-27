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
  separate reading_highlights table populated from Kindle imports
  (My Clippings.txt or an Export Notebook email).
section: lifestyle
tags:
  - lifestyle
  - reading
  - memory
status: stable
ask_examples:
  - How do I add a book to my reading list?
  - How do I import my Kindle highlights?
  - Can the agent recommend something from my reading list?
  - Where do reading-list items get stored?
locale: en-US
created: 2026-04-25
updated: 2026-06-07
keywords:
  - reading
  - books
  - highlights
  - kindle
  - read later
related:
  - features/memory-files/user-profile
  - features/lifestyle/receipts
  - features/lifestyle/travel-bookings
api_endpoints:
  - GET /api/books
  - PATCH /api/books/:id
  - POST /api/books/import-clippings
  - POST /api/books/import-notebook-html
ui_anchors:
  - /reading
---

# Reading

## In One Sentence

A reading list backed by the `books` and `reading_highlights` SQLite
tables: imports your Kindle highlights, tracks each book's status
(`reading`, `completed`, or `abandoned`), and surfaces the working set
at `/reading`.

## What It Does

- **Import Kindle highlights** — the primary way books enter the list.
  Two pipelines, both of which create any missing `books` rows and link
  every highlight back to `books.id` in the `reading_highlights` table:
  - `POST /api/books/import-clippings` parses a pasted `My Clippings.txt`.
  - `POST /api/books/import-notebook-html` parses the HTML of a Kindle
    "Export Notebook" email.
- **List** the library on `/reading` or via `GET /api/books`
  (filterable by `status` and `source`, paginated to 200 rows per call).
- **Mark complete or abandoned** — an existing row is updated via
  `PATCH /api/books/:id`. This is an **Approve-tier** write that requires
  an operator `Authorization: Bearer` token, so it is driven from the
  dashboard, not autonomously by the agent (an unauthenticated agent curl
  is rejected with **401** before the handler runs). Setting `status` to
  `completed` stamps `completed_at` automatically; you can also set a 1–5
  `rating` or `notes`.
- **Recommend** from the list during reactive turns, and refresh the
  reading-taste profile during the weekly review.

There is **no bare "add a book" endpoint** — new books arrive through the
two Kindle import pipelines above (or are created internally during an
import); `PATCH` only edits books that already exist. If you ask the
agent to "add a book" conversationally, it works from whatever import
data it has rather than minting a free-form row.

There is no Markdown context file for the reading list; the durable
record is the SQLite row. If you want a parallel copy in your external
Obsidian or Notion vault, ask the agent to write one — the list itself
stays canonical in the database.

## When It Runs / How It Is Triggered

There is no dedicated autonomous reading-list routine — the operator
drives the list shape. The reading skill loads in two situations:

- **Reactively**, when you mention a book or highlight in a DM.
- **From existing routines** — the morning routine can mention what
  you're currently reading, the weekly review refreshes the
  reading-taste profile, and the monthly review pulls reading progress
  for its reading report (it reads the existing taste profile but does
  not re-derive it).

## What It Outputs

- Rows in the `books` table (with status, dates, optional rating /
  notes) and linked rows in `reading_highlights`.
- A clean operator-facing view on `/reading`.

## Where in the Dashboard

- **Reading (`/reading`)** is the operator surface.

## When Something Goes Wrong

- **An import that produced no books**: check the Activity row's tool
  calls — the agent hits `/api/books/import-clippings` (or
  `/import-notebook-html`), so a parse failure, oversized payload, or
  network error there surfaces in the audit log even when the chat reply
  looked fine. A common cause is pasting a partial or non-Kindle
  clippings file, which yields zero parsed books.
- **An edit that didn't stick**: `PATCH /api/books/:id` is Approve-tier,
  so a request without a valid operator Bearer token is rejected with 401
  before the handler runs — book status/rating/notes corrections are made
  from the dashboard, not by an autonomous agent. Once authenticated, it
  returns 404 if the id doesn't exist and 400 for an invalid `status`
  (only `reading`, `completed`, `abandoned`) or an out-of-range `rating`
  (must be 1–5).

## Related

- [Receipts](receipts.md)
- [Travel Bookings](travel-bookings.md)
