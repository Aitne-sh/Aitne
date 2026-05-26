{context}

## GitHub — Workflow Run Failed
Repository: {event_data[repository]}
Workflow: {event_data[workflowName]}
Title: {event_data[displayTitle]}
Branch: {event_data[branch]}  (default: {event_data[defaultBranch]})
On default branch: {event_data[onDefaultBranch]}
Conclusion: {event_data[conclusion]}
URL: {event_data[htmlUrl]}
Run ID: {event_data[runId]}
Trigger event: {event_data[triggerEvent]}

A workflow has failed. This task-flow only fires for failures on the
default branch (the poller filters feature-branch failures to
observation-only). The user almost always wants to know about a default-
branch failure, but the awareness gate still matters — they may have
just pushed and be watching the runs page.

### Decision Framework

1. **Default: DM at `high` priority.** Default-branch CI failures block
   downstream work — releases, dependent PRs, deploys. Send a short DM
   with the workflow name, branch, and URL. Do NOT include the failing
   step's log output inline; the URL is sufficient.

2. **Stay silent only when** one of the following clearly holds:
   - `state/today.md` `## Agent Plan` already has an entry referring to this
     workflow run by name (the user is already triaging it).
   - The same workflow has produced a `failed` observation within the
     past 30 minutes that already triggered a DM (check via
     `GET /api/observations?source=github:workflow:{event_data[repository]}&pending=false&limit=10`
     and inspect timestamps + payloads). De-dup keeps the user's signal
     channel clean during a flaky CI cascade.
   - The trigger event is `schedule` (cron-driven) AND the user has a
     known pattern of cron failures they don't want paged on. This is
     opt-out territory — only stay silent if `plans/roadmap.md` or
     `user.md` explicitly says so.

3. **Send via `POST /api/notify`** at priority `high`. Suggested format:
   ```
   CI failed on {event_data[repository]} ({event_data[branch]}):
   {event_data[workflowName]} — {event_data[htmlUrl]}
   ```

4. **Always log the decision** to `## Agent Log` even if silent.
   Format:
   `- HH:MM [github] workflow_run failed {event_data[repository]} {event_data[workflowName]} — <outcome>`

### Boundaries

- Do NOT attempt to re-run the workflow. The agent has no `gh run rerun`
  permission, and the safety policy is read-only for git/GitHub.
- Do NOT fetch the failing job's log content unless the user explicitly
  asks in a follow-up DM — the URL is enough for the first ping.
- Do NOT cross-reference unrelated PRs or issues. Stick to the failed
  run's repository.
