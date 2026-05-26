---
name: drift-analysis
description: Read signals → decide which to act on, which to ignore, which to defer. Never act on a single signal in isolation; require corroboration.
allowed-tools:
  - Read
---

# Drift Analysis

Signals live under `data/signals/<skill_slug>.json` in your workdir.
Each is one row from `skill_curation_signals`:

```jsonc
{
  "id": 42,
  "skill_slug": "user-profile",
  "section_id": "topic-files",
  "signal_type": "structure_diff",
  "payload": { "sub_kind": "heading_add", "target": "identity/personal.md#health-log" },
  "observed_at": 1717000000000
}
```

## Corroboration rule

A single `structure_diff` signal is suggestive, not actionable. To submit
a proposal you must EITHER:

- cite ≥ 2 distinct signals affecting the same `(skill, section)`, OR
- cite a single signal of weight ≥ 3 (only `owner_correction` qualifies).

Single-signal proposals from `structure_diff` alone are auto-rejected by
the smoke test (`signal_citations_valid`). Don't try.

## Triage taxonomy

For each (skill, section) with corroborated signals, classify the change
shape:

- `additive_only` — signals all describe ADD operations (file_add,
  heading_add). Propose with confidence; the worst case is a `revert`.
- `mixed` — some adds, some modifications. Propose with extra rationale
  citing each signal's contribution.
- `destructive` — at least one signal cites a removal. Only propose if
  signals explicitly state user intent to remove (`owner_correction`
  with intent="remove"; structure_diff alone is insufficient). When in
  doubt, SKIP.

## Skip conditions

Do nothing on (skill, section) when ANY of these hold:

- Signals contradict (one says add, another says remove the same target).
- All signals are < 24h old (`structure_diff` low-weight gate hasn't
  matured; the snapshot may be a brief experiment).
- Section is `frozen` (returns from `/skills/<slug>` as `frozen=true`).
- Section had a proposal applied or auto-applied within the last 7 days
  (cooldown).
- Section had a proposal reverted/conflict in the last 14 days.

## Self-restraint

**It is correct and expected to finish a run with zero proposals.** The
optimizer's success is measured over weeks, not per run. The owner
prefers "no action needed" to a low-confidence proposal. If you're
unsure, skip.

## Recording your decisions

Use `POST /api/skill-curation/runs/<runId>/finalize`'s `notes` field to
explain skips. Examples:

- "user-profile/routing-table: 3 signals but contradictory (one heading_add for ## Health, two heading_remove for same — likely an in-progress restructure). Skipping until next cadence."
- "today/section-shape: 1 structure_diff signal — below corroboration threshold."
- "context/file-responsibilities: section frozen since 2026-04-22 owner revert. Skipping."
