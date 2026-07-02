---
schema_version: 1
slug: concepts/safety-and-execution
title: Safety and Execution Modes
id: safety-and-execution
aliases:
  - execution mode
  - safe mode
  - allow mode
  - absolute block
  - disallowed tools
category: concepts
summary: |
  Aitne has two execution-mode postures (Safe / Allow) plus an
  always-disallowed layer that holds in both. Together they decide
  what tools the agent can run, when it must ask for approval, and
  which actions are categorically refused.
section: safety
tags:
  - safety
  - operations
  - backends
status: stable
ask_examples:
  - What is the difference between Safe and Allow mode?
  - Can the agent ever delete files on its own?
  - How do I see what tools the agent is allowed to use?
locale: en-US
created: 2026-04-25
updated: 2026-07-01
keywords:
  - safety
  - safe mode
  - allow mode
  - absolute block
  - disallowed tools
  - approval
  - execution mode
  - risk tier
related:
  - concepts/safety-model
  - concepts/skills
  - features/operations/approvals
  - reference/disallowed-tools
ui_anchors:
  - /settings/safety
  - /settings/models
config_keys:
  - disallowedTools
  - allowedToolsOverride
  - claudeExecutionPermissionMode
  - codexExecutionPermissionMode
  - geminiExecutionPermissionMode
  - opencodeExecutionPermissionMode
---

# Safety and Execution Modes

## TL;DR

Three layers gate what the agent can do:

1. **Skill `allowed-tools`** — the visible toolset for that session.
2. **Execution mode** — Safe (strict permission checks, sandboxes)
   or Allow (the SDK's permission prompts are bypassed, sandbox off).
   Set per backend (the underlying agent engine — Claude, Codex,
   Gemini, or OpenCode).
3. **Always-disallowed** — a hard floor. Recursive deletes, `sudo`,
   secret-file reads / writes are denied unconditionally regardless
   of mode, and neither a skill nor Allow mode can widen past it.

A fourth idea — the **risk tier** — sits on top of the daemon API and
decides whether a *write* runs on its own or waits for your approval.

## Why This Concept Exists

A long-running agent that can write files, send messages, and call
external APIs is one bad prompt away from a destructive turn. Layering
the safety controls means a misconfigured allow-list can't unlock the
absolute-block layer; a too-broad skill can't widen past the
disallowed-tools floor.

## Definitions

- **Safe mode**: the default. Strict permission checks, plus a
  backend-specific enforcement layer — Claude curl/jq hooks, the Codex
  workspace-write sandbox, the Gemini whitelist TOML, and the OpenCode
  permission block.
- **Allow mode**: the looser posture. SDK bypass, sandbox off, minimal
  TOML. The absolute-block layer still holds in Allow mode on Claude,
  Gemini, and OpenCode. Codex is the documented exception. Its Allow
  mode is a binary sandbox-off switch, with no hook layer the daemon can
  attach the block list to, so the dashboard warns you before you flip
  it. You set the mode separately for each backend, so one backend can
  run Allow while the others stay Safe.
- **Absolute block**: the unconditional layer. `ALWAYS_DISALLOWED_TOOLS`
  in `src/safety/always-disallowed.ts`. Cannot be widened by skills,
  by config, or by allow-mode.
- **Risk tier**: every daemon-API operation carries one of three tiers —
  `autonomous`, `read_sensitive`, or `approve`. *Autonomous* runs without a
  prompt. *Read-sensitive* reads (email, calendar, notes, context files) can
  do no more harm than autonomous ones, but they are gated by a read token
  when `enforceReadToken` is on. *Approve* actions are blocked until you
  confirm with a bearer token (the dashboard does this when you click
  Approve). There is no separate "notify" tier — that behaviour now lives in
  the skill prompts: before a potentially destructive action the agent DMs
  you first, then proceeds. See [Safety model](safety-model.md) for the full
  taxonomy.

## Concrete Examples

The daemon API is the agent's only write path, so most of the writes it makes
are `autonomous` — a single choke point validates and snapshots each one. The
places the agent is actually stopped are the absolute-block layer and the
Approve tier.

| Action | What gates it |
|---|---|
| Read `state/today.md` | `read_sensitive` (read token if `enforceReadToken`) |
| Append to `journal/agent.md` | `autonomous` — daemon API write |
| Update `plans/roadmap.md` | `autonomous`, plus a roadmap write-lock |
| Send a DM | `autonomous`; destructive follow-ups DM you first |
| Configure an automation trigger | `approve` — needs a bearer token |
| `chmod` on a daemon-owned file | Safe-mode disallowed (allowed in Allow mode) |
| Recursive delete (`rm -rf`), `sudo`, secret-file read | absolute-block (refused in both modes) |

## Where You See It in the Dashboard

- **Settings → Safety** holds the `disallowedTools` and
  `allowedToolsOverride` tool-policy lists.
- **Settings → Models & Cost** holds the per-backend Safe / Allow
  **Execution Mode** switch (you can also set it in the setup wizard).
- **Activity** logs every absolute-blocked tool call as
  `action_type='blocked_absolute'`.
- The **Overview** page shows an approval card where Approve-tier
  actions queue when they fire.

## Related

- [Safety model](safety-model.md) — the full risk-tier taxonomy and where
  each API endpoint is classified.
- [Skills](skills.md) — where each session's per-task `allowed-tools` lives.
- [Approvals](../features/operations/approvals.md) — the operator-side
  surface for Approve-tier actions.
- [Disallowed Tools (reference)](../reference/disallowed-tools.md)
