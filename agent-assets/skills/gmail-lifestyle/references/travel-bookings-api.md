---
kind: reference
name: travel-bookings-api
description: /api/travel-bookings reference — filter / upcoming / PATCH status for Gmail-observer-detected flight, hotel, train, restaurant, and bus reservations.
---

# `/api/travel-bookings` reference

The daemon's Gmail observer detects booking confirmation emails from
airlines, hotels, OTAs, restaurant reservation platforms, and rail
services. Data is stored in the `travel_bookings` SQLite table.

## GET /api/travel-bookings

```bash
# All bookings
curl -s "http://localhost:8321/api/travel-bookings?limit=20"

# Filter by type
curl -s "http://localhost:8321/api/travel-bookings?type=flight"

# Upcoming only
curl -s "http://localhost:8321/api/travel-bookings?status=upcoming"

# Date range
curl -s "http://localhost:8321/api/travel-bookings?from=2026-04-01&to=2026-05-01"
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | — | flight, hotel, restaurant, train, bus, other |
| `status` | string | all | upcoming, completed, cancelled, all |
| `from` | ISO date | — | Bookings with start_date on or after |
| `to` | ISO date | — | Bookings with start_date before |
| `limit` | number | 50 | Max results (1–200) |

Response:

```json
{
  "bookings": [
    {
      "id": 1,
      "type": "flight",
      "provider": "United",
      "destination": null,
      "startDate": "2026-05-15T10:30:00Z",
      "endDate": null,
      "confirmationNumber": "ABC123",
      "amount": 350,
      "currency": "USD",
      "status": "upcoming",
      "providerMsgId": "18f...",
      "createdAt": "2026-04-12T10:00:00Z"
    }
  ],
  "total": 1
}
```

## GET /api/travel-bookings/upcoming

Convenience endpoint, sorted by start date.

```bash
curl -s "http://localhost:8321/api/travel-bookings/upcoming?limit=10"
```

## PATCH /api/travel-bookings/:id

```bash
curl -s -X PATCH "http://localhost:8321/api/travel-bookings/1" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```
