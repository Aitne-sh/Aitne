---
kind: reference
name: today-skeleton
description: today.md full-skeleton detail for Morning Routine — day-type derivation, focus-dimension mapping, downstream focus-filter usage, per-section update matrix, and entry-format table. Only Morning Routine writes the full skeleton; DM/activity-scan events do not need this.
---

# today.md skeleton — derivation, sections, entry formats

Only the Morning Routine writes the full skeleton from scratch. DM
handlers, activity scans, and scheduled.task sessions patch individual
sections and do not need this detail — load it only when populating
line 2 or laying out the section bodies.

## Day-type derivation (Morning Routine at 04:00)

Line 2 is:

```
> Day type: {Weekday|Weekend} | Work focus: {on|off} | Study focus: {on|off} | Personal focus: {on|off}
```

1. Day-of-week from `<current_time>`. Weekday = Mon–Fri, Weekend = Sat–Sun (unless user/profile.md overrides).
2. Read `identity/profile.md` → ## Notification Preferences. Apply matching policy.
3. No explicit policy → default: weekday = all on, weekend = work off, study on, personal on.

Category → focus-dimension mapping:

| Category tag | Controlled by |
|---|---|
| `[work]` | Work focus |
| `[study]` | Study focus |
| `[personal]`, `[home]` | Personal focus |

How downstream events use the filter:
- Morning Routine suppresses items with focus `off` at generation time
- scheduled.task re-checks at fire time: if focus is off, skip + close as `skipped (focus off)`
- DM handler skips follow-ups on rows whose focus is off
- Activity scan drops observations whose focus is off
- schedule.approaching suppresses notifications for off categories

## Sections and when to update

| Section | When to update | Mode | Who writes |
|---|---|---|---|
| `user_schedule` | Morning from calendar; refresh after sync | PUT (Morning) / PATCH replace | Morning primary |
| `user_tasks` | Status changes, new tasks, activity-scan observations | PATCH append (new) / replace (flip) | Morning + event-driven |
| `agent_plan` | Morning lays out actions; activity scan adds new; scheduled.task flips `[x]` | PATCH append / replace (flip) | Morning + activity scan + scheduled.task |
| `agent_notes` | Look-ahead + day-time events | PATCH append | Morning (look-ahead) + event-driven |
| `agent_log` | Every non-trivial agent action | PATCH append | All events |
| `handoff` | Evening Review finalizes carry-overs | PATCH replace | Evening Review only |

## Entry formats

| Section | Format | Example |
|---|---|---|
| `user_schedule` | `- HH:MM[–HH:MM] <title> [category]` | `- 14:00–15:00 Design review [work]` |
| `user_tasks` | `- [ ] HH:MM <description> [category]` | `- [ ] 11:00 Finalize Q2 draft [work]` |
| `agent_plan` | `- [ ] HH:MM <action> [category] →<trigger>` | `- [ ] 08:55 DM reminder: standup [work] →DM` |
| `agent_notes` | see flavors in the `today` skill body | |
| `agent_log` | `- HH:MM <action description>` | `- 13:50 [cal] Design review — reminder sent` |

**Category tags**: `[work]`, `[study]`, `[personal]`, `[home]` — mandatory on Agent Plan rows (not decorative).

**Trigger tags** (Agent Plan only): `→DM`, `→notify`, `→check-in`, `→wake`

**HH:MM is mandatory** on User Tasks and Agent Plan rows. If no natural time: (1) deadline → 2h before, (2) calendar-adjacent → 15 min before, (3) otherwise → working-hours midpoint.
