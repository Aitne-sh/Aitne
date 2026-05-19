---
kind: reference
name: output-path
description: output_path grammar — `<domain>/<type-plural>/` only, trailing slash mandatory, no `..`, no leading `context/`. Daemon CHECKs at INSERT/UPDATE.
---

# output_path grammar

The `output_path` field on `/api/managed-tasks` is the L2 directory
under the primary context vault where the recurring fetch will write
entity files. The daemon enforces the format with a CHECK constraint
at INSERT / UPDATE time.

## Format

`<domain>/<type-plural>/`

- Leading `context/` is **implicit** and must NOT be included; the
  daemon prepends it.
- The trailing `/` is **mandatory**.
- No `..` segments. No absolute paths. No leading `/`.

## Allowed values

| Position | Allowed |
|---|---|
| `<domain>` | `work`, `travel`, `finance`, `personal`, `health`, `learning` |
| `<type-plural>` | `meetings`, `trips`, `receipts`, `projects`, `books`, `notes` |

Not every domain × type combination is meaningful in practice — pick
the pair whose semantic prior best fits the fetch's data shape (see
the §"Decide output path" table in the Register section of the skill
body for the typical mapping).

## Examples

| Valid | Invalid | Why invalid |
|---|---|---|
| `work/meetings/` | `work/meetings` | Missing trailing `/` |
| `finance/receipts/` | `/finance/receipts/` | Leading `/` |
| `travel/trips/` | `context/travel/trips/` | Leading `context/` is implicit |
| `learning/books/` | `random/dir/` | `<domain>` not in allowed set |
| `personal/notes/` | `work/agendas/` | `<type-plural>` not in allowed set |
| (path omitted) | `work/../etc/` | `..` segments rejected |

## When to omit

`output_path` is **optional** on POST. Omit when the data shape is
genuinely ambiguous (e.g. the probe returned zero rows). The first
scheduled run populates it from real data, and a subsequent PATCH
back-fills the field if the user wants to pin it.

## When to relocate

A `PATCH /api/managed-tasks/:id` with a new `output_path` changes
only the *future* runs — existing entity files written under the old
path stay where they were. If the user wants reorganisation, stop
the task, move the files manually (or ask the user to), and
re-register.

To clear an existing `output_path` back to "first run decides", send
`{"output_path": null}` in the PATCH.

## 422 envelope on rejection

```json
{
  "error": "validation_error",
  "message": "output_path 'work/meetings' is missing the trailing slash",
  "field": "output_path"
}
```

Surface the daemon's `message` verbatim — it names the exact rule
that failed. Do not retry the same value.
