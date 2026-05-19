---
kind: reference
name: skills-crud
description: Dashboard-shaped CRUD for user-authored skills under ~/.personal-agent/skills/. Built-in skills are read-only (403).
---

## Skills Management

User-authored skills: `~/.personal-agent/skills/{slug}/SKILL.md`. Built-in skills are read-only (403). Slug: lowercase kebab-case `[a-z0-9][a-z0-9-]*`, 1–64 chars.

```bash
curl -s http://localhost:8321/api/skills                                            # list all
curl -s http://localhost:8321/api/skills/todo-digest                                # read one
curl -s -X POST http://localhost:8321/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"name": "todo-digest", "description": "Summarize today.md", "content": "# TODO Digest\n...", "allowedTools": ["Bash(curl *)", "Read"]}'
curl -s -X PUT http://localhost:8321/api/skills/todo-digest \
  -H 'Content-Type: application/json' -d '{"description": "New description"}'      # update
curl -s -X DELETE http://localhost:8321/api/skills/todo-digest                      # delete
```
Always `GET /api/skills` before creating (check name collisions). **Omit frontmatter** from `content` — the API injects it.

The description is the **only** routing signal the SDK uses to pick a
skill — keep it under 280 chars and make the trigger surface
distinct from every other skill in the manifest. Slug grammar is
strict: `[a-z0-9][a-z0-9-]*[a-z0-9]` or `[a-z0-9]` (single char),
1-64 chars total. PUT rejects collisions with built-in slugs.
