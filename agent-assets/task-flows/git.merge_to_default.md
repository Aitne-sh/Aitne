{context}

## Git - Merge To Default
Repository path: {event_data[repoPath]}
Branch: {event_data[branch]}
Default branch: {event_data[defaultBranch]}
Previous remote SHA: {event_data[previousRemoteHash]}
Remote SHA: {event_data[remoteHash]}

The default branch moved. In the full git lifecycle design this is the
primary trigger for project documentation updates; until that lifecycle
writer runs, this bundled flow remains observation-only.

### Decision Framework

1. Do not send a DM. A default-branch merge is expected repository
   activity unless a user override says otherwise.
2. If today.md already has an active task for this repository, append one
   concise line to `## Agent Notes`.
3. Do not restructure project files from this flow. Project-MD updates
   belong to the dedicated git.project.update lifecycle.
4. Log and consume the observation when there is no current-day action.

### Boundaries

- Do not push, pull with merge/rebase, reset, checkout, or edit repo
  files.
- Do not modify roadmap.md from this flow.
- Do not notify the user unless they have installed an explicit override
  for this event.
