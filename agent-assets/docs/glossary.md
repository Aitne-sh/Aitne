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
section: glossary
summary: |
  Single flat term list for Aitne vocabulary. Cross-references
  link to a single canonical anchor here so concept docs do not drift.
tags:
  - knowledge
status: stable
ask_examples:
  - What is a ProcessKey?
  - What does heavy tier mean?
  - What is the difference between light and heavy tiers?
  - What is OpenCode?
  - What is a routine pre-pass?
  - What is the wiki workspace?
  - What is an integration mode?
  - What is native mode?
  - What is B-3 / browser history?
  - What is B-4 / managed Chromium?
  - What is a schema migration?
  - What is execution permission mode?
  - What is a bang command?
  - What is deniedTools?
  - What is an observation?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
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
  - integration mode
  - native mode
  - delegated mode
  - browser history
  - managed chromium
  - schema migration
  - execution permission mode
  - research cluster
  - bang command
  - deniedTools
  - safety model
related:
  - concepts/agent-day
  - concepts/backends-and-tiers
  - concepts/process-keys
  - concepts/observations
  - concepts/delegated-mode
  - concepts/safety-and-execution
  - concepts/safety-model
  - features/routines/morning-routine
  - features/wiki/overview
  - features/integrations/browser-history
  - features/messaging/bang-commands
ui_anchors:
  - /settings/models
  - /docs
  - /settings/integrations/browser-history-managed/b4
process_keys:
  - dashboard.docs_qa
  - delegated_task_heavy
  - routine.fetch_window
  - routine.activity_scan
  - routine.research_cluster_update
config_keys:
  - dayBoundaryHour
  - browserTaskHostnameDenylist
  - delegatedTaskHeavyEnabled
  - claudeExecutionPermissionMode
api_endpoints:
  - POST /api/observations
---

# Glossary

A single flat list of Aitne vocabulary. Concept docs link to
anchors here rather than redefining terms inline.

## Agent Day

The 24-hour window starting at the configured day-boundary hour (default
04:00 local). See [Agent Day](concepts/agent-day.md) for the full rule
and rationale.

## Backend

One of the AI model providers Aitne can send work to: `claude`
(Claude Code SDK), `codex` (Codex CLI), `gemini` (Gemini CLI), or
`opencode` (`@opencode-ai/sdk` HTTP server). Each backend is configured
per-installation; one is the **main backend**, and the others can be
enabled as fallbacks.

## Browser History (B-3)

A local-only poller that reads the browser's own SQLite history database
(Chromium-based browsers — Chrome, Chromium, Edge, Brave, Comet, Atlas)
and records page visits as observations. It feeds the **research cluster**
derivation, the weekly reload-memory block, and the
[`!checks`](features/messaging/bang-commands.md) on-demand reload tally.
Nothing is uploaded — only the URLs, titles, and visit timings the browser
itself already recorded. See
[Browser History](features/integrations/browser-history.md).

## Managed Chromium (B-4)

Experimental purchase-confirmation flow that drives a daemon-spawned
Chromium profile to complete a vendor checkout the agent has already
prepared. **Default-off.** Requires per-site opt-in, the experimental-
danger acknowledgement modal, at least one DM channel, a single-use
`!~xxxxxxxx` token, screenshot-first consent, and a 5-min timeout. There
is no longer a hardcoded domain category denylist (banks, government,
payment processors, etc. were removed at the framework level on
2026-05-27); domain-level deny is operator-managed via **Settings →
Integrations → Browser History (Managed) → B-4** (`browserTaskHostnameDenylist`,
default empty). The structural defences that remain: the IP CIDR layer
in `shouldDenyEgress` (RFC1918 / loopback / cloud-metadata), the
form-submit `payment-path-blocker`, and the single-use token primitive.
Operator self-testing only until B-3 has been stable for six weeks. See
[Managed Chromium](features/operations/managed-chromium.md).

## Bang Command

Short, owner-only command typed in a paired DM that starts with `!`
(e.g. `!help`, `!stop`, `!cost`, `!report`, `!checks`, `!research`,
`!ingest`, `!compile`, `!ask`). Handled by the daemon directly — no
LLM call, no cost, no session opened. Built-in commands plus operator-
enabled custom commands appear in `!help`. See
[Bang Commands](features/messaging/bang-commands.md).

## Backend Router

The component that turns a `ProcessKey` into a concrete `(backend,
model, maxTurns, maxBudgetUsd)` binding at dispatch time (the moment an
invocation is handed to a backend). Lives in
`packages/daemon/src/core/backends/backend-router.ts`. Routing reads
`process_backend_config` (per-process pins) layered over
`backend_global_defaults` (installation-wide defaults).

## Citation Pill

The clickable inline UI element rendered from a `[doc:slug#anchor]`
token in a QA reply. Clicking scrolls the docs content pane to the
matching anchor.

## Day Boundary

