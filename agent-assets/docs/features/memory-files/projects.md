---
schema_version: 1
slug: features/memory-files/projects
title: plans/projects/ files
id: projects
aliases:
  - project files
  - projects directory
  - plans/projects
category: features
summary: |
  One Markdown file per project under plans/projects/. Each captures
  the project's why, status, key links, and the per-project log of
  agent activity. Cross-linked from the roadmap and surfaced by the
  morning routine while the project is active.
section: memory-files
tags:
  - memory
  - projects
  - core
status: stable
ask_examples:
  - Where do I find the per-project files?
  - How does the agent decide a project is active?
  - How does the agent write to a project file?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - projects
  - project file
  - plans/projects/<slug>.md
  - active project
related:
  - features/memory-files/roadmap
  - features/memory-files/today
ui_anchors:
  - /knowledge?tab=context-files
api_endpoints:
  - GET /api/context/list/:dir
  - PUT /api/context/*
  - PATCH /api/context/*
context_files:
  - plans/projects/<slug>.md
---

# plans/projects/ Files

## In One Sentence

One Markdown file per project, stored at `plans/projects/<slug>.md`;
the agent appends notes, decisions, and external references over the
project's lifetime.

## What It Does

- Captures the project's purpose, status, links, and recent decisions
  in a single durable note.
- Surfaces in the morning routine while the project is active and the
  roadmap has Preparation Timeline rows pointing at it.
- Becomes the canonical reference the agent quotes from in DMs.

## File Shape

Each file lives at `plans/projects/<slug>.md`. The daemon validates
only the minimum — `type: project`, `owner: shared`, an `updated`
date, and an H1 title. By convention the agent also writes `slug`,
`state`, `start`, `due`, `stakeholders`, `next_milestone`, and `tags`.

`state` is what marks a project **active**: the dashboard's project
view filters on it, and the morning routine only surfaces projects
whose `state` is active.

```markdown
---
type: project
owner: shared
slug: spring-launch
state: active
due: 2026-06-15
next_milestone: ship beta
updated: 2026-05-28
---

# Spring Launch

## Why
Ship the public beta before the conference.

## Log
- 2026-05-28: agreed to cut feature X for v1.
```

## When It Runs / How It Is Triggered

Read on demand. Written when the operator asks the agent to remember
something project-specific, or when a DM expresses project intent
(create, update status, mark done).

The agent never edits files on disk — it has no `Edit`/`Write` tools.
All project writes go through the context API:

- `GET /api/context/list/projects` — discover existing project files.
- `PUT /api/context/plans/projects/<slug>` — create or fully replace.
- `PATCH /api/context/plans/projects/<slug>` — append a log line or
  update a section.

## Where in the Dashboard

- **Knowledge → Context Files** (`/knowledge?tab=context-files`), under
  the `plans/projects/` folder.

## Related

- [roadmap.md](roadmap.md) — cross-links to project files for deeper context.
- [today.md](today.md) — where active-project prep surfaces each day.
