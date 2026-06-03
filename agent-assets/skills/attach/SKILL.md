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

- **curl with literal strings only.** No `$VAR` / `$(...)` / backticks / pipes / chained commands (`&&`, `||`, `;`, `|`) — the `dontAsk` classifier silently denies them. Pre-compute any value in your reasoning and write it as a literal. The session's curl wrapper (`.pa/bin/curl`) injects `X-Turn-Token` from `PA_TURN_TOKEN` for you — never pass it yourself, and binary/PDF/chart generation (`python3`, `pandoc`, `node`) is out of scope for Phase 1; stick to text formats you can `Write`.

If the turn has already ended (or no token was issued), the daemon returns HTTP 403 `missing_turn_token`. Treat that as a terminal signal, not something to retry.

## API

### POST /api/chat/outbound-attachments

Upload a single file (one call per file). Multipart `file` field, optional `X-Filename` + `X-Caption` headers. The wrapper injects `X-Turn-Token` automatically.

```bash
curl -s -X POST http://localhost:8321/api/chat/outbound-attachments \
  -H "X-Filename: weekly-summary.md" \
  -H "X-Caption: Weekly summary" \
  -F "file=@/tmp/weekly-summary.md"
# → {"id":"<uuid>"}                      HTTP 200 — success
# → 403 — turn token missing/invalid; do not retry (see Errors table)
```

Errors return the standard agent-error envelope `{ok:false,summary,errors:[{code,field,hint}],retryable,error:<code>}`. Branch on the flat `error` field (a legacy alias for the single issue code); the codes in the Errors table are accurate.

| Header / field | Purpose |
|---|---|
| `file` (form field, binary) | The bytes to deliver. Stream from a file you just created with `Write`. |
| `X-Filename` | Optional. Overrides the filename shown to the user. Literal string — no substitutions. Default: the multipart `filename` parameter. |
| `X-Caption` | Optional. ≤ 1024 chars. Literal string — no `$(...)` / backticks. |

> If you *do* pass `X-Turn-Token` explicitly (e.g. during local debugging), the wrapper respects your value and does not overwrite it.

### Size and type limits (Phase 1)

- Images: **≤ 5 MB** (PNG, JPEG, WebP, GIF, HEIC, HEIF, SVG).
- Other files: **≤ 25 MB** (PDF, DOCX/XLSX/PPTX, ODT, TXT, MD, CSV, JSON, YAML, XML, common source types).
- Audio/video: **≤ 25 MB** (AAC, AMR, FLAC, M4A, MP3, MP4 audio, OGG, OPUS, WAV, WebM audio; MP4 video, MPEG, WebM video, QuickTime, 3GP). Accepted as opaque files — staged into the session workdir and named in the prompt, but only image attachments receive native multimodal argv treatment.
- Executables, archives (zip/tar/7z/rar), and unknown binary payloads are rejected.

Per-turn total across all attachments is capped at **100 MB**; the endpoint returns 429/`too_many_uploads` if you issue more than 5 concurrent uploads on the same turn.

## Workflow

1. Decide the filename and caption up front (literal strings — no shell interpolation).
2. Generate the content and write it with the `Write` tool. Write scratch files under `/tmp/<name>` — the session workdir is re-materialized between turns and the context dir is daemon-owned, so `/tmp` avoids collisions.
3. Issue the single curl POST shown above. One file per call.
4. On success (`{"id": "..."}`) mention the attachment in your reply, e.g. `"Attached: weekly-summary.md"` — you may discard the id; the daemon links it automatically. On any error, follow the Errors table below.

Never base-64 embed files into your reply body. Always go through this endpoint.

## Errors

| Response | Cause | What to do |
|---|---|---|
| 403 `missing_turn_token` / `invalid_turn_token` | Turn already ended, or the header was empty at request time | Do not retry. Paste content inline and mention the limitation. |
| 400 `too_large` | File exceeded the per-type cap | Trim / summarize the content before retrying. |
| 400 `disallowed_mime` / `undetected_mime` | Format not on the Phase 1 allowlist | Convert to an allowed format (e.g. table → CSV). |
| 429 `too_many_uploads` | > 5 uploads in flight on this turn | Wait briefly and retry, or batch into fewer files. |
