---
kind: reference
parent_skill: reading
---

This file captures what the user reads and *why* — topics they return to,
how they think, values that keep surfacing in their highlights, and a
rolling list of candidate books. It is dictionary-like (same layer as
other `identity/*.md` files) and is consumed on-demand — never injected
into every session. Do not notify the user about taste updates.

### When to refresh

- **Weekly review, Phase 5**: required sweep (see task flow).
- **On-demand**: if the user asks "what do my highlights say about me?"
  or "recommend a book based on what I've read".
- **After a book is marked `completed`** with rating ≥ 4: one-shot refresh
  biased to that book's highlights.

**Do not refresh** if fewer than 10 new highlights have accrued since the
last sweep. A low-signal pass produces noise — prefer silence.

### Refresh-trigger check (how to compute the delta reliably)

The file carries a dedicated frontmatter line `Highlights at last sweep: N`
holding the `totalHighlights` value from `GET /api/books/summary` at the
time of the last successful write. To decide whether to refresh:

1. `GET /api/context/identity/reading-taste` — if 404, treat as
   `N = 0` and proceed (first sweep).
2. `GET /api/books/summary` — read `totalHighlights` as `M`.
3. If `M - N < 10`, skip the sweep (log one bullet under agent-journal
   "What worked": `reading sweep skipped — only (M-N) new highlights`).
4. Otherwise, run the workflow. The new `M` becomes the `Highlights at
   last sweep` value written on this sweep.

Do **not** compare the `Sampled: X highlights` line — `X` is the
sample size the agent read, not a count of highlights in the DB.

### Sampling strategy

You are working with potentially hundreds of highlights. Do not read them
all. Use this sampling recipe:

1. `GET /api/books?status=reading&limit=20` and
   `GET /api/books?status=completed&limit=20` (most recently touched first).
2. Pick up to 8 books: all currently-reading, plus the most recent
   completed books to fill the slot.
3. For each book: `GET /api/books/:id/highlights?limit=12`. The endpoint
   sorts by `highlighted_at DESC` — for Kindle imports this is **when the
   user highlighted on device**, not when the daemon ingested the email.
   That means the 12-entry sample is representative of what the user
   latched onto in a book, NOT a freshness-ordered activity feed. Treat
   it as a broad taste sample, not a "last week" view.
4. When sampling a book with >50 highlights total, you are viewing a
   dozen out of many. Note this in the "Sampled" line of the file —
   don't claim exhaustive coverage of a 200-highlight book.

The refresh-trigger check (previous section) uses `totalHighlights` from
`/api/books/summary` and is insensitive to `highlighted_at`; it detects
"new highlights exist in the DB" regardless of their on-device date.

### Required file schema

First refresh writes the whole file via `PUT /api/context/identity/reading-taste`.
Subsequent refreshes use `PATCH` per section (but the metadata lines must
be updated via a full-file `PUT`). Required structure:

```markdown
---
type: user
owner: shared
updated: YYYY-MM-DD
---
# Reading Taste
> Last updated: YYYY-MM-DD HH:MM
> Sampled: N highlights across M books (window: last K weeks)
> Highlights at last sweep: T   <!-- total in DB from /books/summary, used for delta check -->

## Topics of Interest
- 3–6 bullets. Concrete topics, not categories: "cognitive biases in
  decision-making" not "psychology". Each bullet: one line.

## Thinking Patterns
- 3–5 bullets. How the user processes ideas, inferred from what they
  highlight — e.g. "highlights counter-intuitive claims with supporting
  evidence", "prefers concrete cases over abstractions", "marks passages
  that challenge common wisdom".

## Values & Recurring Questions
- 3–5 bullets. Values or open questions the highlights keep returning
  to — e.g. "tension between productivity and depth", "skepticism of
  institutional incentives", "what makes work meaningful".

## Preferred Formats
- 1–3 bullets. Observed preferences: narrative nonfiction, research-heavy,
  essay collections, short-form, etc. State only what the sample supports.

## Book Candidates
- 5–10 bullets. Rolling list of books the user might enjoy, written by
  you based on the sampled highlights. Format each as:
  `- <Title> — <Author>. Why: <1 sentence tying it to a specific pattern
    above>.`
  Do not repeat books already in `books` (any status). Prefer ≤2 per author.
  Replace the full list each weekly sweep (append-style drift produces
  stale duplicates).
```

