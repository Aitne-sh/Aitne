---
schema_version: 1
slug: troubleshooting/observation-not-detected
title: Observation Not Detected
id: observation-not-detected
aliases:
  - observation missing
  - no observations
  - polling broken
  - hourly check empty
category: troubleshooting
summary: |
  An expected change (commit, note, calendar move) didn't surface in
  the hourly check. Most often a polling delay, a vault/repo not
  watched, or the change was authored by the agent itself.
section: observation-not-detected
tags:
  - troubleshooting
  - observations
  - polling
status: stable
ask_examples:
  - Why didn't the agent notice my new commit?
  - Why didn't a calendar change show up?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - observation
  - polling
  - observer
  - AgentWriteTracker
  - hourly check
related:
  - concepts/observations
  - features/integrations/git
  - features/integrations/obsidian
  - features/routines/hourly-check
---

# Observation Not Detected

## What You See

- A change you made by hand, not echoed by the hourly check.
- The hourly check ran but did not mention it.

## Most Likely Causes

1. Poll has not yet fired since your change.
2. The repo / vault is not on the watched list.
3. The change was tagged `actor='agent'` (anti-loop filter).
4. Below the `hourlyCheckMinObservations` threshold.

## Diagnostic Steps

1. Confirm the integration's "last polled" timestamp on
   `/connections/...`.
2. Confirm the observed path is in the watched set.
3. Lower `hourlyCheckMinObservations` to test.

## Confirming the Fix

- Future changes record observations and surface in the next
  hourly check.

## Related

- [Observations](../concepts/observations.md)
