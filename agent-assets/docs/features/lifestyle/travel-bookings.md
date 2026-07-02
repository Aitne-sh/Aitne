---
schema_version: 1
slug: features/lifestyle/travel-bookings
title: Travel Bookings
id: travel-bookings
aliases:
  - travel
  - bookings
  - flights
  - hotels
  - trains
category: features
summary: |
  A log of trips, flights, hotels, restaurants, and confirmation
  numbers that the agent builds automatically from booking-confirmation
  emails. The morning routine surfaces upcoming travel.
section: lifestyle
tags:
  - lifestyle
  - mail
  - integrations
status: stable
ask_examples:
  - How does the agent track my flights and hotels?
  - Will the agent remind me about my upcoming trip?
  - Where are my travel bookings stored?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - flight
  - hotel
  - booking
  - trip
  - itinerary
  - trains
  - restaurants
  - confirmation number
related:
  - features/integrations/mail
  - features/lifestyle/receipts
  - features/routines/morning-routine
api_endpoints:
  - /api/travel-bookings
  - /api/travel-bookings/upcoming
process_keys:
  - gmail_classify
  - routine.morning_routine
ui_anchors:
  - /trip
---

# Travel Bookings

## In One Sentence

A trip log the agent builds automatically from booking-confirmation
emails, surfaced by the morning routine on travel days.

## What It Does

The mail observer watches your connected mail accounts for booking
confirmations from airlines, hotels, online travel agencies, restaurant
reservation platforms, and rail/bus services. When a message is
classified as travel, the daemon extracts the details and stores a row
in the `travel_bookings` SQLite table:

- **Type** — `flight`, `hotel`, `restaurant`, `train`, `bus`, or `other`.
- **Provider** — e.g. the airline or hotel chain.
- **Dates** — `start_date` and (where present) `end_date`.
- **Confirmation number**, **amount**, and **currency**.

Each booking is keyed by its source message, so re-reading the same
confirmation email never creates a duplicate row.

## How Bookings Get Created

Bookings come from email only — there is no manual "log a flight"
command or DM shortcut. To start capturing travel, connect a mail
account (see [Mail](../integrations/mail.md)) and let the classifier
do the rest. The flow is:

1. The mail poller fetches new messages.
2. The classifier (`gmail_classify`, lite tier) tags travel
   confirmations.
3. The daemon parses the booking and inserts it into `travel_bookings`.

## Where Bookings Surface

- **Morning routine.** On travel days the morning routine
  (`routine.morning_routine`) surfaces upcoming trips in your briefing.
  A booking with a `start_date` within roughly the last 30 days (or in
  the future) keeps the travel-aware briefing helpers active.
- **Trip page.** The dashboard `/trip` page is the eventual home for an
  itinerary timeline view. It is a placeholder while that view is built
  — the underlying data already lives in the database and is reachable
  via the API below.

## API

These endpoints give read and status-update access. The two read
endpoints are read-sensitive, because they expose personal travel data.
The `PATCH` endpoint follows the standard write-safety tier, so it
requires approval before it runs.

```bash
# All bookings (optionally filter by type/status/date range)
curl -s "http://localhost:8321/api/travel-bookings?type=flight&limit=20"

# Upcoming only, sorted by start date
curl -s "http://localhost:8321/api/travel-bookings/upcoming?limit=10"

# Mark a booking completed
curl -s -X PATCH "http://localhost:8321/api/travel-bookings/1" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

Filters on `GET /api/travel-bookings`: `type`
(`flight|hotel|restaurant|train|bus|other`), `status`
(`upcoming|completed|cancelled|all`), `from` / `to` (ISO date on
`start_date`), and `limit` (1–200, default 50).
