---
type: index
owner: shared
updated: 2026-04-24
template_version: 2
---
# Policies

Natural-language policy files the agent reads to decide HOW to act. Each
is user-editable; changes take effect at the next task-flow assembly.

| File | Purpose |
|---|---|
| `policies/management.md` | Source-of-truth bindings (where each category lives) |
| `policies/management-captures/_index.md` | Active management policies captured from conversation |
| `policies/mcp.md` | MCP usage rules (B-003) |
| `policies/journal-format.md` | Format spec for the daily synthesized journal |
| `policies/journal-export.md` | User-defined redaction / inclusion rules for B-005 |
| `policies/redaction.md` | Built-in secret patterns (English, informational) |
| `policies/routines/` | Per-cadence routine definitions read by the scheduler |
| `policies/integrations.md` | Integration mode snapshot (renderer keeps this in sync) |
