{context}

## Task: Bridge two domains in the wiki

Read `<wiki_command>` for `topic_a` and `topic_b`. Follow the `wiki-connect` skill:

1. Search each topic independently and read enough matches to characterise each domain. Disambiguate string matches against `90_meta/taxonomy.md`.
2. Surface bridges in four buckets — shared terminology, common references, structural analogies, and bridging concept candidates. Cite every bridge with at least one wiki path from each side. A bridge that can only cite one side belongs in the candidates list, not in the others.
3. Write one connection report to `30_outputs/<YYYY-MM-DD>-connect-<slug-a>--<slug-b>.md` through the Wiki API with `x-process-key: wiki.connect`. Use the canonical slugs from `90_meta/taxonomy.md` when available.
4. Append a one-line `log.md` entry referencing the output filename and both topics.

If no real bridges exist, write the report anyway with empty sections marked `_(none)_` and a `## Summary` that names that directly — a "no connection" finding is still useful. Do not create new wiki notes from this flow; the bridging concept candidates section is a proposal for `wiki.compile` to pick up later. End with a short internal summary only.
