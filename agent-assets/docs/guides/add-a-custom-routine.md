---
schema_version: 1
slug: guides/add-a-custom-routine
title: Create a Recurring Agent
id: add-a-custom-routine
aliases:
  - recurring agent
  - new agent
  - user agent
  - custom routine
  - add a routine
  - scheduled task
category: guides
summary: |
  Make the agent run a prompt you write on a schedule you pick by
  creating a user Agent — via the "New Agent" form on /agents or
  POST /api/agents. The Markdown body (the prompt) becomes the task
  prompt for every run; runs appear on the Agent's detail page.
section: add-a-custom-routine
tags:
  - agents
  - routines
  - scheduler
  - autonomous
status: stable
ask_examples:
  - How do I create a recurring agent?
  - How do I schedule the agent to run on a cron?
  - How do I add a custom routine?
  - Where do I see my agent's runs?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - recurring agent
  - new agent
  - cron
  - schedule
  - recurrence
  - task prompt
  - agent.task
ui_anchors:
  - /agents
api_endpoints:
  - POST /api/agents
  - GET /api/agents/{slug}/executions
  - POST /api/agents/{slug}/run-now
context_files:
  - policies/agents/<slug>/agent.md
related:
  - features/routines/custom-routines
  - concepts/routines
  - concepts/process-keys
  - concepts/backends-and-tiers
---

# Create a Recurring Agent

## Goal

Run a task you write on a schedule you pick, packaged as a user
**Agent** you can watch, tune, and toggle from `/agents`.

## Prerequisites

- Daemon running.

## Steps (dashboard)

1. Open **Agents** (`/agents`) and click **New Agent**.
2. Fill the form:
   - **Name** — the human label in the agents list (e.g. "Daily
     Digest").
   - **ID** — lowercase kebab-case slug. It becomes the URL
     (`/agents/<id>`) and the definition file
     `policies/agents/<id>/agent.md`. Must not collide with an
     existing Agent (built-in slugs are reserved too).
   - **Schedule** — pick a frequency (hourly / daily / weekly /
     monthly) and its fields, e.g. weekly on Tuesday at 11:00. An
     optional toggle defers runs that land inside your quiet hours.
   - **Backend engine / Model tier** — `lite` (Haiku-class), `medium`
     (Sonnet-class), or `high` (Opus-class). See
     [Backends and tiers](../concepts/backends-and-tiers.md).
   - **Limits** — max turns, max budget (USD) per run, and timeout
     (minutes).
   - **Task prompt** — what the agent should do on each run. This text
     becomes the Markdown body of `agent.md` and is the prompt the
     agent receives every time it fires.
   - An **Advanced (YAML)** toggle reveals the raw `agent.md` editor
     for the extra fields the form doesn't expose (tags, tools,
     success criteria, error handling).
3. Save. The dashboard writes `policies/agents/<slug>/agent.md`
   through the context vault and opens the new Agent's detail page;
   the daemon imports the file without a restart.

## Steps (API)

`POST /api/agents` is the programmatic counterpart:

```bash
curl -X POST http://localhost:8321/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "tuesday-notion-sweep",
    "name": "Tuesday Notion Sweep",
    "description": "Weekly Notion inbox cleanup",
    "schedule": { "kind": "cron", "expression": "0 11 * * 2" },
    "backend": { "tier": "medium" },
    "limits": { "max_budget_usd": 0.10 },
    "prompt": "- Review my Notion inbox for items older than a week.\n- File or archive each one.\n- DM me a one-paragraph summary."
  }'
```

- **`prompt` becomes the Agent's task prompt** — it is stored as the
  Markdown body of `agent.md` and sent to the agent on every run. It
  must be a real task definition: an empty body or a stand-in like
  `"placeholder"`/`"TODO"` is rejected as `400 invalid_definition`
  (the agent would skip every run as too ambiguous to act on).
- **`schedule`** takes one of two forms: a raw 5-field cron
  (`{ "kind": "cron", "expression": "0 11 * * 2" }`, interpreted in
  the daemon's timezone unless `schedule.timezone` is set) or a
  structured rule (`{ "kind": "recurring", "recurrence": { "frequency":
  "weekly", "daysOfWeek": ["tuesday"], "time": "11:00" } }`).
  `/agents` is recurring-only — a one-time task belongs on
  `POST /api/schedule` instead.
- **`backend.tier`** is optional; if you omit it, the Agent inherits
  the `agent.task` process default (medium). `backend.process_key`
  defaults to `agent.task` — you don't need to set it.
- **`limits`** defaults: 20 turns, $0.25 per run, 10-minute timeout.
- Success returns `201 { "status": "created", "slug": ... }`. A taken
  slug returns `409 slug_collision`; validation failures return `400`
  with a field-level `issues` list.

## Where to See Runs

- **`/agents`** lists every Agent with its schedule, enable toggle,
  7-day metrics, and last run.
- **`/agents/<slug>`** is the detail page: the full definition, recent
  execution history with results and cost, and a **Run now** button
  (`POST /api/agents/<slug>/run-now`).
- **Activity** logs each run alongside everything else the agent does.
- Programmatically: `GET /api/agents/<slug>/executions`.

## Verification

- Click **Run now** on the detail page (or wait for the schedule); an
  execution row should appear with its result and cost.

## If It Fails

- `409 slug_collision` — pick a different ID; built-in Agent slugs are
  reserved.
- `400 invalid_definition` — fix the fields listed in `issues`.
- `400 one_shot_not_supported` — `/agents` is recurring-only; use
  `POST /api/schedule` for one-time work.
- **Run now** returns `409 agent_prompt_placeholder` — the Agent's
  stored prompt is empty or still a placeholder stub (possible for
  Agents created before this was validated); write the real task into
  its `agent.md` and try again.
- A prompt that trips the absolute-block guardrails — the run still
  executes, but the offending tool call is logged as `blocked_absolute`
  in the action log.

## Migrating From Custom Routines

The legacy custom-routine format —
`policies/routines/custom/<slug>.md` files with `cron:` frontmatter
and a `## Checks` body — is retired and those files no longer fire.
At the first daemon start after the upgrade, each valid file was
converted **once** into a user Agent with the same cron, tier, budget,
and enabled state; the `## Checks` body became the Agent's task
prompt, and the source file was kept but marked inert
(`enabled: false` plus a `migrated_to_agent: <slug>` marker). See
[Custom Routines (Retired)](../features/routines/custom-routines.md)
for collision and invalid-file handling.

## Related

- [Custom Routines (Retired)](../features/routines/custom-routines.md)
- [Routines](../concepts/routines.md)
- [ProcessKeys](../concepts/process-keys.md)
- [Backends and tiers](../concepts/backends-and-tiers.md)
