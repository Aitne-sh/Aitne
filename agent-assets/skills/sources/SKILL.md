---
name: sources
description: Load to manage the durable source library (user-sent PDFs/PPTX/docs) — list unfiled sources, file them as knowledge/sources/ cards, promote images, or send a stored source back. SKIP for delivering files you generated this turn (attach) or general vault edits (context).
allowed-tools:
  - Bash(curl *)
  - Read
  - Write
---

# Source library

Document attachments the user sends (PDF, PPTX, DOCX, XLSX, ODT) are captured automatically into a durable library the moment they arrive — they survive chat pruning. Each source is a ledger row (`src_…` id) plus the original bytes. Your job is the *organization* layer: write a markdown **card** for each source under `knowledge/sources/<collection>/`, link it to projects, and keep the collections tidy.

- **curl with literal strings only.** No `$VAR` / `$(...)` / pipes / chained commands — pre-compute values and write literals.
- Cards are written via the `context` API (this skill shows the calls); the library API below only records metadata and bindings.

## API (all on `http://localhost:8321`)

| Verb | Purpose |
|---|---|
| `GET /api/sources?status=unfiled` | List sources awaiting filing (also `filed`, `archived`; `limit`/`offset`). |
| `GET /api/sources/<id>` | One source's metadata (filename, mime, size, caption, provenance, cardPath). |
| `GET /api/sources/<id>/file` | The original bytes. Save to the workdir: `curl -s -o ./src-deck.pdf http://localhost:8321/api/sources/<id>/file` |
| `POST /api/sources/promote` | Capture a chat attachment the auto-capture skipped (images, audio): `{"attachmentId":"<uuid>","caption":"…"}`. Returns the `src_…` id (`deduped:true` if already stored). |
| `PATCH /api/sources/<id>` | Record the filing: `{"cardPath":"knowledge/sources/<collection>/<slug>.md"}` (implies `status:"filed"`). Also `{"status":"archived"}` for junk, `{"caption":"…"}`. |
| `POST /api/sources/<id>/export` | Copy the original binary into the user's external Obsidian vault: `{"target":"obsidian"}`. Lands at `sources/<file>` with a companion note embedding it (`{"note":false}` to skip). 409 if no external vault is configured. For **Notion**, there is no binary path — create a page from the card markdown via `POST /api/notion/pages` instead. |

Errors use the standard agent-error envelope; `404 sources.not_found` means a stale id — re-list. Never DELETE a source; archive instead (deletion is owner-only).

## Filing a source (the core loop)

1. `GET /api/sources?status=unfiled` — pick a source.
2. Understand it. PDFs: fetch the bytes to the workdir and `Read` the file directly. PPTX/DOCX: best-effort text peek without new tools, e.g. `unzip -p ./src-deck.pptx ppt/slides/slide1.xml` (a .pptx is a zip of XML; strip tags mentally). Often the filename + caption suffice.
3. Choose a collection per the taxonomy below (create a new one only when nothing fits).
4. Write the card:

```bash
curl -s -X PUT http://localhost:8321/api/context/knowledge/sources/acme-launch/pitch-deck.md \
  -H "Content-Type: application/json" \
  -d '{"content":"---\ntype: source\nowner: agent\nupdated: 2026-07-01\nsource_id: src_1234\nmime: application/pdf\nreceived: 2026-07-01\nprovenance: user_telegram\n---\n# Acme launch pitch deck\n\nOne-paragraph summary of what the document contains and why the user sent it.\n\nProject: [[acme-launch]]\n"}'
```

5. Bind it: `curl -s -X PATCH http://localhost:8321/api/sources/src_1234 -H "Content-Type: application/json" -d '{"cardPath":"knowledge/sources/acme-launch/pitch-deck.md"}'`
6. If the source belongs to a project, add a `- [[knowledge/sources/acme-launch/pitch-deck|Pitch deck]]` line under a `## Sources` heading in `plans/projects/<slug>.md` (PATCH, append mode).
7. Keep `knowledge/sources/_index.md` current: one line per collection with a one-phrase scope.

## Reorganizing

Move a card = PUT the card at the new path, DELETE the old path (`curl -X DELETE http://localhost:8321/api/context/knowledge/sources/old/card.md`), then PATCH the source's `cardPath`. Deletes are snapshotted — recoverable. Merge singleton collections into broader ones; split collections past ~15 cards.

## Sending a source back to the user

Fetch the bytes to the workdir, then deliver through the outbound endpoint (see the `attach` skill for limits):

```bash
curl -s -o ./src-deck.pdf http://localhost:8321/api/sources/src_1234/file
curl -s -X POST http://localhost:8321/api/chat/outbound-attachments \
  -H "X-Filename: pitch-deck.pdf" -F "file=@./src-deck.pdf"
```

## Collection taxonomy (auto-curated)

<!-- CURATION:knowledge_layout id="source-collections" -->

## Filing conventions (auto-curated)

<!-- CURATION:convention_notes id="filing-rules" -->
