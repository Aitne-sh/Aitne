---
name: project-doc
description: Create and maintain Git-backed project and repository context documents through the daemon context API only.
allowed-tools:
  - Bash(curl *)
  - Bash(git -C *)
---

# Project Doc

Output language: project docs are Policy B — see `<output_language_policy>`. Template H2/H3 headers stay English skeleton; body prose, bullets, and summaries are in `<settings primary_language>`. Preserve user-customized headers verbatim.

Use this skill for Git-backed context documents under the unified
repositories layout (see
`docs/design/appendices/unified-repositories.md` §4.5):

- **Git-managed repositories** (any classification) write to
  `git/<slug>/overview.md` plus per-day `git/<slug>/journal/<YYYY-MM-DD>.md`.
- **Non-git project pages** (manual projects without a backing repo)
  still live at `projects/<slug>.md` per the original layout.

The pre-cutover paths `projects/<slug>.md` (for git-backed projects)
and `git-repos/<slug>.md` are **retired** — every git-managed repo
now lives under `git/<slug>/`. Classification (`project` vs `repo-only`)
no longer changes the path; it controls which sections the overview
carries (project keeps `## Lifecycle Phases`, repo-only stays light).

## Hard rules

- Write only through `/api/context/*`. Never edit files directly on disk.
- Do not modify `state/today.md`, `plans/roadmap.md`, `user/*`, `rules/*`, or
  unrelated context files.
- Preserve valid frontmatter. The overview file uses `type: git-project`,
  the journal file uses `type: git-journal`. Both carry an ISO `updated`
  date.
- Use `GET /api/context/<path>` before updating an existing overview.
  Use `PUT /api/context/<path>` for initialization or full-document
  updates. Use `PATCH` only when appending to a section without touching
  frontmatter.
- Preserve user prose, manual notes, and existing headings. Compress
  old Git history instead of deleting meaningful context.

## Overview file shape (`git/<slug>/overview.md`)

- Frontmatter: `type: git-project`, `repository_id`, `slug`,
  `github_repo` (or null), `local_path`, `classification`, `category`,
  `created`, `updated`.
- `# <display name>`
- `## Summary`
- `## Architecture`
- `## Notable Changes`
- `## Lifecycle Phases` (project classification only)
- `## Open Threads` (manual prose; preserved verbatim)
- `## Daily Activity Log` (rolling 30-day window)

## Journal file shape (`git/<slug>/journal/<YYYY-MM-DD>.md`)

- Frontmatter: `type: git-journal`, `repository_id`, `date`,
  `commit_count`, `pr_events`, `workflow_events`.
- `# <date> — <slug>`
- `## Commits`
- `## PR / Workflow Events`
- `## Files Changed`

## Placeholder substitution

When the template carries placeholders, replace every one before
writing:

- `{updated}` / `{created}`: current ISO date, `YYYY-MM-DD`.
- `{slug}`: `task_context.slug` (deterministic, sanitized).
- `{repository_id}`: `task_context.repositoryId`.
- `{local_path}`: `task_context.localPath`.
- `{github_repo}`: `task_context.githubRepo` or `null`.
- `{classification}`, `{category}`: values from `task_context`.
- `{display_name}`: pretty-printed slug or `task_context.displayName` if
  the row has one.
- `{date}`, `{commit_count}`, `{pr_events}`, `{workflow_events}`,
  `{commits_list}`, `{pr_workflow_summary}`, `{files_summary}`: derived
  from Git evidence collected for the journal day.

## Project / git-project file shape (auto-curated)

<!-- CURATION:knowledge_layout id="project-shape" -->

## Slug grammar (auto-curated)

<!-- CURATION:convention_notes id="slug-grammar" -->
