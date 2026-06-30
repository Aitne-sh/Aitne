---
schema_version: 1
slug: troubleshooting/wiki-ingest-full-blocked
title: "`!compile full` Is Blocked"
id: wiki-ingest-full-blocked
aliases:
  - ingest full refused
  - wiki approval pending
  - wiki dirty tree refused
  - compile full uncommitted changes
category: troubleshooting
summary: |
  `!compile full` stopped before running and replied with one of three
  things: "uncommitted changes" (the git pre-compile gate), "Sent for
  approval" (the cost gate), or "Wiki is not enabled" (no workspace).
  This entry tells you how to clear each branch.
section: troubleshooting
tags:
  - troubleshooting
  - wiki
  - cost
  - git
  - approval
status: stable
ask_examples:
  - Why did !compile full refuse to run?
  - Where do I approve a pending wiki compile?
  - Why does !compile full want a clean git tree?
  - What does "Sent for approval" mean after !compile full?
locale: en-US
created: 2026-05-12
updated: 2026-05-28
keywords:
  - wiki compile blocked
  - compile cost gate
  - compile approval
  - full rebuild blocked
  - uncommitted changes
process_keys:
  - wiki.compile
api_endpoints:
  - GET /api/approvals
  - POST /api/approvals/:id/approve
related:
  - features/wiki/commands
  - features/wiki/cost-and-approval
  - guides/budget-and-cost-for-wiki
  - features/wiki/overview
prerequisites:
  - features/wiki/overview
ui_anchors:
  - /settings/wiki
  - /
---

# `!compile full` Is Blocked

## What You See

You ran `!compile full` and the bang reply was one of these. Jump to the
matching section:

- **"the external vault has uncommitted changes"** — the git pre-compile
  gate. See [Uncommitted Changes](#uncommitted-changes).
- **"Sent for approval"** — the cost gate. See [Sent for
  Approval](#sent-for-approval).
- **"Wiki is not enabled"** — no workspace exists. See [Not
  Enabled](#not-enabled).

## Uncommitted Changes

The full reply is:

> Cannot run `!compile full` — the external vault has uncommitted
> changes. Please commit or stash first. Dirty paths: …

This is the **git pre-compile gate** firing. Before a full rebuild,
Aitne wants to take a clean pre-compile snapshot commit so you can revert
the whole compile in one step. It refuses to start on an external
git-tracked vault whose working tree is dirty, because that snapshot
would no longer be a clean baseline.

To proceed:

1. `git -C <vault> status` — review the dirty paths Aitne listed.
2. Commit or stash them: `git add -A && git commit -m "wip"` or
   `git stash -u`.
3. Re-run `!compile full`. On a clean tree Aitne commits the snapshot
   itself (`aitne wiki: pre-compile snapshot <ts>`) before the compile
   starts, and the reply echoes the short SHA.

If you don't want the auto-commit, turn off **Auto-commit before
`!compile full`** on `/settings/wiki` (the toggle only appears for
git-tracked external vaults). Aitne then runs without taking a snapshot,
and the estimate reply says `pre-compile git snapshot: disabled by
setting`.

> Internal-mode wikis are not git-tracked — they snapshot through
> `md_file_snapshots` instead, so this gate never fires for them.

## Sent for Approval

The full reply ends with:

> Sent for approval. Open `/settings/wiki` → Approvals to confirm and the
> compile will start.

This is the **cost gate**. Before running, Aitne estimates the compile
cost (pure on-disk arithmetic — no agent session is spent). The estimate
DM looks like this:

```
Full compile estimate for `my-wiki`:
- raw notes: 42
- est. input tokens: 51,300
- cost range: $0.08 (optimistic) – $0.31 (pessimistic), expected $0.15
- approval threshold: $2.00
```

If the **pessimistic** bound (`2× expected`) exceeds the per-workspace
approval threshold (default **$2.00**), the compile is queued for
approval instead of running.

### Approve or Deny

The queued request shows up as a **pending approval** on the dashboard.
Open the dashboard overview (the home page `/`, also reached via the
`/approvals` shortcut) and use the **pending approvals** card:

- Click **Approve** to run the compile. Aitne re-checks the git tree and
  takes the pre-compile snapshot at that moment (so declining leaves your
  git log clean).
- Click **Deny** to drop it.

You can also approve from your DM channel by replying `yes` to the
request.

### If the estimate looks too high

You have three levers, all on `/settings/wiki`:

- **Raise the threshold.** The **Approval threshold for `!compile full`**
  field controls when a compile queues for approval. Bump it if routine
  recompiles keep stalling on a confirmation you'd always grant.
- **Use a cheaper model.** In the **Commands & models** section, point
  `wiki.compile` at a lite-tier model. It defaults to the medium tier
  (Claude Sonnet 5), whose per-token cost is the dominant variable in
  the estimate.
- **Trim the raw layer.** The estimate scans `10_raw/` and approximates
  tokens per file from on-disk content, so the cost tracks the actual
  size of what you're compiling. Compiling fewer or shorter raw notes
  lowers the bound directly.

> The estimate is a heuristic (≈4 chars per token for prose, denser for
> CJK), bracketed `0.5×`–`2×`. It is intentionally cheap rather than
> exact — close enough to gate spend without burning a session to
> measure it.

## Not Enabled

If the reply is:

> Wiki is not enabled. Open `/settings/wiki` and enable the internal
> wiki workspace first.

you have no active workspace row. On `/settings/wiki`, either click
**Enable internal wiki** to create the built-in workspace, or point Aitne
at an existing folder with **Use this folder** (after the path probe
passes). Then re-run `!compile full`.

If the workspace exists but is archived, the page shows a **This wiki is
archived** card — click **Re-activate wiki** there before any `!compile`
command will run.
