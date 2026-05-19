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
  - storage
  - knowledge
status: stable
ask_examples:
  - Where are my context files stored?
  - How does the agent edit context files?
  - What is the difference between context MD and SQLite?
  - Where do management rules and policies live?
  - How does the daemon prevent the agent from writing to disk directly?
locale: en-US
created: 2026-04-25
updated: 2026-05-15
keywords:
  - context
  - markdown
  - SQLite
  - today.md
  - user/profile.md
  - roadmap.md
  - rules/management.md
  - rules/policies
  - agent journal
  - context API
  - AgentWriteTracker
  - durable memory
related:
  - features/memory-files/today
  - features/memory-files/user-profile
  - features/memory-files/roadmap
  - features/memory-files/agent-journal
  - features/memory-files/schedule
  - features/memory-files/projects
ui_anchors:
  - /knowledge
  - /connections/knowledge
context_files:
  - today.md
  - user/profile.md
  - roadmap.md
  - agent/journal.md
  - daily/<date>.md
  - projects/<slug>.md
  - rules/management.md
  - rules/policies/<slug>.md
  - rules/policies/_index.md
---

# Memory Model

## TL;DR

Aitne treats Markdown files in `~/.personal-agent/context/`
as its long-term memory and SQLite
(`~/.personal-agent/data/personal_agent.db`) as session-scoped state.
Anything you want the agent to remember between runs lives in an MD
file you can read, diff, and edit by hand.

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

## Concrete Examples

- `today.md` — rewritten by the morning routine.
- `user/profile.md` — your profile, hand-edited or appended by the
  agent on request. Topic-shaped slices live alongside it
  (`user/people.md`, `user/work.md`, `user/expertise.md`,
  `user/personal.md`, `user/goals.md`). See
  [User Profile](../features/memory-files/user-profile.md).
- `roadmap.md` — long-running goals + Preparation Timeline rows that
  fire daily during the morning routine.
- `agent/journal.md` — the agent's own running log of decisions,
  retros, and judgement calls.
- `daily/2026-04-25.md` — per-date archive of that day's plan,
  synthesized by the morning routine.
- `projects/<slug>.md` — one file per active project.
- `rules/management.md` — the umbrella registry: Source-of-Truth
  bindings, Managed Tasks, an Active Policies summary. Always
  injected into every flow.
- `rules/policies/<slug>.md` — one file per durable management rule
  ("from now on, do X"). The daemon auto-maintains a slug index at
  `rules/policies/_index.md`.

## Where You See It in the Dashboard

- **Knowledge → Context Files** lists every file with its size, last
  modified time, and a preview.
- **Connections → Knowledge** is where vault integrations (Obsidian,
  Notion) attach.

## Related

- [today.md](../features/memory-files/today.md)
- [user/profile.md](../features/memory-files/user-profile.md)
- [roadmap.md](../features/memory-files/roadmap.md)
- [Skills](skills.md) — the per-skill SKILL.md files that tell the
  agent how to read and write each context file.
