---
name: background-task
description: Hand a long-running or open-ended task (deep research, multi-repo CI audit, monitor X over time, bulk compile) to /api/background-task. Compose a self-contained brief, set the notification policy, POST, ack, end the turn. Read GET /:id for follow-up detail.
allowed-tools:
  - Bash(curl *)
---

# Background Task — long-running work from DM

A detached worker runs the task in its own session with its own budget.
**The daemon delivers the result to the user directly — in your own voice —
when it finishes or needs input. You are NOT in that delivery path.** Your
job is the front bookend only: scope the task *now*, compose a
self-contained **brief**, choose a notification policy, POST it,
acknowledge in one line, and **end your turn**. The worker's run is
invisible to you.

This is the surface for *generic* long tasks. For an open-ended **browser**
job (post a tweet, fill a form) use the `browser-task` skill. For a
*recurring* cadence ("every morning…", "each hour check my PRs") use
`agent-create` / `schedule` — a background task is a single detached run.

## When to background it (triage)

Background work that is **long-running or open-ended** so the user can keep
chatting. No duration guess — decide on the signals:

1. **Category** — deep research, a multi-repo / multi-file audit,
   "monitor / watch X", a multi-step web dig, a bulk compile. Strongest
   signal.
2. **Owner signal** — explicit ("take your time", "report back later") or a
   research-style bang command.
3. **Scoping reveals size** — if resolving the request shows large or
   genuinely open-ended work, delegate it.

