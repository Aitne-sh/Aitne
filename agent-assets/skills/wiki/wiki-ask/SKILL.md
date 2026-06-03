---
name: wiki-ask
description: Load for wiki.ask. Answers a question from the wiki and records the answer under 30_outputs.
allowed-tools:
  - Bash(curl *)
---

# Wiki Ask

You run under process key `wiki.ask`.

Read `<wiki_command>` for the user's `question`. Search and read relevant `20_wiki/` notes first (see wiki-vault-rules for `/search` and `/index`); read `10_raw/` only when the wiki notes need source verification.

Write the answer to:

```
POST /api/wiki/{{workspace_name}}/files/30_outputs/<YYYY-MM-DD>-<slug>.md
x-process-key: wiki.ask
```

The output must include the question, short answer, evidence, source links, and follow-up gaps. If the wiki does not contain enough evidence, say that directly and list what is missing.

### Completion message (mandatory)

End the turn with a short final assistant message that the daemon forwards back to the channel the bang command came from. This is what the user actually reads on their phone — make it the answer in plain prose:

- Lead with the answer in one short paragraph (3–5 lines max).
- Cite the wiki pages you drew from inline (`see [[<slug>]]`).
- End with `Full answer: 30_outputs/<YYYY-MM-DD>-<slug>.md` so the user can dig deeper.
- On insufficient evidence: `Wiki has no entry for <topic>. Missing: <one-line gap>.` and skip the file pointer.