The hour of the day when the agent day rolls over (when "today" starts
fresh). Configured via `dayBoundaryHour` (default `4`).

## deniedTools

Per-integration deny list of tool names (or prefix globs like
`send_*`) the agent must not call. The primary defense against
unwanted destructive actions in the [Safety Model](concepts/safety-model.md).
Editable in **Connections → \<integration\> → Tool Permissions**;
seeded with a recommended starter list on first delegated setup.
Patterns are validated against the connector's `capabilityTools` set
at PATCH time so typos fail fast.

## Execution Permission Mode

Per-backend `Safe` / `Allow` posture, set independently for each
registered backend via
`{claude,codex,gemini,opencode}ExecutionPermissionMode`. **Safe** =
strict per-call permission checks plus the Claude curl/jq hooks,
Codex `workspace-write` sandbox, and Gemini whitelist TOML. **Allow** =
SDK bypass / sandbox off / minimal TOML. The absolute-block layer
(recursive delete, sudo, secret-file reads/writes) is enforced in
*both* modes — `allowedToolsOverride` cannot widen past it. Codex
allow mode cannot enforce the absolute-block layer for shell commands
(no hook surface); the gap is documented in
`docs/design/09-safety-cost.md`. See
[Safety and Execution](concepts/safety-and-execution.md).

## Integration Mode

The per-integration posture for how Aitne ingests events from a
connected service: `direct | delegated | native | disabled`.

- **direct** — the daemon runs its own poller against the integration's
  API.
- **delegated** — a lite-tier `delegated-sync-worker` polls on opt-in
  cadences (see `docs/design/appendices/delegated-sync-opt-in.md`).
- **native** — no poller; the main backend reaches the integration
  through its own MCP connector and POSTs observations in-turn via
  `/api/observations`. Two variants: **descriptor-driven** (the
  integration ships a `backendConnectors` entry — `gmail`,
  `google_calendar`, `notion`) and **user-managed** (the descriptor
  declares `userManagedConnector: true` and the user installs their own
  MCP / skill harness — `outlook_mail`, `outlook_calendar`).
- **disabled** — silence; no poller, no native handoff.

Mode lookup goes through `readIntegrationState(db, key)`; never
hardcode an integration reference outside
`packages/shared/src/integrations.ts`. See
[Delegated Mode](concepts/delegated-mode.md).

## Heavy Tier

Synonym for the **high** tier — the expensive, high-quality model lane
on each backend (Claude Opus 4.8 / `claude-opus-4-8`, `gpt-5.5` on
Codex, `gemini-3.1-pro-preview` on Gemini, Opus 4.8 via OpenCode).
Registered but not auto-selected on any install-seeded surface: after
the "no Opus by default" pass (2026-05-16) the **only** process key that
defaults to high tier is `delegated_task_heavy` (opt-in, gated by the
`delegatedTaskHeavyEnabled` flag). Every other process key — including
`setup` and `knowledge.import` — defaults to medium. Operators can pin
any other process key to high per row from the `/settings/models`
dashboard page.

## Light Tier

Operator-facing umbrella for the two non-heavy lanes on each backend:

- **Medium / Main** (Claude Sonnet 5, `gpt-5.4` on Codex,
  `gemini-3.1-pro-preview` on Gemini, Sonnet 5 via OpenCode) —
  default for owner DMs, dashboard chat, the activity scan, and the
  morning / evening / weekly review routines. (Sonnet 4.6 became a
  `(legacy)` pin when Sonnet 5 shipped on 2026-06-30.)
- **Lite / Delegated** (Claude Haiku 4.5, `gpt-5.4-mini` on Codex,
  `gemini-3.1-flash-lite-preview` on Gemini, Haiku 4.5 via OpenCode) —
  reserved for mechanical / delegated surfaces: Gmail classification,
  GitHub triage, calendar-change handlers, the routine pre-pass
  fetcher, the `delegated_task` invoker.

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
routine (morning / today_refresh / activity_scan / evening / weekly).
It fetches each routine's mail / calendar / Notion window
(`ROUTINE_WINDOWS`) and POSTs the results to `/api/observations`. The
main routine then consumes the resulting `<fetch_report>` block and
pending observations instead of calling upstream APIs itself. Introduced
in 2026-05 to trim morning-routine input tokens by ~24%.

## Observation

One row in the `observations` table. A change record that a polling
integration (Obsidian, Git, Notion, calendar, mail, browser history)
or a `routine.fetch_window` pre-pass wrote into SQLite. The
`routine.activity_scan` is the consumer — there is no per-change
notification. `actor='agent'` rows are filtered out by the consumer
to break the agent-observing-its-own-writes loop. See
[Observations](concepts/observations.md).

## ProcessKey

The typed string identifier (a "branded" string in the TypeScript code)
for a class of agent invocation, e.g.
`routine.morning_routine`, `message.dm`, `dashboard.docs_qa`. Drives
backend selection, skill manifest, agent profile, and task-flow
template lookup. Defined in `packages/shared/src/process-key.ts`.

