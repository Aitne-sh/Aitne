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
  - guides
  - backends
  - operations
  - routing
status: stable
ask_examples:
  - How do I switch from Claude to Codex?
  - How do I make Gemini the default backend?
  - How do I change the main backend the agent uses?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - main backend
  - switch backend
  - default backend
  - PUT /api/backends/main
related:
  - concepts/backends-and-tiers
  - features/operations/backend-routing
  - guides/change-which-model-handles-x
  - troubleshooting/fallback-keeps-firing
ui_anchors:
  - /settings/models
  - /activity
process_keys:
  - message.dm
  - dashboard.docs_qa
api_endpoints:
  - PUT /api/backends/main
  - POST /api/backends/apply-defaults
---

# Switch the Default Backend

## Goal

Change which backend the agent uses by default for most work —
`claude`, `codex`, `gemini`, or `opencode`. This is the broad switch
that re-seeds every ProcessKey to the new backend's per-tier default
models. To change just one ProcessKey instead, see
[Change which model handles X](change-which-model-handles-x.md).

## Prerequisites

The new backend needs working auth before you switch, or the agent
will start failing the moment it routes work there.

- Register an API key for the backend on `/settings/models`
  (`anthropic` / `openai` / `google`, or one of the cloud-provider
  options for that backend).
- API keys are the supported path. If no key is set, the daemon falls
  back to whatever subscription login the backend's CLI already has —
  the auth-health card on `/settings/models` flags this so you can
  tell which credential is actually in use.

## Steps

1. Open `/settings/models`.
2. In the "Main backend" control, pick the new default and confirm.
3. The daemon re-seeds every ProcessKey to the new backend's per-tier
   default model (lite → medium → high). Rows you previously pinned
   yourself are **left untouched** — the re-seed skips any binding you
   set by hand, so your manual overrides survive the switch.

Behind the scenes step 2 calls `PUT /api/backends/main`, which writes
the new `default_backend`, runs the re-seed
(`POST /api/backends/apply-defaults` is the same logic you can trigger
manually to reset), and cascades any integrations that were in `native`
mode off the old backend.

### What the re-seed picks

Each ProcessKey keeps its tier; only the backend-specific model id
changes. For example, switching the main backend to Codex maps:

- lite-tier keys → `gpt-5.4-mini`
- medium-tier keys → `gpt-5.4`
- high-tier keys → `gpt-5.4` (the seeded high default collapses to the
  medium model; `gpt-5.5` stays opt-in only)

`dashboard.docs_qa` is hard-locked to the medium tier regardless of the
backend, so it always lands on that backend's medium model.

## Verification

- The Activity feed (`/activity`) shows the new backend on the next
  routine or DM row.

## If It Fails

- The auth-health card on `/settings/models` flips amber — the new
  backend's credential isn't valid. See
  [Auth Failed](../troubleshooting/auth-failed.md).
- If the agent keeps bouncing back to the old backend, the fallback
  may be firing: see
  [Fallback keeps firing](../troubleshooting/fallback-keeps-firing.md).

## Related

- [Backends and Tiers](../concepts/backends-and-tiers.md)
- [Backend routing](../features/operations/backend-routing.md)
- [Change which model handles X](change-which-model-handles-x.md)
