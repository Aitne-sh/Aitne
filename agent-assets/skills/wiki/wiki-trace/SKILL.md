---
name: wiki-trace
description: Load for wiki.trace. Reconstructs the chronological evolution of an idea across raw, wiki, and outputs; writes a cited timeline to 30_outputs/.
allowed-tools:
  - Bash(curl *)
---

# Wiki Trace

You run under process key `wiki.trace`.

Read `<wiki_command>` for the user's `topic` (free-form). Your job is to reconstruct **how thinking about that topic evolved over time** using only what the wiki actually contains. Never invent sources.

## Method

1. Search across all layers:
   ```
   GET /api/wiki/{{workspace_name}}/search?q=<topic>
   ```
   Then drill into matches by reading their bodies. Cover `10_raw/`, `20_wiki/`, and `30_outputs/`.
2. Order findings chronologically. Prefer dates that the content asserts (raw `retrieved` timestamps, source publish dates, output filenames `<YYYY-MM-DD>-…`). When only file `mtime` is available, mark the entry as "discovered on" rather than "happened on".
3. Group into **phases** — a phase is a span where the dominant framing, vocabulary, or open question stays roughly stable. Two to five phases is the usual shape; one phase is fine for a topic the wiki only mentions briefly.
4. For each phase, surface:
   - The dominant question or claim.
   - The new evidence introduced.
   - What changed compared to the previous phase.
5. Cite every claim with a wiki path (e.g. `10_raw/quantum-computing-2024-overview.md`). Do not collapse multiple sources into a single uncited paragraph.

## Output

Write exactly one timeline report to:

```
POST /api/wiki/{{workspace_name}}/files/30_outputs/<YYYY-MM-DD>-trace-<slug>.md
x-process-key: wiki.trace
```

- `<YYYY-MM-DD>` is today's date.
- `<slug>` is a kebab-case slug derived from the topic (e.g. `quantum-computing`). Use the canonical slug from `90_meta/taxonomy.md` when one exists.

Report shape:

```
# Trace — <topic> (<YYYY-MM-DD>)

## Summary
- one-paragraph synthesis of the arc

## Phase 1 — <YYYY-MM> through <YYYY-MM>: <short label>
- key question / claim
- evidence: `<wiki path>`, `<wiki path>`
- shift since last phase: _(first phase, no prior)_

## Phase 2 — …
…

## Gaps
- bullet list of questions the wiki cannot yet answer
```

If the wiki has fewer than two distinct sources on the topic, say so directly in `## Summary` and keep the report short — do not pad it with speculation. Append a one-line `log.md` entry referencing the output filename and the topic.

### Completion message (mandatory)

End the turn with one short final assistant message that the daemon forwards back to the channel the bang command came from:

- `Trace complete — <topic>: <N> phase(s) across <M> source(s). Timeline: 30_outputs/<YYYY-MM-DD>-trace-<slug>.md.`
- Sparse-vault case: `Trace complete — wiki has <M> source(s) on <topic>; too few to show a clear arc. Report: 30_outputs/<YYYY-MM-DD>-trace-<slug>.md.`
- On failure (no report written): `Trace failed — <one-sentence reason>.`

Do not summarise the timeline content in the completion message — let the file carry it.
