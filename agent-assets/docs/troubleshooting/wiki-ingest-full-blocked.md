---
schema_version: 1
slug: troubleshooting/wiki-ingest-full-blocked
title: "`!compile full` Is Blocked"
id: wiki-ingest-full-blocked
aliases:
  - ingest full refused
  - wiki approval pending
  - wiki dirty tree refused
category: troubleshooting
summary: |
  `!compile full` either refused with "uncommitted changes" (git
  pre-compile gate) or returned "Sent for approval" (cost gate).
  This entry tells you how to clear each branch.
section: wiki-ingest-full-blocked
tags:
  - troubleshooting
  - wiki
  - cost
  - git
status: stable
ask_examples:
  - Why did !compile full refuse to run?
  - Where do I approve a pending wiki compile?
  - Why does !compile full want a clean git tree?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - wiki ingest blocked
  - ingest cost gate
  - ingest approval
  - full rebuild blocked
related:
  - features/wiki/commands
  - guides/budget-and-cost-for-wiki
  - features/wiki/overview
ui_anchors:
  - /settings/wiki
  - /approvals
---

# `!compile full` Is Blocked

## What You See

You ran `!compile full` and the bang reply says either:

- "Cannot run `!compile full` — the external vault has uncommitted
  changes."
- "Sent for approval. Open `/settings/wiki` → Approvals to confirm
  and the compile will start."

## "Uncommitted Changes"

This is the **git pre-compile gate** firing. Aitne refuses to start
`!compile full` on an external git-tracked vault with a dirty working
tree because the pre-compile snapshot it would create can no longer
be a clean baseline.

To proceed:

1. `git -C <vault> status` — review the dirty paths Aitne listed.
2. Commit or stash them: `git add -A && git commit -m "wip"` or
   `git stash -u`.
3. Re-run `!compile full`. On a clean tree Aitne runs
   `git add -A && git commit -m "aitne wiki: pre-compile snapshot <ts>"`
   automatically.

If you don't want the auto-commit, disable **Auto-commit before
`!compile full`** in **Settings → Wiki** (only visible for
git-tracked external vaults). Aitne will then run without taking a
snapshot — and the approval-gate DM will explicitly say "no git
backup taken".

## "Sent for Approval"

The cost estimator's pessimistic bound (`2× expected`) exceeded the
per-workspace approval threshold (default $2.00). To approve:

1. Open the dashboard.
2. Go to **Settings → Wiki → Approvals** (or hit the **Approvals**
   notification card directly).
3. Review the estimate. Click **Approve** to run, **Deny** to skip.

If the estimate looks wrong, you have three levers:

- **Lower the avg input tokens** — the default 1500 is conservative
  for short raw notes; check whether your typical raw note is
  smaller.
- **Switch the `wiki.compile` model** to a lite tier in the
  per-command selector. Sonnet's per-token cost is the dominant
  variable.
- **Raise the threshold** in **Settings → Wiki** so routine
  recompiles don't queue an approval.

## "Not Enabled"

If `!compile full` replies "Wiki is not enabled", you have no active
workspace row. Run **Enable Internal Workspace** (or **Probe &
Create External**) on `/settings/wiki` first.
