---
name: skill-curation
description: Submit typed-payload proposals to update knowledge-cartography sections of skills. Read-then-validate-then-submit. Never invent new section ids or kinds.
allowed-tools:
  - Bash(curl http://localhost:8321/api/skill-curation/*)
  - Read
---

# Skill Curation

You are running inside an isolated optimizer workdir. The ONLY mutation
surface available to you is the curation API at
`http://localhost:8321/api/skill-curation/*`. You cannot Edit, Write,
MultiEdit, NotebookEdit, run shell commands other than the curl glob, or
read any file outside this workdir's `data/` subtree.

## Workflow (in order, every run)

1. List candidate skills:
   `curl -s http://localhost:8321/api/skill-curation/skills`
2. For each skill the run targets, list its current sections:
   `curl -s http://localhost:8321/api/skill-curation/skills/<slug>`
3. Read the current payload for each candidate section:
   `curl -s http://localhost:8321/api/skill-curation/skills/<slug>/sections/<section_id>`
4. Compare against the knowledge-map snapshot under `data/knowledge-map.json`.
5. For each section where signals + snapshot agree on a real change, submit
   ONE proposal at a time, the smallest payload that closes the gap.

## Submission shape

```
POST /api/skill-curation/proposals
Header: X-Optimizer-Token: <runToken from env>
Body:
{
  "runId": "<runId>",
  "skill_slug": "user-profile",
  "section_id": "topic-files",
  "payload": { "kind": "knowledge_layout", "files": [...] },
  "rationale": "structure_diff observed `## Health Log` heading on user/personal.md last week",
  "signal_ids": [42, 47]
}
```

The API returns `{proposalId, rendered, diff}` on accept. On reject, the
response body lists `failures[]` — fix the payload and try again.

## Hard rules (auto-reject)

- Never invent new `section_id` values. If the skill doesn't declare a
  section, you cannot create one.
- Never POST to a section whose declared `kind` doesn't match your
  payload's `kind`.
- Never re-submit a `frozen` section (`/skills/<slug>` returns
  `frozen_sections`). The frozen state is a deliberate owner override.
- ALWAYS cite at least one `signal_id`. A proposal with empty
  `signal_ids[]` is rejected.
- Never copy a `signal_id` already cited in another proposal in the same
  run (each signal is consumed once).

## Decision-language guard

Free-text fields (`convention_notes.rule`, `routing_table.note`,
`search_recipes.note`) MUST describe the convention, not prescribe an
action. Examples:

- ❌ "When the user mentions a doctor visit, write to user/personal.md"
- ✅ "Doctor visits are recorded under `user/personal.md ## Health Log`"
- ❌ "Always include the date with the entry"
- ✅ "Entries carry a `[YYYY-MM-DD]` prefix"
- ❌ "Never use spaces in slugs"
- ✅ "Slugs are kebab-case, no spaces"

The API rejects payloads that match `\b(must|always|never)\b` or
imperative `when X then Y` / `if X do Y` / `before X you should Y`
constructions. If you find yourself wanting to write a rule, restate it
as a description.

## Dry-run discipline

Every proposal MUST be dry-run first to surface smoke-test failures
without consuming signals:

```
POST /api/skill-curation/proposals/dryrun
(same body shape; no proposalId returned, only diff + failures)
```

If `dryrun` returns failures, fix the payload — never skip dry-run.

## Stop conditions

If a section's signals contradict each other (one says "add ## Health",
another says "## Health was deleted"), submit no proposal and surface the
conflict in the run summary by including a `notes` field on
`POST /api/skill-curation/runs/<runId>/finalize`. It is correct and
expected to finish a run with zero proposals.

## Finalization

When you've submitted all proposals you intend to:

```
POST /api/skill-curation/runs/<runId>/finalize
Body: { "notes": "applied 2 additions for user-profile, skipped today (contradictory signals)" }
```

The daemon notifies the owner and tears down your workdir.
