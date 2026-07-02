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
updated: 2026-07-01
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

You ran `!compile full` and it stopped before doing anything, with one of
these replies. Jump to the section that matches what you saw:

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

This is the **git pre-compile gate**. Before a full rebuild, Aitne makes a
clean snapshot commit of your vault, so you can undo the whole compile in
one step later. It will not start when a git-tracked external vault still
has uncommitted changes (a "dirty" working tree), because that snapshot
would no longer be a clean baseline to revert to.

To proceed:

1. `git -C <vault> status` — review the dirty paths Aitne listed.
2. Commit or stash them: `git add -A && git commit -m "wip"` or
   `git stash -u`.
3. Re-run `!compile full`. On a clean tree Aitne makes the snapshot commit
   for you (`aitne wiki: pre-compile snapshot <ts>`) before the compile
   starts, and the reply shows its short SHA.

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

This is the **cost gate**. Before running, Aitne estimates what the compile
will cost. This estimate is just arithmetic over the files on disk — it
does not spend an agent session to work it out. The estimate DM looks like
this:

```
Full compile estimate for `my-wiki`:
- raw notes: 42
- est. input tokens: 51,300
- cost range: $0.08 (optimistic) – $0.31 (pessimistic), expected $0.15
- approval threshold: $2.00
```

If the **pessimistic** figure (`2× expected`) is above the per-workspace
approval threshold (default **$2.00**), the compile waits for your approval
instead of running right away.

### Approve or Deny

The waiting request shows up as a **pending approval** on the dashboard.
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
  field decides when a compile has to wait for approval. Raise it if
  routine recompiles keep stalling on a confirmation you would always say
  yes to.
- **Use a cheaper model.** In the **Commands & models** section, point
  `wiki.compile` at a lite-tier model. It defaults to the medium tier
  (Claude Sonnet 5), and the model's per-token price is the biggest factor
  in the estimate.
- **Trim the raw layer.** The estimate scans `10_raw/` and approximates
  the tokens in each file from its on-disk content, so the cost tracks the
  actual size of what you are compiling. Fewer or shorter raw notes lower
  the estimate directly.

> The estimate is a rough rule of thumb (≈4 characters per token for
> prose, denser for CJK), bracketed `0.5×`–`2×`. It is deliberately cheap
> rather than exact — close enough to gate spending without burning a
> session just to measure it.

## Not Enabled

If the reply is:

> Wiki is not enabled. Open `/settings/wiki` and enable the internal
> wiki workspace first.

you have no active workspace yet. On `/settings/wiki`, either click
**Enable internal wiki** to create the built-in workspace, or point Aitne
at an existing folder with **Use this folder** (once the path check
passes). Then re-run `!compile full`.

If the workspace exists but is archived, the page shows a **This wiki is
archived** card — click **Re-activate wiki** there first. No `!compile`
command will run until you do.
