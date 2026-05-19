---
schema_version: 1
slug: glossary
title: Glossary
id: glossary
aliases:
  - terms
  - vocabulary
  - lexicon
category: glossary
summary: |
  Single flat term list for Aitne vocabulary. Cross-references
  link to a single canonical anchor here so concept docs do not drift.
tags:
  - core
  - reference
  - glossary
status: stable
ask_examples:
  - What is a ProcessKey?
  - What does heavy tier mean?
  - What is the difference between light and heavy tiers?
  - What is OpenCode?
  - What is a routine pre-pass?
  - What is the wiki workspace?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - terminology
  - vocabulary
  - glossary
  - backend
  - processkey
  - tier
  - opencode
  - observation
  - skill
  - wiki workspace
related:
  - concepts/agent-day
  - concepts/backends-and-tiers
  - concepts/process-keys
  - concepts/observations
  - features/routines/morning-routine
  - features/wiki/overview
---

# Glossary

A single flat list of Aitne vocabulary. Concept docs link to
anchors here rather than redefining terms inline.

## Agent Day

The 24-hour window starting at the configured day-boundary hour (default
04:00 local). See [Agent Day](concepts/agent-day.md) for the full rule
and rationale.

## Backend

One of the model providers Aitne can dispatch to: `claude`
(Claude Code SDK), `codex` (Codex CLI), `gemini` (Gemini CLI), or
`opencode` (`@opencode-ai/sdk` HTTP server). Each backend is configured
per-installation; one is the **main backend**, and the others can be
enabled as fallbacks.

## Backend Router

The component that resolves a `ProcessKey` to a concrete `(backend,
model, maxTurns, maxBudgetUsd)` binding at dispatch time. Lives in
`packages/daemon/src/core/backends/backend-router.ts`. Routing reads
`process_backend_config` (per-process pins) layered over
`backend_global_defaults` (installation-wide defaults).

## Citation Pill

The clickable inline UI element rendered from a `[doc:slug#anchor]`
token in a QA reply. Clicking scrolls the docs content pane to the
matching anchor.

## Day Boundary

The hour-of-day at which the agent day rolls over. Configured via
`dayBoundaryHour` (default `4`).

## Heavy Tier

Synonym for the **high** tier — the expensive, high-quality model lane
on each backend (Claude Opus 4.7, GPT-5.5, Gemini 3 Pro, Opus 4.7 via
OpenCode). Registered but not auto-selected on any routine: after
`docs/design/appendices/morning-routine-optimization.md` Phase 7
(2026-05-16) the only flows that default to this tier are `setup` and
`knowledge.import`. Operators can pin any other process key to high
per row from `/settings/models`.

## Light Tier

Operator-facing umbrella for the two non-heavy lanes on each backend:

- **Medium / Main** (Claude Sonnet 4.6, GPT-5.4-mini, Gemini 3 Flash,
  Sonnet 4.6 via OpenCode) — default for owner DMs, dashboard chat,
  the hourly check, and the morning / evening / weekly review
  routines.
- **Lite / Delegated** (Claude Haiku 4.5 and equivalents) — reserved
  for mechanical / delegated surfaces: Gmail classification, GitHub
  triage, calendar-change handlers, the routine pre-pass fetcher,
  the `delegated_task` invoker.

## OpenCode

The 4th backend (joined 2026-05). Implemented on top of
`@opencode-ai/sdk`'s HTTP server. Operates in **Managed** mode (the
daemon spawns a local loopback server) or **Remote** mode (operator
points at an existing baseUrl). OpenCode dispatches the same
ProcessKey set as Claude / Codex / Gemini but does not host
native-mode integration connectors. Cost telemetry reads
`session.info.cost` + `info.tokens` with a `MODEL_REGISTRY` pricing
fallback when upstream reports zero.

## Routine Pre-pass

A lite-tier `routine.fetch_window` session spawned before each main
routine (morning / today_refresh / hourly_check / evening / weekly).
It fetches each routine's mail / calendar / Notion window
(`ROUTINE_WINDOWS`) and POSTs the results to `/api/observations`. The
main routine then consumes the resulting `<fetch_report>` block and
pending observations instead of calling upstream APIs itself. Introduced
in 2026-05 to trim morning-routine input tokens by ~24%.

## ProcessKey

The branded string identifier for a class of agent invocation, e.g.
`routine.morning_routine`, `message.dm`, `dashboard.docs_qa`. Drives
backend selection, skill manifest, agent profile, and task-flow
template lookup. Defined in `packages/shared/src/process-key.ts`.

## QA Panel

The right-side pane on `/docs` and the bottom of the `?`-button
slide-over that runs grounded question answering over the docs corpus.
Runs on the operator's DM-bound backend at the **light tier** —
inherited from `message.dm`'s binding via the cascade-write helper.

## Skill

A read-only or scoped tool surface defined as `agent-assets/skills/<slug>/SKILL.md`.
Skills are the only way the agent reaches the daemon API or external
services. The skill manifest per ProcessKey controls which skills load.

## Slug

The path-style canonical identity of a doc, e.g.
`features/routines/morning-routine`. Used as the URL under `/docs/<slug>`,
the row key in `fts_docs`, and the first half of every
`[doc:slug#anchor]` citation.

## Tier

Short for **model tier**: `light` or `heavy`. Each ProcessKey has a
default tier; per-process pins and per-call requested-tier overrides can
deviate from that default.

## Today.md

The current agent day's main memory file under
`~/.personal-agent/context/today.md`. Rebuilt once per day by the
morning routine and edited by every DM, observation, and routine that
needs to record state for the day.

## Wiki Workspace

A single named root the wiki feature writes into. Either **internal**
(`~/.personal-agent/wiki/`) or **external** (a path you point at, often
an existing Obsidian vault). Every wiki bang command targets a
workspace; omitting the `@<workspace>` token addresses the default.
See [Wiki Overview](features/wiki/overview.md) and
[Multiple Wikis](guides/multiple-wikis-for-multiple-domains.md).

## Wiki Layers

The four directories every workspace contains:

- `00_inbox/` — agent-readable but agent-unwritable; for hand-drops
  destined for graduation.
- `10_raw/` — captured sources from `!ingest <url>` and other intake.
- `20_wiki/` — synthesised articles produced by `!compile`, plus
  `_index.md`.
- `30_outputs/` — derived artefacts (`!ask` answers, `!lint` reports,
  `!trace` and `!connect` outputs).

Dataflow is single-direction: `00_inbox` → `10_raw` → `20_wiki` →
`30_outputs`. Skills enforce the invariant; the daemon's Wiki API is
the only legal write path.

## Compile Preview

The dry-run touch list `!compile --preview` (alias `--dry-run`) produces
before any agent session runs. Lists pages that would be **added**,
**modified**, or **unchanged**, plus the bracketed cost estimate and
ETA. The compile is an LLM and may diverge inside the loop; the preview
is an upper bound on the touch set. Computed purely in JS — no tokens
spent.
