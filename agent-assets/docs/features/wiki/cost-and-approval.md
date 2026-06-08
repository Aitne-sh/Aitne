---
schema_version: 1
slug: features/wiki/cost-and-approval
title: Wiki Cost Estimation and Approval Flow
id: wiki-cost-and-approval
aliases:
  - wiki cost
  - wiki approval
  - !compile full approval
  - wiki cost gate
  - wiki cost estimate
  - wiki budget
  - wiki precompile snapshot
  - git pre-compile
category: features
summary: |
  How Aitne predicts the cost of a `!compile full` run, when the cost
  gate escalates to the dashboard approval queue, and how the
  pre-compile git snapshot interacts with both. Also covers the
  `--preview` dry-run and how the same estimator powers the
  per-workspace cost banner in `/settings/wiki`.
section: wiki
tags:
  - wiki
  - cost
  - approval
  - safety
  - core
status: stable
ask_examples:
  - How does !compile full estimate cost?
  - When does !compile full need approval?
  - How do I change the wiki approval threshold?
  - What happens if my Obsidian vault is dirty before !compile full?
  - Does !compile or !ingest need approval?
  - How accurate is the wiki cost estimate?
  - What is the pre-compile git snapshot?
  - Why is my !compile full sitting in /approvals?
  - Can I see the cost before running !compile full?
locale: en-US
created: 2026-05-21
updated: 2026-06-07
keywords:
  - cost estimate
  - cost bracket
  - 0.5x
  - 2x
  - bracketed cost
  - approval threshold
  - !compile full
  - approval queue
  - /approvals
  - dashboard approval
  - git pre-compile
  - pre-compile snapshot
  - dirty working tree
  - cost banner
  - compile preview
  - --preview
  - --dry-run
  - char to token
  - token approximation
  - CJK token ratio
related:
  - features/wiki/overview
  - features/wiki/commands
  - features/wiki/workspaces
  - features/operations/approvals
  - concepts/costs-and-quotas
  - guides/budget-and-cost-for-wiki
  - troubleshooting/wiki-ingest-full-blocked
ui_anchors:
  - /settings/wiki
  - /
api_endpoints:
  - /api/wiki/:workspace/estimate
  - /api/wiki/:workspace/compile/preview
  - /api/wiki/:workspace/git/status
  - /api/approvals
process_keys:
  - wiki.compile
config_keys:
  - full_compile_approval_threshold_usd
---

# Wiki Cost Estimation and Approval Flow

`!compile full` is the most expensive command in the wiki surface
because it touches every raw note in the workspace and rewrites the
canonical wiki pages from scratch. Aitne predicts the cost before
the run starts and gates the actual execution behind an approval
threshold you control per workspace.

The same estimator backs four surfaces so the numbers cannot drift:

- `GET /api/wiki/:workspace/estimate` — the dashboard banner in
  `/settings/wiki` reads from here so you can see what the next
  `!compile full` will cost before running it.
- `GET /api/wiki/:workspace/compile/preview` — the `--preview`
  dry-run.
- The `!compile` / `!compile full` bang handler — uses the same
  estimate to decide whether the run starts autonomously or
  escalates to approvals.
- The DM acknowledgement message — quotes the bracketed estimate
  back to the user.

## How the estimator works

Pure JS, no agent session, no SDK call. The estimator
(`packages/daemon/src/core/wiki/cost-estimate.ts`) opens each raw
note under `10_raw/`, approximates its token count from on-disk
content, then multiplies the total by the tier unit cost and
brackets with 0.5×/2× multipliers.

### Character → token approximation

- **Latin / English content** — ~4 chars per token. The well-known
  OpenAI rule-of-thumb; matches Anthropic's tokenizer within ±15%
  for prose; confirmed against the gpt-tokenizer dist.
- **CJK content** — ~1.5 chars per token. BPE merges short CJK runs
  but not as aggressively as Latin word fragments.

The classifier counts Unicode code points whose script is one of
Han, Hiragana, Katakana, Hangul, Bopomofo. If the document is
majority-CJK we apply the CJK divisor to the entire file; otherwise
Latin. A per-script split per file would be marginally more accurate
but adds 30% code for a sub-percent gain on typical mixed-script
files.

### The 0.5×/2× bracket

The estimator never returns a single number. It always returns three:

| Field | Meaning |
|---|---|
| `expectedUsd` | The point estimate: total approximated tokens × tier input cost. |
| `optimisticUsd` | 0.5× `expectedUsd` — the "everything compresses well, the LLM exits early" scenario. |
| `pessimisticUsd` | 2× `expectedUsd` — the "the LLM rewrites every page from scratch" scenario. **The approval gate compares this against your threshold.** |

