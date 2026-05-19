---
name: attach
description: Load when the reply should embed a file (generated md/PDF/CSV, chart image, modified upload) — `Write` to disk alone is not delivery.
allowed-tools:
  - Bash(curl *)
  - Write
---

# Attach files to your reply

You can deliver files alongside your reply by uploading them to the daemon's outbound-attachment endpoint. The daemon collects everything tagged with the current turn's token, pins it to the assistant message it is about to record, and hands the file refs to the originating adapter (dashboard in Phase 1) so the user sees it in the same chat thread.

## When to use

- User asks for a chart/graph, PDF export, CSV dump, text file, or an image you produced this turn.
- A file is meaningfully better than a large inline paste (e.g. several-page report).
- User uploaded a file and asks for a modified / summarized version in return.

Do NOT use this for trivial text that fits in a chat reply — pasting inline is faster and easier to skim.

## Tools you may use (enforced allowlist)

Only the following tools are available inside this skill. Everything else is denied silently in `dontAsk` mode — do not try alternatives, pipes, or shell helpers.

| Tool | Purpose |
|---|---|
| `Write` | Create the file to upload (text, markdown, CSV, JSON, YAML). |
| `Bash(curl *)` | Issue exactly one POST to the daemon per file. |

### Commands that WILL be denied — do not attempt

The Claude Code permission classifier blocks these patterns under `dontAsk`. Attempting them wastes a turn and confuses the user.

- **Any shell expansion of an environment variable**: `$PA_TURN_TOKEN`, `$HOME`, `$(date +%Y)`, `` `whoami` `` — all auto-denied. This is why the turn token is injected by the daemon's curl wrapper instead of being passed inline (see below).
- `ls /tmp/...` / `ls <absolute-path>` — absolute-path listings are auto-denied.
- `cat <file>`, `head`, `tail`, `stat`, `file`, `test -f`, `echo <anything>` — none are on the allowlist.
- Chained commands via `&&`, `||`, `;`, `|` — each segment is evaluated separately; any segment outside the allowlist fails the whole line.
- `python3 ...`, `pandoc`, `node <script>`, `sh -c`, etc. — not on the allowlist. Binary/PDF/chart generation is out of scope for Phase 1; stick to text formats you can `Write`.

If you *think* you need one of the above, the answer is to pre-compute the value in your reasoning, write it as a literal, and invoke curl once with no substitutions.

## Per-turn capability token

The daemon issues a per-turn token and makes the session's curl wrapper (`.pa/bin/curl`) attach it automatically to requests to `/api/chat/outbound-attachments`. **Do not pass `X-Turn-Token` yourself** — inline `$PA_TURN_TOKEN` expansion is blocked by the permission classifier, and the wrapper already handles this for you.

If the turn has already ended (or no token was issued), the daemon returns HTTP 403 `missing_turn_token`. Treat that as a terminal signal, not something to retry.

## API

### POST /api/chat/outbound-attachments

Upload a single file (one call per file). Multipart `file` field, optional `X-Filename` + `X-Caption` headers. The wrapper injects `X-Turn-Token` automatically.

```bash
curl -s -X POST http://localhost:8321/api/chat/outbound-attachments \
  -H "X-Filename: weekly-summary.md" \
  -H "X-Caption: Weekly summary" \
  -F "file=@/tmp/weekly-summary.md"
# → {"id":"<uuid>"}                      on success
# → {"error":"missing_turn_token"}       HTTP 403
# → {"error":"invalid_turn_token"}       HTTP 403
# → {"error":"too_large"}                HTTP 400
# → {"error":"disallowed_mime"}          HTTP 400
# → {"error":"too_many_uploads"}         HTTP 429
```

| Header / field | Purpose |
|---|---|
| `file` (form field, binary) | The bytes to deliver. Stream from a file you just created with `Write`. |
| `X-Filename` | Optional. Overrides the filename shown to the user. Literal string — no substitutions. Default: the multipart `filename` parameter. |
| `X-Caption` | Optional. ≤ 1024 chars. Literal string — no `$(...)` / backticks. |

> The wrapper silently adds `X-Turn-Token` from `PA_TURN_TOKEN`. Do not add it yourself. If you *do* pass `X-Turn-Token` explicitly (e.g. during local debugging), the wrapper will respect your value and not overwrite it.

### Size and type limits (Phase 1)

- Images: **≤ 5 MB** (PNG, JPEG, WebP, GIF, HEIC, SVG).
- Other files: **≤ 25 MB** (PDF, DOCX/XLSX/PPTX, ODT, TXT, MD, CSV, JSON, YAML, XML, common source types).
- **Audio/video** uploads are rejected — Phase 3 work.
- Executables, archives (zip/tar/7z/rar), and unknown binary payloads are rejected.

Per-turn total across all attachments is capped at **100 MB**; the endpoint returns 429/`too_many_uploads` if you issue more than 5 concurrent uploads on the same turn.

## Workflow

1. Decide the filename and caption up front (literal strings — no shell interpolation).
2. Generate the content and write it with the `Write` tool. Use `/tmp/<name>` as the path only — every other path (`~/`, session workdir, context dir, `/var/`, `/Users/...`) is denied by the absolute-block layer (`packages/daemon/src/safety/always-disallowed.ts`). Never write into the session workdir or the context dir.
3. Issue the single curl POST shown above. One file per call.
4. Branch on the response:
   - Success (`{"id": "..."}`) — mention the attachment in your reply, e.g. `"Attached: weekly-summary.md"`. You may discard the id; the daemon links it to your message automatically.
   - HTTP 403 (`missing_turn_token` / `invalid_turn_token`) — the turn has already been released or the skill was invoked outside a turn. Do not retry. Fall back to inline paste and tell the user the attachment could not be sent.
   - Other errors — follow the table below.

Never base-64 embed files into your reply body. Always go through this endpoint.

## Errors

| Response | Cause | What to do |
|---|---|---|
| 403 `missing_turn_token` / `invalid_turn_token` | Turn already ended, or the header was empty at request time | Do not retry. Paste content inline and mention the limitation. |
| 400 `too_large` | File exceeded the per-type cap | Trim / summarize the content before retrying. |
| 400 `disallowed_mime` / `undetected_mime` | Format not on the Phase 1 allowlist | Convert to an allowed format (e.g. table → CSV). |
| 429 `too_many_uploads` | > 5 uploads in flight on this turn | Wait briefly and retry, or batch into fewer files. |
