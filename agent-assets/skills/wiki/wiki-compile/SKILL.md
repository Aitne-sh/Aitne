---
name: wiki-compile
description: Load for wiki.compile. Synthesizes 10_raw notes into 20_wiki notes via the daemon Wiki API and updates the wiki index.
allowed-tools:
  - Bash(curl *)
---

# Wiki Compile

You run under process key `wiki.compile` in workspace `{{workspace_name}}` (vault `{{vault_path}}`). The event payload's `data.mode` is either `"incremental"` (compile only raws touched since the last compile) or `"full"` (compile every raw). Read `<wiki_command>` for the mode and any caller-supplied filters.

Your job: read `10_raw/` source notes through the daemon Wiki API and emit synthesized `20_wiki/<slug>.md` articles. Never invent sources, never edit existing raws, never collapse multiple conflicting sources into a single uncited paragraph.

## The success contract (read this first)

A run is "successful" only when the daemon's Wiki API has returned `{"ok":true,"path":"20_wiki/<slug>.md"}` (or the corresponding `_index.md` / `log.md` path) to each `curl POST` / `PATCH`. There is no other definition of success — the vault is on disk, you cannot write it any other way.

Therefore:

- Every wiki note you claim to have created MUST be the `path` field of a `200 {"ok":true,...}` response you observed. Never fabricate a path.
- After all writes, the final tool call before your completion DM SHOULD be a successful PATCH to `log.md` summarising what was compiled.
- If any planned write fails (4xx/5xx, missing `ok` field, no body, `PA_API_ERROR` on stderr), classify the overall run as **partial** or **failure** in the completion DM — never as success.

## Allowed endpoints (the entire surface for this skill)

| Method | Path | Purpose |
|---|---|---|
| `GET`   | `/api/wiki/{{workspace_name}}/index` | List every file in the workspace with `path`/`mtime`/`sizeBytes`. Primary enumeration tool. |
| `GET`   | `/api/wiki/{{workspace_name}}/search?q=<query>` | Body-substring search for duplicate detection. |
| `GET`   | `/api/wiki/{{workspace_name}}/files/<path>` | Read raw notes, existing wiki notes, taxonomy, log. |
| `POST`  | `/api/wiki/{{workspace_name}}/files/20_wiki/<slug>.md` | Create a new wiki note. |
| `POST`  | `/api/wiki/{{workspace_name}}/files/20_wiki/<slug>.md` | Rewrite an existing wiki note — re-POST to the same path overwrites in place (a `.snapshots/` backup is taken first). |
| `PATCH` | `/api/wiki/{{workspace_name}}/files/20_wiki/_index.md` | Append a new wiki note's entry (`mode: "append"`). |
| `PATCH` | `/api/wiki/{{workspace_name}}/files/log.md` | Append the per-run summary (`mode: "append"`). |

Every request must include `-H 'x-process-key: wiki.compile'`. The `wiki-vault-rules` skill carries the body-quoting cheat-sheet, the `PA_API_ERROR` shape, and the full set of error codes.

## Procedure

