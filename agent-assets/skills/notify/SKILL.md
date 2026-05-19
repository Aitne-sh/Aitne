---
name: notify
description: Load whenever composing user-facing text — DMs, notifications, briefings, replies, observer alerts. Owns awareness gate + /api/notify.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Notification Decision Guide

A bad notification (noisy, poorly timed, unclear) is worse than no notification.

## Universal user-facing message discipline

Every user-facing message — `/api/notify` call, `scheduled.dm`
final-text DM (Morning briefing), `scheduled.task` final-text DM,
message.received reply, observer alert — must clear the gates below.
Specific contracts (Morning briefing) layer additional rules on top;
nothing they say overrides a universal rule.

### Awareness gate

The user already knows their own calendar, their own course syllabus,
their own class times, and the events they themselves set up. Do NOT
read those items back to them. Lead with what the agent learned from
input the user could not passively see — new mail, new DM, calendar
delta, observation, conflict the agent detected, missing prep for a
known event.

Profile-specific carve-outs (e.g. how this gate applies to interactive
DM replies vs. daemon-initiated DMs) live in the matching persona
file's pointer line — see `agent-profiles/<profile>.md ## Principles`.

### No ceremony

The first user-visible line must be a specific fact the agent learned
or decided since the last message — not a greeting, label, routine
name, time-of-day opener, or summary header. If a line can be deleted
without losing information, delete it. **This rule is
language-agnostic** — it applies whatever language the agent uses
with the user.

Anti-examples (non-exhaustive — the positive rule above is
load-bearing, not this list): "Good morning!", "Evening check-in —",
"Morning briefing —", "Summary:", "Done.", "Sent.", "OK.", "Here's
your day:", "Heads-up —", "FYI:", "Quick update:". Near-synonyms of
these in any language also fail the positive rule.

### No internal mechanism names

Never mention `today.md`, `user/profile.md`, `roadmap.md`, `## Agent
Plan`, `## Agent Log`, `## Handoff`, `did-not-fire`, "Morning
Routine", "Evening Review", "scheduled.task", "scheduled.dm",
"dm_session", "sub_flow", or any other internal mechanism in
user-visible text. Those go in Agent Log only.

### No filler timing commentary

Forbidden — "Just a heads-up", "Still about N hours to go", "About N
hours left", "FYI". If timing matters, the deadline / event time
itself carries it.

### No table-of-contents readback

Forbidden patterns: "Schedule: ...", "Tasks: ...", "Notes: ...",
"Deadlines: ...". These enumerate the user's own data; they already
have it. (`scheduled.dm` Morning briefing has a section-labelled
output of its own — those labels are sanctioned by that contract; the
rule above bars *introducing* such enumeration in any other surface.)

### Language and style

Output language: follow `<output_language_policy>`. Tone: follow
`user/profile.md` Communication Style and the Character block in your
system prompt. Keep technical terms in original form.

### Compactness

Default to the shortest form that conveys the substance — 1–5 short
lines. No bullet list > 3 items unless the per-message contract
explicitly allows it (Morning briefing has its own caps).

## When to Notify

Notify when **all three** are true: (1) **actionable** or requires awareness, (2) **time-sensitive**, (3) user **not already aware** via another channel. Common: meeting reminders (15 min before), deadline alerts, task completions, error alerts, conversational replies. (Recurring DM-tone messages — Morning briefing — are delivered as the final assistant turn via `scheduled.dm`'s Morning briefing contract and do NOT use this API.)

## When NOT to Notify

- **Already notified on the same item today** — do a pre-flight dedup
  scan of `<today>` `## Agent Log` for `notify sent` / `DM sent` /
  `[cal] ... — reminder sent` referencing the same item within the
  last 4 hours. If the injected log is truncated (`[...N earlier
  entries omitted ...]` marker) and you can't rule out a prior
  notification, `GET /api/context/today` for the full log before
  firing. Duplicate notifications are the #1 cause of noise.
- **A pending Agent Plan row / scheduled DM is already set to fire
  for this item within the next 2 hours** — let the planned channel
  deliver; don't pre-empt it.
- **Quiet hours (default 22:00-08:00, configurable)** unless `critical` — schedule for after instead
- **Rate-limited (429)** — do NOT retry; log skip to Agent Log. If time-critical, upgrade priority at next opportunity
- **Routine file changes** or **agent internal state** — use Agent Log instead
- **When in doubt — prefer silence**

## Priority

**Default to `normal`.** Reserve `high` for 8h-delay-matters. Reserve
`critical` for 3am-matters. Full per-level table, examples, and
rate-limit caps are in the priority reference below.

{{> ref:priority }}

## Style

One notification per task, under 5 bullets, lead with the action, follow the Character block. Actionable > informational: "3 emails from boss — 1 asks for Q2 plan by EOD" beats "3 emails from boss".

## API Reference — POST /api/notify

```bash
curl -s -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message": "Design review starts in 15 minutes.", "priority": "normal"}'
```
Fields: `message` (required, markdown), `priority` (optional: critical/high/normal/low), `platform` (optional, override target).
Response: `{ "status": "sent", "notificationId": "..." }`. Risk tier: `Autonomous` — the agent decides when to notify; recorded in `notification_log` for the on-demand retrospective.
