---
schema_version: 1
slug: guides/explore-with-trace-and-connect
title: Explore Your Wiki with !trace and !connect
id: explore-with-trace-and-connect
aliases:
  - "!trace"
  - "!connect"
  - wiki trace
  - wiki connect
  - bridging domains
category: guides
summary: |
  How to use `!trace <topic>` to reconstruct the evolution of an
  idea across your raw / wiki / outputs layers, and `!connect <a>
  <b>` to find bridges between two domains.
section: guides
tags:
  - guides
  - wiki
  - exploration
  - bang-commands
status: stable
ask_examples:
  - How do I trace an idea across the wiki?
  - What does !connect do?
  - How do I find connections between two topics?
  - Where does the !trace output land?
  - Can I use multi-word topics with !connect?
  - How do I run !trace against a non-default wiki workspace?
locale: en-US
created: 2026-05-12
updated: 2026-05-28
keywords:
  - "!trace"
  - "!connect"
  - wiki exploration
  - topic history
  - topic bridges
  - bridging domains
prerequisites:
  - guides/build-your-wiki
related:
  - features/wiki/overview
  - features/wiki/commands
  - guides/maintain-wiki-health
  - features/messaging/bang-commands
process_keys:
  - wiki.trace
  - wiki.connect
ui_anchors:
  - /wiki/timeline
  - /settings/wiki
---

# Explore Your Wiki with `!trace` and `!connect`

`!trace` and `!connect` are the two wiki exploration commands. Both
produce a one-off output document in `30_outputs/` and never touch
your raw or wiki notes. Think of them as cited essays written from
what your wiki actually contains.

Both run as owner-DM bang commands. Both also accept an optional
leading `@<workspace>` token to target a non-default wiki workspace
— for example `!trace @research formal methods` or
`!connect @research category theory, distributed systems`. Omit the
token and the command runs against your default workspace.

## `!trace <topic>` — Time-Based Exploration

Use `!trace` when you want to see **how thinking about a topic has
evolved**. The wiki agent searches every layer, orders the matches
chronologically (preferring dates asserted in the content over
file mtimes), and groups them into two-to-five phases of stable
framing.

```
!trace quantum computing
!trace formal methods in distributed systems
```

The topic is free-form prose. The skill canonicalises against
`90_meta/taxonomy.md` before deriving the output slug, so
`!trace quantum computing` and `!trace quantum-computing` produce
the same output filename if `quantum-computing` is your canonical
topic.

### Output

The output lands at:

```
30_outputs/<YYYY-MM-DD>-trace-<slug>.md
```

Each report has:

- A one-paragraph synthesis of the arc.
- One section per phase with the dominant question, new evidence,
  and what changed compared to the previous phase.
- A `## Gaps` list of questions your wiki cannot yet answer — a
  pointer to where the next `!ingest` run should focus.

If your wiki has fewer than two sources on the topic, the report
says so directly. No padding, no speculation.

### When to Reach for `!trace`

- Before writing about a topic externally — get the lineage right.
- After a long ingest run on one area — see whether the phases
  changed or just thickened.
- When a wiki note feels stale — `!trace` will surface the dated
  evidence and the gap list will tell you what to refresh.

## `!connect <a> <b>` — Bridge Two Domains

Use `!connect` to find honest overlaps between two domains in
your wiki. The agent surfaces four kinds of bridges:

1. **Shared terminology** — terms that mean the same (or
   recognisably different) things in each domain, disambiguated
   against `90_meta/taxonomy.md`.
2. **Common references** — the same URL, author, or wiki note
   linked from both sides.
3. **Structural analogies** — recurring patterns of reasoning or
   tradeoffs, even when the surface vocabulary differs.
4. **Bridging concept candidates** — proposals for a new wiki
   note that would naturally sit between the two areas.

### Argument Forms

`!connect` requires exactly two topics (after any optional
`@<workspace>` token). Whitespace separates them by default; a
comma lets you use multi-word topics:

```
!connect quantum gravity
!connect quantum computing, classical computing
!connect category theory, distributed systems
!connect @research category theory, distributed systems
```

The handler rejects a single topic, three-or-more topics, a
trailing comma, or empty input with a usage message — pick a
topic for each side.

### Output

The output lands at:

```
30_outputs/<YYYY-MM-DD>-connect-<slug-a>--<slug-b>.md
```

The double-hyphen (`--`) separates the two canonical slugs in the
filename. Each report cites bridges with at least one path from
each side — a one-sided match becomes a bridging candidate, not a
bridge.

### Honest "No Connection" Reports

If your wiki contains nothing in common between the two domains,
the report still writes — with `_(none)_` filling the empty
sections and a `## Summary` that says so plainly. A negative
finding is itself useful: it tells you where the wiki has gaps.

### `!connect` Does Not Create Wiki Notes

The "bridging concept candidates" section is a **proposal** for
`wiki.compile` (or you, manually) to pick up later. `!connect`
never writes to `20_wiki/` — the safety boundary is the same as
`!ask` and `!trace`: read everywhere, write only to
`30_outputs/`.

## Finding Past Reports

Every report is a regular wiki file under `30_outputs/`. You can:

- Open **My Life → Wiki → Timeline & health** (`/wiki/timeline`)
  — the timeline shows every wiki write with a process-key
  filter, so filtering by `wiki.trace` or `wiki.connect` lists
  past reports in reverse-chronological order.
- Use `!ask` to fold a past trace or connect into a new answer.
- Browse the files on disk (the wiki vault root path is shown on
  **My Life → Wiki** and on `/settings/wiki`).

## Cost Envelope

Both commands run at Sonnet medium tier with a default $1.00
spend cap per run, identical to `!ask`. The 7-day cost rollup on
**Settings → Wiki** breaks the spend out per command so you can
see where the budget went.
