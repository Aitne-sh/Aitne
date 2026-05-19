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
  Approve-tier actions block until the operator clicks approve in
  the dashboard. They bypass quiet hours.
section: operations
tags:
  - core
  - safety
  - operations
status: stable
ask_examples:
  - What is an approval?
  - Why is the agent waiting for me?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - approval
  - approve tier
  - /dashboard/approvals
  - agent approval queue
  - approve before action
related:
  - concepts/safety-and-execution
  - features/operations/notifications
---

# Approvals

## In One Sentence

A small set of high-blast-radius actions queue as approvals; the
agent waits for an operator click before proceeding.

## What It Does

- Blocks the action.
- Shows it on the Overview page's approval card.
- Sends a notification (bypasses quiet hours by design).
- Resumes when the operator approves.

## Where in the Dashboard

- **Overview** shows the count badge.
- The approvals card lists pending items with diff previews.

## When Something Goes Wrong

- An approval that hangs: the agent's session may have timed out.
  The action expires when the session does; the operator must redo
  the request that produced it.

## Related

- [Safety and Execution](../../concepts/safety-and-execution.md)
