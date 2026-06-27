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
  - browser-automation
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
updated: 2026-06-16
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
sandboxed sub-agent with **one browser tab to itself**, under allowlist
enforcement, a payment-path block, and a screenshot trace. The
**Browser Tasks** page (`/browser-tasks`) is the operational surface
where every run shows up — what is queued, running, waiting on you, or
finished.

This is different from two neighbouring surfaces:

- **[Browser History](browser-history)** reads your *existing* Chrome
  passively (research clusters, revisit nudges). It never drives a
  browser.
- **[Managed Chromium / B-4](managed-chromium)** is the heavily-gated,
  default-off *purchase-confirmation* flow. Browser tasks are the
  general-purpose, non-purchasing actions; a final purchase confirm is
  the one thing they hand off to the B-4 token primitive.

## Starting a Task

You don't start a task from this page — you ask in **DM** or `/chat`:

> "Send a contact form on Amazon's contact-us page saying my order
> #123 never arrived."

The agent creates the task (`POST /api/browser-task`), opens a tab, and
works the goal step by step. You can also **schedule** one to run later
(it appears here when it fires). The page itself is a read + monitor
surface: filter, search, open a run, or cancel it.

## Reading the Page

- **Tasks awaiting you** — a strip pinned to the top that only appears
  when one or more tasks are blocked on your input. It links straight
  to the run that needs you. The same signal drives the nav red-dot and
  the persistent shell banner, so they stay in lock-step.
- **Filter chips** — narrow by state (`All`, `Active`, or a specific
  state) and by **site**. `Active` means any non-terminal task.
- **Search** — free-text match over the task description.
- **Table** — one row per task: state, description (click to open the
  run), site, originating channel, created time, and duration. Active
  rows expose a **Cancel** button.

Click any row to open the **run detail** (`/browser-tasks/:id`): the
step-by-step event log and the **screenshot trace** the sub-agent
captured along the way.

## Task States

A task moves through a small state machine. Non-terminal states are
still in flight; terminal states are done.

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

When a task is `awaiting_user` or `final_confirm`, **answer in the DM
the agent sent you** — that is the loop that unblocks it. The dashboard
strip and banner are just where you notice it.

## Cancelling

Active tasks have a **Cancel** button (and `POST
/api/browser-task/:id/cancel`). Cancelling releases the browser context
immediately and DMs you a confirmation. Terminal tasks can't be
cancelled — there is nothing left to stop.

## Safety Model (why it's safe to let it drive)

Browser tasks inherit the project's structural browser defences — there
is **no hardcoded category/brand denylist**:

1. **One sandboxed tab per task.** Tasks don't share a browser context,
   so one task can't read another's session.
2. **Allowlist enforcement + hostname denylist.** Navigation is
   constrained; you manage blocked hostnames via
   `browserTaskHostnameDenylist`.
3. **IP egress layer (not configurable).** Navigations that resolve to
   private, loopback, link-local, or cloud-metadata addresses are
   denied at the egress chokepoint — defence-in-depth against SSRF.
4. **Payment-path block.** A URL-pattern matcher trips at form-submit
   time on payment-handoff paths, so a task can't silently push a
   transaction through. An actual purchase requires the separate,
   default-off [B-4 token flow](managed-chromium).
5. **Human-in-the-loop gates.** Anything ambiguous or consequential
   surfaces as `awaiting_user` / `final_confirm` and waits for your DM.

See **[Safety and Execution](../../concepts/safety-and-execution)** and
the **[Safety Model](../../concepts/safety-model)** for the full
picture.

## Configuration

These keys live in the editable config (Settings → Infrastructure):

- `browserTaskMaxConcurrent` — how many tasks may run at once; the rest
  queue (`pending`).
- `browserTaskPendingQueueTimeoutMinutes` — how long a `pending` task
  waits before it is `abandoned`.
- `browserTaskRespectQuietHours` — when on, tasks defer during your
  quiet hours rather than running overnight.
- `browserTaskHostnameDenylist` — hostnames a task may never navigate
  to (user-managed; there is no shipped default brand/category list).
