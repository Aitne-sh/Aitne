---
kind: reference
name: travel-time-api
description: /api/travel-time reference — Google Maps Directions wrapper. Estimate door-to-door duration and compute departure time for a calendar event with location.
---

# `/api/travel-time` reference

Uses the Google Maps Directions API. Prerequisite: `googleMapsApiKey`
configured in the daemon's secret store, with the Directions API
enabled.

## GET /api/travel-time

Estimate travel time between two locations.

```bash
# Transit (default)
curl -s "http://localhost:8321/api/travel-time?origin=Grand+Central&destination=Times+Square"

# Driving with arrival time
curl -s "http://localhost:8321/api/travel-time?origin=Brooklyn&destination=Newark&mode=driving&arrival=2026-04-12T14:00:00-04:00"
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `origin` | string | (required) | Origin address or place name |
| `destination` | string | (required) | Destination address or place name |
| `mode` | string | transit | driving, transit, walking, bicycling |
| `arrival` | ISO 8601 | — | Desired arrival time (computes departure time) |

Response:

```json
{
  "origin": "Grand Central Terminal, NY",
  "destination": "Times Square, NY",
  "mode": "transit",
  "durationSeconds": 1380,
  "durationText": "23 mins",
  "distanceMeters": 8500,
  "distanceText": "8.5 km",
  "departBy": "2026-04-12T13:34:00.000Z"
}
```

## GET /api/travel-time/for-event/:eventId

```bash
curl -s "http://localhost:8321/api/travel-time/for-event/abc123?origin=Home&mode=transit"
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `origin` | string | (required) | Your starting location |
| `mode` | string | transit | Travel mode |

Response includes both `event` and `travelTime` blocks; see the route
implementation for full shape.
