---
schema_version: 1
slug: features/routines/hourly-check
title: Hourly Check
id: hourly-check
aliases:
  - hourly
  - observation consumer
category: features
summary: |
  A light-tier routine that fires every hour during active hours and
  consumes accumulated observations from the polling integrations.
section: routines
tags:
  - routines
  - autonomous
  - light-tier
status: stable
ask_examples:
  - What does the hourly check do?
  - When does it run?
  - How do I tune the threshold?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - hourly
  - observations
  - polling
related:
  - concepts/observations
  - concepts/routines
process_keys:
  - routine.hourly_check
config_keys:
  - hourlyCheckEnabled
  - hourlyCheckIntervalMinutes
  - hourlyCheckActiveStartHour
  - hourlyCheckActiveEndHour
  - hourlyCheckMinObservations
---

# Hourly Check

## In One Sentence

A light-tier routine that empties the observations queue and decides
whether the accumulated changes warrant a notification.

## What It Does

- Reads pending `observations` rows.
- Decides whether the pattern adds up to something worth surfacing.
- Either appends to `today.md` or sends a notification (or both).

## When It Runs / How It Is Triggered

Every `hourlyCheckIntervalMinutes` (default 60), inside the active
window (`hourlyCheckActiveStartHour` to `hourlyCheckActiveEndHour`).
Skips when the morning routine is in progress; an atomic flag
prevents two hourly checks from running at once.

## What It Outputs

- Updates to `today.md`.
- Notifications when warranted.

## Configuration

| Setting | Default |
|---|---|
| `hourlyCheckEnabled` | true |
| `hourlyCheckIntervalMinutes` | 60 |
| `hourlyCheckActiveStartHour` | 4 |
| `hourlyCheckActiveEndHour` | 24 (end-exclusive, ≡ midnight) |
| `hourlyCheckMinObservations` | 1 |

## When Something Goes Wrong

- Skipped hourly checks below the min-observations threshold are
  expected. The daemon log shows the skip reason.

## Related

- [Observations](../../concepts/observations.md)
