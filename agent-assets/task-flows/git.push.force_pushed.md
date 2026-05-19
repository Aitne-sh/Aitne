{context}

## Git - Force Push Detected
Repository path: {event_data[repoPath]}
Branch: {event_data[branch]}
Default branch: {event_data[defaultBranch]}
Previous remote SHA: {event_data[previousRemoteHash]}
New remote SHA: {event_data[remoteHash]}
Force-push check: {event_data[forcePushCheck]}

A watched remote branch was rewritten: the new remote SHA does not contain
the previous remote SHA in its ancestry. The poller emits this as a
high-priority event because history rewrites can invalidate local work,
reviews, CI results, and release assumptions.

### Decision Framework

1. Default: send one high-priority DM. Keep it short and factual:
   repository path, branch, previous short SHA, new short SHA.
2. Stay silent only if today.md `## Agent Log` already records a DM for
   the same repository, branch, previous SHA, and new SHA.
3. Use `POST /api/notify` with priority `high`. Suggested format:
   ```
   Force-push detected on {event_data[repoPath]} ({event_data[branch]}):
   {event_data[previousRemoteHash]} -> {event_data[remoteHash]}
   ```
4. Append a matching audit line to today.md `## Agent Log`:
   `- HH:MM [git] force-push {event_data[repoPath]} {event_data[branch]} - notified`

### Boundaries

- Do not attempt recovery. The agent must not reset, rebase, merge, push,
  checkout, or edit repository files.
- Do not diagnose blame or intent. Report the rewrite and let the user
  decide the next action.
- Do not include diff contents in the DM.
