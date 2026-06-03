---
kind: reference
name: output-path
description: output_path grammar — `<domain>/<type-plural>/` only, trailing slash mandatory, no `..`, no leading `context/`. Daemon CHECKs at INSERT/UPDATE.
---

# output_path grammar

The `output_path` field on `/api/managed-tasks` is the L2 directory
under the primary context vault where the recurring fetch will write
entity files. The full grammar (domain/type enum, two segments, no
`..`) is enforced by a Zod `.refine` PRE-insert, so a bad value is
rejected with **HTTP 400**. The SQL CHECK constraint only guarantees
the trailing slash (`output_path LIKE '%/'`).

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
the pair whose semantic prior best fits the fetch's data shape.

## Data shape → path mapping

When no existing entity path is found for the source (see Register
Step 4a), pick the `(domain, type)` pair whose semantic prior best
fits the probe sample:

| Probe sample shape | Likely `<domain>/<type-plural>/` |
|---|---|
| Recording with attendees + duration | `work/meetings/` |
| PDF / image with monetary amount | `finance/receipts/` |
| Travel itinerary / booking | `travel/trips/` |
| Long-form note / article | `<domain>/notes/` (pick by content topic) |
| Book metadata / progress | `learning/books/` |

If the data shape is genuinely ambiguous (zero rows), omit the field
(`output_path: null`) — the first scheduled run populates it.

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

## Rejection

A bad `output_path` fails Zod and the route returns **HTTP 400** with
the generic `managed_tasks.validation_error` issue — there is no
top-level `field` and no per-`output_path` `message`. The raw
ZodError lives under `legacyFields.details`, but it is a serialized
ZodError object (`{name:"ZodError", message:"<stringified issues>"}`),
NOT an array — there is no `details[].path` to read. The offending
field (`output_path`) is named in `body.summary` and the issue `hint`;
the raw issues are inside the stringified `details.message`. Surface
`body.summary` or the issue `hint`. Do not retry the same value.
