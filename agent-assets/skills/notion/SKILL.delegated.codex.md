---
name: notion
description: Load when the task touches Notion AND Notion is cross-backend delegated from a Codex CLI DM session (`delegatedBackend` is non-Codex). All Notion operations flow through `POST /api/integrations/notion/exec`. `GET /api/notion/databases` remains available for label resolution.
---

# Notion (delegated, cross-backend)

Your DM session runs on Codex CLI. Notion access has been delegated
to a *different* backend (Claude or Gemini) whose Notion connector is
signed in. **You describe Notion intent in natural language; the
daemon picks the tool.** Tool name divergence between Claude
(`notion-search`, `notion-create-pages`), Gemini (same hyphenated
form via the user's installed Notion MCP server) and any custom
Notion MCP server is invisible to you.

To check which backend currently owns Notion, read
`~/.personal-agent/integrations.md`. The `/exec` body below is
backend-agnostic.

## 1. Label resolution (still direct)

Database UUIDs are unstable; the user's labels (e.g. `"projects"`,
`"meeting-notes"`) map to UUIDs through the daemon's settings store.
This route is NOT proxied — it returns the configured map even in
delegated mode:

```bash
curl -sS http://localhost:8321/api/notion/databases
# → { databases: { "<label>": { "id": "<uuid>", "title": "..." }, ... } }
```

Resolve label → UUID here BEFORE the `/exec` call so your `task`
prose carries a concrete data-source URL or UUID.

## 2. The single call shape

```bash
curl -sS -X POST http://localhost:8321/api/integrations/notion/exec \
  -H 'Content-Type: application/json' \
  -d '{"task": "<natural-language intent>", "outputSchema": { ... }, "cacheable": true}'
```

The daemon:

1. Verifies Notion is in `mode="delegated"`. If not, you get
   `409 mode_mismatch` — re-read `integrations.md` and stop.
2. Spawns the delegatedBackend in a tempdir, lets it pick the right
   tool against the per-task allowed-tools envelope, validates the
   final JSON against your `outputSchema`, returns it.

`outputSchema` is **required** (4 KB cap). Defaults: `maxToolCalls=8`,
`maxBudgetUsd=0.05`, `timeoutMs=60000`. Bump up to 15 / 0.50 / 300000
for genuinely larger intents.

## 3. Worked examples

### Search + structured listing (read)

```bash
curl -sS -X POST http://localhost:8321/api/integrations/notion/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "List the top-level pages in the Tasks database (data source <UUID>). For each page return the title, status (if a Status property exists), and last-edited timestamp. Sort by last-edited descending.",
    "outputSchema": {
      "type": "object",
      "required": ["pages"],
      "properties": {
        "pages": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["id", "title", "lastEditedAt"],
            "properties": {
              "id":           {"type": "string"},
              "title":        {"type": "string"},
              "status":       {"type": "string"},
              "lastEditedAt": {"type": "string", "format": "date-time"}
            }
          }
        }
      }
    },
    "maxToolCalls": 5,
    "cacheable": true
  }'
```

### Create a page (destructive — confirmation required)

```bash
curl -sS -X POST http://localhost:8321/api/integrations/notion/exec \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Create a new page under the Projects database (data source <UUID>) titled \"Migration plan — May\". Body: <BODY>. Properties: Status=\"Active\", Owner=<USER_ID>.",
    "outputSchema": {
      "type": "object",
      "required": ["pageId", "url"],
      "properties": {
        "pageId": {"type": "string"},
        "url":    {"type": "string"}
      }
    },
    "allowDestructive": true
  }'
```

## 4. Destructive-confirm two-step (`allowDestructive`)

Default is `false`. The subprocess will not run create / update /
delete / move / duplicate / comment — instead it returns:

```jsonc
{
  "needsConfirmation": true,
  "confirmationPlan": "I will create a new page titled \"Migration plan — May\" under the Projects database with status \"Active\"."
}
```

Surface the plan to the user verbatim. On their explicit OK, re-issue
the **same `task` verbatim** with `allowDestructive: true`. Never set
`cacheable: true` on the second call.

## 5. `cacheable: true` for read-only Notion lookups

60s TTL — well-suited to follow-up reads on the same page tree. Skip
caching when the user explicitly asked about a recent edit, and never
on writes or the destructive-confirm second call.

## 6. Decision rules

### Page archive — workaround only

Neither hosted connector exposes a page-archive tool. Phrase the
intent as one of:

1. **Property workaround**: "Set Status = Archived on page <UUID>."
   Page stays addressable but drops out of default views.
2. **Move to a Trash page**: "Move page <UUID> under the top-level
   Trash page (creating Trash if it doesn't exist)." Reversible.

### Schema admin — Approve-tier intent

Database / view / data-source mutations change workspace structure.
Surface what you'd do before invoking, and ask the user.

### Mass-update — ask first

If the intent would touch more than ~10 pages, summarize the plan and
ask before executing.

### Structured database filtering

Phrase property-equality intents as the WHERE clause; the subprocess
picks the right primitive whichever connector is active.

## 7. Error envelope

| HTTP | `error` | retry? | What to do |
|---|---|---|---|
| 400 | `validation_error` / `schema_too_large` | no | Fix the request body. |
| 409 | `mode_mismatch` | no | Notion isn't delegated. Re-read `integrations.md` and stop. |
| 409 | `precondition` | no | Mode/backend flipped during the queue wait. Re-check state. |
| 429 | `task_quota_exhausted` | no | Daily cap reached. Wait or surface. |
| 502 | `parse_error` / `schema_violation` | no (daemon already retried once) | Simplify schema. |
| 502 | `tool_unavailable` | no | No connector tool fits. Surface the gap. |
| 502 | `tool_failed` | maybe | Connector tool returned an error. Surface verbatim. |
| 502 | `auth_error` | no | Connector signed out. Re-authenticate. |
| 502 | `policy_violation` | no | Subprocess attempted an out-of-allowlist tool (anti-injection). |
| 502 | `loop_aborted` | no | `maxToolCalls` exceeded. Bump or simplify. |
| 502 | `budget_exhausted` | no | `maxBudgetUsd` exceeded. Caller can raise the cap. |
| 502 | `post_write_format_failure` | no | Write succeeded; formatting failed. Surface with partial trace. |
| 503 | `delegated_proxy_busy` | yes | Queue saturated. Backoff and retry once. |
| 503 | `task_mode_disabled` | no | Operator killed it. Stop. |
| 504 | `timeout` | yes (1×) | Wall-clock fired. Retry once. |
| 500 | `subprocess_crashed` | no | Daemon-side defect. Surface and stop. |

Always preserve `body.message` verbatim when reporting to the user.

## 8. Owner notification (opt-in)

```bash
curl -sS -X POST http://localhost:8321/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"message": "Archived 7 stale pages under the <db> database."}'
```

Do not call `/api/notify` for routine reads or single-page edits.

## 9. Cost attribution

Every `/exec` writes one row to `agent_actions` with
`action_type='delegated_task.exec'`, full token + USD breakdown, and
the parent `event_id` / `processKey`. Retrospective calls
(`GET /api/agent/actions?kind=delegated_task.exec`) surface exactly
what was spent.
