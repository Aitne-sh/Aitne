---
schema_version: 1
slug: features/wiki/search
title: Wiki Search and Index
id: wiki-search
aliases:
  - wiki search
  - wiki fts
  - wiki full text search
  - _index.md
  - wiki index
  - how ask searches
  - how trace finds sources
category: features
summary: |
  How `!ask`, `!trace`, and `!connect` find content inside a wiki. The
  workspace exposes two search surfaces — the LLM-maintained
  `20_wiki/_index.md` catalogue and a content-less FTS5 virtual table
  (`fts_wiki`) the daemon syncs on every write. Both are read-only
  consumers; only `!compile` writes the catalogue.
section: wiki
tags:
  - wiki
  - knowledge
status: stable
ask_examples:
  - How does !ask find the right wiki pages?
  - What is _index.md and who writes it?
  - How does the wiki search work internally?
  - Can I search the wiki from the dashboard?
  - Why didn't !ask find my recent ingest?
  - Does the wiki search Japanese / CJK content?
  - How do I rebuild the wiki search index?
  - What is fts_wiki?
locale: en-US
created: 2026-05-21
updated: 2026-07-01
keywords:
  - wiki search
  - fts_wiki
  - FTS5
  - content-less FTS
  - unicode61
  - tokenizer
  - _index.md
  - index catalogue
  - wiki layer
  - layer classifier
  - reindex
  - backfillWikiFulltext
  - workspace_id
  - layer prefix
  - !ask retrieval
related:
  - features/wiki/overview
  - features/wiki/commands
  - features/wiki/workspaces
  - features/wiki/dashboard
ui_anchors:
  - /wiki
  - /wiki/timeline
api_endpoints:
  - /api/wiki/:workspace/search
  - /api/wiki/:workspace/index
  - /api/wiki/:workspace/reindex
process_keys:
  - wiki.ask
  - wiki.trace
  - wiki.connect
  - wiki.compile
  - wiki.lint
context_files:
  - knowledge/wiki
---

# Wiki Search and Index

The wiki exposes two read paths the skills use to find content:

1. **`20_wiki/_index.md`** — the LLM-maintained catalogue of pages.
   A short, human-readable list with one bullet per wiki page, kept
   current by every `!compile` run. Good for "give me the lay of the
   land" queries.
2. **`fts_wiki`** — a full-text search index (a content-less SQLite
   FTS5 virtual table) the daemon syncs on every successful disk
   write. Good for "find any page that mentions X" queries.

Both surfaces are read-only consumers; only `!compile` writes the
catalogue, and only the wiki API write endpoints update `fts_wiki`.

## `_index.md` — the LLM-maintained catalogue

Lives at `20_wiki/_index.md`. The compile skill rewrites it at the
end of every `!compile` run with one bullet per wiki article, each
with a short summary, the source slugs that fed it, and a
`Last touched: <date>`. The dashboard `/wiki` page renders this file
verbatim as the **Index** card.

The catalogue is **not** authoritative — the source of truth is the
on-disk files. If `_index.md` drifts (e.g. references a page that
was renamed), `!lint` flags it under the **drift between
`20_wiki/_index.md` and the files on disk** check and `!compile`
rewrites it on the next pass.

`GET /api/wiki/:workspace/index` returns both the parsed catalogue
and a directory listing the dashboard uses to find the latest
`90_meta/health/<date>.md` for the timeline page.

## `fts_wiki` — content-less FTS5 search

Aitne mirrors every wiki file into a SQLite FTS5 virtual table
named `fts_wiki`. The table is **content-less** — the indexed text
is the file on disk, not a row in another SQL table. This matters:

- The mail FTS pattern (`fts_mail_messages`) uses
  `AFTER INSERT/UPDATE/DELETE` triggers on `mail_messages_index`
  because the source rows live in SQLite.
- Wiki content lives on the filesystem. There's no source table to
  trigger off, so the wiki API write endpoints
  (`POST /api/wiki/:ws/files/:path`, `PATCH /api/wiki/:ws/files/:path`)
  call `upsertWikiFulltextRow` directly after a successful disk write.
  (`deleteWikiFulltextRow` is reached internally — it's how
  `upsertWikiFulltextRow` drops a `log`/`inbox` row from the index.)

The schema (`packages/daemon/src/db/schema.ts`):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_wiki USING fts5(
    workspace_id UNINDEXED,
    path UNINDEXED,
    layer UNINDEXED,
    title,
    body,
    mtime UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);
