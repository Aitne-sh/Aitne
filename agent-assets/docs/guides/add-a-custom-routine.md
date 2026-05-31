---
schema_version: 1
slug: guides/add-a-custom-routine
title: Add a Custom Routine
id: add-a-custom-routine
aliases:
  - custom routine
  - user-defined routine
  - add a routine
  - scheduled task
category: guides
summary: |
  Define a new autonomous routine — slug, cron expression, model tier, and
  budget cap — via /settings/routines. The form writes a vault file at
  policies/routines/custom/<slug>.md; saving it registers the cron job.
section: add-a-custom-routine
tags:
  - guides
  - routines
  - scheduler
  - autonomous
  - core
status: stable
ask_examples:
  - How do I add a custom routine?
  - What can a custom routine do?
  - How do I schedule the agent to run on a cron?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - custom routine
  - schedule
  - cron
  - recurrence
  - backend_tier
  - process_key
ui_anchors:
  - /settings/routines
api_endpoints:
  - PUT /api/context/*
context_files:
  - policies/routines/custom/<slug>.md
related:
  - features/routines/custom-routines
  - concepts/routines
  - concepts/process-keys
  - concepts/backends-and-tiers
---

# Add a Custom Routine

## Goal

Make the agent fire a particular kind of work on a schedule you pick.

## Prerequisites

- Daemon running.

## Steps

1. Open `/settings/routines` (the older `/connections/routines` URL
   redirects here).
2. Click **Add**. The "New custom routine" dialog opens.
3. Fill the form:
   - **Slug** — lowercase kebab-case, 1–64 chars, no leading/trailing
     hyphen (e.g. `tuesday-notion-sweep`). It becomes the ProcessKey
     `routine.custom.<slug>` and the file name
     `policies/routines/custom/<slug>.md`.
   - **Cron expression** — standard 5-field cron in the daemon's
     timezone (e.g. `0 11 * * 2` for 11:00 every Tuesday). The dialog
     previews the next three fire times.
   - **Backend tier** — `lite` (Haiku), `medium` (Sonnet), or `high`
     (Opus). Default is `medium`. Custom routines have no concrete
     model picker; the tier is written to the file's `backend_tier`
     frontmatter, and the BackendRouter resolves the actual model at
     fire time. (See [Backends and tiers](../concepts/backends-and-tiers.md).)
   - **Max budget (USD)** — per-execute cap (default `0.05`; must be a
     positive number).
   - **Description** — optional free text. It becomes the body of the
     generated vault file, above an empty `## Checks` section seeded
     with a `### First check` placeholder. Edit the file later on the
     same page to flesh out the check list.
4. Click **Create**. The dashboard writes the vault file via the
   context API (`PUT /api/context/policies/routines/custom/<slug>`).
   Because the file ships with `enabled: true` and a `cron:` field,
   saving it registers (or refreshes) the cron job, and the next-fire
   timestamp appears in the routine list.

The generated file looks roughly like this:

```yaml
---
type: rule
slug: tuesday-notion-sweep
cron: "0 11 * * 2"
process_key: routine.custom.tuesday-notion-sweep
enabled: true
backend_tier: medium
max_budget_usd: 0.05
---
```

To stop a routine without deleting it, set `enabled: false` in the
file and save — that unregisters the cron job.

## Verification

- Wait for the cron to fire; check Activity for the row tagged
  `routine.custom.<slug>`.

## If It Fails

- A cron that resolves to "never" (or is otherwise invalid): the
  dialog shows the preview error and refuses to save it.
- A prompt that hits the absolute-block guardrails: the routine fires
  but the offending tool call is logged as `blocked_absolute` in the
  action log.

## Related

- [Custom Routines](../features/routines/custom-routines.md)
