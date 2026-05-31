---
schema_version: 1
slug: guides/change-which-model-handles-x
title: Change Which Model Handles X
id: change-which-model-handles-x
aliases:
  - per-process tier
  - per-process model
  - pin a process key
category: guides
summary: |
  Pin a single ProcessKey to a non-default backend or model tier — for
  example, move the evening review onto Opus (high tier) for deeper
  reasoning, or run a routine on Codex while Claude stays the default.
section: change-which-model-handles-x
tags:
  - guide
  - backends
  - operations
  - routing
status: stable
ask_examples:
  - How do I make one routine use Opus instead of Sonnet?
  - How do I pin the evening review to a different backend?
  - Can I change the model for just one ProcessKey?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - per-process model
  - /settings/models
  - process binding
  - tier override
  - change model
  - pin process key
related:
  - guides/switch-default-backend
  - concepts/backends-and-tiers
  - concepts/process-keys
ui_anchors:
  - /settings/models
  - /activity
process_keys:
  - routine.morning_routine
  - routine.evening_review
  - message.dm
  - dashboard.docs_qa
  - delegated_task_heavy
config_keys:
  - delegatedTaskHeavyEnabled
---

# Change Which Model Handles X

## Goal

Override the default backend or model tier for a **single** ProcessKey
without changing the global default. Use this when one surface needs a
stronger (or cheaper) model than the seeded default — for example,
pinning the evening review to Opus (high tier), or pushing a noisy
delegated routine onto Gemini to save Claude quota.

## Steps

1. Open `/settings/models`.
2. Find the ProcessKey row in the per-process table (e.g.
   `routine.evening_review`).
3. Set its **main backend** and **tier** explicitly. The tier maps to a
   model class — `lite` → Haiku-class, `medium` → Sonnet-class,
   `high` → Opus-class. Optionally set a **fallback** backend too.
4. Save. The row is now marked operator-edited and will keep your pin
   through a defaults reset (only an install-time `force` re-seed
   overwrites it).

## Concrete Example

To give the evening review deeper reasoning, set
`routine.evening_review` → main `claude`, tier `high`. The next evening
run resolves to **Opus 4.8** instead of the default Sonnet 4.6. The
execution budget for that run also scales with the tier (high tier
carries a larger turn / cost envelope than medium).

## Verification

- The next fire of that ProcessKey shows the new backend and model in
  the **Activity** event detail (after fallback resolution).

## Caveats

- **`dashboard.docs_qa` is tier-locked to `medium`** — a high/lite pin
  on that row is ignored by the router. It also inherits its backend
  from `message.dm`'s pin.
- **High tier is opt-in, not auto-selected.** No install-time-seeded
  surface defaults to high; the only `high`-tagged ProcessKey shipped is
  `delegated_task_heavy`, gated behind the `delegatedTaskHeavyEnabled`
  config flag. Any *other* ProcessKey can still be pinned to high here.
- **On Codex and Gemini there is no separately-seeded high model** —
  their high tier collapses to the medium model, so pinning those
  backends to high won't change the model unless you pick a specific
  higher model in the row.
- To change the backend for *every* ProcessKey at once, use the global
  default instead — see Related.

## Related

- [Switch the Default Backend](switch-default-backend.md)
- [Backends and Tiers](../concepts/backends-and-tiers.md)
- [Process Keys](../concepts/process-keys.md)
