---
kind: reference
name: model-selection
description: Tier vs model selection for schedule rows + `GET /api/schedule/options` discovery endpoint. Mutual-exclusion rules, legacy alias rewrite, composite-form disambiguator.
---

# Tier / Model selection

`tier` is the backend-neutral cost knob — **prefer it**. `model` pins
a specific registered model id when the row must run against a
particular backend (e.g. a routine that depends on Opus reasoning
even after `/settings/models` re-routes the process key). The two are
**mutually exclusive on a single row** — passing both returns
`schedule.tier_and_model_conflict` (no "tier wins" precedence).

| `tier` | Class | When |
|---|---|---|
| `"lite"` | Haiku | hourly polling / health checks (e.g. docker `ps` summary) |
| `"medium"` | Sonnet | lock against future `/settings/models` re-routes |
| `"high"` | Opus | one-off generative work driving user-visible output |

`model` accepts:

- **Legacy aliases** — `"sonnet"` / `"opus"`. Auto-rewritten at the
  route to `tier:"medium"` / `tier:"high"`; the alias is not stored
  verbatim.
- **Registered model ids** — any id from `MODEL_REGISTRY` across the
  four backends. Examples: `claude-opus-4-8`, `claude-sonnet-4-6`,
  `claude-haiku-4-5-20251001`, `gpt-5.4`, `gemini-3.1-pro-preview`.
  The row persists `(model, backend_id)` together so the dispatcher
  honors the pin at fire time.
- **Composite `<backendId>/<modelId>`** — disambiguator for a future
  registry that has the same model id under multiple backends (today
  unreachable but accepted). The prefix MUST be one of `claude` /
  `codex` / `gemini` / `opencode`; opencode model ids like
  `anthropic/claude-opus-4-8` are NOT composites and fall through to
  the cross-backend scan.

Unknown / ambiguous / deprecated model tokens surface through the
error envelope's `validValues` field — read it instead of guessing.
The full code list lives in `references/errors.md`.

## PATCH semantics — tier ↔ model swap

A row carries at most one pin at rest. On PATCH:

- Pass `null` to clear one and a concrete value to set the other in
  the same request — that is the documented form for swapping a
  tier-pinned row to a model-pinned row (and vice versa).
- Setting a registered `model` token also clears any prior
  `tier_override` automatically; setting `tier` does not auto-clear
  `model` — pair the change with `"model": null` when the intent is
  to swap.
- Setting a legacy alias (`sonnet` / `opus`) on PATCH is rewritten to
  `tier:"medium"` / `tier:"high"`; the alias is never stored verbatim.

## Discovery — `GET /api/schedule/options`

Read-only one-stop endpoint that returns every value the daemon will
accept right now: registered models per backend, model aliases,
allowed tiers, recurrence frequencies, `daysOfWeek` map, hourly /
monthly bounds (`intervalHours` 1..23, `minuteOfHour` 0..59,
`onMissingDay` default), and the operator's configured timezone.
Fetch once per cold session before composing tricky schedules; the
error envelope also cites this endpoint via `docsUrl` so you can
recover after a 400.

```bash
curl -s http://localhost:8321/api/schedule/options
```

Response shape:

```jsonc
{
  "tiers": ["lite", "medium", "high"],
  "modelAliases": { "sonnet": "medium", "opus": "high" },
  "models": {
    "claude":   [{ "id": "claude-opus-4-8", "tier": "high", "deprecated": false }, ...],
    "codex":    [...],
    "gemini":   [...],
    "opencode": [...]
  },
  "frequencies": ["hourly", "daily", "weekly", "monthly"],
  "daysOfWeek":  { "0": "Sun", "1": "Mon", ..., "6": "Sat" },
  "recurrence": {
    "intervalHours": { "min": 1, "max": 23 },
    "minuteOfHour":  { "min": 0, "max": 59 },
    "daysOfMonth":   { "min": 1, "max": 31 },
    "onMissingDay":  { "values": ["skip", "lastDayOfMonth"], "default": "lastDayOfMonth" }
  },
  "timeFormat":      "HH:MM (24h)",
  "timezoneExample": "Asia/Tokyo",
  "defaults":        { "timezone": "<operator's configured primary timezone>" }
}
```