The bracket is wide on purpose. `!compile` is an LLM and may merge
or skip pages inside the agent loop in ways the estimator cannot
predict from on-disk content alone — but the pessimistic bound will
not undercount the actual touch set.

(History: P2 originally shipped a flat `rawCount × 1500` heuristic.
P4.C upgraded to the per-file char→token approximation above because
the flat heuristic under-counted on long ingested articles and
over-counted on one-line stubs.)

## The cost gate

The `!compile full` flow:

1. **Estimate** — bang handler calls the estimator.
2. **Pre-compile snapshot** — on an external git-tracked vault with
   `git_pre_compile_enabled = 1` (the default) and a clean working
   tree, Aitne runs `git add -A && git commit -m "aitne wiki:
   pre-compile snapshot <ts>"` before continuing. A dirty tree
   refuses the operation — commit or stash first, then re-run.
3. **Threshold check** — if `pessimisticUsd` ≤ the workspace's
   `full_compile_approval_threshold_usd` (default $2.00), the run
   starts autonomously.
4. **Approval** — if `pessimisticUsd` > the threshold, the run is
   queued under the **Approvals** panel on the dashboard home (`/`).
   The acknowledgement DM links there; approve from the dashboard to
   start the compile.
5. **Completion** — a completion DM lands with the actual spend (not
   the estimate). Significant overshoots are flagged in the audit
   row.

`!compile` (incremental) does not go through the cost gate — it's
only invoked when raw notes have changed since the last compile, and
its budget envelope is bounded by the per-process `maxBudgetUsd`
(default $5.00). The same applies to `!ingest`, `!ask`, `!lint`,
`!trace`, `!connect`.

## Changing the threshold

Per workspace, in `/settings/wiki` — the **Approval threshold (USD)**
input. The value lives on `wiki_workspaces.full_compile_approval_threshold_usd`
and the PATCH endpoint validates it to the `$0`–`$100` range. Setting it
lower escalates more runs to manual approval; setting it higher trusts
the estimator more.

A common pattern: start at $2.00, watch the spend on the next
`!compile full`, then dial up or down based on how close the
estimate landed to the actual cost.

## The pre-compile git snapshot

Only meaningful on an **external + git-tracked** vault. The gate
decides:

| Workspace state | Outcome |
|---|---|
| Internal mode | Skip (`NotApplicable`). The `md_file_snapshots` mechanism is the recovery surface. |
| External, not a git repo | Skip (`NoBackup`). The approval-gate DM tells you no git backup was taken. |
| External + git, `git_pre_compile_enabled = 0` | Skip (`Disabled`). |
| External + git, **dirty** working tree | **Refused.** The bang handler aborts with a DM telling you to commit or stash first; no agent session is spawned. |
| External + git, clean working tree | Run `git add -A` + `git commit -m "aitne wiki: pre-compile snapshot <ts>"`. Operator git hooks fire as normal (no `--no-verify`). |

The snapshot is your rollback target if `!compile full` produces a
surprise — `git reset --hard <snapshot-commit>` puts the vault back.

The pre-compile commit uses no special author identity; it lands
under whatever git is configured to use. If you co-author with
Aitne, you'll want to set that up at the git config level.

## The `--preview` dry-run

`!compile --preview` (alias: `--dry-run`) calls
`GET /api/wiki/:workspace/compile/preview` to show what `!compile`
would do without spending tokens:

- **added** — wiki pages that would be created (raws with no
  existing wiki match).
- **modified** — wiki pages that would be rewritten (raws whose
  slug matches an existing wiki page).
- **unchanged** — wiki pages the compile is expected to skip.
- **est. cost** — Optimistic / pessimistic bracket plus expected
  spend.
- **est. duration** — Rough wall-clock estimate (intentionally
  pessimistic).

The preview is an upper bound for the same reason the cost bracket is
(the compile is an LLM and may merge or skip pages mid-loop), but it
will not undercount the touch set. Reply `!compile` (or `!compile
full`) to actually run.

The preview is free — no agent session runs, no tokens spent.

## See also

- [features/wiki/commands](commands.md) for the user-facing reference
  of every wiki bang command.
- [features/wiki/workspaces](workspaces.md) for where the per-workspace
  threshold and git toggle live in `/settings/wiki`.
- [features/operations/approvals](../operations/approvals.md) for the
  general dashboard approval flow.
- [guides/budget-and-cost-for-wiki](../../guides/budget-and-cost-for-wiki.md)
  for the operator-level "tune the budget" walkthrough.
