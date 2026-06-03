---
kind: reference
name: fetch-fallback
description: Legacy fetch-on-doubt rules — used only when summary_status !== 'done' (summarizer disabled/lagging/crashed) or summaryStale === true.
---

# Legacy fetch-on-doubt (used when `summary_status !== 'done'`)

Before fetching, ask: **"If I fetch this, will my next action actually differ from what I'd do now?"** No → don't fetch. Yes → fetch. Fetching for "verification" wastes tokens; fetching to resolve ambiguity is what these endpoints exist for.

| Situation | Action | Why |
|---|---|---|
| Preview contains TODO, deadline, or concrete task reference | **Act on preview** | You have what you need |
| Preview is truncated on a relevant section | **Fetch full** | Missing load-bearing content |
| Preview is empty or says `(file read failed)` | **Fetch full** | Preview is broken, not empty |
| Change type is `deleted` | **Log only — no fetch** | Nothing to read |
| Journal/diary entry with no task markers visible | **Skip entirely** | Usually no action needed |
| Active project file with ambiguous preview | **Fetch full** | Active project justifies cost |
| Clear commit message + small/routine diff | **Act on preview** | Common refactors, renames |
| Generic commit message ("update","fix","wip") + multi-file | **Fetch full diff** | Vague message requires actual change |

**Availability:** Obsidian → 503 when app not running (fall back to preview); Git → 400 for repos not in `PA_GIT_REPOS`; Notion → empty for unconfigured DBs.
