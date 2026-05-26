---
kind: reference
name: obsidian
description: External Obsidian vault CRUD — separate from the agent's primary management vault. Routed via /api/obsidian/*. Stripped when `obsidian` is not configured.
---

<!-- service:obsidian -->
## Obsidian (external vault)

**Scope**: this skill targets a **separate** Obsidian vault the user maintains
alongside this app — e.g. a personal knowledge base. It is **not** the agent's
own primary management store. The agent's primary files (`state/today.md`,
`plans/roadmap.md`, `projects/`, `rules/`, `routines/`, `user/`, `agent/`, …) live
in the primary vault and are reached via `/api/context/*` (see the `context`
skill). **Never** use this skill to read or write the primary vault.

Use this skill when the user asks the agent to look up, append to, or create
notes inside their external knowledge vault — never for the agent's own
working state.

Output language: external-vault writes are Policy C — see `<output_language_policy>`. Preserve verbatim any path / file-name patterns the user has established.

Full CRUD over the external vault. Requires the Obsidian app running (the
CLI proxies through it). Omit `.md` extension from paths. All writes are
Autonomous; the daemon does not DM the owner before/after the call. Call
`POST /api/notify` yourself when the user would want to know.

```bash
curl -s http://localhost:8321/api/obsidian/status                            # external vault availability
curl -s "http://localhost:8321/api/obsidian/search?q=meeting+notes&limit=10" # search external vault
curl -s http://localhost:8321/api/obsidian/notes/Daily%20Notes/2026-04-06    # read external note
curl -s -X POST http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"name": "Meeting Notes 2026-04-02", "content": "# Meeting\n..."}'    # create external note (fails if exists)
curl -s -X PUT http://localhost:8321/api/obsidian/notes/Projects/ProjectA \
  -H 'Content-Type: application/json' -d '{"content": "# Full body"}'       # create-or-overwrite external note
curl -s -X PATCH http://localhost:8321/api/obsidian/notes \
  -H 'Content-Type: application/json' \
  -d '{"file": "Meeting Notes 2026-04-02", "content": "\n- Action item"}'   # append to external note
curl -s -X PATCH http://localhost:8321/api/obsidian/daily \
  -H 'Content-Type: application/json' -d '{"content": "- [ ] Follow up"}'   # append to external daily note
curl -s -X DELETE http://localhost:8321/api/obsidian/notes/Projects/Old      # delete from external vault (moves to trash)
```
**Endpoint choice**: Read → GET, Create-only → POST, Edit → PUT, Append → PATCH.

If the user's request is really about the agent's own state (today, roadmap,
projects, journal, rules, routines, user profile), switch to the `context`
skill and the `/api/context/*` endpoints instead.
<!-- /service:obsidian -->
