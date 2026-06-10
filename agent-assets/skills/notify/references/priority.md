---
kind: reference
name: priority
description: Notification priority levels — critical / high / normal / low — as metadata you set, with per-level usage examples.
---

# Notification priority levels

`priority` is a metadata field you set on the `/api/notify` call. It
travels into `notification_log` and helps the user (and the
retrospective) gauge how urgent each message was. One level changes
delivery: `critical` bypasses the endpoint's quiet-hours deferral and
rate caps and always sends immediately — every other level rides the
gates below. Pick the lowest priority that still honestly describes
the message. **Default to `normal`.**

| Priority | Use for |
|---|---|
| `critical` | Security alerts (credential leak, account lockout), data-loss risk (about to overwrite without backup, irreversible deletion in flight), system errors blocking the user from working. The "wake the user at 3 am" tier. |
| `high` | Hard deadlines firing in the next 8 hours, urgent inbound messages from people the user has flagged as priority, "meeting starting now". Important but not 3 am. |
| `normal` | Regular reminders (`15 min until standup`), digest-style summaries, single-recipient FYIs the user opted into. **Default.** |
| `low` | Background updates, observational FYIs the user did not explicitly ask for, optional context. Often better as an Agent Log entry instead of a notification at all. |

## Examples by level

### `critical` — "3 am matters"

- `AWS console session was used from an IP not on your allowlist 5 min ago — review and rotate keys if not you.`
- `Backup job failed on the database for 3 consecutive runs — primary now 6 hours out of sync.`

If the user would not want the message to wake them, it is not `critical`.

### `high` — "8 hours delay matters"

- `Design review at 14:00 was just moved up to 11:00 — you have a conflicting meeting.`
- `Submission deadline for the grant is 5 pm today — draft still has 3 unresolved comments.`
- `Inbound DM from Sarah (priority contact): "Can you call before noon?"`

If the next morning would still be soon enough, it is not `high`.

### `normal` — the default

- `Standup starts in 15 minutes.`
- `Daily digest: 3 emails from boss, 1 asks for Q2 plan by EOD.`
- `Reminder you set yesterday for "call vet": now.`

### `low` — opt-in informational

- `Calendar found a 30-min slot at 16:00 today if you want to schedule the writeup.`
- `Build #4291 on develop turned green (you asked to be notified).`

If the user did not opt in to receiving this category of update, do not
send `low`. Drop it to an Agent Log entry instead.

## Delivery semantics

`/api/notify` returns one of three envelopes:

- `200 {status:"sent", ...}` — delivered to at least one channel right
  now. `"sent"` IS proof of delivery — do NOT re-post the same item on
  a 200. A total delivery failure THROWS and surfaces as HTTP 500 (not
  a silent 200-drop).
- `200 {status:"deferred_quiet_hours", scheduleId, deliverAfter}` —
  you fired inside the user's quiet hours; the message was queued as a
  scheduled DM that delivers at `deliverAfter` (quiet-hours end).
  Nothing was lost; do NOT re-post. Repeat calls from the same origin
  coalesce into the same pending DM. If the item will be stale by
  `deliverAfter`, `DELETE /api/schedule/{scheduleId}` and record it in
  `<today>` `## Agent Log` instead. `critical` priority bypasses this
  gate entirely.
- `429 {status:"rate_limited", retryAfter}` — the proactive hourly or
  daily notification cap is spent. Nothing was sent or queued. Do not
  retry-loop; drop the item to `<today>` `## Agent Log` (or escalate
  honestly to `critical` if it truly cannot wait).

Noise control is still YOUR job, not the endpoint's. The agent CANNOT
query `notification_log` directly (Approve-tier), so use `<today>`
`## Agent Log` as the authoritative dedup source (look for `notify
sent` / `DM sent` lines) and self-throttle before firing. Don't
re-send the same item at the same level; if the situation has
genuinely escalated, raise the priority metadata to reflect that.
