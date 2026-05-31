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
  - guides
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
updated: 2026-05-28
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

The wiki ships with three cost knobs you can tune in
**Settings → Wiki** (`/settings/wiki`):

1. **Per-command model selector** for each wiki process. The model
   picker covers the full set: `wiki.ingest_url`, `wiki.compile`,
   `wiki.ask`, plus the operational triad `wiki.lint`, `wiki.trace`,
   `wiki.connect`. Each defaults to your main backend at the medium
   tier; downgrade `wiki.ingest_url` to a lite tier if you ingest a
   lot of URLs.
2. **Per-process budget cap** (`max_budget_usd` on each row). The
   dispatcher's per-session budget envelope is the enforcer.
3. **Per-workspace `!compile full` approval threshold** (default
   $2.00, range $0–$100). The cost estimator brackets the expected
   spend at 0.5× / 1× / 2× the estimated input-token count; if the
   pessimistic (2×) estimate breaches the threshold, the bang handler
   escalates to the approval queue instead of running autonomously.

## What the Estimator Does

`!compile full` is the most expensive wiki command because a full
rebuild touches every raw note. The estimator is **pure JS** — it
does not spawn an agent (spawning one to estimate would itself burn
budget). It walks the `10_raw/` layer, approximates each file's token
count from its on-disk character count, sums the total, and brackets:

```
expected_usd = total_estimated_input_tokens / 1000 × $0.003
optimistic   = 0.5 × expected
pessimistic  = 2.0 × expected
```

Per-file token approximation is script-aware: ~4 characters per token
for Latin/prose, ~1.5 for majority-CJK files, with a 200-token floor
per file so empty or one-line stubs still account for the fixed
per-call overhead (system prompt, skills bundle, tool docs). The unit
cost (`$0.003` per 1k tokens) matches Claude Sonnet 4.6's ~$3 /
Mtoken input price. The bracket lets you see a worst case before
approving.

> The dashboard surfaces the top raw files by estimated token count,
> so you can see which sources dominate the bill before approving.
> An older flat heuristic (`raw_count × 1500 tokens`) survives as an
> opt-in fallback for deterministic banner copy, but the default is
> the per-file character scan described above.

## Where the Gate Fires

- **Below threshold**: the compile runs autonomously and you get a
  completion DM with actual spend.
- **Above threshold**: the bang handler inserts an `agent_schedule`
  row with `task_type='approval'`, DMs you the estimate, and pauses.
  The request shows up as an **Approvals** card on the dashboard home
  page (`/`); the `/settings/wiki` page also points you there.
  Clicking **Approve** flips the row to `task_type='approved_task'`
  and the scheduler picks it up — only then is the pre-compile git
  snapshot taken (see below) and the compile session spawned.

If you change your mind, hit **Deny** on the approval card — the row
flips to `skipped`, no git commit is made, and no agent session is
spawned.

## Git Pre-Compile Snapshot

On an external workspace that is a git repo and has **Auto-commit
before `!compile full`** enabled, Aitne runs:

```
git -C <vault> status --porcelain
# must be empty — dirty trees refuse the operation entirely
git -C <vault> add -A
git -C <vault> commit -m "aitne wiki: pre-compile snapshot <ISO-8601-ts>"
```

before the compile session starts. The commit message is
deterministic so you can roll back with `git reset --hard HEAD~1` if
the compile produces a surprise. The `--no-verify` flag is not used —
your pre-commit hooks run as normal.

The estimate DM tells you which snapshot path applies:
**"will commit before compile starts"** (clean repo), **"not taken
(no git repo)"**, **"disabled by setting"** (auto-commit off), or
**"not applicable"** for internal-mode workspaces — those recover via
`md_file_snapshots` instead of git. When no git backup will be taken,
you can decide whether to add one before approving.

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
