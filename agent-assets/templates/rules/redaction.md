---
type: rule
slug: redaction
owner: agent
updated: 2026-04-17
template_version: 1
---
# Redaction patterns

This file is English-only, informational — it exists so the user can see
what the agent is instructed to redact from any content it writes. Actual
redaction is performed in code by `packages/shared/src/secret-redaction.ts`.

## Always-redact

- API keys, tokens, session cookies
- OAuth client secrets, refresh tokens
- Private keys (PEM blocks, SSH keys)
- Connection strings with embedded credentials
- Personal secrets the user has asked the agent to forget

## Context-specific (journal export)

When exporting `daily/*.md` to an external vault (B-005), additional
user-defined rules in `rules/journal-export.md` are applied on top.

## Appearance in logs

Redacted values are replaced with `[REDACTED]` before any write to a vault
file, a notification payload, or an `agent_actions` row.
