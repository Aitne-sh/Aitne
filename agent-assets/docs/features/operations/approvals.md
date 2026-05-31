---
schema_version: 1
slug: features/operations/approvals
title: Approvals
id: approvals
aliases:
  - approve tier
  - approval queue
  - human in the loop
category: features
summary: |
  A few high-blast-radius actions queue as approvals. The action
  blocks until you click Approve on the dashboard Overview page;
  the approval card stays visible there regardless of quiet hours.
section: operations
tags:
  - core
  - safety
  - operations
status: stable
ask_examples:
  - What is an approval?
  - Why is the agent waiting for me?
  - Where do I approve a pending action?
locale: en-US
created: 2026-04-25
updated: 2026-05-28
keywords:
  - approval
  - approve tier
  - approval queue
  - agent approval queue
  - approve before action
  - deny approval
related:
  - concepts/safety-and-execution
  - features/operations/notifications
ui_anchors:
  - /
api_endpoints:
  - GET /api/approvals
  - POST /api/approvals/:id/approve
  - POST /api/approvals/:id/deny
---

# Approvals

## In One Sentence

A small set of high-blast-radius actions queue as approvals; the
agent waits for you to click **Approve** on the dashboard before it
proceeds.

## How It Works

A few actions are classified as *Approve* tier (see
[Safety and Execution](../../concepts/safety-and-execution.md)).
When the agent reaches one, instead of running it the daemon parks
the request in the approval queue:

1. The action **blocks** — nothing runs while it waits.
2. It appears in the **approval card** on the dashboard Overview
   page (`/`).
3. You click **Approve** to let it run, or **Deny** to discard it.
4. On Approve, the queued action resumes and the agent continues.

The approval card is always shown on the Overview page while items
are pending — it does not respect quiet hours, so you can clear it
whenever you next open the dashboard.

## Where in the Dashboard

The Overview page (`/`) shows an amber **approval card** whenever
something is pending. The card header reports the count
("2 pending approvals") and each row lists:

- the action description,
- a badge with its type,
- when it was queued,
- **Approve** and **Deny** buttons.

Deny asks for confirmation before discarding the item.

## When Something Goes Wrong

- **An approval that never clears:** the agent session that produced
  it may have timed out. The action expires with the session — redo
  the request that triggered it (for example, re-send the DM or
  re-run the routine).

## Related

- [Safety and Execution](../../concepts/safety-and-execution.md) —
  how the agent decides an action needs approval.
- [Notifications](notifications.md) — how the agent reaches you
  outside the dashboard.
