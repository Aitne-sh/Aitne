---
schema_version: 1
slug: concepts/skills
title: Skills
id: skills
aliases:
  - SKILL.md
  - skill manifest
  - allowed-tools
category: concepts
summary: |
  Skills are the per-task playbooks the agent follows. Each skill is a
  Markdown file with frontmatter that names the skill, describes when
  to load it, and pins the exact tools the session may use.
section: skills
tags:
  - core
  - skills
  - safety
  - knowledge
  - backends
status: stable
ask_examples:
  - What skills does the agent have?
  - How do I add a new skill?
  - Why does the agent refuse to run a tool?
  - How does skill self-optimization work?
  - Where do skill overlays live?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - SKILL.md
  - allowed-tools
  - skills-compiler
  - manifest
  - self-optimization
  - skill curation
  - overlays
  - skill
  - skills
related:
  - concepts/safety-and-execution
  - concepts/process-keys
  - reference/skills
ui_anchors:
  - /knowledge
  - /connections/mcp
  - /settings/self-learning
process_keys:
  - dashboard.docs_qa
  - routine.skill_curation
config_keys:
  - allowedToolsOverride
  - disallowedTools
api_endpoints:
  - GET /api/skills
  - GET /api/skills/manifest/:processKey
---

# Skills

## TL;DR

A skill is a Markdown file the daemon copies into the agent's working
directory before each session. Its frontmatter declares the skill's
`name`, `description`, and the `allowed-tools` the session may use.
The agent reads `SKILL.md` at the start of every session that loads
that skill and follows it as a contract.

## Why This Concept Exists

The agent runs against a real machine. Without scoped permissions, a
"please summarize my mail" turn could in principle invoke `Bash(rm)`,
post to your social accounts, or rewrite arbitrary files. Skills fix
that by making the available toolset task-shaped: the morning routine
loads the routines/observations/today/schedule skills; a docs question
loads only `docs-search`. Tools outside the allow-list aren't even
visible to the model.

## Definitions

- **SKILL.md**: the Markdown file that defines a single skill. Lives
  under `agent-assets/skills/<slug>/SKILL.md` in the repo and is
  materialized into each session workdir under a per-backend namespace —
  `.claude/skills/<slug>/` for Claude, `.codex/skills/` for Codex,
  `.gemini/skills/` for Gemini, and `.opencode/skills/` for OpenCode.
  The frontmatter (`name`, `description`, `allowed-tools`) is byte-identical
  across all four; only the destination directory changes.
- **`allowed-tools`**: a YAML list in the skill's frontmatter naming
  tools and patterns the session may use. Patterns like
  `Bash(curl http://localhost:8321/api/context/*)` are the daemon's
  primary chokepoint.
- **Manifest**: the per-event-type set of skill slugs to load, defined
  in `packages/daemon/src/core/skills-manifest.ts`. Different
  ProcessKeys load different manifests.
- **Profile**: the persona document (e.g. `conversational.md`) prepended
  to every session. Profiles live under `agent-assets/agent-profiles/`.

## Concrete Examples

- `today` — read and rewrite `state/today.md`.
- `schedule` — produce per-date schedule files from the calendar.
- `mail` — search and label messages via the daemon's mail proxy.
- `docs-search` — read-only fetch over the docs corpus, used only by
  `dashboard.docs_qa`.
- `notify` — emit notifications through the configured messaging app.

## Self-Optimization (Overlays)

Skills aren't frozen. A background process — **skill curation** —
watches how your knowledge layout drifts (file moves, new
sub-folders, schema tweaks under `identity/`, `plans/projects/`, etc.)
and proposes JSON **overlays** that update specific sections of the
relevant skill: knowledge layout, routing tables, frontmatter
schema, search recipes, convention notes, cross-references.

Overlays live at `<dataDir>/skill-curation-overlays/<slug>/<section_id>.json`
and are merged in by the SkillsCompiler at session-init. The original
`SKILL.md` files in `agent-assets/skills/` are never rewritten;
disabling self-learning (or deleting the JSON file) reverts to the
seed payload immediately.

The optimizer agent runs in an isolated workdir with a tightly
scoped toolset (`Bash(curl http://localhost:8321/api/skill-curation/*)`,
`Read`) and an auto-revert safety net: each cadence cycle the daemon
re-checks recently-applied overlays, and any section that has
accumulated *more* drift signal weight after the overlay was applied
than before is rolled back automatically and frozen for two cycles to
stop thrashing. This is the only roll-back path — there is no
per-proposal approve/reject API, just the on/off toggle.

Skill curation is **off by default**. The master toggle, curation
cadence, manual-run trigger, and the per-skill exclusion list are all
surfaced at **Settings → Self-learning** (`/settings/self-learning`).

## Where You See It in the Dashboard

- **Knowledge → Skills** lists every skill, its description, and the
  events it loads for.
- **Connections → MCP** is where MCP servers (which surface as tools
  inside skills) attach.
- **Settings → Self-learning (`/settings/self-learning`)** is where
  the curation cadence, model, and per-skill exclusions live, plus
  a "Run optimization now" button and a rolled-up summary of the
  most recent runs.

## Related

- [Safety and Execution](safety-and-execution.md) — how the
  always-disallowed layer enforces guardrails even when a skill's
  `allowed-tools` is too permissive.
- [Process Keys](process-keys.md) — the dispatch identity that picks
  which skill manifest to load.
- [Skills (Reference)](../reference/skills.md) — index of every
  built-in skill.
