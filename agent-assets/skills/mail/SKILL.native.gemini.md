---
name: mail
description: Load when the task touches Gmail AND Gmail is in native mode bound to Gemini (`nativeBackend === "gemini"`). Use the Gmail connector your Gemini harness exposes directly; the daemon does not proxy Gmail. Non-Gmail accounts (IMAP/Outlook/iCloud/Yahoo) keep `/api/mail/*`.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Mail (native — in-session Gmail connector)

> **Refusal directive — read first.** Gmail is in `native` mode bound to
> Gemini. Do **NOT** call any of:
>
> - `/api/mail/<gmail-account-id>/*` (per-account 410)
> - `POST /api/integrations/gmail/exec`
> - `POST /api/integrations/gmail/reconcile`
>
> In native mode `POST /api/integrations/gmail/exec` returns **409
> `mode_mismatch`** (the handler rejects non-delegated mode);
> `.../reconcile` is not mode-gated at all. Do not call either — use the
> native connector. The 410 + `X-Integration-Mode: native` refusal
> contract applies ONLY to the integration's own data routes
> (the per-account `/api/mail/<gmail-account-id>/*` paths).
>
> Reach Gmail through the in-session Gmail connector your harness
> exposes (typically Gemini CLI's `google-workspace` extension or a
> user-installed equivalent). Your tool menu lists every available tool
> at session start — pick the Gmail one.

Confirm the binding by reading `<integration_modes>` (carries
`gmail="native"`) and the `<integration-routing-table>` block in the
session preamble. `~/.personal-agent/integrations.md` mirrors the same.

## Gmail — in-session connector

The exact tool names depend on which Gmail connector your harness has
loaded. Inspect your tool menu at session start and pick the matching
capability. Gemini CLI's `google-workspace` extension is the typical
provider here; its surface is leaner than Codex's (no dedicated
delete / forward — those compose from primitives, see below). Other
user-installed Gmail MCP servers may differ; rely on the capability
classes rather than specific tool names.

### Read-class capabilities (`requiredCapabilities` floor)

| Capability | What to do |
|---|---|
| `search` | Gmail search — pass a query string in the same grammar as the web UI. |
| `read` | Fetch a single message by id. Some connectors expose no thread-walk primitive; compose search + per-message read in that case (see pattern below). |
| `label` | Enumerate available labels (read-only). |

Canonical search flow: invoke your connector's search function with
`q="newer_than:1d in:inbox -label:Promotions"` and (if supported)
`maxResults=50`. See the Gemini-specific quirk below: some connectors
silently ignore `maxResults`.

Read pattern when the connector lacks a thread-walk primitive (compose
search + per-message read):

```
hits = <connector search>(q="threadId:<id>", maxResults=100)
for msg_id in hits:
    <connector get message>(id=msg_id)
```

### Draft-class capabilities (reversible — write-class, not destructive)

| Capability | What to do | Confirmation |
|---|---|---|
| `draft` | Create a draft. Autonomous — drafts are inert until the user sends. Prefer drafts over send. |
| `read_attachment` | Download an attachment (read). |

The create-draft capability typically accepts `inReplyTo` and
`references` fields for RFC-2822 thread chaining — fetch the thread
first, pin the headers.

### Destructive capabilities (require explicit user confirmation)

Per the registry's `gmail.backendConnectors.gemini.destructiveTools`,
the following capability classes are destructive in native:gemini mode:

- **Send** — compose-and-send in one call (irreversible).
- **Send draft** — dispatch a previously composed draft (irreversible).
- **Modify** — apply / remove labels including the system `TRASH` label
  (covers delete-by-trash; archive likewise via `INBOX` label removal).
- **Modify thread** — same as modify, thread-scope.
- **Create label** — taxonomy edit.
- **Batch modify** — mass label mutation.

Some Gemini-side connectors (notably the `google-workspace` extension)
expose **no** dedicated delete or forward tool — those compose from
primitives (delete = modify + add `TRASH`; forward = send with re-quoted
body). The registry's `gemini.optionalCapabilities` reflects this
honestly; do not infer parity the connector does not have. If the user
asks to forward a message, fetch it, compose the body, and call send
after the destructive confirmation.

Apply the destructive-confirm contract:

1. Summarise the plan in one line.
2. Surface verbatim and wait for explicit user OK.
3. On OK, issue the call once. The starter `deniedTools` list
   (typically includes the send capability) is enforced before the
   call lands; honour it.

The absolute-block layer (`docs/design/09-safety-cost.md` §6) continues
to fire regardless of mode — recursive deletes, secret-file reads, and
privilege escalation are denied in every posture.

## Non-Gmail accounts (IMAP / Outlook / iCloud / Yahoo)

Per-account gating: `/api/mail/*` 410 only fires when `accountId`
resolves to a Gmail account. Routing:

| Selected account `kind` | Path |
|---|---|
| `gmail` | in-session Gmail connector (as above) |
| `outlook` / `icloud` / `yahoo` / `imap` | direct: `/api/mail/<acct>/*` (see base body) |

The base body's account-resolution rules (§1), send-vs-draft contract,
RFC-2822 reply chain shape, and bulk-operation discipline are unchanged
for non-Gmail accounts.

## Persisting observations from native fetches

POST each materialised Gmail message fetched in a routine to
`/api/observations`. The daemon computes `contentHash` server-side via
the shared util in `@aitne/shared/observations-hash`; pass
`payload` verbatim.

**Batch when you have more than one message.** Use
`POST /api/observations/batch` with up to 200 items in one
`observations[]` array (see the `observations` skill for the envelope).
The single-item form below is for the rare "one new message surfaced"
case.

```bash
curl -s -X POST http://localhost:8321/api/observations \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "gmail:<accountId>",
    "ref": "<threadId-or-messageId>",
    "changeType": "created",
    "actor": "agent",
    "payload": <verbatim connector response object>
  }'
```

`actor` MUST be `"agent"` or `"system"` — the server rejects `"user"`.

`/api/observations` is never gated. On HTTP 409 the integration has
flipped during the lock window (§11.3.1) — stop and re-read
`<integration_modes>`.

## Decision rules

- **Activity scan is read-only** — inherits the constraint from
  `routine.activity_scan.native.gemini.md`.
- **Prefer drafts over send.** The create-draft capability is
  autonomous; send / send-draft need explicit user OK.
- **Replies preserve the RFC-2822 chain.** Pin `inReplyTo` /
  `references` on the draft.
- **Bulk operations: ask first.** Batch-modify and modify-thread calls
  touching more than ~3 messages need an explicit confirmation.
- **The reply account is implicit** — the connector signs from the
  user's authenticated Google account.
- **No `bcc` unless the user explicitly asks for it.**
- **Gemini-specific quirk** (`maxResults` ignored on search): some
  Gemini-side Gmail connectors silently ignore `maxResults`; the
  result set is bounded only by the query window and the connector's
  default. When the call returns more than expected, paginate via
  narrower `q=` windows rather than retrying with a smaller
  `maxResults`.

## Cost / audit

Native MCP calls land `agent_actions` rows of type `mcp_call` with
`provider="gemini"`, the tool name, and the parent `event_id` /
`processKey`. The cost dashboard joins them to the registry by
`toolNamespace` prefix for the `nativeAttribution` rollup (§14.4).
