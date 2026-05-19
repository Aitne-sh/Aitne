---
schema_version: 1
slug: features/wiki/commands
title: Wiki Commands
id: wiki-commands
aliases:
  - "!ingest"
  - "!compile"
  - "!ask"
  - "!wiki"
  - "!lint"
  - "!trace"
  - "!connect"
  - bang commands wiki
category: features
summary: |
  Reference for the wiki bang commands — `!ingest`, `!compile`,
  `!compile full`, `!ask`, `!wiki`, plus the Phase 3 operational
  triad `!lint`, `!trace`, `!connect` — including the dispatch-mode
  and approval-gate semantics.
section: wiki
tags:
  - wiki
  - bang-commands
  - core
status: stable
ask_examples:
  - How do I send a URL to the wiki?
  - What is the difference between `!compile` and `!compile full`?
  - Why did `!compile full` ask for approval?
  - What does serial dispatch mode change?
  - How do I run a wiki health check?
  - What does `!trace` do?
  - How do I bridge two domains with `!connect`?
locale: en-US
created: 2026-05-12
updated: 2026-05-12
keywords:
  - !ingest
  - !compile
  - !ask
  - !lint
  - !trace
  - !connect
  - !wiki
  - bang commands
  - wiki commands
related:
  - features/wiki/overview
  - features/messaging/bang-commands
  - guides/budget-and-cost-for-wiki
  - guides/maintain-wiki-health
  - guides/explore-with-trace-and-connect
  - troubleshooting/wiki-ingest-full-blocked
ui_anchors:
  - /wiki
  - /wiki/timeline
  - /settings/wiki
  - /approvals
---

# Wiki Commands

Use these from a paired DM channel after enabling the wiki — open
**Setup → Settings → Wiki** to enable, then browse from **My Life →
Wiki**.

| Command | Effect |
|---|---|
| `!ingest [@<workspace>] <url> [url...]` | Queues one `wiki.ingest_url` event per URL. |
| `!compile [@<workspace>]` | Queues an incremental `wiki.compile` run. |
| `!compile [@<workspace>] --preview` | Dry-run preview: lists pages that would be added / modified / unchanged plus cost and ETA. Aliases: `--dry-run`. No agent session runs. |
| `!compile [@<workspace>] full` | Queues a full rebuild. Cost-gated; estimates above the threshold need dashboard approval first. |
| `!compile [@<workspace>] full --preview` | Dry-run preview of the full rebuild. Same shape as the incremental preview. |
| `!ask [@<workspace>] <question>` | Queues a `wiki.ask` answer run and writes to `30_outputs/`. |
| `!lint [@<workspace>]` | Audits the wiki for orphans, broken links, schema drift, taxonomy candidates, and stale notes. Writes `90_meta/health/<YYYY-MM-DD>.md`. |
| `!trace [@<workspace>] <topic>` | Reconstructs how an idea has evolved across raw / wiki / outputs. Writes `30_outputs/<YYYY-MM-DD>-trace-<slug>.md`. |
| `!connect [@<workspace>] <a> <b>` | Finds bridges (shared terms, references, structural analogies) between two domains. Writes `30_outputs/<YYYY-MM-DD>-connect-<slug-a>--<slug-b>.md`. |
| `!wiki` | Shows workspace status and counts. One line per workspace when multiple are active. |
| `!wiki help` | Shows the command list. |

`!ingest` accepts only `http://` and `https://` URLs and caps each
batch at 10 URLs.

## `@<workspace>` — addressing a non-default workspace

If you run more than one wiki workspace (Phase 5), every bang command
accepts an optional `@<name>` token immediately after the bang. The
token is parsed before the command's own argument parser sees the
rest, so multi-word topics and comma-separated arguments work as
normal:

    !compile @research full
    !ask @parenting what did the pediatrician recommend?
    !connect @research diffusion models, score matching

Omit the token and the command targets the **default** workspace.
See `agent-assets/docs/guides/multiple-wikis-for-multiple-domains.md`
for a walkthrough.

## `!compile --preview` — the dry run

Use `!compile --preview` (or `--dry-run`) when you want to see what
`!compile` would do without spending tokens:

- **added** — wiki pages that would be created (raws with no
  existing wiki match).
- **modified** — wiki pages that would be rewritten (raws whose
  slug matches an existing wiki page).
- **unchanged** — wiki pages the compile is expected to skip.
- **est. cost** — Optimistic / pessimistic bracket plus expected
  spend.
