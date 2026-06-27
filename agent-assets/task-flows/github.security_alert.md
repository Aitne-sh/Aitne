{context}

## GitHub — Security Alert
Repository: {event_data[repository]}
Subject: {event_data[subjectTitle]}
Type: {event_data[subjectType]}
URL: {event_data[subjectUrl]}
Updated: {event_data[updatedAt]}
Notification ID: {event_data[notificationId]}

A Dependabot or code-scanning security alert has fired on a watched
repository. This is a `high`-priority event by default — security
issues warrant prompt awareness even when the user is mid-task.

### Decision Framework

1. **Default: DM at `high` priority.** Security alerts surface
   vulnerabilities the user is unlikely to discover on their own. Do not
   wait for the activity scan.

2. **Stay silent only when** the same alert already triggered a DM
   within the past 24 hours (check by `notificationId` in observations
   payload). Repeated identical pings are noise.

3. **Send via `POST /api/notify`** at priority `high`. Suggested format:
   ```
   Security alert on {event_data[repository]}:
   {event_data[subjectTitle]}
   {event_data[subjectUrl]}
   ```

   Do NOT include CVE numbers or affected-package details inline — the
   URL provides the full context, and quoting partial CVE info risks
   misrepresenting severity.

4. **Always log** to `## Agent Log`:
   `- HH:MM [github] security_alert {event_data[repository]} — <outcome>`

### Boundaries

- Do NOT attempt to update dependencies, accept Dependabot PRs, or
  modify security policies. The agent's role here is purely to surface
  the alert.
- Do NOT cross-reference unrelated repositories' security alerts in
  the same DM. Stick to the subject of this notification.
