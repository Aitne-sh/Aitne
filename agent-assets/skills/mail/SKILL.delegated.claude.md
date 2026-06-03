---
name: mail
description: Load when the task touches Gmail AND Gmail is cross-backend delegated from a Claude DM session (`delegatedBackend` is non-Claude). Gmail routes through `POST /api/integrations/gmail/exec`; non-Gmail accounts (IMAP/Outlook/iCloud/Yahoo) keep `/api/mail/*`.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Mail (delegated, cross-backend)

Gmail is delegated to a different backend (Codex or Gemini). The daemon
spawns that backend on demand, lets it pick the right MCP tool, and
returns a schema-validated JSON result. **You describe intent in
natural language; the daemon picks the tool.** Tool name divergence
between Codex (`search_emails`), Gemini (`search`) and any custom MCP
server the user installs is invisible to you.

To confirm Gmail's current delegate, read
`~/.personal-agent/integrations.md` and consult its `delegatedBackend`
field. The same prose body below works for every delegate.

## Non-Gmail accounts keep the direct-mode surface

Per-account gating: the `/api/mail/*` 410 only fires when the resolved
`accountId` is `kind=gmail`. IMAP / Outlook / iCloud / Yahoo accounts
remain fully reachable through the direct-mode endpoints documented in
the base `mail` skill body — `GET /api/mail/:acct/messages`,
`POST /mail/:acct/drafts`, `GET /api/mail/:acct/threads/:threadId`, etc.
Use `accounts.md` (still materialized for this session) to resolve the
account and pick the path:

| Selected account `kind` | Path |
|---|---|
| `gmail` | task: `POST /api/integrations/gmail/exec {task, outputSchema, …}` (this file) |
| `outlook` / `icloud` / `yahoo` / `imap` | direct: `/api/mail/:acct/*` (base body) |

Only the Gmail branch leaves the direct-mode surface. Account
resolution (§1 of the base body), draft-vs-send rules, and reply-thread
chaining are unchanged for non-Gmail accounts.

## Call shape

The single endpoint is `POST /api/integrations/gmail/exec`. The body
takes a natural-language `task` plus an `outputSchema` (Draft-07 JSON
Schema) the daemon validates the result against. Optional fields
default safely; raise them only when the task genuinely needs more
budget.

```bash
curl -s -X POST http://localhost:8321/api/integrations/gmail/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Search Gmail for unread messages from alice@example.com in the last 7 days. Return up to 10 with sender, subject, snippet, timestamp.",
    "outputSchema": {
      "type": "object",
      "required": ["messages"],
      "properties": {
        "messages": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["from", "subject", "snippet", "ts"],
            "properties": {
              "from":    {"type": "string"},
              "subject": {"type": "string"},
              "snippet": {"type": "string"},
              "ts":      {"type": "string", "format": "date-time"}
            }
          }
        }
      }
    },
    "maxToolCalls": 5,
    "cacheable": true
  }'
```

Response shape on success:

```jsonc
{
  "result":   { "messages": [ ... ] },     // schema-validated parse
  "needsConfirmation": false,
  "confirmationPlan":  null,
  "trace":    [ /* per-tool-call breakdown — informational */ ],
  "cost":     { "tokensInput": ..., "costUsd": ..., "durationMs": ... }
}
```

`outputSchema` is **required** — the subprocess emits exactly one JSON
object as its final message and the daemon validates it. Schemas
larger than 4 KB are rejected (`schema_too_large`). Caps default to
`maxToolCalls=8`, `maxBudgetUsd=0.05`, `timeoutMs=60000` — bump them via
the request body up to the hard caps (15 / 0.50 / 300000) when a task
genuinely needs more.

## Idempotent reads — `cacheable: true`

Pure-read tasks (thread fetches, search summarisations, label lookups)
should set `cacheable: true` so a repeat invocation within 60s returns
~5ms from the in-memory LRU. The cache key includes the integration
state version, so flipping `deniedTools` or `delegatedBackend` purges
entries automatically. Cache hits still write a `delegated_task.exec`
audit row with `cost_usd=0` and `detail.cacheHit=true`.

Never set `cacheable: true` on:
- destructive-confirm second calls (`allowDestructive: true`),
- tasks that depend on minute-level freshness,
- any write.

## Destructive-confirm dance — `allowDestructive`

Default is `false`. The subprocess will not call destructive tools
(send / delete / batch label mutate / etc.) — instead it returns:

```jsonc
{
  "needsConfirmation": true,
  "confirmationPlan": "I will send a reply to alice@example.com with subject \"Re: Proposal\" and body …"
}
```

Surface `confirmationPlan` to the user verbatim. On their explicit OK,
re-issue the **same `task` verbatim** with `allowDestructive: true`. Do
NOT set `cacheable: true` on the second call — the confirmation does
not extend across cache lifetimes.

## Worked examples

### Read a whole thread (composition handled by the subprocess)

When the active connector lacks a thread-fetch primitive (Gemini), the
subprocess composes search + per-message get — you don't have to
think about it.

```bash
curl -s -X POST http://localhost:8321/api/integrations/gmail/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Fetch every message in Gmail thread <THREAD_ID>. For each message, return from / subject / body / timestamp. Sort by timestamp ascending.",
    "outputSchema": {
      "type": "object",
      "required": ["messages"],
      "properties": {
        "messages": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["from", "subject", "body", "ts"],
            "properties": {
              "from":    {"type": "string"},
              "subject": {"type": "string"},
              "body":    {"type": "string"},
              "ts":      {"type": "string", "format": "date-time"}
            }
          }
        }
      }
    },
    "maxToolCalls": 7,
    "cacheable": true
  }'
```

