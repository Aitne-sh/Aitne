---
kind: reference
name: curl-errors
description: On-demand detail for wiki-ingest curl mechanics — body-quoting rules, silent-denial anti-patterns, and the per-status error->recovery table.
---

# Curl mechanics, anti-patterns, and error recovery

## Body-quoting rules

**Heredoc body (recommended for article bodies):** wrap with a single-quoted marker (`<<'JSON' … JSON`). The body is verbatim — shell does NOT expand `$`, backticks, or quotes. Only JSON's own escapes apply: `\"`, `\\`, `\n`. The line `JSON` must appear at column 0 with no trailing characters.

**Inline body (short bodies only):** wrap the JSON in outer single quotes; inside, use JSON escapes:

| Need in `content` | Write in shell-arg |
|---|---|
| `"` | `\"` |
| `\` | `\\` |
| newline | `\n` |
| `'` | `'\''` (close-escape-reopen), or substitute `’` (U+2019) |
| `$`, backticks | leave as-is (single quotes suppress expansion) |

Keep the note compact — well under 512 KB. Curate 5-20 KB of the most informative extracts rather than dumping the whole page.

## Anti-patterns (silent denials / 4xx — never claim success after these)

- `WebFetch http://localhost:8321/...` — Claude WebFetch refuses loopback. Use curl.
- `echo '{...}' | curl ...`, `cat <<JSON | curl ... -d @- JSON ; …`, `bash -c "curl ..."` — Bash command does not start with `curl`; denied silently under `dontAsk` (see "Canonical curl invocation"). (Heredoc redirected directly into curl on the same line — `curl ... -d @- <<'JSON' … JSON` — IS allowed because the command still starts with `curl`.)
- `curl ... -d @/tmp/body.json` — `@<path>` form is blocked by the security hook and by the shim.
- `curl http://example.com/...` (non-loopback) — security hook denies; only `http://localhost:8321/api/*` is permitted.
- POST to a non-existent path like `/api/send-message` etc. (see "Allowed endpoints") — calls return 401/404 and DO NOT notify anyone.
- POST/PATCH to `/api/wiki/.../10_raw/<slug>.md` a second time — raw is create-only; the second call returns 409 and **does NOT** modify the file.
- `Write` / `Edit` tools — stripped from the session allow-list for every `wiki.*` process key. The SDK denies them silently under `dontAsk` (you'll see "Permission to use Write has been denied …"). There is no path-rewrite that makes them work; use the Wiki API via curl. `Bash(find ...)`, `Bash(ls ...)`, `Bash(cat ...)` and other shell utilities are also denied — only `Bash(curl *)` and `Bash(jq *)` are on the allow-list.

## Troubleshooting

Every non-2xx response causes the curl shim to write one line to stderr:

```
PA_API_ERROR {"method":"POST","path":"/api/wiki/...","status":<n>,"bodyPreview":"<json error>"}
```

Read `status` + `bodyPreview` and react:

| Status | Body code | Cause | Recovery |
|---|---|---|---|
| 200 | (response is `{"ok":true,"path":...}`) | Success | Emit the success DM. |
| 200 | (response missing `ok` or `path`) | Should not happen — but if it does, treat as failure | Emit failure DM. |
| 400 | `invalid_json_body` | JSON body did not parse (runs before the Zod check) | Re-emit the body. For inline `-d` check your single-quote / `\n` / `\"` escapes. If the body was `@-` literally, the heredoc was missed — switch to the heredoc shape (`-d @- <<'JSON' … JSON` on the same line as curl). |
| 400 | `invalid_body` | Body parsed but `content` is not a string (Zod rejection) | Re-emit the body with `content` as a JSON string. |
| 400 | `invalid_path` / `invalid_layer` | Slug or layer rejected | Path must be **exactly** `10_raw/<slug>.md`, slug matching `^[a-z0-9][a-z0-9-]*$`. No nested folders. |
| 403 | `missing_process_key` | Header missing | Add `-H 'x-process-key: wiki.ingest_url'` and retry. |
| 403 | `raw_write_denied` | Process key isn't `wiki.ingest_url` | Configuration error; emit failure DM, do not retry. |
| 409 | `append_only` | Slug already exists in `10_raw/` | Suffix the slug (`<slug>-2`), retry the POST **once**. If `-2` also 409, PATCH log.md and emit failure DM — do not loop further. |
| 413 | (body too large) | Article > 512 KB | Trim verbatim extracts; keep essentials. |
| 5xx | — | Daemon error | PATCH log.md and emit failure DM. Do not retry — the daemon will not heal mid-turn. |

If the Bash call returns to the prompt with **no stdout body and no `PA_API_ERROR`**, your command was silently denied (see "Canonical curl invocation"). Rewrite it as a flat, single-line curl invocation following the canonical shape.
