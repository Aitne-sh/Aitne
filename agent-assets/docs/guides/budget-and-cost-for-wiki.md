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
  - guide
  - wiki
  - cost
status: stable
ask_examples:
  - How much does !compile full cost?
  - Why did !compile full need approval?
  - How do I raise the wiki approval threshold?
  - What does the pre-compile snapshot do?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - wiki budget
  - wiki cost
  - wiki cost gate
  - wiki approval
  - compile cost
related:
  - features/wiki/overview
  - features/wiki/commands
  - concepts/costs-and-quotas
  - troubleshooting/wiki-ingest-full-blocked
ui_anchors:
  - /settings/wiki
  - /approvals
---

# Wiki Budgets and Cost

The wiki ships with three cost knobs you can tune in
**Settings → Wiki**:

1. **Per-command model selector** for each of the three wiki
   processes (`wiki.ingest_url`, `wiki.compile`, `wiki.ask`).
   Defaults to your main backend at the medium tier; downgrade
   `wiki.ingest_url` to a lite tier if you ingest a lot of URLs.
2. **Per-process budget cap** (`max_budget_usd` on each row). The
   dispatcher's per-session budget envelope is the enforcer.
3. **Per-workspace `!compile full` approval threshold** (default
   $2.00). The dashboard cost estimator brackets the expected spend
   at 0.5× / 1× / 2× the assumed input-token count; if the
   pessimistic estimate breaches the threshold, the bang handler
   escalates to the approval queue instead of running autonomously.

## What the Estimator Does

`!compile full` is the most expensive wiki command because a full
rebuild touches every raw note. The estimator is **pure JS** — it
does not spawn an agent — and computes:

```
expected_usd = raw_count × avg_input_tokens_per_raw × $0.003 / 1k tokens
optimistic   = 0.5 × expected
pessimistic  = 2.0 × expected
```

Defaults: `avg_input_tokens_per_raw = 1500`, the unit cost matches
Sonnet 4.6's $3 / Mtoken input price. The bracket lets you see a
worst-case before approving.

## Where the Gate Fires

- **Below threshold**: the compile runs autonomously and you get a
  completion DM with actual spend.
- **Above threshold**: the bang handler inserts an `agent_schedule`
  row with `task_type='approval'` and DMs the estimate. The
  dashboard `/approvals` view (also reachable from Notifications)
  is where you click **Approve** — that flips the row to
  `approved_task` and the scheduler picks it up.

If you change your mind, hit **Deny** on the approval card — the row
flips to `skipped` and no agent session is spawned.

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

If your vault is not a git repo, the approval-gate DM appends
"no git backup taken" so you can decide whether to add one before
approving.

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
