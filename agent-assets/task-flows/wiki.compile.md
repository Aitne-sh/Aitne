{context}

## Task: Compile wiki notes

A `!compile` (or approved `!compile full`) landed here. Read `<wiki_command>` for `data.mode` — `"incremental"` (compile only `10_raw/` notes touched since the last compile) or `"full"` (compile every raw). Read `<wiki_workspace>` for the destination workspace.

You succeed if and only if every wiki note you claim to have created came back from the daemon's Wiki API as `{"ok":true,"path":"20_wiki/<slug>.md"}`. The vault is on disk and there is no other path to write it.

### Critical: the only write surface is the Wiki API via `curl`

- `Write` and `Edit` tools are **stripped from this session's allow-list**. The SDK denies them silently under `dontAsk` ("Permission to use Write has been denied …"). They cannot be made to work via path rewriting; do not try.
- `Bash(find ...)`, `Bash(ls ...)`, `Bash(cat ...)`, `Bash(grep ...)`, `Bash(wc ...)` and every other shell utility are also silently denied. Only `Bash(curl *)` and `Bash(jq *)` are on the allow-list. Enumerate raw notes via `GET /api/wiki/<workspace>/index`, NOT by walking `{{vault_path}}` from disk.
- The `Bash(curl *)` allow-rule is prefix-matched against the full command. Wrappers — `echo '{...}' | curl …`, `cat <<JSON | curl …`, `bash -c "curl …"`, `( curl … )`, `var=… curl …`, chained `curl … ; curl …` — are silently denied (no output, no `PA_API_ERROR`). The reverse, `curl … -d @- <<'JSON' … JSON` on the same line, IS allowed because the command still starts with `curl`; the shim reads stdin via `-d @-`.

### Procedure

1. **Baseline (incremental only).** Read `20_wiki/_index.md` (or the most recent `wiki.compile` entry in `log.md`) to recover the prior `compiled_at` ISO timestamp. If the workspace has never been compiled, compile every raw.
2. **Enumerate raw notes** via `GET /api/wiki/<workspace>/index`, then filter with `jq` for `path` under `10_raw/` and (incremental) `mtime > <baseline>`.
3. **Read existing wiki + taxonomy** so synthesis can de-duplicate and use canonical slugs.
4. **For each topic**, synthesize a root-level `20_wiki/<slug>.md` note (one note per coherent topic — merge multiple raws when they cover the same thing). `POST` for a new slug, `PATCH mode: "replace"` for an existing one (read-before-write).
5. **Append `20_wiki/_index.md`** (`PATCH mode: "append"`) with one bullet per added or updated note.
6. **Append `log.md`** (`PATCH mode: "append"`) with one summary line: `[<ISO>] wiki.compile (<mode>): compiled <N> notes from <M> raws — added <A>, updated <B>, unchanged <C>`.

The `wiki-compile` skill carries the canonical curl shapes (including the multi-KB heredoc body shape), the per-error recovery table, and the slug rules. The `wiki-vault-rules` skill carries the body-quoting cheat-sheet and the full layer/endpoint reference.

Do NOT modify `00_inbox/` or existing `10_raw/` notes. Do NOT call `/api/send-message`, `/api/whatsapp/send`, `/api/notify-user`, or any other "send" endpoint — those routes do not exist. Your final assistant text IS the delivery channel; the daemon forwards it to the bang's reply target automatically.

End with the single-line completion DM from the skill (Success / Partial / Failure).
