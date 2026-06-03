---
kind: reference
name: exec-errors
description: Delegated `/exec` error envelope — HTTP status, `error` code, retry guidance. Shared across the cross-backend SKILL.delegated.*.md Calendar variants.
---

### Error envelope

`/exec` extends the direct-mode envelope with delegated-mode fields.
Discriminator: `body.mode === "delegated"`.

| HTTP | `error` | retry? | What to do |
|---|---|---|---|
| 400 | `validation_error` / `schema_too_large` | no | Fix the request body. |
| 409 | `mode_mismatch` | no | Calendar isn't delegated, OR your DM backend matches `delegatedBackend`. Re-read `integrations.md` and stop. |
| 409 | `precondition` | no | Mode/backend flipped during the queue wait. Re-check state and re-plan. |
| 429 | `task_quota_exhausted` | no | Daily cap reached; wait or surface. |
| 502 | `parse_error` / `schema_violation` | no (daemon already retried once) | Consider a simpler schema. |
| 502 | `tool_unavailable` | no | No connector tool fits the intent. Surface the gap. |
| 502 | `tool_failed` | maybe | Connector tool returned an error. Surface `body.message` verbatim; retry only if clearly transient. |
| 502 | `auth_error` | no | Connector signed out. Tell the user to re-authenticate it. |
| 502 | `policy_violation` | no | Subprocess attempted a tool outside the per-task allowlist (anti-injection). |
| 502 | `loop_aborted` | no | `maxToolCalls` exceeded. Bump the cap or simplify. |
| 502 | `budget_exhausted` | no | `maxBudgetUsd` exceeded. Caller can raise the cap. |
| 502 | `post_write_format_failure` | no | Write succeeded; formatting failed. Side effect is real — surface with the partial trace. |
| 503 | `delegated_proxy_busy` | yes | Daemon queue saturated. Backoff a few seconds, try once. |
| 503 | `task_mode_disabled` | no | Operator turned the kill switch off. Stop. |
| 504 | `timeout` | yes (1×) | Wall-clock fired. Retry once if intent was simple. |
| 500 | `subprocess_crashed` | no | Unhandled exception inside the subprocess. Surface and stop. |

Always preserve `body.message` verbatim when reporting to the user — it
carries the connector's own language.
