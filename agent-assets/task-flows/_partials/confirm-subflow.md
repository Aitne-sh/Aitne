<!--
  Confirm sub-flow contract (`confirm:` `dm_session` rows).
  Single source of truth for the `confirm_dedup_key` shape and the
  cross-path cancellation behaviour. Included from:
    - `scheduled.dm.md` (`## Confirmation follow-up`)
    - `message.received.dm.md` / `message.received.dm_first.md`
      (suppression rule → schedule a `confirm:` row instead)
    - `schedule/SKILL.md` references this partial via the pointer
      paragraph in its dedup pre-check section.
-->

### `confirm_dedup_key` pre-check (mandatory for `confirm:` sub-flow rows)

When scheduling a `dm_session` row with `taskContext.sub_flow="confirm"`,
filter `GET /api/schedule?status=pending,running` by
`taskContext.confirm_dedup_key`. Skip if any match exists — regardless of
`scheduledFor` distance or description match. The confirm sub-flow's
chained-fire model (successor row queued for `<current_time> + 15 min`)
and the hot-thread defer both inherit the same `dedup_key`, so a
legitimate successor / defer row will occupy the queue with the same
key — a second gate firing for the same topic MUST yield to it rather
than double-asking.

```bash
curl -s "http://localhost:8321/api/schedule?status=pending,running" \
  | jq --arg k "<gate>:<stable-topic>" \
      '[.items[] | select(.taskContext.confirm_dedup_key == $k)] | length'
```

If the count is `≥ 1`, log to `## Agent Log` and proceed without
scheduling:

```
- HH:MM [confirm] skipped <dedup_key>: row already pending
```

### `confirm_dedup_key` shape contract

The key is `<gate>:<stable-topic>`. Examples:

- `create_project:la-pm-masters`
- `roadmap_ambiguous:tokyo-trip-date`
- `managed_task_dedup:<existing-task-id>`

The gate scope ensures two unrelated gates can't collide on the same
topic name. The topic component MUST be deterministic from the topic
itself — no timestamps, no message IDs, no random nonces — so re-fires
of the same gate produce the same key and the pre-flight catches them.

This rule layers on top of the schedule skill's three baseline dedup
checks (Agent Plan, description-match, recurring-schedule). It catches
the case where two confirms target the same topic at different
scheduled times (e.g. one queued for the morning briefing, another the
gate would queue for `+4h`).

### Cross-path cancellation

A pending `confirm:` row is cancelled by the agent updating
`taskContext` on either:

- The row itself (via `PATCH /api/schedule/:id`) when the originating
  gate's outcome resolves through a non-confirm path (e.g. the user
  answered inline before the scheduled `confirm:` fired).
- A predecessor confirm row whose decision supersedes the topic.

Cancellation is the gate's responsibility — the scheduler does not
introspect `taskContext` for it. Use the `confirm_dedup_key` to locate
the row(s) to cancel.
