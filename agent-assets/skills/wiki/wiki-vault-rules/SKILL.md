---
name: wiki-vault-rules
description: Load for every wiki.* process. Defines wiki vault layout, layer ownership, and the daemon Wiki API call convention (endpoints + canonical curl shape).
allowed-tools:
  - Bash(curl *)
  - Read
---

# Wiki Vault Rules

The wiki vault is `{{vault_path}}` for workspace `{{workspace_name}}` (schema `{{schema_version}}`, language `{{language}}`).

Never write this directory directly. Use only the daemon Wiki API at `http://localhost:8321`:

```
GET    /api/wiki/{{workspace_name}}/index
GET    /api/wiki/{{workspace_name}}/search?q=<query>
GET    /api/wiki/{{workspace_name}}/files/<path>
POST   /api/wiki/{{workspace_name}}/files/<path>
PATCH  /api/wiki/{{workspace_name}}/files/<path>
```

Every request must include `x-process-key` with your current process key.

## Layers

- `00_inbox/` is human-only. Agents may read it but must never write it.
- `10_raw/` is create-only source capture. `wiki.ingest_url` may create root-level `<slug>.md`; existing raw notes are immutable.
- `10_raw/images/<slug>/<file>` is reserved for source images.
- `20_wiki/` is synthesized knowledge. `wiki.compile` may write root-level `<slug>.md` and `_index.md`.
- `30_outputs/` is answers and reports. `wiki.ask` may write root-level `<YYYY-MM-DD>-<slug>.md`.
- `90_meta/` holds taxonomy, schemas, and health notes. Treat schema files as read-mostly.
- `log.md` is append-only operational history (PATCH `mode: "append"` only).

Slugs are lowercase kebab-case (`^[a-z0-9][a-z0-9-]*$`). Preserve source URLs in raw and wiki notes.

## Calling the Wiki API from Bash

The session installs a node-backed curl shim at `.pa/bin/curl` (first on `PATH`) which pins host/port and auto-attaches read-side auth. From your point of view it behaves like plain `curl` against `http://localhost:8321/api/*` — with the constraints below.

### The command MUST start with the literal `curl` token

The session's allow-list is `Bash(curl *)`, **prefix-matched against the full command string**. These shapes are silently denied under `dontAsk` (no error, no `PA_API_ERROR`, no body — the call simply does not run):