**Bias toward backgrounding category-1 work; keep plausibly-quick lookups
inline** (delivery costs a turn's latency). One task per request: "research
X AND audit Y" → two POSTs.

## Compose the brief — this is the real work

The worker sees ONLY your `brief` (it does not inherit the conversation,
the user profile, or the management rules). An under-specified brief forces
a clarification round-trip you can avoid by writing it well *this turn*.
Resolve ambiguity with the user now, then encode all of:

- **Objective** — the end state as an outcome ("find which repos have a red
  main build", not "go look at repos").
- **Scope & inputs** — the concrete inputs the worker can't infer: the repo
  list, what "failing" means, which sites, the date range.
- **Output language** — the user's language for `result`, `draft`, and any
  clarification.
- **Persona hints** — a line on the user's voice so the `draft` summary
  reads right if it's sent directly.
- **Notification policy + criteria** — see below; for `if_significant` the
  criteria MUST be written into the brief in concrete terms.
- **Expected output** — what a good `result` contains (a per-repo table, a
  ranked list, a one-paragraph verdict).

The worker can read owner memory itself to fill in preferences, so you need
only supply the *task-specific* inputs above. **Promoting an inline task?**
Also fold in the work you already did (findings, partial results) so the
worker continues rather than restarting cold.

## Notification policy — you author it

`notificationPolicy` decides whether the worker's result reaches the user.
The worker doesn't free-judge; it evaluates the policy you set:

- **`always`** (default) — the user asked and wants the answer, even
  "nothing found / 0 issues". The common case; always delivered.
- **`if_significant`** — delivered **only if** the concrete criteria are
  met. Prefer the structured **`significanceCriteria`** array (below) over
  prose; vague criteria defeat the policy.
- **`silent`** — never delivered; filed only.

A filed (`silent` / unmet-`if_significant`) result is not lost — it surfaces
in the daily digest and the user can pull it (see "Filed results" below).

## Endpoints (localhost only)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/background-task` | Create + dispatch, or schedule (`scheduleAt`). |
| GET | `/api/background-task?state=...` | List (also `notify`, `sinceHours` for the filed pull). |
| GET | `/api/background-task/:id` | The artifact — verbatim `report`, `draft`, `notify`, clarifications. |
| POST | `/api/background-task/:id/cancel` | Force-stop. |

Clarifications are answered with the **`background-task-reply`** skill.

## Hard rules

1. **Localhost only.** `http://127.0.0.1:8321/api/background-task/*`.
2. **POST, ack, end the turn. NEVER poll for completion.** After a
   successful POST, reply once and stop. Do NOT GET `/:id` in a loop or
   "wait and check". Ending your turn has zero effect on the detached
   worker — it keeps running and the daemon delivers the result as a DM in
   your voice. The only allowed GET is a single on-demand read answering an
   explicit user question (see "Follow-up detail").
3. **Never invent `taskId` / `clarificationId`** — uuid v4 minted by the
   daemon; read them from responses.
4. **The worker has no messaging tool** — it cannot DM the user; it writes
   its artifact and *you* (the daemon, in your voice) deliver.
5. **One task per request.**

## POST — composing a request

`POST /api/background-task` with the self-contained brief:

```bash
curl --silent --fail -X POST -H 'Content-Type: application/json' \
  -d '{"brief":"Audit these repos for a red main-branch CI build: aitne/daemon, aitne/web. \"Failing\" = the latest default-branch run concluded failure. Summary in English. Only notify if at least one repo is red. Output: one line per failing repo with the job.","title":"CI audit","notificationPolicy":"if_significant"}' \
  http://127.0.0.1:8321/api/background-task
```

Body:

- `brief` (1..16384) — the self-contained worker prompt above.
- `title` (1..200, optional) — short human label for status + the DM.
- `notificationPolicy` — `always` (default) / `if_significant` / `silent`.
- `significanceCriteria` (optional, `if_significant` only) — up to 12
  atomic conditions (each ≤500 chars), e.g. `["any repo's main build is
  red","spend > $100"]`. Worker notifies iff one is met. Omit otherwise.
- `tier` (optional) — `lite` / `medium` / `high` budget envelope. Default
  is fine; use `high` only for genuinely heavy research.
- `maxBudgetUsd` (optional) — override the dollar cap (hard ceiling `15`;
  a larger value is rejected `400`). Prefer `tier` over a raw dollar value.
- `scheduleAt` (ISO 8601, optional) — defer the *run* to a fire time (the
  worker starts then; it is compute, so it runs even during quiet hours).
  The eventual *result delivery* is what respects quiet hours, not the run.
  `202` with `{ taskId, status:"scheduled", scheduledFor, scheduleRowId }`.
  A time more than 60s in the past is rejected `400`.

Immediate response carries `taskId` and `status`. Then ack once and stop
(Hard rule 2).

## Acknowledgement

One line, no ceremony, no internal mechanism names (`taskId`, "worker",
"artifact"); your output language is already governed by your policy.
Structural examples (English): *"Started the audit in the background — I'll
report when it's done."* / *"On it. I'll dig into that and come back with
what I find."* Do NOT promise a specific time; say "when it's done".

## Follow-up detail — answer from the artifact, don't guess

The delivered DM carries a *summary*. When the user later asks for precise
detail it didn't include ("what exactly did it find on repo X?", "show me
the numbers"), do a **single** read and answer from the verbatim `report`:

```bash
curl --silent --fail http://127.0.0.1:8321/api/background-task/<taskId>
```

`report` is the full, unparaphrased result. Quote from it; don't invent
detail. If you lack the `taskId`, list `state=completed` and match by
`title`.

## Filed results — the "did that monitor ever run?" pull

A `silent` / unmet-`if_significant` result is filed (`notify=false`), not
pushed. When the user asks whether a backgrounded task ran:

```bash
curl --silent --fail "http://127.0.0.1:8321/api/background-task?state=completed&notify=false&sinceHours=168"
```

Each row carries `title`, `significance`, and `report`. Summarize
naturally; offer to pull any in full.

## Force-stop — "stop" / "cancel" / "abort"

On a clear stop signal, find the task (by `taskId`, or list
`state=running,awaiting_user,pending` and match the topic), then
`POST /api/background-task/<taskId>/cancel` with optional
`{"reason":"user_cancel"}`. `200` = accepted; `404 not_found` = stale id,
re-read; `409 already_terminal` = too late, report `currentState`
verbatim. "wait" is NOT a cancel.

## Scheduling — `scheduleAt` ≠ the `schedule` skill

For "do this research at <time>" use `scheduleAt` in this POST. The
`schedule` skill is for listing / modifying / cancelling pending schedules;
a recurring cadence is `agent-create`.
