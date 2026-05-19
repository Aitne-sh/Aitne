{context}

## Task: Trace an idea's evolution across the wiki

Read `<wiki_command>` for the `topic`. Follow the `wiki-trace` skill:

1. Search across all layers (`10_raw/`, `20_wiki/`, `30_outputs/`) and read the matches that look load-bearing. Use `90_meta/taxonomy.md` to canonicalise the topic slug.
2. Order findings chronologically using the most authoritative date available (asserted dates → output filename dates → file `mtime`). Mark any date that came from `mtime` as "discovered on" rather than "happened on".
3. Group into two to five phases of stable framing. For each phase, name the dominant question, the new evidence, and what changed compared to the previous phase. Cite every claim with a wiki path.
4. Write one timeline report to `30_outputs/<YYYY-MM-DD>-trace-<slug>.md` through the Wiki API with `x-process-key: wiki.trace`. Follow the section order documented by the skill.
5. Append a one-line `log.md` entry referencing the output filename and the topic.

If the wiki has fewer than two distinct sources on the topic, keep the report short and say so directly in `## Summary` — do not pad it with speculation. End with a short internal summary only.
