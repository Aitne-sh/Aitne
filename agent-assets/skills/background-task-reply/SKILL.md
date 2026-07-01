---
name: background-task-reply
description: |
  When a background task is parked on a clarifying question and the
  owner's DM answers it, relay the answer via
  POST /api/background-task/<taskId>/clarify. Use ONLY when a task is in
  awaiting_user AND the conversation shows the question was just asked.
allowed-tools:
  - Bash(curl *)
---

# Background Task — clarification relay

A detached background task can pause to ask the owner one question
(`awaiting_user`). The daemon already DMed that question to the owner, in
your voice — you did NOT author it and you do not poll for it. You act only
when the owner comes back with an answer, translating their natural-language
reply into the structured `/clarify` call that un-parks the worker.

This skill does NOT spawn tasks (that's `background-task`) and does NOT
deliver results (the daemon does that directly).

## Hard rule — never cold-call

This skill is a no-op unless BOTH hold:

1. `GET /api/background-task?state=awaiting_user` returns a non-empty list
   (call this FIRST). Empty → do nothing; the owner's message is not a
   clarification answer.
2. The conversation shows the agent recently asked that task's question —
   a pending `task_clarification` in your catchup context, or a recent
   assistant DM that posed it. No recent question → the reply is about
   something else; leave the parked task alone (its deadline scanner
   handles a genuine no-answer).

Relaying when the owner didn't answer the question is a worse failure than
missing an ambiguous reply. When unsure whether the message answers the
question, ask ONE short clarifier rather than guessing.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/background-task?state=awaiting_user` | List parked tasks. Call FIRST. |
| GET | `/api/background-task/:id` | Read the open `clarifications` row (`resolved:false`) for its `id` + `question`. |
| POST | `/api/background-task/:id/clarify` | Relay the answer. |

## Resolving which task

1. `GET /api/background-task?state=awaiting_user`. Usually exactly one
   parked task; if several, match the owner's reply to the right one by
   topic / `title`, or ask which.
2. `GET /api/background-task/<taskId>` — read the open `clarifications`
   entry (`resolved:false`) and re-read the `question` so you can confirm
   the owner's message actually answers it. The GET response exposes each
   clarification row's identifier as `id`; to answer, POST `/clarify` with
   that value in the request-body field `clarificationId`.

If your catchup context already carries the `clarificationId` in metadata,
you may use it — but **never surface a `clarificationId` or `taskId` in
user-visible text** (token hygiene). The GET is the authoritative source.

## Relay the answer

```bash
curl --silent --fail -X POST -H 'Content-Type: application/json' \
  -d '{"clarificationId":"<uuid>","answer":"api first"}' \
  http://localhost:8321/api/background-task/<taskId>/clarify
```

- `answer` (1..8192) — the owner's reply, verbatim and faithful. Do not
  re-decide the task on their behalf; pass what they said.
- `clarificationId` is optional — if you omit it the daemon resolves the
  single open clarification — but prefer passing the explicit id when more
  than one task is parked.

Then ack briefly ("Got it, picking that back up.") and end the turn — the
worker resumes on its own and the daemon delivers the eventual result.

Status codes — handle each, don't retry blindly:

- `200` — recorded; the worker resumes. Brief ack.
- `400 validation_error` — `clarificationId` not a uuid, or `answer` empty
  / > 8192 chars. Re-read with GET and re-send.
- `409 not_awaiting_user` (carries `currentState`) — the task already moved
  on (finished, cancelled, or the window closed). Tell the owner the state
  plainly; do not re-send.
- `409 no_open_clarification` — nothing to answer; your state was stale.
  Re-read with GET first.
- `409 already_resolved` — the question was already answered (a racing
  reply landed first). The worker has resumed; do not re-send. A brief ack
  is enough.
- `410 expired` — the clarification deadline passed; the worker will time
  out. Apologise briefly and offer to re-run if relevant.
- `404 not_found` — stale `taskId`; re-read with GET.

## Localhost only

`http://localhost:8321/api/background-task/*`. JSON body in single quotes
(project convention) so the daemon hooks classify the payload as data.
