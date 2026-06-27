---
schema_version: 1
slug: concepts/memory-model
title: Memory Model
id: memory-model
aliases:
  - context files
  - memory files
  - long-term memory
category: concepts
summary: |
  Aitne stores durable memory as plain Markdown files under
  ~/.personal-agent/context/. SQLite holds sessions, actions, and
  observations; the MD files are the authoritative store for everything
  the agent reads and rewrites about you.
section: memory
tags:
  - core
  - memory
  - knowledge
  - context
  - safety
status: stable
ask_examples:
  - Where are my context files stored?
  - How does the agent edit context files?
  - What is the difference between context MD and SQLite?
  - Where do management rules and policies live?
  - How does the daemon prevent the agent from writing to disk directly?
locale: en-US
created: 2026-04-25
updated: 2026-06-11
keywords:
  - context
  - markdown
  - SQLite
  - state/today.md
  - identity/profile.md
  - plans/roadmap.md
  - policies/management.md
  - policies/management-captures
  - journal/agent.md
  - context API
  - AgentWriteTracker
  - durable memory
  - context-vault v2
related:
  - features/memory-files/today
  - features/memory-files/user-profile
  - features/memory-files/roadmap
  - features/memory-files/agent-journal
  - features/memory-files/schedule
  - features/memory-files/projects
ui_anchors:
  - /knowledge
  - /settings
context_files:
  - state/today.md
  - identity/profile.md
  - plans/roadmap.md
  - journal/agent.md
  - journal/daily/<date>.md
  - plans/projects/<slug>.md
  - policies/management.md
  - policies/management-captures/<slug>.md
  - policies/management-captures/_index.md
config_keys:
  - dayBoundaryHour
  - dataDir
api_endpoints:
  - GET /api/context/*
  - PUT /api/context/*
  - PATCH /api/context/*
  - DELETE /api/context/*
---

# Memory Model

## TL;DR

Aitne treats Markdown files in `~/.personal-agent/context/`
as its long-term memory and SQLite
(`~/.personal-agent/data/personal_agent.db`) as session-scoped state.
Anything you want the agent to remember between runs lives in an MD
file you can read, diff, and edit by hand. The vault is partitioned
into six authority classes — `identity/`, `state/`, `plans/`, `journal/`,
`knowledge/`, and `policies/` — each carrying its own authority and
lifecycle contract. See [Knowledge Layout](../reference/knowledge-layout.md)
for the canonical map.

## Why This Concept Exists

A long-running agent that stores meaning inside an opaque database
gives you no recourse when something goes wrong. Aitne's design
is the opposite: every fact the agent recalls about you, your projects,
your day, or its own past behavior sits in a `.md` file you can open in
any editor. Auditing, backups, and recovery are all "use git or rsync".

SQLite is reserved for the things you do not want the agent rewriting
on every turn — session logs, action audit trails, observations, FTS
indexes, and configuration.

## Definitions

- **Context file**: any `.md` file under `~/.personal-agent/context/`.
- **Authoritative memory**: the union of context files; SQLite never
  stores facts the agent treats as canonical truth about the operator.
- **`AgentWriteTracker`**: the daemon component that distinguishes an
  agent-originated context-file write from a human edit so the
  Obsidian/Git observers do not loop on the agent's own output.
- **Context API**: the daemon's `/api/context/*` endpoint, the **only**
  legal write path. The agent does not have direct `Edit` / `Write`
  permissions on the filesystem; it must go through the daemon.

## How the Agent Writes

The agent has no `Edit` or `Write` tool. To change a context file it
calls the daemon over HTTP, and every write funnels through one
endpoint family so the daemon can validate, hold locks, and snapshot a
backup before touching disk. Paths are class-prefixed
(`/api/context/<class>/<path>`):

```bash
# Append a section to today.md
curl -X PATCH http://localhost:8321/api/context/state/today.md \
  -H 'Content-Type: application/json' \
  -d '{"mode":"append","section":"Notes","content":"Booked the dentist."}'
```

- `PUT /api/context/*` replaces a whole file; `PATCH` does a section op
  (`append`, `replace`, `clear`, `clear_before`, `append_to_file`);
  `DELETE` removes a file (permitted only on a few paths — user Agent
  definitions, inbox/scratch notes, and legacy custom-routine files).
- Legacy bare paths (`/api/context/today.md`) still resolve — the daemon
  rewrites them to the canonical class-prefixed form in process, so a
  plain `curl -X PATCH` without `-L` keeps working — but new writes
  emit the class-prefixed path.
- `state/today.md` and `plans/roadmap.md` are serialized behind
  dedicated write locks, so two flows can't clobber each other.

## Concrete Examples

- `state/today.md` — rewritten by the morning routine.
- `identity/profile.md` — your profile, hand-edited or appended by the
  agent on request. Topic-shaped slices live alongside it
  (`identity/people.md`, `identity/work.md`, `identity/expertise.md`,
  `identity/personal.md`, `identity/goals.md`). See
  [User Profile](../features/memory-files/user-profile.md).
- `plans/roadmap.md` — long-running goals + Preparation Timeline rows that
  fire daily during the morning routine.
- `journal/agent.md` — the agent's own running log of decisions,
  retros, and judgement calls.
- `journal/daily/2026-04-25.md` — per-date archive of that day's plan,
  synthesized by the morning routine.
- `plans/projects/<slug>.md` — one file per active project.
- `policies/management.md` — the umbrella registry: Source-of-Truth
  bindings, Managed Tasks, an Active Policies summary. Injected as
  `<management_rules>` on the wide-path flows (DMs, mentions, the
  morning routine); a few narrow routines (the journal stage, activity
  scan, today refresh, observer events, scheduled tasks) opt out to
  save budget.
- `policies/management-captures/<slug>.md` — one file per durable management rule
  ("from now on, do X"). The daemon auto-maintains a slug index at
  `policies/management-captures/_index.md`.

## Where You See It in the Dashboard

- **Knowledge → Context Files** lists every file with its last
  modified time and a preview.
- **Settings → Management Mode** shows where the vault lives (this app
  or an Obsidian-style directory), relocates it, and surfaces vault
  health.
- **Connections → Notes** is where personal note sources (your external
  Obsidian vault, Notion) attach.

## Related

- [Knowledge Layout](../reference/knowledge-layout.md) — canonical map of every vault file
- [state/today.md](../features/memory-files/today.md)
- [identity/profile.md](../features/memory-files/user-profile.md)
- [plans/roadmap.md](../features/memory-files/roadmap.md)
- [Skills](skills.md) — the per-skill SKILL.md files that tell the
  agent how to read and write each context file.