```

The `unicode61` tokenizer with `remove_diacritics 2` matches the
mail FTS table for consistency. CJK (Chinese, Japanese, Korean)
content is handled by code-point breaking, so searches work across
those scripts and mixed-script wikis.

### Layer prefixes

The path classifier maps each on-disk file to one of six layers:

- `10_raw/...` → `raw`
- `20_wiki/...` → `wiki`
- `30_outputs/...` → `output`
- `90_meta/...` → `meta`
- `log.md` (workspace root) → `log`
- `00_inbox/...` → `inbox`

Only four of these are actually indexed. `upsertWikiFulltextRow`
**drops `log` and `inbox` rows** before insert: `log.md` is an
append-only audit trail and `00_inbox/` is human-only, so indexing
them would bury wiki and raw matches under log noise. So the only
values you ever see in `fts_wiki.layer` are `raw`, `wiki`, `output`,
and `meta`.

Searches can filter by layer to restrict the result set — e.g.
`layer=wiki` for only canonical pages, not raw notes.

### Querying the index

`GET /api/wiki/:workspace/search` is the daemon-internal search
endpoint. The `!ask`, `!trace`, and `!connect` skills call it (via
`curl`) to pull a candidate set of pages before the LLM picks
evidence. The query supports:

- `q` — the search query. Each whitespace-separated token is quoted
  and joined by implicit AND, so a multi-word query narrows the
  result set. (Tokens are quoted to neutralize FTS5's `AND`/`OR`/
  `NOT`/`NEAR` operator vocabulary — typing literally `rust AND go`
  matches those words, it does not parse as a boolean.)
- `layer` — restrict to a single indexed layer (`raw` / `wiki` /
  `output` / `meta`). Unknown values are ignored.
- `limit` — default 20, clamped to the range 1–50.
- `kind` — `fts` (default) queries `fts_wiki`; `grep` is a literal
  case-insensitive substring fallback over the files on disk. When
  an FTS query returns zero hits for a non-empty `q`, the caller gets
  empty FTS results; an **empty** `q` automatically falls back to
  grep so `/search?q=` enumerates the workspace.

Each result row carries `path`, `layer`, `title`, a body `snippet`
(FTS5 `snippet()` output, `<mark>`-wrapped), `mtime` so the caller
can rank by recency, and a BM25 relevance `rank` (lower is better,
`title` weighted above `body`).

There is no dashboard content-search bar today — the FTS surface is
used by the agent, not the user UI. The dashboard timeline
(`/wiki/timeline`) does carry a process-key filter, but that filters
over `log.md` rather than searching content.

## Rebuilding the index

The FTS index can fall out of sync if you edit files in the wiki
root with another tool (e.g. directly editing an external Obsidian
vault). Two recovery paths:

- **Per-workspace reindex** — `POST /api/wiki/:workspace/reindex`
  scans the workspace tree and rebuilds every `fts_wiki` row for
  that workspace. Cheap; runs synchronously.
- **Boot-time backfill** — `backfillWikiFulltext` runs once on
  daemon start when `fts_wiki` is detected as empty for any active
  workspace. This is the recovery path after a clean reinstall or a
  fresh DB.

The reindex never deletes files on disk; it's a pure read-then-write
into the SQL index.

## How `!ask` uses both surfaces

A simplified flow for `!ask <question>`:

1. The skill orients on `_index.md` for the lay of the land, then
   searches and reads relevant `20_wiki/` pages first — running FTS
   queries against `fts_wiki` to find pages that mention the
   question's key terms.
2. It reads `10_raw/` notes only when the wiki pages need source
   verification.
3. The LLM synthesizes an answer from the pages it pulled.
4. The answer is written to
   `30_outputs/<YYYY-MM-DD>-<slug>.md` (the date-prefixed output
   shape the `OUTPUT_RE` path check enforces). The file records the
   question, a short answer, the evidence, source links, and any
   follow-up gaps; if the wiki lacks enough evidence the skill says
   so and lists what is missing.
5. The skill ends the turn with a short plain-prose reply forwarded
   to the channel the command came from, citing pages inline as
   `see [[<slug>]]` and pointing at the full answer file.

`!trace` and `!connect` follow a similar pattern but with
trace-specific (chronological) or connect-specific (cross-domain)
search queries.

## Why no embedding-based search

Aitne's wiki is local-first and keychain-isolated; running embedding
inference adds either a remote API dependency or a heavy local model
— neither of which fits the "your laptop, your data" promise. FTS5
unicode61 covers the common case (find pages by keyword) without a
network round-trip and without a model file. The compile step's
wikilinks + the LLM-maintained `_index.md` carry the semantic
"connect related pages" load.