### Compose a draft (default-safe, no destructive flag needed)

Drafts are inert — the user can review and send from the Gmail web UI.
Prefer drafts over send.

```bash
curl -s -X POST http://localhost:8321/api/integrations/gmail/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Compose a Gmail draft replying to message <MESSAGE_ID>. Subject: \"Re: <ORIGINAL_SUBJECT>\". Body: <BODY>. Preserve the RFC-2822 thread (Message-Id + References).",
    "outputSchema": {
      "type": "object",
      "required": ["draftId"],
      "properties": { "draftId": { "type": "string" } }
    },
    "maxToolCalls": 4
  }'
```

### Send a previously-vetted draft (destructive — confirmation required)

Two-step ceremony: first call without `allowDestructive` returns the
confirmation envelope; on user OK, re-issue with the flag.

```bash
curl -s -X POST http://localhost:8321/api/integrations/gmail/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Send Gmail draft <DRAFT_ID> as-is. Do not edit the body.",
    "outputSchema": {
      "type": "object",
      "required": ["messageId"],
      "properties": { "messageId": { "type": "string" } }
    },
    "maxToolCalls": 2,
    "allowDestructive": true
  }'
```

## Default deny floor

The setup wizard pre-populates `gmail.deniedTools` with the connector's
destructive defaults. `/exec` honors the deny list, distinguishing two
cases: if **every** connector tool is denied → `403 denied_tool` (no
surface to plan against, rejected up front); if usable tools remain but
the specific tool a planned task needs is denied (or no tool fits) →
`502 tool_unavailable`. In both cases, surface that to the user and ask
whether to lift the relevant deny before retrying.

## Decision rules

- **Prefer drafts over send.** Drafts are reversible, send is not. The
  destructive-confirm dance applies to send anyway.
- **Replies preserve the RFC-2822 chain.** Pin `Message-Id` /
  `References` headers on the draft. The subprocess fetches them from
  the original message regardless of which connector underlies the
  delegate.
- **The reply account is implicit.** The connector picks the account
  based on its own auth — do not pass an `accountId`.
- **No `bcc` unless the user explicitly asks for it.**
- **Bulk operations: ask first.** Mass-mutation intents touch many
  messages in one call. Summarise what you would do (count + criteria)
  and confirm before invoking, even on the destructive-confirm path.

## Error envelope

`/exec` extends the direct-mode envelope with delegated-mode fields.
Discriminator: `body.mode === "delegated"`.

| HTTP | `error` | retry? | What to do |
|---|---|---|---|
| 400 | `validation_error` / `schema_too_large` | no | Fix the request body. |
| 409 | `mode_mismatch` | no | Gmail isn't delegated, OR your DM backend matches `delegatedBackend`. Re-read `integrations.md` and stop. |
| 409 | `precondition` | no | Mode/backend was flipped while the call queued. Re-read `integrations.md` and re-plan. |
| 403 | `denied_tool` | no | Every tool in the connector is denied — task mode has no surface to plan against. Surface to the user and ask whether to lift the deny. |
| 429 | `task_quota_exhausted` | no | Daily cap reached; wait or surface. |
| 502 | `parse_error` / `schema_violation` | no (daemon already retried once) | Consider a simpler schema. |
| 502 | `tool_unavailable` | no | No connector tool fits the intent. Surface the gap to the user. |
| 502 | `tool_failed` | maybe | Connector tool returned an error. Surface `body.message` verbatim; retry only if clearly transient. |
| 502 | `auth_error` | no | Connector signed out. Tell the user to re-authenticate. |
| 502 | `policy_violation` | no | Subprocess attempted a tool outside the per-task allowlist (anti-injection). Surface as anomaly. |
| 502 | `loop_aborted` | no | `maxToolCalls` exceeded. Likely planning gap; bump the cap or simplify the task. |
| 502 | `budget_exhausted` | no | `maxBudgetUsd` exceeded. Caller can raise the cap. |
| 502 | `post_write_format_failure` | no | Write succeeded; formatting failed. The side effect is real — surface to user with the partial trace. |
| 503 | `delegated_proxy_busy` | yes | Queue saturated. Backoff 3-5s and retry once. |
| 503 | `task_mode_disabled` | no | Operator turned the kill switch off. Stop. |
| 504 | `timeout` | yes (1×) | Wall-clock fired. Retry once for simple intents; otherwise surface. |
| 500 | `subprocess_crashed` | no | Daemon-side defect. Surface and stop. |

## Owner notification (opt-in)

The daemon does not auto-DM the owner. When you take an action the
user would want to know about *immediately* — sending an external
email, archiving a stack, applying a sensitive label — call:

```bash
curl -s -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message": "Sent reply to alice@example.com (Re: Proposal)"}'
```

Do not call `/api/notify` for routine reads / drafts / searches.

## Cost / retrospective

Every `/exec` writes one row to `agent_actions` with
`action_type='delegated_task.exec'` (token + USD breakdown). When the
user asks what you did:

```bash
curl -s "http://localhost:8321/api/agent/actions?kind=delegated_task.exec&since=2026-04-25T00:00:00Z&limit=50"
```

Summarise from the returned `actions` array — each row carries
`detail.taskHash` (a hash, NOT the task text — the verbatim intent is
deliberately not persisted, so do not try to read intent prose from it),
cost, cache hit flag, and timestamp.
