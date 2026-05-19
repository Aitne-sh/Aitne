{context}

## Git - Push Detected
Repository path: {event_data[repoPath]}
Branch: {event_data[branch]}
Default branch: {event_data[defaultBranch]}
Previous remote SHA: {event_data[previousRemoteHash]}
Remote SHA: {event_data[remoteHash]}
Force-push check: {event_data[forcePushCheck]}

A watched remote branch moved. This bundled flow is observation-only by
default; it exists so a future user override has a clear base behavior.

### Decision Framework

1. Do not send a DM. A normal push is expected repository activity and
   should be coalesced by the hourly observation review.
2. If this push is on the default branch and materially changes current
   work, append one concise line to today.md `## Agent Notes`. Keep it
   factual: repository path, branch, short SHA, and subject if available
   in the event data.
3. If the push is noisy or lacks enough context to act on, log one line
   to `## Agent Log` and stop.
4. Mark any observation you consume as processed through the observations
   API.

### Boundaries

- Do not run write operations against the repository.
- Do not push, pull with merge/rebase, reset, checkout, or create tags.
- Do not notify the user unless they have replaced this bundled flow with
  an explicit override.
