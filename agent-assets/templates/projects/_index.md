---
type: index
owner: shared
updated: 2026-04-22
template_version: 1
---
# Projects

No projects yet.

Open the _active.base file in this folder for a live table view of all active
projects (state ≠ archived, sorted by last update).

Each project lives in this folder as <slug>.md with frontmatter:

```yaml
---
type: project
slug: <kebab>
state: active | incubating | on-hold | archived
owner: shared
start: YYYY-MM-DD
due: YYYY-MM-DD      # optional
stakeholders: [<owner>, ...]
next_milestone: "..."
tags: [project/<slug>, priority/<level>]
agent_last_synced_at: ISO-8601
---
```
