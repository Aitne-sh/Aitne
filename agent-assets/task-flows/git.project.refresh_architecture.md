{context}

# Task Flow: Refresh Repository Architecture Section

You are producing the body of the `## Architecture` section in
`git/<slug>/overview.md` for a registered repository. The dashboard's
"Refresh architecture" button (or the auto-enqueue at manual init time)
created this `git.project.refresh_architecture` task. The daemon owns the
surgical merge — you submit only the new section body and it replaces the
marker-bracketed Architecture block in place. Other sections (Summary,
Notable Changes, Daily Activity Log) are preserved automatically.

## Tools available to you

This session runs under a **read-only clamp**. Your only write surface is the
single daemon-API call in Step 6. The runtime denies every other writer.

Available:

- `Read` / `Glob` / `Grep` — inspect the repository at `<localPath>` and any
  documentation under it. Pass absolute paths; you do **not** need to `cd`.
- `Bash(curl *)` — pinned to `localhost:<apiPort>` by the security hook; used
  exclusively for the Step 6 `PUT`.
- `Bash(jq *)` — JSON post-processing for the curl response.

Denied (these tools will fail at the SDK layer — do not attempt them):

- `Write`, `Edit` — no agent-side write to the worktree. The daemon owns
  every byte under `git/<slug>/`.
- `Bash(git ...)`, `Bash(ls ...)`, `Bash(cat ...)` and any other shell verbs —
  use `Glob` to enumerate directories and `Read` to inspect files. You are
  analysing *current code structure*, not git history, so the git CLI is not
  needed here. The daily-journal cron is the path that consumes git history.

## Inputs

Read `<task_context>` first. It contains:

- `repositoryId` — opaque ID; pass it back on the write call below.
- `slug` — the directory slug under `git/`; the overview is at `git/<slug>/overview.md`.
- `localPath` — absolute path to the repository's local clone. **Read directly from this path** with the Read tool; you do NOT need to `cd` into it.
- `githubRepo` — `owner/repo` string when GitHub-linked, otherwise `null`.
- `classification` — `"project"` or `"non-project"`.
- `category` — operator-supplied category label.

## Goal

Produce a thorough, evergreen Architecture analysis suitable for a
project-overview document. Aim at a reader who is technical but new to
the repo. Cover, **only as the repo actually warrants**:

- **Top-level layout and module map.** What lives in each top-level dir,
  what each package owns, what the entry points are.
- **Runtime shape.** Long-running daemon vs. CLI vs. library. Process
  lifecycle. Background workers, schedulers, cron, observers, web servers.
- **Data flow.** How input enters the system, how it's stored
  (database, files, in-memory), how it leaves (API, write to disk,
  emitted events).
- **Persistence.** Database tables/schemas, file conventions, caches,
  migration approach.
- **External integrations.** APIs called, services consumed, auth model.
- **Build / packaging.** Languages, build tooling, monorepo structure
  if any, how it's installed/distributed.
- **Test surface.** Test framework, structure, what's covered vs. not.
- **Notable design choices.** Patterns the codebase commits to (DI,
  message bus, event sourcing, plugin registries, etc.) and the
  invariants those patterns enforce.

Skip generic boilerplate. Don't list every file or every script —
synthesize.

## Steps

1. **Read the README** at `<localPath>/README.md` (or `README.*`). Use
   it as the author's stated framing of the project, but verify against
   the code; the README can drift.
2. **Survey top-level structure.** `Glob` `<localPath>/*` (and
   `<localPath>/.*` for dotfiles you care about) + targeted `Read`s of
   `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / etc. to
   identify the language, build system, and entry points.
3. **Walk the meaningful directories.** Read enough source to confirm
   each module's responsibility. Prefer reading entry points,
   manifests, and central registries (e.g. a router, a server bootstrap,
   a scheduler) over leaf files.
4. **Cross-check the design docs** if `docs/` or `design/` exists —
   these often record invariants that aren't visible from code alone.
   Cite the doc filename when you rely on it.
5. **Write the Architecture body.** Compose well-structured Markdown:
   - Use `### ` and `#### ` for sub-sections (NOT `## ` — that boundary
     belongs to the parent file).
   - Use bulleted lists, short prose paragraphs, and small tables where
     they communicate better than prose.
   - File / dir references use backticks (e.g. `packages/daemon/src/`).
   - Code references use the `path/to/file.ext:line` form so a reader
     can jump to the source.
   - **Do NOT include** the `<!-- architecture:start -->` /
     `<!-- architecture:end -->` markers in your submission — the daemon
     wraps your body with them.
6. **Submit the section.** One write, one shot:

   ```
   PUT /api/repositories/<repositoryId>/architecture-section
   { "markdown": "<your section body>" }
   ```

   Use curl from the session workdir (no Bearer token needed — this
   endpoint is agent-callable).

## Stopping conditions

- Target ~6–15 turns. If you reach 25 turns, finalize whatever you have
  and submit it; a partial-but-honest Architecture section beats an
  unfinished one that never lands.
- If `localPath` does not exist or is not a git worktree, abort and
  surface the error in your final response — do NOT submit a placeholder.
- Do not call any other write endpoint. Your only output is the single
  `PUT /architecture-section` call.

## Final response

Keep it brief. One sentence confirming the write landed (or summarizing
why it could not). The dashboard reads the file directly; there is no
need to DM the owner.
