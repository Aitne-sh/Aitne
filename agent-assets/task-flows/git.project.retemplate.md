{context}

# Task Flow: Git Project Re-Template

You are re-conforming durable Git project context files to a newly edited
template. The dashboard's "Apply current template" action created the
`git.project.retemplate` task and pre-backed up every target file before
this session started, so writes here are reversible by the daemon's
finalize step on failure.

Use the `project-doc` skill rules for all reads and writes.

## Inputs

Read `<task_context>` first. It contains:

- `kind` — `"project"` or `"git-repo"` (which template family is being applied).
- `templateName` — `project.md` or `git-repo.md`.
- `templateContent` — the full body of the current `~/.personal-agent/templates/<templateName>` (verbatim, including frontmatter and section headings).
- `targets` — array of `{ slug, contextPath, contextFile, classification, category, repoPath, accountAlias, org, backupRelPath }`. Each entry is one file you must process. The list is finite and pre-validated; do not add or skip targets that are not in this array.
- `backupRoot` — absolute path containing the auto-backup of every target before this session started.
- `correlationId` — pass this back on every per-file status report (the daemon uses it to attribute audit rows to this run).

## Steps

For each `target` in `targets`, in order:

1. **Mark started.** Before reading or writing anything for this file, report:

   ```
   POST /api/git/templates/retemplate/file
   { "slug": "<target.slug>", "status": "started", "correlationId": "<correlationId>" }
   ```

   The daemon stamps this in the status grid; if the session aborts after this point, the daemon's finalize step will restore the file from `<backupRoot>/<target.backupRelPath>`.

2. **Read the current file.** `GET /api/context/<target.contextPath>`. If the file is missing (404), report `{"status":"skipped","reason":"missing"}` and continue. (The daemon enumerates targets from disk before enqueue, so a 404 here means the user moved or deleted the file in between — accept silently.)

3. **Compare against the template.** Quickly check whether the existing body already conforms to `templateContent` (same set of `## ...` headings in the same order, same frontmatter keys, no extra top-level structure). If yes, report `{"status":"skipped","reason":"already_conformed"}` and continue. Idempotency is essential — re-running the action must be cheap.

4. **Re-shape the body.** Produce a new body that:
   - Uses `templateContent` as the structural source: every section heading and frontmatter key the template defines must be present in the same order.
   - **Preserves user information wherever possible.** Manual prose under `## Open Threads`, `## Notable Changes`, `## Lifecycle Phases`, etc., maps onto the same heading in the new template. If the new template drops a heading, fold its content into the most semantically related surviving heading rather than discarding it. Add a one-line `<!-- migrated from: <old heading> -->` HTML comment beside any folded block so a later editor can audit the transformation.
   - Keeps the existing frontmatter values for `slug`, `git_repo`, `default_branch`, `remote`, `created`, `account_alias`, `category`, `org`, and any other identifiers — only the *shape* of the frontmatter changes, not the data. Set `updated:` to today's ISO date.
   - For `kind: "project"`: leaves `## Git Activity`, `## Notable Changes`, `## Lifecycle Phases` populated with whatever the existing file said. Do not refetch git history here — the goal is structural conformance, not refresh.
   - For `kind: "git-repo"`: leaves `## Activity` and `## Recent Pushes` intact.

5. **Write the new body.** `PUT /api/context/<target.contextPath>` with `{ "content": "<full markdown>" }`.

6. **Mark completed.**

   ```
   POST /api/git/templates/retemplate/file
   { "slug": "<target.slug>", "status": "completed", "correlationId": "<correlationId>", "beforeBytes": <int>, "afterBytes": <int> }
   ```

7. **On a per-file error** (`PUT` returns non-2xx, body is malformed, etc.):

   ```
   POST /api/git/templates/retemplate/file
   { "slug": "<target.slug>", "status": "failed", "correlationId": "<correlationId>", "error": "<short message>" }
   ```

   Do **not** attempt to roll back yourself — the daemon's finalize step owns rollback. Continue with the next target.

## Stopping conditions

- Process every target in order, even if some fail. Do not abort the whole run on a single per-file failure.
- If you encounter the same systemic error on three consecutive targets (e.g. context API returning 503), stop and let the daemon mark the run failed — there is no point burning quota against a broken vault.

## Final response

Keep it silent/internal. The dashboard reads the status grid via `GET /api/git/templates/retemplate/status`; there is no need to DM the owner unless the entire flow could not start (no targets, missing template, etc.) and the user needs to act in the dashboard.
