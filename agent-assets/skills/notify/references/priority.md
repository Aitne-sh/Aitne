---
kind: reference
name: priority
description: Notification priority levels — critical / high / normal / low — with quiet-hours behavior and per-level examples.
---

# Notification priority levels

Pick the lowest priority that still preserves the user-visible
behavior the message needs. **Default to `normal`.**

| Priority | Quiet-hours | Use for |
|---|---|---|
| `critical` | Bypasses | Security alerts (credential leak, account lockout), data-loss risk (about to overwrite without backup, irreversible deletion in flight), system errors blocking the user from working. Wakes the user. |
| `high` | Bypasses | Hard deadlines firing in the next 8 hours, urgent inbound messages from people the user has flagged as priority, "meeting starting now". User wants to see this even during quiet hours but not at 3 am. |
| `normal` | Respects (dropped during quiet hours) | Regular reminders (`15 min until standup`), digest-style summaries, single-recipient FYIs the user opted into. **Default.** |
| `low` | Respects (dropped during quiet hours) | Background updates, observational FYIs the user did not explicitly ask for, optional context. Often better as an Agent Log entry instead of a notification at all. |

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

## Rate-limit defaults

3/hour, 12/day across all priorities (`critical` bypasses both caps).
The agent CANNOT query `notification_log` directly (Approve-tier). Use
`<today>` `## Agent Log` as the authoritative dedup source (look for
`notify sent` / `DM sent` lines).

A 429 response is final for this attempt — do NOT retry. Log `notify
skipped (rate_limited)` to Agent Log. If the message is time-critical
and the next opportunity arises, upgrade to `high` (or `critical` if
the situation has escalated) rather than re-sending at the same level.
