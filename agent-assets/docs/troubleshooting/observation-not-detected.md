---
schema_version: 1
slug: troubleshooting/observation-not-detected
title: Observation Not Detected
id: observation-not-detected
aliases:
  - observation missing
  - no observations
  - polling broken
  - activity scan empty
category: troubleshooting
summary: |
  An expected change (commit, note, calendar move) didn't surface in
  the activity scan. Most often a polling delay, a vault/repo not
  watched, or a change the agent authored itself (filtered out).
section: troubleshooting
tags:
  - observations
  - polling
status: stable
ask_examples:
  - Why didn't the agent notice my new commit?
  - Why didn't a calendar change show up?
  - Why is the activity scan empty?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - observation
  - polling
  - observer
  - AgentWriteTracker
  - activity scan
related:
  - concepts/observations
  - features/routines/activity-scan
  - features/integrations/git
  - features/integrations/obsidian
config_keys:
  - activityScanMinObservations
  - activityScanEnabled
  - activityScanIntervalMinutes
process_keys:
  - routine.activity_scan
ui_anchors:
  - /connections/repositories
  - /connections/calendar
  - /agents/activity-scan
context_files:
  - state/today.md
---

# Observation Not Detected

You made a change by hand — a commit, an Obsidian note, a calendar move — and
expected the agent to notice it on the next activity scan. It didn't.

This is almost always one of four things: the poller hasn't run yet, the
source isn't being watched, the agent itself made the change (so it was
filtered out), or there weren't enough observations to clear the activity-scan
gate. Work through them in that order.

## How detection actually works

Observers (Obsidian, Git, Notion, Calendar) do **not** fire an event the
instant something changes. Instead they poll — check the source on a fixed
schedule — and each time they call `recordObservation(...)`, which appends a
row to the `observations` table. The activity scan later reads those rows in
one batch. So a "missing" observation is usually a row that was never written,
or one that was written but then filtered out.

`AgentWriteTracker` tags every change as either `actor='agent'` or
`actor='user'`. Changes the agent wrote itself are tagged `actor='agent'` and
skipped by the activity scan. This is a deliberate anti-loop filter: it keeps
the agent from reacting to its own output.

## Most likely causes

1. **The poll hasn't fired since your change.** Each integration runs on its
   own interval; a fresh change can sit for several minutes before the next
   poll picks it up.
2. **The repo / vault / calendar isn't on the watched list.** If the source
   was never connected, nothing polls it.
3. **The change was tagged `actor='agent'`.** If the agent (not you) authored
   the commit or note, the anti-loop filter drops it.
4. **It was below the gate threshold.** The activity scan only runs its full
   pass once the number of pending observations reaches the activity-scan
   agent's **min observations** threshold (default `1`; legacy key
   `activityScanMinObservations`). A single low-signal change can be held back.

## Diagnostic steps

1. **Check the "last polled" timestamp.** On the relevant connection page —
   `/connections/repositories` for Git/GitHub, `/connections/calendar` for
   calendars, or the matching `/connections/...` page — confirm the source
   polled *after* you made the change. If the timestamp predates your change,
   you're just early; wait for the next poll.
2. **Confirm the source is watched.** Verify the repo/vault/calendar is
   actually connected and enabled on its connection page. A disabled or
   never-added source produces no observations.
3. **Rule out the agent-authored filter.** If the commit or note was written
   by the agent, that's expected — it's filtered by design. Look for a change
   *you* made by hand to test detection.
4. **Lower the gate threshold to test.** Temporarily set **Min
   observations** to `1` (its default) on the activity-scan agent's page
   (`/agents/activity-scan`, Definition tab → Cadence card)
   so even a single observation triggers the check, then make a manual change
   and wait for the next activity-scan run.

## Confirming the fix

After the next poll runs, a manual change you made should record an
observation and surface in the next activity scan. You can cross-check recent
agent activity from the CLI with `aitne audit`, which reads the `agent_actions`
log read-only.

## Related

- [Observations](../concepts/observations.md) — what gets recorded and why
- [Activity Scan](../features/routines/activity-scan.md) — the gate and its thresholds
- [Git integration](../features/integrations/git.md)
- [Obsidian integration](../features/integrations/obsidian.md)
