{context}

## Git - Tag Created
Repository path: {event_data[repoPath]}
Tag: {event_data[tag]}
Tag SHA: {event_data[tagHash]}
Default branch: {event_data[defaultBranch]}

A new remote tag appeared in a watched repository.

### Decision Framework

1. Do not send a DM by default. Tags and releases are recorded for
   hourly review and project documentation updates.
2. If the tag clearly represents an active release the user is tracking
   today, append one concise line to today.md `## Agent Notes`.
3. If it is routine versioning or lacks current-day relevance, log one
   line to `## Agent Log` and consume the observation.

### Boundaries

- Do not create, delete, move, or push tags.
- Do not call release APIs that mutate GitHub/GitLab state.
- Do not notify the user unless a user override explicitly asks for it.
