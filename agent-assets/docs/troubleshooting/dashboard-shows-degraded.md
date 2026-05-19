---
schema_version: 1
slug: troubleshooting/dashboard-shows-degraded
title: Dashboard Shows Degraded
id: dashboard-shows-degraded
aliases:
  - dashboard degraded
  - degraded pill
  - health pill red
  - health degraded
category: troubleshooting
summary: |
  The DegradedBanner appears at the top of every page when the daemon
  reports a critical-write block. Usually an integration auth failure
  or a context-file lock issue.
section: dashboard-shows-degraded
tags:
  - troubleshooting
  - operations
  - health
status: stable
ask_examples:
  - Why is the dashboard showing a degraded banner?
  - What does "writes are blocked" mean?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - degraded
  - health pill
  - /health
  - auth health
  - indexer degraded
related:
  - troubleshooting/auth-failed
  - features/memory-files/today
---

# Dashboard Shows Degraded

## What You See

- A red banner at the top of every page reading
  "Writes are blocked".
- Routines that write context files fail.

## Most Likely Causes

1. The today-write-lock did not release (rare; daemon was killed
   mid-write).
2. An integration auth failure that propagated.
3. The data directory ran out of disk.

## Diagnostic Steps

1. `aitne logs` — search for the most recent error.
2. Confirm `df -h` shows free space on the data directory.
3. Check for a stale lock file in `~/.personal-agent/`.

## Confirming the Fix

- The banner clears within 30 seconds of the underlying issue
  resolving.

## Related

- [Auth Failed](auth-failed.md)
