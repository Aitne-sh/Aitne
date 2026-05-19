{context}

## Delegated Git Lifecycle Poll

This is an internal delegated-mode poll. The daemon selected this backend
because the Git or GitHub integration is in `delegated` mode.

Task: {event_data[task]}

<task_context>
{event_data[task_context]}
</task_context>

### Boundaries

- Read-only only. You may run `git status`, `git log`, `git show`, `git
  branch`, `git ls-remote`, `git fetch --prune --tags`, and read-only
  `gh` commands.
- Do not run `git push`, `git pull`, `git merge`, `git rebase`,
  `git reset`, `git checkout`, `git switch`, `git tag`, `git commit`, or
  any command that changes the worktree, branch, index, or remote.
- Do not edit repository files.
- A normal push, branch, tag, or merge is observation-only. Notify only for
  high-risk findings such as a likely force-push on a protected/default
  branch or a security/CI failure that needs immediate owner attention.

### Steps

1. Parse `<task_context>`. It contains:
   - `repoPaths`: absolute local repositories to inspect.
   - `githubRepos`: explicit GitHub repositories in `owner/repo` form.
   - `activeIntegrations`: `git`, `github`, or both.
   - `cadenceSeconds` and `pushOverdueMinutes`.
2. For each local repo, gather read-only evidence:
   - current branch and upstream;
   - ahead/behind counts;
   - latest default-branch remote commit, tag, and branch heads;
   - oldest unpushed commit timestamp when the branch is ahead.
3. For each explicit GitHub repo, use `gh` read-only commands to check
   notifications and recent default-branch workflow failures when available.
4. Record durable findings with `POST /api/observations`. Use stable
   `(source, ref)` pairs so repeated delegated polls coalesce:
   - `source`: `git-delegated:<repoPath>` or `github-delegated:<owner/repo>`
   - `ref`: include the event type, branch/tag, and SHA or run id.
   - `actor`: `agent`
   - `payload`: include `eventType`, repo identity, branch/tag, SHAs, and a
     concise evidence summary.
5. If a default-branch merge, push, or tag materially changes a watched
   project document, update it through the project-doc/context API only.
   Preserve manual prose and headings.
6. Close silently for normal maintenance. If you send a notification for a
   high-risk finding, do not also repeat that message in the final text.