```
echo '{...}' | curl ...      # starts with `echo`
cat <<JSON | curl ... -d @-  # starts with `cat`
bash -c "curl ..."           # starts with `bash`
( curl ... )                 # starts with `(`
curl1=... ; curl ...         # starts with `curl1` then `;` — chained-curl deny
```

Write a single, flat curl call. Multi-line / large bodies use a heredoc redirected directly to curl's stdin (the command still starts with `curl`):

```
curl http://... -X POST -H 'content-type: application/json' \
  -H 'x-process-key: ...' -d @- <<'JSON'
{"content":"... multi-line body ..."}
JSON
```

The shim reads stdin when `-d @-` is passed, so the heredoc body lands as the request payload. For small single-line bodies, prefer `-d '<inline-json>'`.

### Allowed curl flags

The shim only understands `-X/--request`, `-H/--header`, `-d/--data/--data-raw/--data-binary`, `-o/--output`, `-F/--form`, and silently ignores `-s/--silent/--show-error`. Any other flag exits with `Unsupported curl flag`.

### Allowed headers

`content-type`, `x-process-key`, `x-lock-id`, `x-session-id`. Other authentication headers are managed by the shim — do not pass `Authorization`, `x-read-token`, or environment-variable expansions; they will be rejected.

### Body-quoting cheat sheet

For inline `-d '<json>'` bodies, wrap the JSON in **outer single quotes** so the shell does not expand it, then follow JSON's own escapes inside:

| Need in `content` | Write in the shell-arg |
|---|---|
| `"` | `\"` |
| `\` | `\\` |
| newline | `\n` |
| `'` | `'\''` (close-escape-reopen), or substitute `’` (U+2019) |
| `$`, backticks | leave as-is |

For heredoc `-d @-` bodies the shell does NOT expand the heredoc body when the marker is single-quoted (`<<'JSON'`), so the JSON inside is verbatim — no shell escaping required, only JSON's own (`\"`, `\\`, `\n`). Use heredoc for any body that's more than a few lines or contains lots of `"`.

`-d @<path>` (file-read) is rejected by both the security hook and the shim — there is no agent-facing reason to load a body from disk.

### What ELSE is silently denied (no `Bash(find|ls|cat|...)`)

Only `Bash(curl *)` and `Bash(jq *)` are on the allow-list. `Bash(find ...)`, `Bash(ls ...)`, `Bash(cat ...)`, `Bash(grep ...)`, `Bash(wc ...)`, and every other shell utility hit the same `dontAsk` denial — no useful tool result. Enumerate the workspace via `GET /api/wiki/<ws>/index` (returns `{ files: [{ path, mtime, sizeBytes }] }`); do not walk `{{vault_path}}` from disk.

`Write` and `Edit` tools are **stripped from the session allow-list** for every `wiki.*` process key — the SDK denies them silently. The Wiki API is the only legal write surface; `{{vault_path}}` is informational, not a target.

### Canonical shapes

```bash
# LIST every file in the workspace (returns JSON with path/mtime/sizeBytes per file)
curl http://localhost:8321/api/wiki/{{workspace_name}}/index \
  -H 'x-process-key: <your-process-key>'

# SEARCH bodies for a substring (returns matches with snippet + mtime)
curl 'http://localhost:8321/api/wiki/{{workspace_name}}/search?q=<query>' \
  -H 'x-process-key: <your-process-key>'

# READ a file
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/<path> \
  -H 'x-process-key: <your-process-key>'

# CREATE a file (POST — used by wiki.ingest_url, wiki.compile, wiki.ask)
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/<path> \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-process-key: <your-process-key>' \
  -d '{"content":"..."}'

# APPEND/PREPEND to a file (PATCH — used for log.md, _index.md, taxonomy.md)
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/<path> \
  -X PATCH \
  -H 'content-type: application/json' \
  -H 'x-process-key: <your-process-key>' \
  -d '{"mode":"append","content":"..."}'
```

Filtering the index is a `jq` job — e.g. raw notes touched since a baseline ISO timestamp:

```bash
curl http://localhost:8321/api/wiki/{{workspace_name}}/index \
  -H 'x-process-key: <your-process-key>' \
  | jq -r --arg since '<YYYY-MM-DDTHH:MM:SSZ>' \
      '.files[] | select(.path | startswith("10_raw/")) | select(.mtime > $since) | .path'
```

### Common error codes

The shim emits `PA_API_ERROR {...}` to stderr on every non-2xx. React on `status` + `bodyPreview.error`:

- `403 missing_process_key` → add `-H 'x-process-key: ...'`.
- `403 read_denied` → your process key isn't a `wiki.*` or DM-read key (the shim should attach the right key).
- `403 human_only_layer` → `00_inbox/` is human-only, never a write target.
- `403 raw_write_denied` / `wiki_write_denied` / `meta_write_denied` / `output_write_denied` / `log_write_denied` → your process key isn't authorized for that layer; fix the target path, not the header.
- `400 invalid_path` / `invalid_layer` → fix the slug shape or layer prefix.
- `400 invalid_body` → JSON shape wrong (e.g. `content` must be a string; PATCH `content` must be non-empty).
- `409 append_only` → file is immutable in this layer; either suffix the slug or use PATCH instead of POST.
- `413` → body exceeds the 512 KB cap.

If the Bash call returns to the prompt with no `PA_API_ERROR` and no body, your command did not start with literal `curl` and was denied under `dontAsk`. Rewrite as a flat curl invocation.
