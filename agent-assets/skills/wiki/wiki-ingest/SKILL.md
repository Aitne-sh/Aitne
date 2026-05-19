---
name: wiki-ingest
description: Load for wiki.ingest_url. Captures one URL into 10_raw/<slug>.md by POSTing through the daemon Wiki API. Carries the canonical curl invocation, the path / response contract, and the strict success-verification rule.
allowed-tools:
  - WebFetch
  - Bash(curl *)
---

# Wiki URL Ingestion

You run under process key `wiki.ingest_url` in workspace `{{workspace_name}}` (vault `{{vault_path}}`). Read `<wiki_command>` for the target `url` and optional `batch_id`. Your job: capture the page faithfully into ONE new file via the daemon Wiki API. Source fidelity beats summarization.

## The success contract (read this first)

A run is "successful" **only** when the daemon's Wiki API has returned `{"ok":true,"path":"10_raw/<slug>.md"}` to your `curl POST`. There is no other definition of success. The vault is on disk; you cannot write it any other way.

Therefore:

- The final tool call before your completion DM MUST be a successful `curl ... /api/wiki/{{workspace_name}}/files/10_raw/<slug>.md`.
- You MUST inspect the curl response body. If you do not see the JSON `{"ok":true,"path":"<the exact path you POSTed>"}`, the write did not happen — emit the FAILURE DM, not the success DM.
- You MUST NOT fabricate a path, claim success after writing to a local file, claim success after a 4xx/5xx response, or claim success after calling any other endpoint.

## Allowed endpoints (the entire surface for this skill)

The only daemon routes this skill writes to are:

| Method | Path | Purpose |
|---|---|---|
| `POST`  | `/api/wiki/{{workspace_name}}/files/10_raw/<slug>.md` | Create the raw note (this is the success path) |
| `PATCH` | `/api/wiki/{{workspace_name}}/files/log.md` | Append a one-line failure entry on fetch failure |
| `GET`   | `/api/wiki/{{workspace_name}}/files/10_raw/<slug>.md` | Verification read after POST (optional) |
| `GET`   | `/api/wiki/{{workspace_name}}/search?q=<q>` | Optional — check whether the URL was already ingested |

Do NOT call any other daemon endpoint. The daemon has **no** `/api/send-message`, `/api/whatsapp/send`, `/api/notify-user`, `/api/dm`, `/api/messages/send`, or anything similar — those names look plausible but do not exist; calls there return 401/404 and your "delivery" never happens. The completion DM you emit as your final assistant text is forwarded by the daemon automatically.

## Procedure

1. **Fetch the source page** (one of these, depending on backend):
   - Claude: `WebFetch <url>`.
   - Codex: `curl <url>` against the real internet (the workspace-write sandbox has outbound network).
   - Gemini: `web_fetch <url>`.
   Preserve facts verbatim; mark uncertainty.
2. **Derive a slug**: lowercase kebab-case from the URL host + path tail, matching `^[a-z0-9][a-z0-9-]*$`. Examples: `news-webike-31883`, `nytimes-headline-2026-05-12`. ~60 chars max.
3. **Build the raw note body** as Markdown:
   - Frontmatter (`source`, `retrieved`, `title`, `process: wiki.ingest_url`).
   - `# <title>` headline.
   - `## Source extracts` — verbatim or close-paraphrase quotes.
   - `## Open questions` — anything you could not verify from the page.
4. **POST the note** via the canonical curl shape (next section). Inspect the response body.
5. **Verify**: the response body must be exactly `{"ok":true,"path":"10_raw/<slug>.md"}`. If anything else (4xx/5xx, missing `ok`, wrong path, no body, `PA_API_ERROR …` on stderr), treat it as failure. Follow the error table below or PATCH `log.md` and emit the failure DM.
6. **Emit the completion DM** (last section). Success or failure, exactly one line, no extra prose.

## Path shape — exact, no nesting

The path component after `/files/` must be **exactly** `10_raw/<slug>.md` — a single segment under `10_raw/`. No date prefix folder, no category folder, no sub-categorisation:

| Wrong | Why | Correct |
|---|---|---|
| `10_raw/articles/2026-05-13-ninja-h2-sx-owner-reviews.md` | nested folder `articles/` — `invalid_layer` 400 | `10_raw/news-webike-31883.md` |
| `10_raw/2026-05-13/ninja.md` | date folder — `invalid_layer` 400 | `10_raw/news-webike-31883.md` |
| `10_raw/news.md/file.md` | path has `.md` mid-segment | `10_raw/news-webike-31883.md` |
| `10_RAW/news.md` | uppercase root | `10_raw/news-webike-31883.md` |
| `10_raw/News-Webike-31883.md` | slug not lowercase | `10_raw/news-webike-31883.md` |

The only acceptable nested form is `10_raw/images/<slug>/<file>` for source images — text notes are always a single segment.

## Canonical curl invocation

