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
updated: 2026-07-01
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

Change the backend or model tier for a **single** ProcessKey — the label
the agent gives to one kind of work, such as `routine.evening_review` —
without touching the global default. Reach for this when one job needs a
stronger (or cheaper) model than the shipped default: pin the evening
review to Opus (high tier), or push a noisy delegated routine onto Gemini
to save your Claude quota.

## Steps

1. Open `/settings/models`.
2. Find the ProcessKey row in the per-process table (e.g.
   `routine.evening_review`).
3. Set its **main backend** and **tier** explicitly. Each tier picks a
   model class — `lite` → Haiku-class, `medium` → Sonnet-class,
   `high` → Opus-class. You can also set a **fallback** backend to use if
   the main one is unavailable.
4. Save. The row is now marked operator-edited, so it keeps your pin
   through a defaults reset — only an install-time `force` re-seed
   overwrites it.

## Concrete Example

To give the evening review deeper reasoning, set
`routine.evening_review` → main `claude`, tier `high`. The next evening
run then uses **Opus 4.8** instead of the default Sonnet 5. The run's
budget scales with the tier too — high tier carries a larger turn and
cost envelope than medium.

## Verification

- The next time that ProcessKey runs, its **Activity** event detail
  shows the new backend and model (after fallback resolution).

## Caveats

- **`dashboard.docs_qa` is tier-locked to `medium`** — the router
  ignores a high or lite pin on that row. It also takes its backend from
  whatever `message.dm` is pinned to.
- **High tier is opt-in, never auto-selected.** No shipped surface
  defaults to high. The only `high`-tagged ProcessKey out of the box is
  `delegated_task_heavy`, and that stays behind the
  `delegatedTaskHeavyEnabled` config flag. You can still pin any *other*
  ProcessKey to high here.
- **Codex and Gemini ship no separate high model.** On those backends
  the high tier falls back to the medium model, so pinning them to high
  changes nothing unless you also pick a specific higher model in the
  row.
- To change the backend for *every* ProcessKey at once, use the global
  default instead — see Related.

## Related

- [Switch the Default Backend](switch-default-backend.md)
- [Backends and Tiers](../concepts/backends-and-tiers.md)
- [Process Keys](../concepts/process-keys.md)
