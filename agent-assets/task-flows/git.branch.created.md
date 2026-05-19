{context}

## Git - Branch Created
Repository path: {event_data[repoPath]}
Branch: {event_data[branch]}
Remote SHA: {event_data[remoteHash]}
Default branch: {event_data[defaultBranch]}

A new remote branch appeared in a watched repository.

### Decision Framework

1. Do not send a DM. Branch creation is observation-only by default.
2. If the branch name clearly maps to an active item in today.md, append
   one concise note to today.md `## Agent Notes`.
3. Otherwise, log one line to `## Agent Log` and consume the observation.
4. Preserve the branch name exactly; do not infer ownership from naming
   conventions unless context already says so.

### Boundaries

- Do not checkout, fetch additional refs beyond read-only inspection, or
  create local branches.
- Do not notify the user unless they have installed an explicit override
  for this task flow.
