---
name: reading
description: Load when the user mentions a book or highlight, weekly/monthly reviews need reading progress, or routines need to refresh the reading-taste profile (`identity/reading-taste.md`) and propose new book candidates. Owns the taste-profile schema and recommendation rules.
allowed-tools:
  - Bash(curl *)
  - Read
---

# Reading & Highlights Tracker

<output_language>english_only — `reading-taste.md` is parsed by display logic; field values and bullet text in that file are Policy A and override `<output_language_policy>`. Other user-facing prose from this skill (e.g. weekly recommendation DMs) follows `<output_language_policy>`.</output_language>

The daemon stores books and reading highlights imported from Kindle
(My Clippings.txt and the "Export Notebook" email pipeline) and manual
entries. Data lives in `books` and `reading_highlights` tables.

## When to Use

- **Monthly review**: generate reading report with books completed,
  highlight counts, and reading pace.
- **Weekly review** (Phase 5, routine.weekly_review.md): refresh the
  reading-taste profile and propose book recommendations.
- **User asks about a book**: query highlights and notes.
- **User asks about reading history**: list books by status.
- **Morning routine**: mention currently reading books (if user has active books).

## Workflow

1. Fetch books list with status and highlight counts.
2. For specific book queries, fetch highlights.
3. For reports, use the summary endpoint.

## Roadmap candidate signal

When a book / article request is **goal-shaped**, queue a
`roadmap_candidate:reading` observation so the next roadmap refresh can
land it in `## Long-term Plans` or `## Agent Action Plan`.

Goal-shaped means the user expresses both a reading/learning objective
and a future horizon or commitment. Examples:
- "I want to read Designing Data-Intensive Applications before Q3."
- "Learn Rust from this list this summer."
- "Finish the ML papers before the September course starts."

Do **not** queue a roadmap candidate for taste, preference, or finished
reading notes without a future objective:
- "I enjoyed Deep Work."
- "Recommend me books like this."
- "Add this article to my reading list" with no deadline or horizon.

Record the signal with a stable reading-list/book/article ref:

```bash
curl -s -X POST http://localhost:8321/api/observations \
  -H 'Content-Type: application/json' \
  -d '{"source":"roadmap_candidate:reading","ref":"reading-goal-ddia-2026-q3","changeType":"created","actor":"agent","payload":{"kind":"reading_goal","horizon_tag":"2026-Q3","intent":"Finish Designing Data-Intensive Applications"}}'
```

Payload contract:
- `kind`: `"reading_goal"`
- `horizon_tag`: roadmap horizon tag (`YYYY-MM`, `YYYY-Qn`,
  `YYYY spring|summer|autumn|winter`, or `undated` when the user gave
  no date but clearly stated a future learning goal)
- `intent`: concise human-readable goal, suitable for a Long-term Plan
  line with `Source: reading`

---

## API Reference

Base URL: `http://localhost:8321`

### GET /api/books

List books with optional filters.

```bash
# Currently reading
curl -s "http://localhost:8321/api/books?status=reading"

# All completed books (first page)
curl -s "http://localhost:8321/api/books?status=completed&limit=50"

# Walk past the 200-row cap via offset
curl -s "http://localhost:8321/api/books?limit=200&offset=200"
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | all | reading, completed, abandoned, all |
| `source` | string | all | kindle, audible, manual, all |
| `limit` | number | 50 | Page size (1–200) |
| `offset` | number | 0 | Rows to skip. Use with `limit` to paginate beyond the 200 cap |

Response: `{ books: [...], total, limit, offset, hasMore }`. Each
book carries `id`, `title`, `author`, `source`, `status`, `rating`,
`highlightCount` (plus `startedAt`/`completedAt`/`notes`/`createdAt`).

When iterating the entire library, keep calling with `offset += limit`
until `hasMore === false`.

### GET /api/books/:id/highlights

Get highlights for a specific book.

```bash
curl -s "http://localhost:8321/api/books/1/highlights?limit=50"
```

### GET /api/books/summary

Reading statistics.

```bash
curl -s "http://localhost:8321/api/books/summary?months=12"
```

Response: `{ byStatus: [{status, count}], monthlyCompleted:
[{month, count}], totalHighlights }`.

### PATCH /api/books/:id

Update book status, rating, or notes.

**Approve tier (Bearer required).** This is an operator/dashboard-gated
write — an autonomous agent curl from a session workdir carries no
`Authorization: Bearer` header and will be rejected with **401** before
the handler runs. Do NOT call this autonomously and do NOT assume the
update landed; book status/rating/notes corrections are made by the user
via the dashboard. (Body shape, for reference: `status` enum
`reading|completed|abandoned`, `rating` 1-5, `notes`.)

```bash
# Operator/dashboard-only — requires Authorization: Bearer (Approve tier).
curl -s -X PATCH "http://localhost:8321/api/books/1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <operator-token>" \
  -d '{"status": "completed", "rating": 4}'
```

### POST /api/books/import-clippings

Import Kindle My Clippings.txt.

```bash
curl -s -X POST "http://localhost:8321/api/books/import-clippings" \
  -H "Content-Type: application/json" \
  -d "{\"data\": \"$(cat 'My Clippings.txt')\"}"
```

---

## Formatting Guide

### Monthly review

```
## Reading Report (April 2026)
Books completed: 2
Currently reading: 3
New highlights: 34

### Completed This Month
1. "Deep Work" by Cal Newport — rating: 5/5
2. "Atomic Habits" by James Clear — rating: 4/5

### Currently Reading
- "Thinking, Fast and Slow" by Daniel Kahneman (47 highlights)
- "The Design of Everyday Things" by Don Norman (12 highlights)
```

---

## Reading Taste Profile (`identity/reading-taste.md`)

{{> ref:reading-taste }}
