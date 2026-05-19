{context}

## Task: Ingest URL into the wiki

A single `!ingest` call landed here. Read `<wiki_command>` for the target `url` and `<wiki_workspace>` for the destination workspace.

You succeed if and only if you POST a new file to `/api/wiki/<workspace>/files/10_raw/<slug>.md` and the daemon responds with `{"ok":true,"path":"10_raw/<slug>.md"}`. There is no other definition of success. The vault file is created by that POST and nothing else — `Write` tool / shell redirection / other endpoints do not put a file in the vault.

### Critical: the Bash command MUST start with literal `curl`

The `Bash(curl *)` allow-list is prefix-matched. Wrappers (`echo '{...}' | curl …`, `cat <<JSON | curl … -d @-`, `bash -c "curl …"`, parentheses, chained `curl … ; curl …`) are silently denied under `dontAsk` — you get no error, no `PA_API_ERROR`, just an empty response. If a Bash call returns nothing, rewrite it to start with `curl`.

Article bodies are typically multi-KB — use a heredoc redirected directly into curl (the command still starts with `curl`):

```
curl http://localhost:8321/api/wiki/<workspace>/files/10_raw/<slug>.md \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.ingest_url' \
  -d @- <<'JSON'
{"content":"---\n…frontmatter…\n---\n\n# Title\n\n## Source extracts\n\n…"}
JSON
```

The shim reads stdin when `-d @-` is passed, so the heredoc body lands as the JSON payload. Inside `<<'JSON'` (single-quoted marker) the body is verbatim — no shell escaping, only JSON escapes (`\"`, `\\`, `\n`). For short bodies (a few hundred bytes) inline `-d '<json>'` is fine.

### Procedure

1. Fetch the URL with the per-backend primitive (WebFetch on Claude, curl on Codex/OpenCode, web_fetch on Gemini).
2. POST one new note at `10_raw/<slug>.md` via the daemon Wiki API with `-H 'x-process-key: wiki.ingest_url'`. Path is EXACTLY `10_raw/<slug>.md` — no nested folders like `10_raw/articles/...`.
3. **Inspect the curl response.** Only `{"ok":true,"path":"10_raw/<slug>.md"}` counts as success. Anything else (4xx, 5xx, missing fields, hallucinated endpoint like `/api/send-message`, no response) means the file was NOT created — PATCH `log.md` with the failure reason and emit the failure DM.

The `wiki-ingest` skill carries the full curl shapes, slug rules, error-code recovery table, and completion-DM format.

End the turn with the single-line completion DM defined in the skill. The path you cite in the success DM must be byte-identical to the `path` field the daemon returned. Do not fabricate a path. Do not claim success without seeing `{"ok":true,...}`. The daemon forwards your final assistant text to the user — you must NOT also call `/api/send-message`, `/api/whatsapp/send`, `/api/notify-user`, `/api/dm`, or any other "send" endpoint; those do not exist.
