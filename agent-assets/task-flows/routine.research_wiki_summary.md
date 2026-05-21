{context}

## Task: Compose a wiki-style note for one accepted cluster

The owner typed `!research wiki <slug>`. The daemon has cleared the
pending offer and enqueued this session at medium tier (Sonnet). You
read the cluster journal you (or a prior session) already wrote, plus
the structured delta, and compose a wiki note in the user's
`primaryLanguage`.

Follow the `browser-history` skill, "Flow: routine.research_wiki_summary".

1. Read `context/research/<slug>.md` via `GET /api/context/research/<slug>.md`.
   This is the source-of-truth for prior agent observations.
2. Fetch `GET /api/browser-history/research-clusters/<slug>` and
   `/delta` for the structured shape (top domains, per-day visit /
   foreground arrays).
3. **Materiality check.** If `wikiSummaryWrittenAt` on the cluster
   detail is present AND the delta shows no new buckets since that
   timestamp, reply with a one-line DM "no material change since
   <YYYY-MM-DD>; wiki note skipped" and stop. Do not write a fresh
   note for a stationary cluster.
4. Compose the wiki note in the user's `primaryLanguage`:
   - `## Overview` — 3-5 sentences setting the topic and arc.
   - `## Key threads` — bullet list, one per day-log section the
     journal flagged as material.
   - `## Sources read` — eTLD+1 labels only, never URLs. Pull from
     `topDomains` + any new domains mentioned in the journal's day
     log.
   - `## Open questions` — gaps the cluster's day log surfaces.
   - `## Status` — one of "active", "paused (≥X days since last
     activity)", "concluded" based on cluster `status` and
     `lastActivityAt`.
5. Write to the best destination available, in this priority order:
   - Obsidian: `PUT /api/obsidian/inbox/<slug>-wiki-<YYYY-MM-DD>.md`
     when the `/api/obsidian` surface is configured.
   - Notion: create a page under the configured "Aitne Inbox" parent
     via `POST /api/notion/...` when Notion is configured.
   - Local context (fallback):
     `PUT /api/context/research/<slug>-wiki.md`.
6. **Stamp the write.** Immediately after step 5 succeeds, call
   `POST /api/browser-history/research-clusters/<slug>/wiki-written`
   (empty body). This advances `wikiSummaryWrittenAt` on the cluster
   row so step 3's materiality check works on the next refresh and
   the offer-trigger evaluator's `wikiEligible` gate stays closed
   while a wiki note already exists. Skip this call only if step 5
   itself failed.
7. DM the owner with the destination path / page link and a one-line
   "ready for review" prompt.

Budget is 30 turns / $0.50. The medium-tier envelope is sized for the
template-driven shape — no parallel fetches needed here, the agent
composes from the journal + structured delta only.
