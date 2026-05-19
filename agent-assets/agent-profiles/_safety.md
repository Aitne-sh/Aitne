## Safety Invariants
- Confirm destructive operations with the user before executing.
- Store no passwords or secrets in any file.
- Execute no financial transactions.
- Auto-post to no social media platforms.
- Do NOT modify `rules/management.md` directly except via the dashboard
  setup wizard. The `## Active Policies` section is auto-maintained by
  the daemon's policy-index reconciler — never edit it by hand; any
  manual change is overwritten on the next reconcile pass.
- Durable management rules captured from conversation belong in
  `rules/policies/<slug>.md`. Use the `management-policy` skill — it
  enforces the read-before-write, similarity-detection, and
  confirmation steps. The skill creates / pauses / resumes the policy
  file and (when applicable) the linked routine; the daemon's
  policy-index reconciler picks the change up and re-renders both
  `rules/policies/_index.md` and `rules/management.md ## Active Policies`
  within ~10 s. Do NOT manually PATCH `_index.md` or the management
  section.
- Day boundary: 04:00 — manage schedules from 04:00 to next 03:59.

- Describe only actions you actually executed. If a tool call returned an error, say it failed. If you did not call the `attach` skill, do not claim to have sent a file. A fabricated success report is a safety violation, not a convenience.

## Common Patterns
- **Read-before-write**: PATCH `mode=replace` replaces the entire section.
  Always GET first, merge your changes into the existing content, then PATCH.
  Prefer `mode=append` when simply adding new entries.
- **One shell call = one operation.** Every shell invocation that hits
  the daemon API MUST be a single, flat `curl …` — never combine
  operations in one call. The following shapes are denied by every
  backend's shell policy:
  - Sequencing — `... ; ...`, `... && ...`, `... || ...`
  - Pipe — `curl … | jq …`, `curl … | head`, `curl … | tee …`,
    even a single `|`. This includes the very natural-looking
    `curl http://localhost:8321/api/foo | jq .x` — denied.
  - Subshell / command substitution — `$(...)`, `` `…` ``
  - Wrapper-led — starts with `echo`, `cat`, `bash -c`, `sh -c`,
    `(`, or a variable assignment like `VAR=val curl …`
  - Multi-target — `curl URL1 URL2 …`, `curl … --next …` / `-:`
  When you need to consume a response, parse the JSON body in your own
  response text — do NOT pipe it to `jq` / `sed` / `awk` / `grep`.
  When you need multiple HTTP calls, issue them as **separate** shell
  invocations. When you need a large body, use the heredoc-into-curl
  shape documented below — `curl … -d @- <<'JSON' … JSON` keeps the
  command starting with `curl` (do NOT pipe from `cat <<JSON | curl …`,
  which starts with `cat` and is denied).
- **The shell surface is intentionally narrow.** Each backend's policy
  permits only `curl http://localhost:${port}/...` and `git …` (no
  `push --force`, `reset --hard`, `clean`). Common utilities — `jq`,
  `sed`, `awk`, `tee`, `echo`, `cat`, `head`, `tail`, `grep`, `find`,
  `ls`, `wc`, `xargs` — are NOT on the shell allow-list. Use the
  daemon API's structured query params (`?fields=`, `?limit=`,
  `?since=`, `?folder=`, …) or your backend's built-in read tools
  (Claude: `Read` / `Grep` / `Glob`; Gemini: `read_file` /
  `grep_search` / `list_directory` / `glob`) instead of trying to
  filter shell output.
- **How a denial surfaces, by backend** — recognise the shape so you
  rewrite and retry instead of looping on it:
  - **Claude Code** — `Bash` PreToolUse hook. Chained-curl / `--next` /
    multi-URL / wrapper shapes return a visible block decision with a
    reason string. Tools or commands that aren't in the session's
    `Bash(curl *)` allow-list under `dontAsk` are silently denied (no
    stdout, no stderr, no `PA_API_ERROR`) — if a `Bash` call returns
    NOTHING at all, your command was denied; rewrite to a single flat
    `curl …` starting with the literal `curl` token.
  - **Gemini CLI** — `run_shell_command` denial returns a visible
    error of the form `Error executing tool run_shell_command: Tool
    execution denied by policy. <reason>` and ends the turn as a
    decisive failure (no retry, no fallback on resume — the chat just
    fails). Same fix: rewrite as a single flat `curl …` (no `|`, no
    `;`, no `&&`, no `$(…)`, no `jq`/`sed`/`awk`) and try again.
- **Daemon-API body submission** (`curl -d` on `/api/context/*`,
  `/api/observations`, `/api/schedule`, etc.). Two safe shapes:
  - Inline JSON — `-d '{"key":"value"}'`. Use for small / single-line
    bodies. Escape internal newlines as `\n`.
  - Stdin heredoc on the SAME curl line — `curl ... -d @- <<'JSON'`
    + body + `JSON`. The heredoc is redirected into `curl`'s stdin so
    the command still STARTS with `curl`; do NOT pipe from
    `cat <<JSON | curl …` (that starts with `cat` and is denied).
    `@-` is curl's stdin marker (a literal two-character token),
    distinct from the file-read forms below.

  Never use `-d @<filepath>` / `--data-raw '@<filepath>'` /
  `-F field=@<filepath>`. They are file-read shapes — safe mode
  hook-blocks them, and a request that slips through sends the literal
  `@/path/...` text as the body, which the daemon rejects with
  `invalid_json_body`. There is no agent-facing reason to read a body
  off the filesystem; pipe stdin via `@-` instead.
