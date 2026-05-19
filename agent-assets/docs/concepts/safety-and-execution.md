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
  - core
  - safety
  - cost
status: stable
ask_examples:
  - What is the difference between Safe and Allow mode?
  - Can the agent ever delete files on its own?
  - How do I see what tools the agent is allowed to use?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - safety
  - safe mode
  - allow mode
  - absolute block
  - disallowed tools
  - approval
related:
  - concepts/skills
  - features/operations/approvals
  - reference/disallowed-tools
ui_anchors:
  - /settings/advanced
config_keys:
  - disallowedTools
  - allowedToolsOverride
  - claudeExecutionPermissionMode
  - codexExecutionPermissionMode
  - geminiExecutionPermissionMode
---

# Safety and Execution Modes

## TL;DR

Three layers gate what the agent can do:

1. **Skill `allowed-tools`** — the visible toolset for that session.
2. **Execution mode** — Safe (strict permission checks, sandboxes)
   or Allow (SDK bypass, sandbox off). Per-backend.
3. **Always-disallowed** — a hard floor. Recursive deletes, sudo,
   secret-file reads / writes are denied unconditionally regardless
   of mode.

## Why This Concept Exists

A long-running agent that can write files, send messages, and call
external APIs is one bad prompt away from a destructive turn. Layering
the safety controls means a misconfigured allow-list can't unlock the
absolute-block layer; a too-broad skill can't widen past the
disallowed-tools floor.

## Definitions

- **Safe mode**: the default. Strict permission checks, Claude curl/jq
  hooks, Codex workspace-write sandbox, Gemini whitelist TOML.
- **Allow mode**: the looser posture. SDK bypass, sandbox off, minimal
  TOML. The absolute-block layer still holds.
- **Absolute block**: the unconditional layer. `ALWAYS_DISALLOWED_TOOLS`
  in `src/safety/always-disallowed.ts`. Cannot be widened by skills,
  by config, or by allow-mode.
- **Risk tier**: `read`, `notify`, `approve`. Read = autonomous. Notify
  = the agent proceeds after DMing the operator. Approve = blocked
  until the operator clicks approve in the dashboard.

## Concrete Examples

| Action | Risk tier |
|---|---|
| Read `today.md` | read |
| Append to `agent/journal.md` | notify |
| Send a DM | notify |
| Update `roadmap.md` | approve |
| Recursive delete | absolute-block (refused) |
| `chmod` on a daemon-owned file | absolute-block |

## Where You See It in the Dashboard

- **Settings → Advanced** holds `disallowedTools`, `allowedToolsOverride`,
  and the per-backend execution mode switch.
- **Activity** logs every blocked tool call as `action_type='blocked_absolute'`.
- **Approvals** is where Approve-tier actions queue when they fire.

## Related

- [Skills](skills.md) — where each session's per-task `allowed-tools` lives.
- [Approvals](../features/operations/approvals.md) — the operator-side
  surface for Approve-tier actions.
- [Disallowed Tools (reference)](../reference/disallowed-tools.md)