### Rules for the taste profile

- **Stay grounded in sampled highlights.** Every claim in Topics / Thinking
  Patterns / Values should be traceable to specific passages you read.
  When writing, mentally annotate each bullet with the highlight(s) that
  justify it — if you cannot, drop the bullet.
- **No moralizing or judgement.** Record what the user is drawn to, not
  whether those interests are "good". Avoid adjectives that evaluate the
  user ("enlightened", "shallow").
- **Avoid one-shot artifacts.** A single standout highlight isn't a
  pattern. Look for themes across ≥2 books before recording.
- **Language: English only.** Per project convention — even if the source
  highlights are in another language, summarize in English.
- **Silent update.** Never notify the user about taste-profile changes.

### PATCH patterns

Replace a single section (snake_case the heading):

```bash
curl -s -X PATCH http://localhost:8321/api/context/identity/reading-taste \
  -H 'Content-Type: application/json' \
  -d '{"section": "topics_of_interest", "mode": "replace", "content": "- cognitive biases\n- systems design"}'
```

Replace the full file (first time, or after a major reset):

```bash
curl -s -X PUT http://localhost:8321/api/context/identity/reading-taste \
  -H 'Content-Type: application/json' \
  -d '{"content": "---\ntype: user\nowner: shared\nupdated: 2026-04-21\n---\n# Reading Taste\n> Last updated: 2026-04-16 09:00\n> Sampled: 87 highlights across 8 books (window: last 12 weeks)\n> Highlights at last sweep: 245\n\n## Topics of Interest\n- ...\n..."}'
```

Update both the `Last updated` line and the `Highlights at last sweep`
line on every refresh. Section-level `PATCH` does not touch the top
metadata — if only sections changed, still issue one `PUT` at the end of
the sweep to write the refreshed metadata and YAML `updated` date.

### First-write registration (_index.md)

The `identity/_index.md` file indexes available topic files. When
creating `reading-taste.md` for the first time (GET returned 404),
append a one-line entry to the index so other flows can discover it:

```bash
curl -s -X PATCH http://localhost:8321/api/context/identity/_index \
  -H 'Content-Type: application/json' \
  -d '{"section": "topics", "mode": "append", "content": "- reading-taste — derived taste profile + rolling book candidates (updated weekly)"}'
```

The section name (`topics` above) depends on the existing `_index.md`
shape; fetch it first and append under the most natural heading. Do
NOT overwrite existing index content.

---

## Book Recommendations

The weekly sweep writes recommendations into the `Book Candidates`
section of `reading-taste.md` (see above). Do **not** create a separate
`recommendations.md` — the candidate list belongs with the taste it was
derived from.

### How to propose candidates

- Use your own book knowledge keyed by the sampled highlights. This is
  reasoning from the user's demonstrated taste, not a lookup — no
  external API.
- Avoid recommending books already in the `books` table (any status).
  Fetch the existing library once before writing the final list. For
  libraries larger than 200 books, paginate with
  `?limit=200&offset=0`, `&offset=200`, … until `hasMore === false`,
  and merge the titles into a single exclusion set.
- Tie each recommendation to a specific pattern from Topics / Thinking /
  Values. A recommendation with no pattern-justification is a generic
  suggestion and should be dropped.
- Prefer books the user is likely unaware of — not the usual-suspects
  that trend on social media.

### Weekly user-facing hint (optional)

If the silent gate in Phase 4 of the weekly review does **not** trigger
and the taste file gained ≥1 genuinely new candidate this sweep, you
MAY add a single optional line to the weekly notification in the form:
`Reading pick: <Title> — <1-clause why>.`

Do not force a line just because recommendations were updated. The
silent-default principle applies: omit if the pick would feel like
filler.
