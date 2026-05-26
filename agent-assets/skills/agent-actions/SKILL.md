---
name: agent-actions
description: Load when the running session needs to write structured metadata into its own `agent_actions` row so daemon-side consumers (morning-routine AgentJournalAppender, anomaly surfacing, audit log) read structured data instead of parsing prose.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Agent self-reporting structured metadata

The running session can patch structured metadata into the `agent_actions`
row that records its own run. The daemon's morning-routine pipeline
consumes that metadata to assemble `journal/agent.md` without parsing
your final-text output — see `docs/design/appendices/morning-routine-
optimization.md` §"Data-flow principle: prose vs structured".

## When to call this

Call exactly once near the end of your turn, after you have produced
every other output. The endpoint is shallow-merge so repeated PATCHes
within the same session accumulate — but the morning-routine task-flow
expects a single consolidated call so the audit row reads cleanly.

## Authentication

<a id="self-write-auth"></a>

The endpoint resolves your `agent_actions` row from two headers that
the daemon's pa-api / curl shim auto-attaches inside a
dispatcher-spawned session:

- `x-pa-event-correlation-id` (from `PA_EVENT_CORRELATION_ID`) —
  matches `agent_actions.event_id`.
- `x-process-key` (from `PA_PROCESS_KEY`) — matches
  `agent_actions.action_type`.

When you call this from skill prose using `curl`, the shim handles
header attachment for you — you do not type them. The endpoint returns
`agent_actions.session_identity_missing` if either header is absent
(the session is misconfigured) and `agent_actions.session_row_not_found`
if no in-flight row matches your session — typically because the row
has already settled to a terminal `result`, or because the dispatcher
spawned the session without the pre-insert step that the morning
routine's pipeline orchestrator owns. Surface as anomaly and continue.

## Metadata shape

<a id="metadata-shape"></a>

The morning-routine Stage A is the primary caller. Its expected shape:

| Field | Type | Purpose |
|---|---|---|
| `dayType` | `"weekday" \| "weekend" \| "focus" \| "off"` | The day-type Stage A derived. ⑥ AgentJournalAppender writes this into agent/journal.md's header line. |
| `anomalies` | `string[]` | Free-form anomalies you encountered (e.g. "AgentPlan cardinality mismatch: today.md has 6 rows, batch had 5"). ⑥ surfaces these in agent/journal.md and `pnpm audit` filters on them. |
| `filesTouched` | `string[]` | Paths your turn wrote to (e.g. `context/today.md`, `context/roadmap.md`). |
| `inboxStats` | `{triaged, movedToScratch, dmConfirmsSent, secretsSkipped}` | Inbox triage counts from Step 4. All keys integers >= 0. `secretsSkipped` is collected but NOT rendered by ⑥; surface secret-skip events through `anomalies` as well so they reach the audit trail. |
| `morningChecks` | `string[]` | Short labels for every Step 8 `policies/routines/morning.md` extension check executed (e.g. `"water bottle filled"`). ⑥ joins these with `, ` into the `Checks from routines/morning.md:` bullet. Empty array → renders as `(none)`. |
| `scheduleBatchSize` | `number` | Cardinality you observed when posting to `/api/schedule/batch`. Mirrors what was POSTed so ⑥ can detect cardinality mismatches against today.md. |

The endpoint accepts any well-formed JSON object — these are the keys
the morning-routine pipeline consumes. Skills can extend the shape
informally; the daemon does not constrain field set.

## Call shape

```bash
curl -s -X PATCH http://localhost:8321/api/agent-actions/self \
  -H 'Content-Type: application/json' \
  -d '{
    "metadata": {
      "dayType": "weekday",
      "anomalies": [],
      "filesTouched": ["context/today.md", "context/roadmap.md"],
      "inboxStats": { "triaged": 4, "movedToScratch": 4, "dmConfirmsSent": 1, "secretsSkipped": 0 },
      "morningChecks": ["water bottle filled", "calendar synced"],
      "scheduleBatchSize": 5
    }
  }'
```

Success (200):
```json
{ "ok": true, "id": 1234, "metadata": { ...merged result... } }
```

## Errors

Every error response uses the **agent-consumable envelope**:

```jsonc
{
  "ok": false,
  "summary": "Request rejected: agent_actions.session_identity_missing on headers.x-pa-event-correlation-id.",
  "errors": [
    {
      "rowIndex": null,
      "code": "agent_actions.session_identity_missing",
      "field": "headers.x-pa-event-correlation-id",
      "received": "<missing>",
      "expected": "x-pa-event-correlation-id and x-process-key headers identifying the running session",
      "hint": "The pa-api shim auto-injects these from PA_EVENT_CORRELATION_ID and PA_PROCESS_KEY when running inside a dispatcher-spawned session.",
      "skillAnchor": "agent-actions#self-write-auth",
      "severity": "error"
    }
  ],
  "retryable": false
}
```

### Codes the endpoint can emit

| Code | When | Fix |
|---|---|---|
| `agent_actions.session_identity_missing` | `x-pa-event-correlation-id` or `x-process-key` header is absent / empty. | Running inside a dispatcher-spawned session the pa-api shim attaches both headers from env. If you see this, the session is misconfigured — surface it as an anomaly via `<safety_violation>` and stop. Not retryable in the same turn. |
| `agent_actions.session_row_not_found` | No in-flight `agent_actions` row matches `(event_id, action_type)`. | Either the row has already settled to a terminal result (success/failed/partial) and your PATCH arrived late, or the dispatcher spawned this session without the orchestrator-side pre-insert that the morning-routine pipeline relies on. Either way, the PATCH cannot land — surface as anomaly and continue. Not retryable. |
| `agent_actions.body_not_object` | Request body is not a JSON object. | POST `{"metadata":{…}}`. |
| `agent_actions.metadata_field_invalid` | `metadata` slot is missing, not an object, an array, or carries non-JSON-serialisable values (functions, Symbols, BigInts). | Pass a plain JSON object literal. Arrays go inside named keys (e.g. `anomalies:[…]`). |

`retryable:false` means the agent should NOT retry the same call; it
should surface the failure as a structured anomaly (via this endpoint's
`anomalies` field when accessible) or DM the operator.