1. **Determine the baseline** (incremental mode only).
   - Read `20_wiki/_index.md` (or `log.md`'s last `wiki.compile` entry) to recover the prior `compiled_at` ISO timestamp.
   - If the workspace has never been compiled, fall back to "compile every raw" (i.e. treat the baseline as the empty string — the `jq` filter then admits every `10_raw/*` row).
2. **Enumerate raw notes** to compile.
   - `GET /api/wiki/{{workspace_name}}/index` returns `{ files: [{ path, mtime, sizeBytes }, ...] }`.
   - Filter with `jq` for `path` under `10_raw/` and (incremental) `mtime > <baseline>`. Do NOT walk `{{vault_path}}` from disk; `Bash(find ...)`, `Bash(ls ...)`, etc. are silently denied.
3. **Read existing wiki + taxonomy** so synthesis can de-duplicate and use canonical slugs.
   - `GET /api/wiki/{{workspace_name}}/files/20_wiki/_index.md`
   - `GET /api/wiki/{{workspace_name}}/files/90_meta/taxonomy.md`
4. **Read each candidate raw note** via `GET /api/wiki/{{workspace_name}}/files/10_raw/<slug>.md`.
5. **Synthesize root-level `20_wiki/<slug>.md`** notes:
   - One note per coherent topic — merge multiple raws when they cover the same thing; split a single raw across multiple notes only when the raw genuinely spans unrelated topics.
   - Use `90_meta/taxonomy.md` for canonical slugs.
   - Preserve source URLs and quoted passages verbatim. Mark conflicts and unknowns explicitly.
   - Each note's frontmatter MUST list every source raw under a `sources:` array and the synthesis date under `compiled_at:`.
   - Write via `POST` for both new and existing slugs — re-POSTing to an existing `20_wiki/<slug>.md` overwrites it in place (the daemon snapshots the prior version to `.snapshots/` first). Read-before-write any slug you overwrite so you preserve material that the new raws didn't cover. (`PATCH` on `20_wiki/<slug>.md` only supports `mode: "append"` / `"prepend"` — there is no `replace` mode.)
6. **Append `20_wiki/_index.md`** with one bullet per newly created or modified wiki note (`PATCH mode: "append"`). Skip notes that were unchanged.
7. **Append `log.md`** with one operational line summarising the run: `[<ISO>] wiki.compile (<mode>): compiled <N> notes from <M> raws — added <A>, updated <B>, unchanged <C>`.

## Canonical curl shapes

The `wiki-vault-rules` skill has the full reference. The shapes you'll use most:

```bash
# 1) Enumerate (and incremental-filter) raw notes since the last compile
curl http://localhost:8321/api/wiki/{{workspace_name}}/index \
  -H 'x-process-key: wiki.compile' \
  | jq -r --arg since '<YYYY-MM-DDTHH:MM:SSZ>' \
      '.files[] | select(.path | startswith("10_raw/")) | select(.mtime > $since) | .path'

# 2) Read one file (raw, wiki, taxonomy, index, log — same shape)
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/<path> \
  -H 'x-process-key: wiki.compile'

# 3) Write a wiki note — heredoc for multi-KB bodies (recommended)
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/20_wiki/<slug>.md \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.compile' \
  -d @- <<'JSON'
{"content":"---\ntitle: <Title>\nsources:\n  - 10_raw/<slug-a>.md\n  - 10_raw/<slug-b>.md\ncompiled_at: 2026-05-13\nprocess: wiki.compile\n---\n\n# <Title>\n\n## Summary\n\n...\n\n## Source extracts\n\n...\n"}
JSON

# 4) Append an entry to the index / log
curl http://localhost:8321/api/wiki/{{workspace_name}}/files/20_wiki/_index.md \
  -X PATCH \
  -H 'content-type: application/json' \
  -H 'x-process-key: wiki.compile' \
  -d '{"mode":"append","content":"- [[<slug>]] — <one-line summary>\n"}'
```

Inside `<<'JSON'` (single-quoted marker) the body is verbatim — only JSON's own escapes (`\"`, `\\`, `\n`) apply.

## Anti-patterns (silent denials — never claim success after these)

- `Write` / `Edit` tools — **stripped from the session allow-list** for every `wiki.*` process key. The SDK denies them silently under `dontAsk` ("Permission to use Write has been denied …"). There is no path-rewrite that makes them work; use the Wiki API via curl. The agent that hit "Write denied → reported failure" is the canonical failure mode this section exists to prevent.
- `Bash(find ...)`, `Bash(ls ...)`, `Bash(cat ...)`, `Bash(grep ...)`, `Bash(wc ...)`, and every other shell utility — silently denied. Only `Bash(curl *)` and `Bash(jq *)` are on the allow-list. Enumerate via `GET /api/wiki/<ws>/index`, not from disk.
- `echo '{...}' | curl ...`, `cat <<JSON | curl ... -d @- JSON`, `bash -c "curl ..."`, `( curl ... )`, `var=... curl ...`, `curl ... ; curl ...` — Bash command does not start with `curl`; silently denied. The reverse — `curl ... -d @- <<'JSON' … JSON` on the same line — DOES start with `curl` and IS allowed (the heredoc redirects into curl's stdin).
- `curl ... -d @/some/path` — `@<filepath>` is blocked by the security hook and the shim. The only acceptable `@…` value is the literal stdin marker `@-`.
- `curl http://example.com/...` (non-loopback) — only `http://localhost:8321/api/*` is permitted.
- POST to a non-existent path (`/api/send-message`, `/api/notify-user`, `/api/dm`, etc.) — not daemon routes; calls return 401/404 and DO NOT notify anyone. Your completion DM (final assistant text) is what the daemon forwards.
- Assuming POST to `/api/wiki/.../20_wiki/<slug>.md` is create-only — it is NOT. Re-POSTing to an existing `20_wiki/<slug>.md` overwrites it in place (with a `.snapshots/` backup first); the `wiki` layer has no create-only guard. The `409 append_only` guard only fires for the `10_raw/` and `log.md` layers. There is no `PATCH mode: "replace"` — PATCH only supports `append` / `prepend`.

## Common error codes

| Status | Body code | Cause | Recovery |
|---|---|---|---|
| 400 | `invalid_body` | JSON body did not parse / `content` not a string | Switch to the heredoc shape if you were inline-escaping a multi-KB body. |
| 400 | `invalid_path` / `invalid_layer` | Slug shape or layer prefix rejected | Path must be exactly `20_wiki/<slug>.md`. Slug matches `^[a-z0-9][a-z0-9-]*$`. |
| 403 | `missing_process_key` | Header missing | Add `-H 'x-process-key: wiki.compile'`. |
| 403 | `wiki_write_denied` | Trying to write outside `20_wiki/` (or the `_index.md` / `log.md` exceptions) under `wiki.compile` | Fix the target path. Use `wiki-graduate` for inbox-to-wiki promotion (same process key, different source layer). |
| 409 | `append_only` | POST to an existing `10_raw/` file or `log.md` (those two layers are create-only). Does NOT apply to `20_wiki/<slug>.md` — re-POSTing there overwrites in place. | For `log.md` use `PATCH mode: "append"`. `10_raw/` files cannot be overwritten by design. |
| 413 | — | Body exceeds 512 KB | Split the note or trim verbatim extracts. |
| 5xx | — | Daemon error | Append a failure line to `log.md`, classify the run as partial, do not retry inside the same turn. |

If a Bash call returns with no stdout body and no `PA_API_ERROR` on stderr, your command was silently denied — rewrite it as a flat, single-line curl invocation.

## Completion message (mandatory final assistant text)

End the turn with one short line — the daemon forwards it verbatim to the channel the bang command came from. Keep it scannable on mobile:

- Success: `Compiled <N> wiki page(s) from <M> raw note(s) — added <A>, updated <B>, unchanged <C>.`
- Partial: `Compiled with warnings — <one-sentence diagnostic>. See log.md for details.`
- Failure: `Compile failed — <one-sentence reason>.`

Do not paste the file list, narrative, or follow-up suggestions into the completion message — the dashboard timeline + `log.md` carry the detail. Do not call `/api/send-message` or any other "send" endpoint; the final assistant text is the delivery channel.