- **est. duration** — Rough wall-clock estimate (intentionally
  pessimistic).

The preview is an upper bound. The compile is an LLM and may
merge or skip pages inside the agent loop; the preview cannot
predict that exactly, but it will not undercount the touch set.
Reply `!compile` (or `!compile full`) to actually run the compile.

## Dispatch Mode for `!ingest`

`!ingest` honours the per-workspace **dispatch mode** in
Settings → Wiki:

- **Parallel** (default): all URLs fan out simultaneously up to the
  per-URL concurrency cap. Fastest; small risk of bursting rate
  limits at the URL host.
- **Serial**: URLs are enqueued in submitted order; each agent
  session starts only after the previous one completes. Slower but
  predictable budget and rate.

The acknowledgement DM tells you which mode ran
(`in parallel` / `serially`).

## `!compile full` — the Cost Gate

Full rebuilds touch every wiki note and are the most expensive
command in the wiki surface. The flow:

1. The bang handler estimates the cost (raw count × assumed input
   tokens × Sonnet unit cost, bracketed at 0.5× / 1× / 2×).
2. On an external git-tracked vault with **Auto-commit before
   `!compile full`** enabled and a clean working tree, Aitne runs
   `git add -A && git commit -m "aitne wiki: pre-compile snapshot <ts>"`
   before continuing. A dirty tree refuses the operation — commit or
   stash first.
3. If the pessimistic estimate exceeds your per-workspace approval
   threshold (default $2.00), the run is queued under **Approvals**
   in the dashboard. Approve from `/approvals` to start the compile.
4. Otherwise, the run starts autonomously and you receive a
   completion DM with actual spend.

The same estimate is shown live in **Settings → Wiki** so you can
see what the next `!compile full` will cost before you run it.

## Operational Triad — `!lint`, `!trace`, `!connect`

These three commands round out the wiki surface for ongoing
maintenance and exploration. None of them write to the content
layers (`10_raw/`, `20_wiki/`); they only produce health reports
(`90_meta/health/`) or output documents (`30_outputs/`).

### `!lint`

Run periodically (weekly is a sensible cadence) to audit the wiki
for:

- Orphaned wiki notes (no incoming links).
- Broken `[[wikilinks]]` pointing at missing files.
- Notes that violate the schema declared in
  `90_meta/schemas/{raw,wiki,output}.md`.
- Stale wiki notes whose newest source is more than 90 days old.
- Slug/title variants that look like the same concept.
- Recurring concepts that should be promoted into `90_meta/taxonomy.md`.
- Drift between `20_wiki/_index.md` and the files on disk.

The output is one Markdown report at
`90_meta/health/<YYYY-MM-DD>.md` with a `## Summary` line, a
`## Action items` list, and one section per check. When taxonomy
candidates are found, `!lint` also appends a `# Candidates` section
to `90_meta/taxonomy.md` for your review — it never promotes the
candidates itself; you decide which to keep.

The latest report is rendered prominently on **My Life → Wiki →
Timeline & health** (`/wiki/timeline`).

### `!trace <topic>`

Reconstructs the chronological evolution of an idea across every
wiki layer. Use a free-form topic — the skill canonicalises against
`90_meta/taxonomy.md` before deriving the output slug:

```
!trace quantum computing
!trace formal methods in distributed systems
```

The output is a timeline at
`30_outputs/<YYYY-MM-DD>-trace-<slug>.md` grouped into two to five
phases with cited evidence and an explicit gap list. If the wiki
has fewer than two sources on the topic, the report says so
directly — no speculative filler.

### `!connect <a> <b>`

Bridges two domains by surfacing shared terminology, common
references, structural analogies, and proposed bridging concepts.
Pass exactly two topics separated by whitespace or by a comma; the
comma form supports multi-word topics:

```
!connect quantum gravity
!connect quantum computing, classical computing
```

A single argument, three or more arguments, an empty input, or a
trailing comma all return a usage message — pick a topic for each
side. The output lands at
`30_outputs/<YYYY-MM-DD>-connect-<slug-a>--<slug-b>.md`. When no
genuine bridges exist, the report still writes — a "no connection"
finding is itself useful.

## Disabled-State Behaviour

When no active wiki workspace exists, every `wiki.*`-routed bang
command (`!ingest`, `!compile`, `!ask`, `!lint`, `!trace`, `!connect`)
replies with:

> Wiki is not enabled. Open `/settings/wiki` to enable.

`!wiki help` is exempt — it returns the command list regardless of
enablement so you can discover the surface before opting in.
