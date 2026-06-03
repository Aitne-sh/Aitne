---
name: mail
description: Load when the task touches Gmail AND Gmail is in native mode bound to Claude (`nativeBackend === "claude"`). Use the in-session Gmail connector directly; the daemon does not proxy Gmail. Non-Gmail accounts (IMAP/Outlook/iCloud/Yahoo) keep `/api/mail/*`.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Mail (native — in-session Gmail connector)

> **Refusal directive — read first.** Gmail is in `native` mode bound to
> Claude. Do **NOT** call any of:
>
> - `POST /api/integrations/gmail/exec` (returns `410` with
>   `X-Integration-Mode: native`)
> - `POST /api/integrations/gmail/reconcile` (410)
> - `/api/mail/<gmail-account-id>/*` (per-account 410 inside the mail
>   handler; the daemon returns `{"error":"integration_native"}`)
>
> Reach Gmail through the in-session Gmail connector your harness exposes.
> Your tool menu lists every available tool at session start — pick the
> Gmail one. The 410 is a contract, not an outage — the route gate
> enforces native-mode exclusivity per `INTEGRATION_NATIVE_MODE_DESIGN.md`
> §9.

To confirm Gmail's current binding, read the `<integration_modes>`
block in the system prompt (it carries `gmail="native"` and the
`<integration-routing-table>` block names the bound backend). The
fallback file `~/.personal-agent/integrations.md` shows the same
information.

## Gmail — in-session connector

The exact tool names depend on which Gmail connector your harness has
loaded. Inspect your tool menu at session start and pick the matching
capability. Capability-to-intent mapping you should look for:

### Read-class capabilities (`requiredCapabilities` floor)

| Capability | What to do | How to use |
|---|---|---|
| `search` | Search / list Gmail threads | Pass a Gmail query string (e.g. `q="newer_than:1d in:inbox -label:Promotions"`). |
| `read` | Fetch a single thread's messages | Pass the `threadId` returned by search. |
| `label` | Enumerate available labels | Read-only listing — labels typically have stable IDs per user. |

Canonical search → read flow:

1. Search recent inbox threads with a Gmail-style query, capping result
   count to a reasonable number (≈50 for hourly windows).
2. For each interesting thread id, fetch the full thread to read its
   messages.

### Draft-class capabilities (reversible — write-class, not destructive)

| Capability | What to do | Confirmation |
|---|---|---|
| `draft` | Create or list drafts | Autonomous — drafts are inert until the user sends from the Gmail web UI. Prefer drafts over direct send. |

Reply-thread chaining for drafts uses the same RFC-2822 headers documented in
the direct-mode `mail` skill — most connectors expose `inReplyTo` /
`references` fields on their create-draft function. Fetch the thread, copy
the last message's `Message-Id` into `inReplyTo`, append it to `references`.

### Destructive capabilities (require explicit user confirmation)

Per the registry's `gmail.backendConnectors.claude.destructiveTools`, any
tool that mutates a thread's or message's labels — or modifies the user's
label taxonomy — counts as destructive in native:claude mode (the hosted
Gmail connector deliberately ships no send / forward / delete / trash /
archive surface, so the destructive set is restricted to label mutation
and label-taxonomy edits). Apply the same destructive-confirm contract as
delegated mode: summarise the plan ("apply label `urgent` to 4 threads"),
wait for the user's explicit OK, then issue the call. The absolute-block
layer (`docs/design/09-safety-cost.md` §6) continues to fire regardless of
mode — secret-file reads, recursive deletes, and privilege escalation are
denied in every posture.

The `deniedTools` list (from `<integration_modes>` / dashboard Tool
Permissions card) still applies. A tool name on the deny list returns
an error before the call lands.

## Non-Gmail accounts (IMAP / Outlook / iCloud / Yahoo)

Per-account gating: the `/api/mail/*` 410 only fires when the resolved
`accountId` is `kind=gmail`. IMAP / Outlook / iCloud / Yahoo accounts
remain fully reachable through the direct-mode endpoints — `accounts.md`
(materialised alongside this skill) lists every active account, and the
routing decision is per account `kind`:

| Selected account `kind` | Path |
|---|---|
| `gmail` | in-session Gmail connector (as above) |
| `outlook` / `icloud` / `yahoo` / `imap` | direct: `/api/mail/<acct>/*` — see the base body for endpoint reference, account-resolution rules (§1), draft-vs-send contract, RFC-2822 reply-thread shape |

Only the Gmail branch leaves the direct-mode surface. Account
resolution, send-vs-draft preferences, and per-account quotas are
unchanged for non-Gmail accounts.

## Persisting observations from native fetches

When you fetch Gmail data during a routine (e.g. `routine.hourly_check`'s
Step 0a), POST each materialised thread to the daemon's
`/api/observations` endpoint so subsequent runs can dedup. The daemon
computes `contentHash` server-side via
`@aitne/shared/observations-hash` — pass the raw `payload`
verbatim; do **not** compute the hash yourself (LLM-side hashes drift
between runs and from the delegated-sync-worker's hash, breaking
`delegated → native` flip dedup).

**Batch when you have more than one thread.** A single-curl
`POST /api/observations/batch` accepting up to 200 items is the
preferred shape — see the `observations` skill for the envelope. The
single-item form below is for the rare "one new thread surfaced" case.

```bash
curl -s -X POST http://localhost:8321/api/observations \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "gmail:<accountId>",
    "ref": "<threadId>",
    "changeType": "created",
    "actor": "agent",
    "payload": <verbatim connector response object>
  }'
```

`actor` MUST be `"agent"` or `"system"` — the server rejects `"user"`
(user-authored observations arrive through the vault / mail watchers,
never this route). The `source` value follows the `"<integrationKey>:<scope>"`
convention so the hourly_check consumer's
`source_prefix=gmail:` filter matches.

`/api/observations` is **never** native-gated — it is the chokepoint the
native flow relies on for cross-mode dedup, so it stays reachable in
every mode. The route also rejects late writes from a mode-flip race
window (§11.3.1) with HTTP 409; on 409 stop and re-read
`<integration_modes>` — the integration has flipped under you.

## Decision rules

- **Hourly check is read-only.** Native variants inherit the
  "External services are read-only this hour" constraint from
  `routine.hourly_check.native.<backend>.md`. No drafts, labels,
  archives during the hourly pass — the morning / evening / DM
  flows are the write paths.
- **Prefer drafts over send.** Hosted Gmail connectors typically expose
  no send surface, so drafts are the default channel here. If the user
  explicitly wants a message sent, point them at the Gmail web UI —
  explain that this configuration is draft-only by design.
- **Replies preserve the RFC-2822 chain.** Fetch the thread, copy
  `Message-Id` to `inReplyTo`, append it to `references`. The connector
  signs from the user's authenticated Google account; do not pass an
  `accountId` (the connector picks).
- **Bulk operations: ask first.** Label mutations that touch more than
  ~3 threads in one call should be summarised and confirmed before
  issuing — even when the destructive-confirm dance covers the tool
  itself.
- **No `bcc` unless the user explicitly asks for it.**

## Cost / audit

Every native MCP call is logged to the `mcp_tool_calls` table
(`server_id`, `tool_name`, `event_type`, `session_id`, `ok` / `error`,
`called_at`, `duration_ms`) — NOT to `agent_actions`, and with no
per-call token or provider columns. The operator's cost view attributes
native spend by server / namespace from those rows so it can see the
shift after a flip. You do not query this yourself — just call the
connector and POST observations.