## Research Cluster

A topic the browser-history poller derives from a user's reading
pattern when meaningful visits, foreground time, and distinct domains
cross a threshold. Each cluster has a slug, a display name, a journal
file at `context/research/<slug>.md`, and a status
(`active | dormant | muted | concluded`). Surfaced via the
**Two-Option Offer DM** (research dive vs. wiki summary) and the
[`!research`](features/messaging/bang-commands.md) bang prefix.

## Schema Migration

Forward-only, append-only, idempotent migration entry in
`packages/daemon/src/db/migrations.ts:MIGRATIONS`. Runs right after
`applySchema(db)` at boot; applied ids are recorded in
`schema_migrations` so each runs at most once per DB. Used for any
non-additive change to a pre-existing structure — `ALTER TABLE ADD
COLUMN`, `CREATE INDEX` on a column added by a prior migration, data
backfill, or a `settings_json` shape change whose old value won't parse
under the new schema. Gating ALTERs behind `columnExists` /
`tableExists` / `indexExists` keeps a fresh DB (where `applySchema`
already produced the target state) a no-op. The legacy reinstall
escape hatch still exists as a last resort, but **migrations are the
upgrade path** — see [Reinstall Cleanly](guides/reinstall-cleanly.md).

## QA Panel

The right-side pane on `/docs` and the bottom of the `?`-button
slide-over that runs grounded question answering over the docs corpus.
Dispatched under the `dashboard.docs_qa` ProcessKey, which is **hard
tier-locked to medium** (`TIER_LOCKED_PROCESS_KEYS` in
`packages/shared/src/process-key.ts`) — an operator pin to a different
tier is ignored. The backend itself is inherited from the operator's
DM-bound backend via the cascade-write helper.

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

Short for **model tier**. The code-level enum (`ProcessModelTier` in
`packages/shared/src/process-key.ts`) has three values — `lite`,
`medium`, `high`. This doc also uses the operator-facing two-way split
**light** (lite + medium) vs **heavy** (high); see [Light Tier](#light-tier)
and [Heavy Tier](#heavy-tier). Each ProcessKey has a default tier;
per-process pins and per-call requested-tier overrides can deviate from
that default, except for keys in `TIER_LOCKED_PROCESS_KEYS` (today only
`dashboard.docs_qa`, locked to medium).

## Two-Option Offer DM

DM pattern used for research-cluster offers and any other follow-up
where the user has two natural choices. Sends one DM with two distinct
actions (e.g. "research dive" vs. "wiki summary") instead of a single
yes/no prompt; the user replies with the matching `!research` subcommand
to accept either path. Replaces the older single-option offer for
ambiguous-intent surfaces.

## Today.md

The current agent day's main memory file under
`~/.personal-agent/context/state/today.md`. Rebuilt once per day by the
morning routine and edited by every DM, observation, and routine that
needs to record state for the day.

## Wiki Workspace

A single named root the wiki feature writes into. Either **internal**
(`~/.personal-agent/context/knowledge/wiki/` after the context-vault v2 restructure;
pre-v2 installs lived at `~/.personal-agent/wiki/`) or **external**
(a path you point at, often an existing Obsidian vault). Every wiki bang
command targets a workspace; omitting the `@<workspace>` token addresses the default.
See [Wiki Overview](features/wiki/overview.md) and
[Multiple Wikis](guides/multiple-wikis-for-multiple-domains.md).

## Authority Class

One of the six top-level partitions of the vault — `identity/`, `state/`,
`plans/`, `journal/`, `knowledge/`, `policies/`. Each class carries a
distinct authority + lifecycle contract; the daemon enforces by reading
file frontmatter (Phase 1 advisory; Phase 2 strict). Established by the
context-vault v2 restructure (CONTEXT_VAULT_REDESIGN_PLAN.md). See
[Knowledge Layout](reference/knowledge-layout.md) for what lives in each.

## Context Vault v2

The vault layout introduced by the context-vault v2 restructure
(migration id `0004-context-vault-restructure`) — six authority classes,
in-process legacy path alias, `wiki/` and `integrations.md` and user
`skills/` consolidated under the vault root. Migrates forward-only on
first boot of the cutover release; never destroys user data. See
[Knowledge Layout](reference/knowledge-layout.md).

## Frontmatter Contract

YAML preamble in each vault MD file declaring `kind` (one of the six
class names), `authority` (`user` / `agent` / `mixed`), `mutability`
(`replace` / `patch` / `append` / `readonly`), `slug`, and `title`.
Parsed by `core/context-validation/frontmatter.ts`. Phase 1 logs
warnings on missing/invalid frontmatter; Phase 2 rejects the write.
Toggle: `runtimeSettings.contextVault.enforceFrontmatter` (default `false`).

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
