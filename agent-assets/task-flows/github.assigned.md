{context}

## GitHub — Assigned
Repository: {event_data[repository]}
Subject: {event_data[subjectTitle]}
Type: {event_data[subjectType]}
URL: {event_data[subjectUrl]}
Updated: {event_data[updatedAt]}
Notification ID: {event_data[notificationId]}

You have been assigned to this issue or PR. The poller already recorded
an observation; this session decides whether to DM the user now.

### Decision Framework

The notify skill's awareness gate applies. The user can see the same
notification in their GitHub inbox. A DM is warranted only when the
agent's context says the assignment is **urgent** or **conflicts with
in-flight work**.

1. **Default: DM at `high` priority.** GitHub assignment is an explicit
   request for the user's attention from a human. The default is to
   surface it within the hour, not wait for the activity scan.

2. **Stay silent only when**:
   - `state/today.md` `## Agent Plan` already references this assignment.
   - The same subject was assigned-then-unassigned within the past
     30 minutes (check via observations: same `notificationId` payload
     across `consumed` rows).

3. **Send via `POST /api/notify`** at priority `high`. Suggested format:
   ```
   Assigned on {event_data[repository]}: {event_data[subjectTitle]}
   {event_data[subjectUrl]}
   ```

4. **Always log** to `## Agent Log`:
   `- HH:MM [github] assigned {event_data[repository]} {event_data[subjectType]} — <outcome>`

### Boundaries

- Do NOT auto-accept, label, or comment on the issue/PR. Assignment
  notifications are read-only signals.
