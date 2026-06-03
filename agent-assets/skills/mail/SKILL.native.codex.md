---
name: mail
description: Load when the task touches Gmail AND Gmail is in native mode bound to Codex (`nativeBackend === "codex"`). Use the Gmail connector your Codex harness exposes directly; the daemon does not proxy Gmail. Non-Gmail accounts (IMAP/Outlook/iCloud/Yahoo) keep `/api/mail/*`.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Mail (native — in-session Gmail connector)

> **Refusal directive — read first.** Gmail is in `native` mode bound to
> Codex. Do **NOT** call any of:
>
> - `POST /api/integrations/gmail/exec` (returns `410` with
>   `X-Integration-Mode: native`)
> - `POST /api/integrations/gmail/reconcile` (410)
> - `/api/mail/<gmail-account-id>/*` (per-account 410)
>
> Reach Gmail through the in-session Gmail connector your harness
> exposes. Your tool menu lists every available tool at session start —
> pick the Gmail one. The 410 is a contract, not an outage — the route
> gate enforces native-mode exclusivity per
> `INTEGRATION_NATIVE_MODE_DESIGN.md` §9.

To confirm the binding, read `<integration_modes>` (carries
`gmail="native"`) and the `<integration-routing-table>` block in the
session preamble. `~/.personal-agent/integrations.md` mirrors the same
information.

## Gmail — in-session connector

The exact tool names depend on which Gmail connector your harness has
loaded. Inspect your tool menu at session start and pick the matching
capability. Codex-side hosted connectors typically expose a richer
surface than Claude's (search-emails / read-thread / draft + dedicated
send / forward / delete / archive / label tools), but the surface
varies by harness; rely on the capability classes below rather than
specific names.

### Read-class capabilities (`requiredCapabilities` floor)

| Capability | What to do |
|---|---|
| `search` | Search Gmail with a query string. Most connectors expose a results-with-payload primitive plus an ids-only paging variant — use the ids-only flavor when the result count would overflow a single page. |
| `read` | Single-message read or full-thread read by id. If the connector exposes both, prefer the thread-walk primitive when you need the conversation context. |
| `label` | Enumerate available labels (read-only). |

Canonical search flow: invoke your connector's search function with
`query="newer_than:1d in:inbox -label:Promotions"` and `max_results=50`.
The exact argument names match the connector's schema (often `query` +
`max_results`); inspect the tool definition to confirm.

Canonical thread read: invoke your connector's read-thread function
(or single-message-read + iterate) with the `thread_id` / `message_id`
returned by search.

### Draft-class capabilities (reversible — write-class, not destructive)

| Capability | What to do | Confirmation |
|---|---|---|
| `draft` | Create a draft. Autonomous — drafts are inert until the user sends. Prefer drafts. |
| `draft` | List drafts (read). |
| `update_draft` | Mutate a not-yet-sent draft. Reversible — the user can still review before sending. Write-class but not destructive. |

Reply-thread chaining: most connectors expose RFC-2822 `in_reply_to` /
`references` fields on their create-draft function. Fetch the thread
first, copy the last message's `Message-Id` to `in_reply_to`, append it
to `references`.

### Destructive capabilities (require explicit user confirmation)

Per the registry's `gmail.backendConnectors.codex.destructiveTools`,
the following capability classes are destructive in native:codex mode:

- **Send / forward** — irreversible dispatch (compose-and-send, send a
  previously composed draft, forward a thread).
- **Delete** — irreversible removal.
- **Archive** — reversible but user-visible; treated as destructive.
- **Apply / bulk-apply labels** — label mutation, single or mass.
- **Create label** — taxonomy edit.
- **Batch modify** — mass mutation across many messages.

Apply the destructive-confirm contract:

1. Compose a one-line plan ("send reply to alice@example.com Re:
   Proposal"; "archive 4 newsletter threads matching `from:digest@...`").
2. Surface the plan to the user verbatim and wait for an explicit OK.
3. On OK, issue the call once. Do not retry on `policy_violation` —
   the absolute-block layer or the `deniedTools` deny list rejected it
   for a reason.

The starter `deniedTools` list (typically denies the send capability)
is pre-populated by the setup wizard for safety; the dashboard's Tool
Permissions card is the surface for widening it. Calls into a denied
tool fail before they reach the connector.

## Non-Gmail accounts (IMAP / Outlook / iCloud / Yahoo)

Per-account gating: `/api/mail/*` 410 only fires when
`accountId` resolves to a Gmail account. `accounts.md` (materialised
alongside this skill) is the authoritative list. Routing:

| Selected account `kind` | Path |
|---|---|
| `gmail` | in-session Gmail connector (as above) |
| `outlook` / `icloud` / `yahoo` / `imap` | direct: `/api/mail/<acct>/*` (see base body) |

The base body's account-resolution rules (§1), send-vs-draft contract,
and RFC-2822 reply chain shape are unchanged for non-Gmail accounts.

## Persisting observations from native fetches

POST each materialised Gmail thread fetched in a routine to
`/api/observations`. The daemon computes `contentHash` server-side via
`@aitne/shared/observations-hash`; pass `payload` verbatim.

**Batch when you have more than one thread.** Use
`POST /api/observations/batch` with up to 200 items in a single
`observations[]` array (see the `observations` skill for the envelope).
The single-item form below is for the rare "one new thread surfaced"
case.

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

`actor` MUST be `"agent"` or `"system"` — the server rejects `"user"`.

`/api/observations` is never gated. On HTTP 409 (lock-window race
during a mode flip per §11.3.1), stop and re-read `<integration_modes>`
— the integration has flipped under you.

## Decision rules

- **Hourly check is read-only** — inherits the constraint from
  `routine.hourly_check.native.codex.md`. No sends, archives, label
  writes during hourly.
- **Prefer drafts over send.** The create-draft capability is
  autonomous; the send / send-draft capabilities require explicit user
  OK.
- **Replies preserve the RFC-2822 chain.** Pin `Message-Id` /
  `References` headers on the draft.
- **Bulk operations: ask first.** A bulk-label or batch-modify call
  that would touch more than ~3 messages needs an explicit confirmation
  message summarising the criteria and the count.
- **The reply account is implicit.** The connector signs from the
  authenticated Google account; do not pass an `accountId`.
- **No `bcc` unless the user explicitly asks for it.**

## Cost / audit

Native MCP calls land `agent_actions` rows of type `mcp_call` with
`provider="codex"`, the tool name, and the parent `event_id` /
`processKey`. The cost dashboard joins these to the registry by
`toolNamespace` prefix for the `nativeAttribution` rollup (§14.4).
