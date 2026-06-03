---
kind: reference
name: cross-check
description: Travel-bookings cross-check — match new roadmap event entries against /api/travel-bookings/upcoming before minting a [check] prep line.
---

# Travel-bookings cross-check

Before generating a new event entry — or a `[check] <date>: Confirm
…` line in an existing entry's Preparation Timeline — for
**accommodation** or **flights**, look up the user's actual booked
travel. If a matching booking already exists, the prep line is
redundant; mark it `completed` and surface the confirmation number in
Agent Notes instead.

## Query

```bash
curl -s 'http://localhost:8321/api/travel-bookings/upcoming?limit=50'
```

Response shape (one row per booking):

```json
{
  "bookings": [
    {
      "id": "<int>",
      "type": "flight" | "hotel" | "restaurant" | "train" | "bus" | "other",
      "provider": "<string>",
      "destination": "city / airport / property name",
      "startDate": "ISO8601 | YYYY-MM-DD | null",
      "endDate": "ISO8601 | YYYY-MM-DD | null",
      "confirmationNumber": "<string | null>",
      "amount": "<number | null>",
      "currency": "<string | null>",
      "status": "upcoming",
      "providerMsgId": "<string | null>",
      "createdAt": "ISO8601"
    }
  ],
  "total": "<int>"
}
```

## Match rules

A booking matches a roadmap event entry when **either**:

- The booking's `destination` substring-matches the event entry's
  `Destination:` field (case-insensitive, after stripping common
  prefixes / suffixes — "Paris" matches "Paris, FR" and "Paris CDG").
- The booking's `startDate` date falls within the event entry's
  `YYYY-MM-DD ~ MM-DD` header range (inclusive on both ends).

When a match is found:

1. Locate the matching `[check]` row in the event entry's Preparation
   Timeline.
2. Flip it to the completed-row grammar (`completed: <prep>
   <YYYY-MM-DD> confirmation #<conf>`), preserving the original
   `[tag]` and date.
3. Append a line to the entry's `**Agent Notes:**` block:
   `- Booking confirmed (<type>) — #<confirmationNumber>`.

## When no match exists

The `[check] <event_date - 28d>: Confirm <…> for <title>` line stays
in the Preparation Timeline. The morning routine will surface it as
an Agent Plan row when its date is within `today + 7d`.

## When NOT to run this cross-check

- Inside the morning routine when it is rebuilding `## Agent Action
  Plan` from scratch — the routine already has the bookings table
  loaded in its pre-pass and runs the match itself.
- For non-travel entries (work projects, deadlines, study sessions).
  Travel-bookings is a travel-specific source of truth.
- When `/api/travel-bookings/upcoming` returns an empty list — skip
  the match step entirely.
