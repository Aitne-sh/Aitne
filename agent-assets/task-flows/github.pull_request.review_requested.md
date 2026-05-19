{context}

## GitHub — Review Requested
Repository: {event_data[repository]}
Pull Request: {event_data[subjectTitle]}
URL: {event_data[subjectUrl]}
Updated: {event_data[updatedAt]}
Notification ID: {event_data[notificationId]}

A teammate (or bot) has requested your review on this PR. The poller has
already recorded an observation; this session decides whether to DM the
user now or stay silent and let the hourly check coalesce it later.

### Decision Framework

The notify skill's awareness gate applies — the user can see the same
notification in their GitHub inbox or email. A DM is warranted only when
the agent's context says the request is **time-sensitive** or **at risk
of being missed**.

1. **Default: do NOT DM.** Append a heads-up to today.md
   `## Agent Notes` per the context skill, citing the repository, PR
   title, and URL. The hourly check will surface the request in its next
   coalesced summary if still open.

2. **DM at `high` priority** if any of the following hold:
   - The PR title contains a release-blocker keyword (`hotfix`,
     `revert`, `urgent`, `security`).
   - `today.md` has a `## Agent Plan` entry that mentions this
     repository or PR number — the user is already context-loaded on it.
   - The roadmap has an active milestone tied to this repository.

   For the third trigger, fetch context once:

   ```bash
   curl -s http://localhost:8321/api/context/roadmap | grep -i "{event_data[repository]}"
   ```

   If non-empty, the milestone tie is real.

3. **Send via `POST /api/notify`** at priority `high`. Include the PR
   title, repository, and URL. Keep it under 200 characters — the user
   can click through for the full diff. Never include the entire diff
   inline.

4. **Always log the decision** to `## Agent Log` per the context skill,
   even when staying silent. Format:
   `- HH:MM [github] review requested {event_data[repository]} #<num> — <outcome>`
   where outcome is `notified` or `silent (awareness gate)`.

### Boundaries

- The agent does NOT post a review comment on the PR. Reviews are the
  user's call.
- If the PR is already merged or closed by the time you check (rare —
  the notification fired moments ago), log `stale (PR closed)` and
  exit silently.
