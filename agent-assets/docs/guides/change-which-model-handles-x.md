---
schema_version: 1
slug: guides/change-which-model-handles-x
title: Change Which Model Handles X
id: change-which-model-handles-x
aliases:
  - per-process tier
  - per-process model
category: guides
summary: |
  Pin a specific ProcessKey to a non-default backend / tier — for
  example, run morning routine on Sonnet to save Opus tokens.
section: change-which-model-handles-x
tags:
  - guide
  - backends
  - models
status: stable
ask_examples:
  - How do I make my morning routine use Sonnet instead of Opus?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - per-process model
  - /settings/models
  - process binding
  - tier override
  - change model
related:
  - guides/switch-default-backend
  - concepts/backends-and-tiers
---

# Change Which Model Handles X

## Goal

Override the default tier or backend on a single ProcessKey.

## Steps

1. Open `/settings/models`.
2. Find the ProcessKey row in the table.
3. Pick its main backend and tier explicitly.
4. Save.

## Verification

- The next fire of that ProcessKey shows the new model in Activity.

## Related

- [Switch the Default Backend](switch-default-backend.md)
