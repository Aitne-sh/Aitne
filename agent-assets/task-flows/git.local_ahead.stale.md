{context}

## Git - Local Ahead Stale
Repository path: {event_data[repoPath]}
Branch: {event_data[branch]}
Upstream: {event_data[upstreamRef]}
Upstream SHA: {event_data[upstreamHash]}
Local HEAD: {event_data[headHash]}
Ahead count: {event_data[aheadCount]}
Oldest unpushed commit: {event_data[oldestUnpushedCommittedAt]}
Stale for minutes: {event_data[staleForMinutes]}
Threshold minutes: {event_data[pushOverdueMinutes]}

The local branch has been ahead of its upstream longer than the configured
threshold. This is a polling-derived "push overdue" signal, not proof that
a specific push attempt failed.

### Decision Framework

1. Do not send a DM by default. Let hourly observation review decide
   whether this matters in today's context.
2. Add a concise entry to today.md `## Agent Notes` only when the repo is
   tied to an active task or deadline in today.md.
3. If there is no active task context, log the stale-ahead observation to
   `## Agent Log` and consume the observation.
4. Keep wording honest: "local branch is still ahead of upstream"; never
   claim "push failed".

### Boundaries

- Do not run `git push`, `git pull`, `git reset`, `git checkout`, or
  any command that changes the working tree or remote.
- Do not inspect private diffs unless the user asks or the loaded context
  already points at this repository as active work.
