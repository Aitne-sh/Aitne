---
kind: reference
name: calendar-outlook
description: Outlook Calendar reference (Microsoft Graph) — read-only on-demand. Same query shape as Google. Stripped when `outlook_calendar` is not configured.
---

<!-- service:outlook-calendar -->
## Outlook Calendar (Microsoft Graph)

Use this section **only when `rules/management.md` Schedule = Outlook Calendar**. The provider-routing table at the top of this skill is non-negotiable.

v1 is **read-only and on-demand** — there is no Outlook calendar poller, so `schedule.approaching` events do not fire for Outlook calendars (the user's own Outlook clients fill that gap). Write surfaces (create / update / delete) are deferred. If the user asks the agent to schedule or change an Outlook event, tell them you can read the calendar but must defer the write to them.

OAuth is **shared with Outlook Mail** via the same MSAL cache row (`mail:outlook:<accountId>`) — if Outlook Mail is configured `direct` and authenticated, calendar reads succeed with no second consent.

### List events
```bash
curl -s "http://localhost:8321/api/calendar/outlook/events?date=today&days=3"
```
Same query params as Google (`date`: `YYYY-MM-DD` or `today`; `days`: 1–90; optional `calendarId`). Returns `{ events: [...], accountId }`.

### List calendars
```bash
curl -s http://localhost:8321/api/calendar/outlook/calendars
```
Returns `{ calendars: [...], accountId }`. The user's primary calendar is marked `primary: true`.

### Outlook Calendar error envelope

| HTTP | `error` | What it means / what to do |
|---|---|---|
| 400 | bad query | Malformed `date` or `days` value. |
| 502 | `calendar_error` | Upstream Microsoft Graph error — `message` carries wire text. |
| 503 | `outlook_not_configured` | No authenticated Outlook account. Direct OAuth credentials missing. |
| 503 | `outlook_calendar_disabled` | The user toggled Outlook Calendar off in Settings → Calendar. Tell the user and stop. |
<!-- /service:outlook-calendar -->
