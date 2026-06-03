---
name: wiki-ingest
description: Load for wiki.ingest_url. Use when ingesting one shared URL/article into the wiki raw layer (10_raw) via the daemon Wiki API. Carries the canonical curl invocation, the path / response contract, and the strict success-verification rule.
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
5. **Verify**: the response body must be exactly `{"ok":true,"path":"10_raw/<slug>.md"}`. If anything else (4xx/5xx, missing `ok`, wrong path, no body, `PA_API_ERROR …` on stderr), treat it as failure. Follow the error->recovery table in "Curl mechanics" or PATCH `log.md` and emit the failure DM.
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

## Curl mechanics, anti-patterns, and error recovery

Body-quoting rules, the silent-denial anti-patterns, and the per-status error->recovery table live on demand:

{{> ref:curl-errors }}

## Completion message (mandatory final assistant text)

Emit exactly one line as your final assistant message. The daemon forwards this verbatim to the channel the bang came from — no other delivery mechanism is needed and you must NOT try to "send" it through another endpoint (no /api/send-message etc.; see "Allowed endpoints").

- Success (only after seeing `{"ok":true,"path":"10_raw/<slug>.md"}`): `Ingested <url> → 10_raw/<slug>.md`
- Failure (any other outcome): `Failed <url> — <one-sentence reason>`

The path you put in the success DM must be **byte-identical** to the `path` field returned by the daemon. Inventing or paraphrasing it is the bug this section exists to prevent.

No follow-up offers, no explanation paragraphs — just the single line.
