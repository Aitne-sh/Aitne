---
kind: reference
name: migration
description: Section auto-ensure recipe for legacy roadmaps missing ## Long-term Plans. PATCH-driven; full-file PUT writers (refresh routine) do not need this.
---

# Section auto-ensure — legacy `plans/roadmap.md` files

Roadmaps created before the `## Long-term Plans` section was
introduced may be missing that header. A PATCH targeting the
`Long-term Plans` section against such a file returns
`400 section_not_found`. This reference is the one-time recovery
recipe DM handlers and the evening sweeper run before their first
write to the `Long-term Plans` section.

## When to run

Run this **only** if you are about to PATCH the `Long-term Plans` section and the
file's body is unknown to you. Full-file PUT writers
(`routine.roadmap_refresh`) always emit the full section schema, so
they never trigger `section_not_found` and never need this recipe.

## Steps

```bash
# 1. Read the file
curl -s http://localhost:8321/api/context/plans/roadmap

# 2. Inspect the body for "## Long-term Plans". If present, skip the
#    insert and go straight to the normal PATCH below.

# 3. Absent → insert it after "## Quarterly Focus":
curl -s -X PATCH http://localhost:8321/api/context/plans/roadmap \
  -H 'Content-Type: application/json' \
  -H 'X-Lock-Id: <roadmap_write_lock_id>' \
  -d '{"section": "quarterly_focus", "mode": "append", "content": "\n## Long-term Plans\n"}'

# 4. Then PATCH the Long-term Plans section normally (note: section value
#    "long-term plans" normalizes to match the "## Long-term Plans" header;
#    the underscore form "long_term_plans" does NOT match)
curl -s -X PATCH http://localhost:8321/api/context/plans/roadmap \
  -H 'Content-Type: application/json' \
  -H 'X-Lock-Id: <roadmap_write_lock_id>' \
  -d '{"section": "long-term plans", "mode": "append", "content": "- [undated] …"}'
```

## Don'ts

- Do NOT insert `## Long-term Plans` blindly without GET-ing first;
  appending it twice produces a malformed file (the PATCH route does
  not deduplicate H2 headers).
- Do NOT use this recipe to insert `## Agent Action Plan` or other
  agent-writable sections. The roadmap refresh routine owns the
  per-section schema; section-by-section insertion from DM is not
  supported.
- Do NOT skip the `X-Lock-Id` header when the
  `<roadmap_write_lock_id>` tag is in your context — PATCH without it
  returns `409 roadmap_write_lock_held` during a held-lock window.
