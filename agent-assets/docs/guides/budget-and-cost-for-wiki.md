---
schema_version: 1
slug: guides/budget-and-cost-for-wiki
title: Wiki Budgets and Cost
id: budget-and-cost-for-wiki
aliases:
  - wiki cost
  - wiki budget
  - "!compile full approval"
  - wiki approval threshold
category: guides
summary: |
  How the wiki estimates `!compile full` cost, when the approval gate
  fires, how the git pre-compile snapshot interacts with it, and how
  to tune the threshold.
section: budget-and-cost-for-wiki
tags:
  - wiki
  - cost
  - approval
status: stable
ask_examples:
  - How much does !compile full cost?
  - Why did !compile full need approval?
  - How do I raise the wiki approval threshold?
  - What does the pre-compile snapshot do?
locale: en-US
created: 2026-05-12
updated: 2026-07-01
keywords:
  - wiki budget
  - wiki cost
  - wiki cost gate
  - wiki approval
  - compile cost
  - compile full
related:
  - features/wiki/overview
  - features/wiki/commands
  - features/wiki/cost-and-approval
  - concepts/costs-and-quotas
  - troubleshooting/wiki-ingest-full-blocked
process_keys:
  - wiki.compile
  - wiki.ingest_url
  - wiki.ask
api_endpoints:
  - PATCH /api/wiki/workspaces/:workspace
  - POST /api/approvals/:id/approve
  - POST /api/approvals/:id/deny
ui_anchors:
  - /settings/wiki
  - /
---

# Wiki Budgets and Cost

This is the operator's walkthrough for keeping wiki spending under
control. For the deep mechanics — exactly how the estimate is
computed and how the approval gate decides — see
[features/wiki/cost-and-approval](../features/wiki/cost-and-approval.md).

The wiki gives you three cost knobs, all in **Settings → Wiki**
(`/settings/wiki`):

1. **Per-command model picker** — one model per wiki process. The
   picker covers `wiki.ingest_url`, `wiki.compile`, and `wiki.ask`,
   plus the operational trio `wiki.lint`, `wiki.trace`, and
   `wiki.connect`. Each starts on your main backend at the medium
   tier. If you ingest a lot of URLs, drop `wiki.ingest_url` to a lite
   tier to save money.
2. **Per-process budget cap** (`max_budget_usd` on each row). The
   dispatcher's per-session budget envelope enforces it.
3. **Per-workspace `!compile full` approval threshold** (default
   $2.00, range $0–$100). The estimator brackets the likely spend at
   0.5× / 1× / 2× the estimated input-token count; if the worst-case
   (2×) number crosses the threshold, `!compile full` asks for
   approval instead of running on its own.

## What the Estimator Does

`!compile full` is the most expensive wiki command because a full
rebuild touches every raw note. Before it runs, a small piece of
plain JavaScript estimates the cost — it never spawns an agent, since
spawning one just to estimate would itself burn budget. It walks the
`10_raw/` layer, approximates each file's token count from its size on
disk, and reports a low/high bracket so you can weigh a worst case
before you approve. For the exact character-to-token ratios and the
0.5× / 2× bracket math, see
[features/wiki/cost-and-approval](../features/wiki/cost-and-approval.md).

The unit cost (`$0.003` per 1k tokens) matches Claude Sonnet 5's ~$3
/ Mtoken standard input price. (An introductory $2 / Mtoken rate runs
through 2026-08-31; the estimate lists the standard rate, while the
SDK's billed `total_cost_usd` reflects the intro price during the
window.)

> The dashboard surfaces the top raw files by estimated token count,
> so you can see which sources dominate the bill before approving.

## Where the Gate Fires

- **Below threshold**: the compile runs on its own, and you get a
  completion DM with the actual spend.
- **Above threshold**: the compile pauses. It inserts an
  `agent_schedule` row with `task_type='approval'`, DMs you the
  estimate, and waits. The request shows up as an **Approvals** card
  on the dashboard home page (`/`); the `/settings/wiki` page also
  points you there. When you click **Approve**, the row flips to
  `task_type='approved_task'` and the scheduler picks it up — only
  then does Aitne take the pre-compile git snapshot (see below) and
  start the compile session.

Changed your mind? Click **Deny** on the approval card. The row flips
to `skipped`, no git commit is made, and no agent session runs.

## Git Pre-Compile Snapshot

On an external workspace that is a git repo and has **Auto-commit
before `!compile full`** enabled, Aitne commits the vault
(`git add -A && git commit`) just before the compile session starts,
giving you a rollback point. If the compile produces a surprise,
`git reset --hard HEAD~1` puts the vault back. A dirty working tree
refuses the operation entirely — commit or stash first, then re-run.
The commit runs your normal pre-commit hooks (the `--no-verify` flag
is not used).

The estimate DM tells you which snapshot path applies:
**"will commit before compile starts"** (clean repo), **"not taken
(no git repo)"**, **"disabled by setting"** (auto-commit off), or
**"not applicable"** for internal-mode workspaces — those recover via
`md_file_snapshots` instead of git. When no git backup will be taken,
you can add one yourself before approving.

For the full state-by-state table of what the snapshot gate does in
each workspace configuration, see
[features/wiki/cost-and-approval](../features/wiki/cost-and-approval.md).

## Tuning the Threshold

The default $2.00 threshold suits a small-to-medium personal wiki
(around 100–500 raw notes). If your wiki grows much larger, raise
the threshold so routine recompiles don't queue an approval every
time — or downgrade `wiki.compile` to the lite tier so the actual
spend stays low.

## When to Use `!compile` vs `!compile full`

- **`!compile` (default)**: incremental — touches only new and
  modified raw notes. Cheap, fast, runs autonomously. Use this in
  normal operation.
- **`!compile full`**: rebuilds everything. Use when you've changed
  the wiki schema, ingested a large batch of historical raw notes,
  or want to force a from-scratch synthesis after editing
  `90_meta/taxonomy.md`.
