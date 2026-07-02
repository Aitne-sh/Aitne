---
schema_version: 1
slug: features/operations/browser-tasks
title: Browser Tasks
id: browser-tasks
aliases:
  - browser tasks
  - browser task
  - web task
  - browser automation tasks
  - sandboxed browser
category: features
summary: |
  Open-ended browser actions the agent runs for you in a sandboxed,
  one-tab-per-task sub-agent — "send a contact form on Amazon", "check
  the price of X". You kick a task off in DM (or schedule one); the
  agent DMs you back for clarification or a final confirm when it needs
  your input. The Browser Tasks page is where every run shows up, with
  live state, a screenshot trace, and a cancel button.
section: operations
tags:
  - operations
  - safety
status: beta
ask_examples:
  - What is the Browser Tasks page?
  - How do I start a browser task?
  - Why is my browser task waiting for me?
  - What do the browser-task states mean?
  - How do I cancel a running browser task?
  - Where do I see the screenshots from a browser task?
locale: en-US
created: 2026-06-16
updated: 2026-07-01
keywords:
  - browser tasks
  - browser-task
  - sandboxed sub-agent
  - awaiting_user
  - final_confirm
  - screenshot trace
  - allowlist
  - payment-path block
  - cancel task
related:
  - features/operations/managed-chromium
  - features/integrations/browser-history
  - concepts/safety-and-execution
  - concepts/safety-model
ui_anchors:
  - /browser-tasks
  - /browser
process_keys:
  - browser_task
config_keys:
  - browserTaskMaxConcurrent
  - browserTaskPendingQueueTimeoutMinutes
  - browserTaskRespectQuietHours
  - browserTaskHostnameDenylist
api_endpoints:
  - POST /api/browser-task
  - GET /api/browser-task
  - GET /api/browser-task/:id
  - GET /api/browser-task/:id/events
  - GET /api/browser-task/:id/screenshots/:file
  - POST /api/browser-task/:id/clarify
  - POST /api/browser-task/:id/cancel
---

# Browser Tasks

A **browser task** is an open-ended action you ask the agent to carry
out on the web — "send a contact form on Amazon's contact-us page",
"check the price of X", "fill in this signup". Each task runs in a
*sandboxed sub-agent* (an isolated, throwaway helper the agent spins
up) that gets **one browser tab to itself**, guarded by an allowlist, a
payment-path block, and a screenshot trace of every step. The **Browser
Tasks** page (`/browser-tasks`) is where every run shows up — what is
queued, running, waiting on you, or finished.

Browser tasks are different from two related features:

- **[Browser History](../integrations/browser-history.md)** only
  *reads* your existing Chrome history, passively (research clusters,
  revisit nudges). It never drives a browser.
- **[Managed Chromium / B-4](managed-chromium.md)** is the
  heavily-gated, default-off flow for *confirming a purchase*. Browser
  tasks handle the general-purpose, non-purchasing actions; the one
  thing they hand off to the B-4 token flow is a final purchase
  confirmation.

## Starting a Task

You don't start a task from this page — you ask in a **DM** or in
`/chat`:

> "Send a contact form on Amazon's contact-us page saying my order
> #123 never arrived."

The agent creates the task (`POST /api/browser-task`), opens a tab, and
works toward the goal step by step. You can also **schedule** one to
run later — it shows up here when it fires. The page itself is just for
watching and managing runs: filter, search, open a run, or cancel it.

## Reading the Page

- **Tasks awaiting you** — a strip pinned to the top that appears only
  when one or more tasks are blocked on your input. It links straight
  to the run that needs you. The same signal drives the red dot in the
  nav and the banner across the top of the app, so they always agree.
- **Filter chips** — narrow the list by state (`All`, `Active`, or one
  specific state) and by **site**. `Active` means any task that hasn't
  finished yet.
- **Search** — free-text match against the task description.
- **Table** — one row per task: state, description (click to open the
  run), site, the channel it came from, created time, and duration.
  Active rows show a **Cancel** button.

Click any row to open the **run detail** (`/browser-tasks/:id`): the
step-by-step event log and the **screenshot trace** the sub-agent
captured along the way.

## Task States

A task moves through a small set of states. Some are *non-terminal*
(the task is still going); the rest are *terminal* (the task is
finished and won't change).

| State | Meaning |
| --- | --- |
| `pending` | Queued, not started yet. The duration cell shows queue wait and, when known, the site / global queue position. |
| `running` | The sub-agent is actively driving the tab. |
| `awaiting_user` | Paused — the agent DMed you a **clarifying question** and is waiting for your answer (`POST /api/browser-task/:id/clarify`). |
| `final_confirm` | Paused at a **final confirmation** gate (e.g. a submit/checkout step) waiting for your explicit go-ahead. |
| `completed` | Finished successfully. |
| `failed` | Stopped on an error; the row shows a short outcome detail. |
| `cancelled` | You (or the agent) cancelled it. |
| `timeout` | Exceeded its time budget. |
| `abandoned` | A pending task expired in the queue before it could start (see `browserTaskPendingQueueTimeoutMinutes`). |

When a task is `awaiting_user` or `final_confirm`, **reply in the DM
the agent sent you** — that reply is what unblocks it. The dashboard
strip and banner are just where you notice it needs you.

## Cancelling

Active tasks have a **Cancel** button (which calls `POST
/api/browser-task/:id/cancel`). Cancelling releases the browser context
(the task's tab) right away and DMs you a confirmation. A finished
(terminal) task can't be cancelled — there is nothing left to stop.

## Safety Model (why it's safe to let it drive)

Browser tasks inherit the project's structural browser defenses. There
is **no hardcoded category or brand denylist** — the safety is built
into how a task runs, not a list of banned sites:

1. **One sandboxed tab per task.** Tasks don't share a browser context,
   so one task can't read another's session.
2. **Allowlist enforcement plus a hostname denylist.** Where a task may
   navigate is restricted; you manage the blocked hostnames via
   `browserTaskHostnameDenylist`.
3. **IP egress layer (not configurable).** If a navigation resolves to
   a private, loopback, link-local, or cloud-metadata address, it is
   blocked at the network exit point — defense-in-depth against SSRF
   (server-side request forgery, where a request is tricked into
   reaching an internal address).
4. **Payment-path block.** A URL-pattern matcher trips at form-submit
   time on payment-handoff paths, so a task can't quietly push a
   transaction through. An actual purchase requires the separate,
   default-off [B-4 token flow](managed-chromium.md).
5. **Human-in-the-loop gates.** Anything ambiguous or high-stakes
   pauses as `awaiting_user` or `final_confirm` and waits for your DM.

See **[Safety and Execution](../../concepts/safety-and-execution.md)**
and the **[Safety Model](../../concepts/safety-model.md)** for the full
picture.

## Configuration

These keys live in the editable config (Settings → Infrastructure):

- `browserTaskMaxConcurrent` — how many tasks may run at the same time;
  any extras wait in the queue (`pending`).
- `browserTaskPendingQueueTimeoutMinutes` — how long a `pending` task
  waits in the queue before it is marked `abandoned`.
- `browserTaskRespectQuietHours` — when on, tasks hold off during your
  quiet hours instead of running overnight.
- `browserTaskHostnameDenylist` — hostnames a task may never visit (you
  manage this list; nothing is blocked here by default).
