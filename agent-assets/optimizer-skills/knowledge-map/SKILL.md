---
name: knowledge-map
description: Read knowledge-map.json snapshots correctly. Distinguish facts (what exists today) from signals (evidence of recent change).
allowed-tools:
  - Read
---

# Knowledge Map

The file `data/knowledge-map.json` in your workdir is a structural
snapshot of `~/.personal-agent/context/` taken at run start. It is the
ground truth for "what files exist and what headings they contain right
now." Use it for `paths_resolve` / `sections_resolve` validation BEFORE
submitting a proposal.

## Schema

```jsonc
{
  "context_dir": "/Users/.../personal-agent/context",
  "taken_at": 1717000000000,
  "files": [
    {
      "path": "user/profile.md",
      "headings": ["Identity", "Work Pattern", "Learned Context"],
      "frontmatter": { "type": "profile", "owner": "shared" },
      "last_modified_at": 1716900000000
    },
    ...
  ]
}
```

- Globs in skill `scope_paths` (e.g. `user/*.md`) are NOT pre-expanded —
  match yourself.
- `headings[]` order is document order, leading `## ` / `### ` already
  stripped.
- `frontmatter` is a flat string→scalar object (no nested YAML).

## How to compare snapshot to a current payload

A `knowledge_layout` payload's `files[]` SHOULD agree with the snapshot's
files. When they diverge:

- Snapshot has a file the payload doesn't → `additive` opportunity.
- Snapshot is missing a file the payload claims → likely a `destructive`
  proposal, but ONLY propose if signals corroborate (a `file_remove`
  structure_diff, an owner_correction, etc.).
- Snapshot has a heading the payload doesn't list → `additive` (heading
  added since last overlay).
- Payload claims a heading the snapshot doesn't have → `destructive`,
  same corroboration rule.

## Anti-patterns

- NEVER infer `cross_references` payloads from snapshot adjacency alone.
  "Two files in the same directory" is not evidence of a relationship.
  Cross-references require an explicit citing signal.
- NEVER propose a `frontmatter_schema` reduction (drop a `required[]`
  entry) — schema reduction is a separate human PR. The smoke test
  rejects this anyway.
- NEVER propose changes that turn a heading list of length 6 into 3.
  Walked-only signals can be wrong; combine with at least one signal of
  weight ≥ 2 before considering removal.

## Time interpretation

- `last_modified_at < 7 days ago` → "fresh", may be in flux.
- `last_modified_at` older than 60 days, unchanged → "stable", safe to
  treat as permanent layout.
- Frequency-of-change is OUT of scope for the optimizer (no analytics).
