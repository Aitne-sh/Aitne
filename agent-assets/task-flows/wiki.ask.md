{context}

## Task: Answer from the wiki

Read `<wiki_command>` for the question. Follow the `wiki-ask` skill:

1. Search `20_wiki/` for relevant notes.
2. Verify against source links or `10_raw/` only when needed.
3. Write one `30_outputs/<YYYY-MM-DD>-<slug>.md` answer through the Wiki API with `x-process-key: wiki.ask`.
4. Keep the final assistant response concise; the durable answer belongs in `30_outputs/`.

