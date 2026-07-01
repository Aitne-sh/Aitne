---
name: browser-task
description: Hand open-ended browser requests (post a tweet, fill a contact form, check an order status, …) to /api/browser-task. Relay sub-agent clarifications, POST /clarify with the reply, /cancel on stop.
allowed-tools:
  - Bash(curl *)
---

# Browser Task — open-ended browser ops from DM

A scoped sub-agent drives Aitne's managed Chromium turn-by-turn from a
natural-language description. **It runs as a detached background process
with its own budget — the daemon DMs the user directly when it finishes,
needs input, or fails.** You are NOT in that delivery path. Your job is
the front bookend only: collect intent, POST it, acknowledge in one line,
and **end your turn**. The Playwright work is invisible to you.

This is NOT the surface for managed-Chromium status, per-site sign-in,
B-4 purchase tokens, or workflow approvals — those live under
`/api/browser-history/managed/*`, `/api/browser-automation/sites/*`, and
`/api/browser-automation/purchase/*`.

## Hard rules

1. **Localhost only.** `http://localhost:8321/api/browser-task/*`.
2. **POST, ack, end the turn. NEVER poll for completion.** After a
   successful POST, reply once ("Started — I'll report back when it's
   done.") and stop. Do not GET `/:id` in a loop, "wait and check", or
   re-issue. Ending your turn has zero effect on the detached task — it
   keeps running and the daemon DMs the user the result (`✅ Browser task
   — report`) or, on any failure/cancel/timeout, `🟦 Browser task <id>
   ended: <state>`. The only allowed GET is a single on-demand status read
   answering an explicit user question (see "On-demand status").
3. **Never echo the `!~xxxxxxxx` final-confirm token.** The daemon DMs it
   directly when the sub-agent trips the final-confirm gate. The user
   types it back themselves; the runner consumes the reply. Do not read,
   log, paraphrase, or relay the token. If the user asks "what was that
   code?", point them at the original DM with the screenshot — that DM is
   the only authoritative source.
4. **Never invent the clarification id or the task id.** Both are uuid v4
   minted by the daemon; read them from the daemon's responses, never make
   them up. The POST-create response carries the task uuid as a top-level
   `taskId`; on GET (`/:id` and the list) that same task uuid is the row's
   `id`. The clarification identifier is the clarifications row's `id` on
   the GET response — to answer you send it back as the request-body field
   `clarificationId` on POST `/clarify`.
5. **Do not pre-decline based on the URL or site.** Open navigation is
   the default — the sub-agent decides where to go and the daemon enforces
   a user-curated hostname denylist plus the payment-path block at
   navigation time. POST the description as the user asked.
6. **One task per request.** "Post a tweet AND subscribe …" → two POSTs.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/browser-task` | Create + dispatch, or schedule for later. |
| GET | `/api/browser-task?state=...` | List (filter on `state`). |
| GET | `/api/browser-task/:id` | Detail — state, action log, clarifications. |
| POST | `/api/browser-task/:id/clarify` | Answer the open clarification. |
| POST | `/api/browser-task/:id/cancel` | Force-stop a task. |

## POST — composing a request

```bash
curl --silent --fail -X POST -H 'Content-Type: application/json' \
  -d '{"description":"Post \"Hello world\" to twitter.com"}' \
  http://localhost:8321/api/browser-task
```

Body:

- `description` (1..4096) — one sentence stating the **end state**, not a
  step recipe. Name the site in plain language when it matters ("post to
  X", "check my hitachi.com order status"); the sub-agent decides where to
  navigate. There is no `siteKey` or `extraAllowedHosts` field — the API
  dropped both on 2026-05-27 (open navigation). Legacy callers passing
  them are silently ignored, not rejected.
- `scheduleAt` (ISO 8601) — defer to later; respects quiet hours.
  Response is `202` with `{ taskId, status:"scheduled", scheduledFor,
  scheduleRowId }` (`scheduledFor` is epoch-ms; `taskId` is the same
  pre-generated id you use for status GETs).
- `requireFinalConfirm` (default `true`) — keep `true` unless the user
  explicitly asks to skip the gate for a reversible flow.

Immediate response carries `taskId`, `status`, and `queueState`; then ack
once and stop (Hard rule 2). If `queueState.waitingForSlot === true`, the
global cap is full — say so once ("queued behind N task(s); I'll start it
when a slot opens"). The daemon DMs the user on promote and on finish.

## Relaying a clarification — `awaiting_user`

The daemon DMs the user a question + screenshot via the originating
channel (you do not author it, and per Hard rule 2 you do not poll for it
to appear). You act only when the user comes back with an answer:

1. `GET /api/browser-task?state=awaiting_user` — find the parked task.
   Usually one; if several, match topic or ask which.
2. `GET /api/browser-task/<taskId>` — read the open `clarifications` row
   (`resolved:false`). The GET response exposes each clarification row's
   identifier as `id`; to answer, POST `/clarify` with that value in the
   request-body field `clarificationId`.
3. `POST /api/browser-task/<taskId>/clarify` with `{clarificationId,
   answer}` (user reply verbatim), then ack briefly and end the turn —
   the runner resumes on its own.

Status codes — handle each, don't retry blindly:

- `200` — recorded; runner resumes. Brief ack ("Got it, resuming.").
- `400 validation_error` — `clarificationId` not a uuid or `answer` empty
  / >8192 chars. Re-read with GET and re-send.
- `409 not_awaiting_user` — window closed (carries `currentState`). Tell
  the user the verbatim state; offer re-issue if relevant.
- `410 expired` — clarification deadline passed; the runner transitions
  the task to `abandoned` on the next scanner tick. Apologise.
- `404 not_found` — your state is stale; re-read with GET first.

## On-demand status — only when the user asks

If (and only if) the user explicitly asks how a task is going, do a
**single** read and summarize — never a loop. `GET
/api/browser-task?state=running,awaiting_user,pending` (or a `taskId` the
user names), then `GET /api/browser-task/<taskId>` and report `state`, the
last `actionLog` entry, and `queueState` if pending. States:

- `pending` — queued; read `queueState` for position. `running` — acting.
- `awaiting_user` / `final_confirm` — relay rules are Hard rule 3 + the
  clarify section; here just report the state.
- `completed` — the daemon already DMed the full `✅ Browser task —
  report`. Don't re-post; if asked "what did it find?", quote the
  `report` field verbatim (don't paraphrase).
- `failed` / `timeout` / `cancelled` / `abandoned` — terminal; the daemon
  already DMed `🟦 Browser task <id> ended: <state>`. `outcomeDetail`
  carries the reason (e.g. `queue_timeout`, `budget_exceeded`,
  `tool_loop_detected`) — quote it verbatim.

## Force-stop — "stop" / "cancel" / "abort"

When the user signals stop, find the task (same identification path as
status), then `POST /api/browser-task/<taskId>/cancel` with optional
`{"reason":"user_cancel"}`. The daemon aborts the in-flight sub-agent,
tears down the Chromium context, and writes the terminal state.

- `200` — accepted; `row.state` carries the post-cancel state (often
  `cancelled`, but a `running` task may briefly stay non-terminal until
  the SDK loop unwinds — re-read with GET if asked).
- `404 not_found` — stale `taskId`; re-read with GET.
- `409 already_terminal` (carries `currentState`) — too late; report the
  state verbatim.

Do NOT cancel without a clear signal; "wait" is NOT a cancel.

## Navigation is open

There is no positive allowlist or registered-site table. Whatever URL the
sub-agent navigates to passes three runtime layers: (1) the user-curated
hostname denylist (Dashboard → Settings → Browser; a hit returns
`blockedByAllowlist: true` — legacy field name), (2) the hardcoded
payment-path block (purchases live in `/api/browser-automation/purchase/*`
with the B-4 token), (3) the network IP CIDR fence (RFC1918, loopback,
`169.254.x.x`, IPv6 ULA). If the sub-agent reports `blockedByAllowlist` /
`blockedByPaymentPath`, quote the reason verbatim and point the user at
`/settings/browser` if a denylist entry is the cause. **Never decline on
the user's behalf before POSTing — that's the user's call.**

## Scheduling — `scheduleAt` ≠ the `schedule` skill

For "do X at <time>" use `scheduleAt` in this POST — NOT `/api/schedule`.
The browser-task surface owns its own `agent_schedule` row
(`task_type:"browser_task"`). The `schedule` skill is the right tool only
when the user wants to list / modify / cancel pending schedules (which
surface scheduled browser tasks alongside other rows).
