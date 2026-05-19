---
schema_version: 1
slug: features/memory-files/projects
title: projects/ files
id: projects
aliases:
  - project files
  - projects directory
category: features
summary: |
  One Markdown file per active project under projects/. Each captures
  the project's why, status, key links, and the per-project log of
  agent activity. Cross-linked from the roadmap.
section: memory-files
tags:
  - memory
  - projects
  - core
status: stable
ask_examples:
  - Where do I find the per-project files?
  - How does the agent decide a project is active?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - projects.md
  - project file
  - projects/<slug>.md
  - active project
related:
  - features/memory-files/roadmap
context_files:
  - projects/<slug>.md
---

# projects/ Files

## In One Sentence

One Markdown file per active project; the agent appends notes,
decisions, and external references over the project's lifetime.

## What It Does

- Captures the project's purpose, status, links, recent decisions.
- Surfaces in the morning routine when the project is active and
  has Preparation Timeline rows.
- Becomes the canonical reference the agent quotes from in DMs.

## When It Runs / How It Is Triggered

Read on demand. Written when the operator asks the agent to
remember something project-specific.

## Where in the Dashboard

- **Knowledge → Context Files → projects/**.

## Related

- [roadmap.md](roadmap.md)
