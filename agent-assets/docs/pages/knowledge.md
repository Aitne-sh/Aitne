---
schema_version: 1
slug: pages/knowledge
title: "Knowledge Page"
id: page-knowledge
aliases:
  - knowledge page
  - memory page
  - context files page
category: pages
summary: |
  The Knowledge page is where the agent's memory lives — the Markdown
  context files it reads and writes, the skills it runs, plus activity,
  entities, and a way to upload your own knowledge files.
tags:
  - knowledge
  - memory
  - skills
status: stable
ask_examples:
  - What can I do on the Knowledge page?
  - Where do I edit what the agent knows about me?
  - Where are the agent's skills?
  - How do I upload a file into the agent's knowledge?
locale: en-US
created: 2026-07-01
updated: 2026-07-01
keywords:
  - knowledge
  - memory
  - context files
  - skills
  - entities
  - upload
related:
  - concepts/memory-model
  - concepts/skills
  - features/memory-files/user-profile
  - guides/import-knowledge-file
ui_anchors:
  - /knowledge
---

# Knowledge Page

The `/knowledge` page is your window into the agent's memory and skills.
It has five tabs.

## What you can do here

- **Context Files** — browse and edit the plain-Markdown files the agent
  reads and writes (identity/profile, state/today, journals, and more).
- **Skills** — review the skills the agent can run and how they're wired.
- **Activity** — see recent reads and writes against the knowledge store.
- **Entities** — the people, projects, and things the agent has extracted.
- **Upload** — add your own file into the agent's knowledge.

Tip: the `?` on each tab opens the concept doc for that tab specifically
(memory model, skills, or the import guide).

## Where to go deeper

- [Memory model](../concepts/memory-model.md) — the file layout and the
  rules around it.
- [Skills](../concepts/skills.md) — how skills and the self-learning loop
  work.
- [User profile file](../features/memory-files/user-profile.md) — what the
  agent knows about you.
- [Import a knowledge file](../guides/import-knowledge-file.md) — the
  upload flow end to end.

## Related

- [Wiki page](wiki.md) — a separate, workspace-scoped knowledge builder.
- [Settings page](settings.md) — Self-learning and Management live there.
