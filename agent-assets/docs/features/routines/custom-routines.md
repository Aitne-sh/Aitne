---
schema_version: 1
slug: features/routines/custom-routines
title: Custom Routines (Retired)
id: custom-routines
aliases:
  - custom routine
  - cron routine
  - user routine
  - migrated_to_agent
category: features
summary: |
  Custom routines — cron-driven Markdown files under
  policies/routines/custom/ — are retired. User Agents replaced them.
  At the first daemon start after the upgrade, each valid custom
  routine was converted once into a user Agent with the same cron,
  tier, budget, and enabled state; the source file is kept but marked
  inert. Recurring work now lives on /agents.
section: routines
tags:
  - routines
  - agents
  - autonomous
  - scheduler
  - advanced
status: deprecated
ask_examples:
  - What happened to my custom routines?
  - Where did my custom routine go?
  - What does migrated_to_agent mean?
  - How do I create a recurring task now?
locale: en-US
created: 2026-04-25
updated: 2026-06-10
keywords:
  - custom routine
  - routine.custom.<slug>
  - migrated_to_agent
  - user agent
  - recurring agent
  - migration
related:
  - guides/add-a-custom-routine
  - concepts/routines
prerequisites:
  - concepts/routines
process_keys:
  - routine.custom.<slug>
context_files:
  - policies/routines/custom/<slug>.md
  - policies/agents/<slug>/agent.md
api_endpoints:
  - POST /api/agents
ui_anchors:
  - /agents
---

# Custom Routines (Retired)

## In One Sentence

Custom routines (`policies/routines/custom/<slug>.md` files fired as
`routine.custom.<slug>`) no longer run — **user Agents replaced
them**, and every valid routine was converted automatically, exactly
once, at the first daemon start after the upgrade.

## What Changed

- The custom-routine scheduler was removed. Files under
  `policies/routines/custom/` are no longer read by any scheduler, and
  no `routine.custom.<slug>` events fire. (Historical Activity rows
  tagged with those keys remain and still resolve to this page.)
- Recurring work you define is now an **Agent**: a
  `policies/agents/<slug>/agent.md` file that appears on the
  **Agents** page (`/agents`) with its schedule, an enable toggle, run
  metrics, execution history, and a **Run now** button — surfaces
  custom routines never had. See
  [Create a Recurring Agent](../../guides/add-a-custom-routine.md).

## The One-Time Migration

At the first daemon start after the upgrade — and only once, guarded
by a persisted flag — every file under `policies/routines/custom/` is
examined:

- A **valid routine becomes a user Agent** at
  `policies/agents/<slug>/agent.md` carrying over:
  - the same **cron expression** (pinned to your configured timezone),
  - the same **model tier** (`backend_tier` → the Agent's tier),
  - the same **per-run budget** (`max_budget_usd`),
  - the same **enabled state** — a disabled routine migrates disabled.

  The routine's body (its `## Checks` section) becomes the Agent's
  **task prompt** verbatim, and the Agent's description records where
  it came from (`Migrated from custom routine "<slug>".`).
- The **source file is never deleted.** It is rewritten in place with
  `enabled: false` and a `migrated_to_agent: <slug>` marker in its
  frontmatter, so it is visibly inert while your content is preserved.

### Collisions and invalid files

- **Slug collision** — if an Agent (built-in or user) already exists
  under the routine's slug, the migration falls back to
  `custom-<slug>`. If that also collides, the routine is skipped with
  a warning and the file is left untouched.
- **Invalid files** — a routine with broken frontmatter or missing
  required fields is left untouched and logged; it is not migrated.
  (Such files never fired under the old scheduler either.)

## After the Migration

- Find your migrated routines on **`/agents`** — each one's
  description says which custom routine it came from.
- Edit the schedule, tier, limits, or prompt there (or directly in the
  `agent.md` file; the daemon picks up changes without a restart).
- The inert files under `policies/routines/custom/` can stay as a
  reference or be deleted whenever you like — they have no effect
  either way.

## Related

- [Create a Recurring Agent](../../guides/add-a-custom-routine.md)
- [Routines](../../concepts/routines.md)
