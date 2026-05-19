---
kind: reference
name: required-frontmatter
description: YAML frontmatter required by /api/context/* validators on full-file PUT — per-glob type/owner/updated values, H1 requirement.
---

# Required frontmatter — guarded files

Full-file `PUT /api/context/<path>` for the following globs is rejected
(`400 validation_error`) unless the body opens with the matching YAML
frontmatter followed by at least one H1 heading.

Use today's date (the value from `<current_agent_day date="…" />`) for
`updated`. The daemon does not auto-fill `updated`; an outdated value
trips the Evening Review's stale-file detector.

## Per-glob frontmatter

| File glob | `type` | `owner` | Required H1 |
|---|---|---|---|
| `projects/*.md` | `project` | `shared` | Yes |
| `daily/*.md` | `daily` | `agent` | Yes |
| `weekly/*.md` | `weekly` | `agent` | Yes |
| `monthly/*.md` | `monthly` | `agent` | Yes |
| `rules/*.md` | `rule` | `shared` | Yes |
| `user/*.md` | `user` | `shared` | Yes |

Every glob also requires `updated: YYYY-MM-DD`.

## Skeleton

```yaml
---
type: <from table>
owner: <from table>
updated: YYYY-MM-DD
---

# <Title>

…body…
```

## Section-level PATCH

`PATCH /api/context/<path>` (`section` + `mode`) **preserves existing
frontmatter** byte-for-byte. You do not need to re-supply the
frontmatter on PATCH. The validator only re-runs the frontmatter check
on `PUT` (full replace).

## Files outside the table

`today.md`, `roadmap.md`, `agent/journal.md`, and `rules/policies/*.md`
have their own validators (date-line regex, transition guard, append-
only mode, policy schema). The frontmatter rules in this reference do
not apply to them — see each owning skill for the specifics.

## Common 400 envelope

```json
{
  "error": "validation_error",
  "message": "user/people.md is missing required frontmatter field: updated",
  "path": "user/people.md"
}
```

The `message` field names the offending field. Re-PUT with the
corrected frontmatter; the daemon does not partially repair the body.

`POST /api/context/repair/stub` is the recovery path for a file that
exists but has only the H1 — it re-runs the template seed. Do not use
it to bypass a frontmatter validation failure on your own PUT body.