The Bash command MUST start with the literal token `curl`. The session's `Bash(curl *)` allow-rule is prefix-matched; commands wrapped in `echo … |`, `cat <<EOF |`, `bash -c`, `( … )`, command substitution, or any other shell construct are silently denied under `dontAsk` mode and you receive no error. If a Bash call returns with no stdout, no stderr, and no `PA_API_ERROR`, your command was silently denied — rewrite it to start with literal `curl`.

### POST the raw note — heredoc shape (recommended for article bodies)

Article bodies are typically several KB and benefit from heredoc quoting (no shell escapes for `"`, real newlines instead of `\n`). The command still starts with `curl`; the heredoc redirects into curl's stdin, and the shim reads it via `-d @-`:

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/10_raw/<slug>.md \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.ingest_url' \
  -d @- <<'JSON'
{"content":"---\nsource: https://news.example.com/path/123\nretrieved: 2026-05-13T05:08:00Z\ntitle: Sample article\nprocess: wiki.ingest_url\n---\n\n# Sample article\n\n## Source extracts\n\n- First quoted paragraph from the page.\n\n## Open questions\n\n- Anything not verifiable from the page."}
JSON
```

Inside `<<'JSON'` (single-quoted marker) the body is verbatim — shell does NOT expand `$`, backticks, or quotes. Only JSON's own escapes apply: `\"`, `\\`, `\n`.

### POST inline (for short bodies only)

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/10_raw/<slug>.md \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.ingest_url' \
  -d '{"content":"---\nsource: ...\n---\n\n# Title\n\n## Source extracts\n\n- Short body."}'
```

Expected response (anything else means failure):

```
{"ok":true,"path":"10_raw/<slug>.md"}
```

### (Optional) Verify the file actually exists

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/10_raw/<slug>.md \
  -H 'x-process-key: wiki.ingest_url'
```

Expected response: `{"path":"10_raw/<slug>.md","content":"...","mtime":"...","sizeBytes":N}`. A 404 means the POST silently failed even if you thought you saw `ok:true`.

### Append a failure entry to log.md (use ONLY when the raw note will NOT be created)

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/log.md \
  -X PATCH \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.ingest_url' \
  -d '{"mode":"append","content":"[2026-05-13T05:08:00Z] wiki.ingest_url failed https://news.example.com/path/123 — fetch returned 403\n"}'
```

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
- `echo '{...}' | curl ...`, `cat <<JSON | curl ... -d @- JSON ; …`, `bash -c "curl ..."` — Bash command does not start with `curl`; denied silently under `dontAsk`. (Heredoc redirected directly into curl on the same line — `curl ... -d @- <<'JSON' … JSON` — IS allowed because the command still starts with `curl`.)
- `curl ... -d @/tmp/body.json` — `@<path>` form is blocked by the security hook and by the shim.
- `curl http://example.com/...` (non-loopback) — security hook denies; only `http://localhost:8321/api/*` is permitted.
- POST to a non-existent path like `/api/send-message`, `/api/whatsapp/send`, `/api/notify-user`, `/api/dm`. These are NOT daemon routes; calls return 401/404 and DO NOT notify anyone.
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
| 400 | `invalid_body` | JSON body did not parse / `content` not a string | Re-emit the body. For inline `-d` check your single-quote / `\n` / `\"` escapes. If the body was `@-` literally, the heredoc was missed — switch to the heredoc shape (`-d @- <<'JSON' … JSON` on the same line as curl). |
| 400 | `invalid_path` / `invalid_layer` | Slug or layer rejected | Path must be **exactly** `10_raw/<slug>.md`, slug matching `^[a-z0-9][a-z0-9-]*$`. No nested folders. |
| 403 | `missing_process_key` | Header missing | Add `-H 'x-process-key: wiki.ingest_url'` and retry. |
| 403 | `raw_write_denied` | Process key isn't `wiki.ingest_url` | Configuration error; emit failure DM, do not retry. |
| 409 | `append_only` | Slug already exists in `10_raw/` | Suffix the slug (`<slug>-2`), retry the POST **once**. If `-2` also 409, PATCH log.md and emit failure DM — do not loop further. |
| 413 | (body too large) | Article > 512 KB | Trim verbatim extracts; keep essentials. |
| 5xx | — | Daemon error | PATCH log.md and emit failure DM. Do not retry — the daemon will not heal mid-turn. |

If the Bash call returns to the prompt with **no stdout body and no `PA_API_ERROR`**, your command did not start with literal `curl` and was silently denied. Rewrite it as a flat, single-line curl invocation following the canonical shape above.

## Completion message (mandatory final assistant text)

Emit exactly one line as your final assistant message. The daemon forwards this verbatim to the channel the bang came from — no other delivery mechanism is needed and you must NOT try to "send" it through another endpoint.

- Success (only after seeing `{"ok":true,"path":"10_raw/<slug>.md"}`): `Ingested <url> → 10_raw/<slug>.md`
- Failure (any other outcome): `Failed <url> — <one-sentence reason>`

The path you put in the success DM must be **byte-identical** to the `path` field returned by the daemon. Inventing or paraphrasing it is the bug this section exists to prevent.

No follow-up offers, no explanation paragraphs — just the single line.
