---
schema_version: 1
slug: guides/switch-default-backend
title: Switch the Default Backend
id: switch-default-backend
aliases:
  - switch backend
  - change main backend
  - switch claude codex gemini opencode
category: guides
summary: |
  Change the main backend the agent uses for most ProcessKeys, plus
  switching the fallback or pinning a specific ProcessKey to a
  different backend.
section: switch-default-backend
tags:
  - guide
  - backends
  - operations
status: stable
ask_examples:
  - How do I switch from Claude to Codex?
  - How do I make my morning routine use Gemini?
locale: en-US
created: 2026-04-25
updated: 2026-05-04
keywords:
  - main backend
  - switch backend
  - default backend
  - PUT /api/backends/main
related:
  - concepts/backends-and-tiers
  - features/operations/backend-routing
  - guides/change-which-model-handles-x
---

# Switch the Default Backend

## Goal

Change which backend the agent uses by default, or pin a specific
ProcessKey to a different one.

## Prerequisites

- The new backend has an API key registered on `/settings/models`
  (`anthropic` / `openai` / `google`, or one of the cloud-provider
  options for that backend). API keys are the supported path; if no
  key is set, the daemon falls back to whatever subscription login
  the CLI already has — the dashboard will flag it.

## Steps

1. Open `/settings/models`.
2. Click "Main backend" and pick the new default.
3. The cascade-write helper updates inheriting ProcessKeys
   (e.g. `dashboard.docs_qa` follows `message.dm`'s pin).
4. Per-ProcessKey overrides happen in the table below — pick a row
   and choose its main / fallback.

## Verification

- The Activity feed's next routine row shows the new backend.

## If It Fails

- Auth-health card flips amber: see [Auth Failed](../troubleshooting/auth-failed.md).

## Related

- [Backends and Tiers](../concepts/backends-and-tiers.md)
- [Change which model handles X](change-which-model-handles-x.md)
