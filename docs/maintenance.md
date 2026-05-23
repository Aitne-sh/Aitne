---
doc_type: playbook
doc_status: active
project: personal-agent
area: maintenance
owner: aitne
created: 2026-04-25
updated: 2026-05-18
tags:
  - "project/personal-agent"
  - "doc/playbook"
  - "area/maintenance"
related:
  - "./advisor.md"
  - "./setup-guide.md"
  - "./troubleshooting.md"
---

# Maintenance Playbook

Cross-cutting "what to touch when X changes" guide for the parts of the
system that are edited frequently and live in more than one file: LLM
models, default-preset routing, skills, task flows, ProcessKeys,
integrations, and the advisor model.

`packages/daemon/src/` is the architectural and implementation
authority. When this doc disagrees with the source, fix this doc.

**Conventions for every change in this guide:**

- All new code, comments, skill/profile/task-flow markdown, tests, and
  user-facing docs are written in **English**.
- Schema policy is **clean reinstall, no data migration** for the
  developer database (`aitne stop && rm
  ~/.personal-agent/data/personal_agent.db* && aitne start`). Any model
  or process rename leaves DB rows behind that point at the old name —
  see "Pitfalls" in each scenario.
- Run `pnpm test` after every scenario; the curated 100% coverage
  subset will catch most missing-test cases (`vitest.config.ts`).

---

## 1. Adding, replacing, or deprecating an LLM model

Source of truth: `MODEL_REGISTRY` in
`packages/daemon/src/core/backends/model-registry.ts`. Every other
location derives from it — pricing math, latest-tier helpers, dashboard
labels.

| Step | File | What changes |
|---|---|---|
| 1 | `packages/daemon/src/core/backends/model-registry.ts` | Add the new `BackendModel` entry to the array. To replace a default: insert the new entry **before** the prior default in the array (the `latestHighFor` / `latestMediumFor` helpers return the first `available && tier === X` entry), and flip the prior entry to `deprecated: true` if it remains usable. |
| 2 | `model-registry.test.ts` | Add the canonical-id assertion (or update the existing one if you replaced a default). Pricing assertions are checked here too. |
| 3 | `DEFAULT_CLAUDE_HIGH_MODEL` / `DEFAULT_CLAUDE_MEDIUM_MODEL` constants in `model-registry.ts` | Only edit these when you replace a Claude default; non-Claude backends use `latestHighFor("codex"\|"gemini")` and pick up the change automatically. |
| 4 | `packages/dashboard/src/lib/backend-ui.ts` | Update `formatModelName` / `formatShortModelName` / `detectBackendFromModel` only if the new model id uses a prefix none of the existing patterns (`claude-`, `gpt-`, `gemini-`) recognise. Existing patterns handle within-family additions automatically. |
| 5 | `plan-presets.ts` (`resolveDefaultBindingFor`) | Default-binding resolution pulls Claude from `DEFAULT_CLAUDE_MEDIUM_MODEL` / `DEFAULT_CLAUDE_LITE_MODEL` and Codex/Gemini from `latestMediumFor(backend)`. No edit needed for non-default model additions. |

**Derived sites that consume the registry — no edit needed.**
The pieces below pull from `MODEL_REGISTRY` (or the `DEFAULT_CLAUDE_*`
constants it re-exports), so a registry bump propagates automatically.
Listed here so you can verify the chain is intact when something looks
wrong; do **not** add new hardcoded literals to these files:

- `packages/daemon/src/db/schema.ts` — `backend_global_defaults` and
  `process_backend_config` seeds use `${DEFAULT_CLAUDE_MEDIUM_MODEL}` /
  `${DEFAULT_CLAUDE_HIGH_MODEL}` template interpolation.
- `packages/daemon/src/core/backends/claude-code-core.ts` — `summarize()`
  uses `DEFAULT_CLAUDE_MEDIUM_MODEL`; `resolveActualModelId` resolves
  legacy `"opus"` / `"sonnet"` aliases to the same constants.
- `packages/daemon/src/core/backends/{codex,gemini-cli}-core.ts` —
  `pickSummaryModel()` calls `latestMediumFor(this.backendId)` and
  throws when the registry has no entry for the backend.
- `packages/daemon/src/core/backends/plan-presets.ts` — `inferTierForModel`
  reads `findRegisteredModel(...).tier` instead of substring-matching the id.
- `packages/daemon/src/api/routes/docs.ts` — `/api/docs/qa/binding` returns
  `defaultModelId` via `cheapestLightFor(backend)`; the dashboard's docs Q&A
  picker uses that value instead of hardcoding a Haiku id.
- `packages/dashboard/src/components/settings/haiku-advisor-warning.tsx` —
  derives its compatibility-substring set from `ADVISOR_ALLOWED_MODELS`
  (`packages/shared/src/advisor-models.ts`).

**Pitfalls**

- DB rows hold the literal model id (`process_backend_config.main_model`,
  `backend_global_defaults.default_{light,heavy}_model`,
  `messages.model_used`, `agent_actions.metadata`). Renaming or removing
  a model leaves these dead. The supported recovery is the clean
  reinstall described above; users who can't reinstall need a manual
  `UPDATE` against the running DB.
- Schema column **DEFAULTs** (`conversation_sessions.model`,
  `recurring_schedules.model`, `agent_schedule.model`) all pin to the
  legacy short-form alias `'sonnet'` (light) — the alias is resolved
  at runtime by `claude-code-core.ts:resolveActualModelId`. **Keep the
  short-form aliases**: replacing them with full model IDs freezes
  rows to a specific generation and breaks the forward-compat property
  that lets existing rows track `DEFAULT_CLAUDE_MEDIUM_MODEL` bumps.
- Tests across the dashboard and daemon hardcode model ids
  (`chat-model-picker.logic.test.ts`, `model-registry.test.ts`,
  `skills-compiler.test.ts`). These are intentional fixtures —
  prefer updating them to reflect reality rather than aliasing the
  fixture to the registry.
- The `MODEL_REGISTRY` array order is load-bearing. Reordering entries
  silently shifts which model `latestHighFor` / `latestMediumFor`
  returns and therefore shifts the default Codex/Gemini bindings in
  `resolveDefaultBindingFor` plus `pickSummaryModel()` in Codex/Gemini
  cores. If you reorder, re-run the backend `*-core.test.ts` files.
- The advisor model has its own constraint chain — see §7 below.

---

## 2. Adding or modifying a built-in skill

Source of truth: `agent-assets/skills/<slug>/SKILL.md`. A skill that
exists on disk but is not listed in `EVENT_SKILL_SETS` is **declared
but not loaded** — the file ships in the repo but no session
materialises it (today this is the state for `receipts`, `tasks`,
`travel`).

| Step | File | What changes |
|---|---|---|
| 1 | `agent-assets/skills/<slug>/SKILL.md` | Author the skill body. English-only. Frontmatter is `name` + `description`; Claude-only skills may add `allowed-tools`. |
| 2 | `packages/daemon/src/core/skills-manifest.ts` | Add the slug to every entry of `EVENT_SKILL_SETS` that should load it. Add the slug to `ALL_SKILLS` if the manifest's fallback should include it (used when an event type has no explicit set). |
| 3 | `packages/daemon/src/core/skills-compiler.test.ts` | Update the materialisation fixture if the skill has a special path (`mail` writes `accounts.md`; `external-services` strips by `<!-- service:* -->` markers). |

**Pitfalls**

- Tool deny-lists are applied per integration, **after** partial-include
  resolution and `external-services` service-section stripping —
  `applyAllDeniedToolsForSkill` in `skills-compiler.ts`. A new skill
  that calls a delegated integration's API needs to participate in this
  pipeline too; see §4.
- The `external-services` skill uses `<!-- service:<key> --> ... <!--
  /service:<key> -->` HTML-comment delimiters per service block.
  `stripUnconfiguredServices` removes any block whose key is not in
  `configuredServices`, but only when the set is non-empty. Adding a
  new service section requires a matching entry in whatever populates
  `configuredServices` (the daemon passes that set in via
  `SkillsCompiler` constructor at session-materialisation time).
- The `mail` skill always materialises with an `accounts.md` file (the
  empty marker matters — see `EMPTY_MAIL_ACCOUNTS_MD` in
  `skills-compiler.ts`). Don't filter the skill out when the account
  list is empty.

---

## 3. Adding a delegation variant for an existing skill

Source of truth: `INTEGRATION_DESCRIPTORS` in
`packages/shared/src/integrations.ts`. Each descriptor declares
`skillsTouched` and `taskFlowsTouched`; the daemon refuses to enter
`delegated` mode if any required variant file is missing
(`missingDelegatedVariants` in `skills-compiler.ts`).

| Step | File | What changes |
|---|---|---|
| 1 | `agent-assets/skills/<slug>/SKILL.delegated.<backend>.md` | Author the variant for each backend in the descriptor's `delegatedBackend` set. Use `{{> base }}` to inherit from `SKILL.base.md`. |
| 2 | `agent-assets/task-flows/<flow>.delegated.<backend>.md` | Author the matching task-flow variant for every entry in `taskFlowsTouched`. Both files must exist or `PATCH /api/integrations/:key` rejects the mode flip with 400. |
| 3 | `packages/shared/src/integrations.ts` | Edit the descriptor only when adding a new `skillsTouched` / `taskFlowsTouched` entry, or when adding a new connector tool to `capabilityTools` / `routeMap`. The probe contract requires `capabilityTools` to cover every capability listed in `requiredCapabilities ∪ optionalCapabilities`. |
| 4 | `packages/shared/src/integrations.test.ts` | The self-consistency test enforces capability coverage; failures here mean the descriptor lies about what tools satisfy what. |

**Pitfalls**

- Variant validation happens at **startup** (`validateDelegatedVariants`
  walks every currently-delegated integration) and at **PATCH time**
  (the route handler calls `missingDelegatedVariants` per `key + new
  delegatedBackend`). Either path can hard-reject a delegation flip
  with a list of missing files. The setup wizard must run a live probe
  (`POST /api/integrations/:key/probe`) before writing `delegated` —
  cached probe rows are invalidated on mode change.
- Never hardcode an integration key string outside
  `integrations.ts`. Use `getIntegrationState(db, key)`
  or `/health.integrationModes`.

---

## 4. Adding or modifying an event-type task flow

Source of truth: `agent-assets/task-flows/<eventType>.md`. Loaded by
`initTaskFlows()` in `packages/daemon/src/core/prompts.ts` once at
daemon startup and served via `getTaskFlow(eventType, backendId,
integrations)`.

| Step | File | What changes |
|---|---|---|
| 1 | `agent-assets/task-flows/<eventType>.md` | Author the base flow. English-only. |
| 2 | `agent-assets/task-flows/<eventType>.delegated.<backend>.md` | Author per-backend delegated variants only when an integration descriptor lists this event type in `taskFlowsTouched`. |
| 3 | `packages/daemon/src/core/skills-manifest.ts` | If the event type is new (not derivable via `PROCESS_TO_EVENT_TYPE`), add an `EVENT_SKILL_SETS` entry so the dispatcher knows which skills to materialise. |

**Pitfalls**

- Task flows are loaded **once** at startup. Editing a flow file does
  not hot-reload — restart the daemon (`aitne restart`) or wait for the
  next scheduled materialisation that does an explicit re-read.
- If you add a `*.delegated.<backend>.md` variant without the
  corresponding integration descriptor entry, it will be ignored at
  runtime and the variant validator won't flag it as missing — silent
  dead code.

---

## 5. Adding a ProcessKey

Source of truth: `packages/shared/src/process-key.ts`.

| Step | File | What changes |
|---|---|---|
| 1 | `packages/shared/src/process-key.ts` | Add the key to `CONFIGURABLE_PROCESS_KEYS` (user-tunable per-process binding) **or** `DEFAULT_PROCESS_KEYS` (system-only, hidden from `/settings/processes`). Add the same key to `DEFAULT_PROCESS_TIERS` with `light` or `heavy` based on the rationale comment in that file (default: `light`). |
| 2 | `packages/daemon/src/core/skills-manifest.ts` | Add an entry to `PROCESS_TO_EVENT_TYPE` if the process key resolves to a different event-type for skill / profile lookup; otherwise the key is used directly. Add an `EVENT_SKILL_SETS` entry for the resolved event type. |
| 3 | `packages/daemon/src/core/dispatcher.ts` | Add the dispatch path that emits the new key (typically a new `executeXxx` method or a branch in `EventBus`). |
| 4 | `packages/daemon/src/core/backends/plan-presets.ts` | Add the new key to `DELEGATED_PROCESS_KEYS` if it should seed Haiku at install time; otherwise it falls through to Sonnet via `applyDefaultPresets` automatically. Existing databases need `POST /api/backends/apply-defaults` (or a manual `setProcessBackendConfig` call) to materialise the row — `applyDefaultPresets` is only invoked at install / main-backend-switch time, not on key addition. |
| 5 | `packages/dashboard/src/lib/backend-ui.ts` | Add the human-readable label to `PROCESS_LABELS` so the dashboard renders the key as something other than the raw string. |

**Pitfalls**

- A key in `CONFIGURABLE_PROCESS_KEYS` becomes immediately available as
  a row in `process_backend_config` on the next default-preset apply.
  Existing databases need a re-apply (`POST /api/backends/apply-defaults`)
  or the row stays absent until the user touches it.
- `getDefaultTierForProcessKey` falls back to `light` for unknown keys.
  Don't rely on the fallback — register every key explicitly.
- Custom routine keys (`routine.custom.<slug>`) are **not** added here;
  they are validated by `isCustomRoutineKey` and provided their tier
  via the routine file's `backend_tier` frontmatter.

---

## 6. Adding an integration

The first edit is always `INTEGRATION_KEYS` + a new
`IntegrationDescriptor` in `packages/shared/src/integrations.ts`.
Everything else is keyed off the descriptor — adding the key elsewhere
first will not type-check. Touchpoints:

```
packages/shared/src/integrations.ts          (registry)
+ src/core/management-md.ts                  (file + fs-watch)
+ src/api/routes/integrations.ts             (PATCH + probe + flip-lock)
+ src/core/integration-lifecycle.ts          (observer start/stop)
+ src/core/integration-health.ts             (/health.integrationModes)
```

**Pitfalls**

- The probe contract requires (a) the backend binary resolvable, (b)
  backend auth valid, (c) every `requiredCapabilities` entry reported
  present by the connector. The setup wizard must call
  `POST /api/integrations/:key/probe` (not the cached row) before
  writing `delegated` to `integrations.md`.
- Adding a delegated tool to `routeMap` without a matching
  `responseMapper` produces 501 at the route handler — the documented
  "connector-capability-gap" signal.
- See §3 above for the skill / task-flow variant-file requirements
  that the descriptor's `skillsTouched` / `taskFlowsTouched` arrays
  trigger.

---

## 7. Changing the advisor model

The advisor is gated by the **Claude Agent SDK** allowlist, not by
this codebase. The SDK ships an allowlist of model ids it will accept
for `advisor_20260301`, and as of SDK 0.2.98 that allowlist is
`claude-sonnet-4-6` and `claude-opus-4-6` only — Opus 4.7 is silently
rejected even though it is the daemon's default heavy model.

Source of truth: `ADVISOR_ALLOWED_MODELS` in
`packages/shared/src/advisor-models.ts`. Bump that one constant when
the SDK extends its allowlist; the three consumers below derive from
it and need no change unless their integration shape changes.

| File | What it does |
|---|---|
| `packages/shared/src/advisor-models.ts` | Canonical allowlist + `DEFAULT_ADVISOR_MODEL` + `isAdvisorModel` predicate. Edit here. |
| `packages/daemon/src/settings/runtime-settings.ts` | `advisorModel` zod refine — calls `isAdvisorModel`. |
| `packages/daemon/src/api/routes/backends.ts` (`advisorUpdateSchema`) | Validates `PUT /api/backends/advisor` body — calls `isAdvisorModel`. |
| `packages/dashboard/src/components/settings/backends-section.tsx` | Filters the registry-derived dropdown via `ADVISOR_ALLOWED_MODELS`; falls back to `ADVISOR_ALLOWED_MODELS[0]` when the form has no value. |

**Pitfalls**

- "Heavy session migrates from Opus 4.6 → Opus 4.7" silently disables
  advisor on every Opus-pinned heavy session. The user-visible
  workaround is to either accept the regression or pin affected
  processes back to `claude-opus-4-6` via `/settings/models`. See the
  "SDK / Anthropic Controls" section in [Advisor](./advisor.md).
- The DB column `backend_global_defaults.advisor_model` accepts NULL
  (= advisor disabled). Treat NULL as the safe default whenever you
  remove a model from the allowlist; otherwise the daemon refuses to
  apply the runtime config and the dashboard goes red.
- Advisor is Claude-only — Codex / Gemini have no SDK feature
  equivalent. Don't try to wire them up.

---

## What to skip in this doc

This guide intentionally does **not** enumerate:

- Every individual file that reads a `BackendId` enum (the type system
  catches misuse).
- Every test that snapshots a session prompt — the
  `skills-compiler.test.ts` fixture set is an open list.
- DB schema additions — those go through
  `packages/daemon/src/db/schema.ts` with the clean-reinstall policy.

When you find a maintenance scenario that touches more than two files
and is not covered above, add a section.

## Related documents

- [Documentation index](./index.md)
- [Setup guide](./setup-guide.md)
- [Troubleshooting guide](./troubleshooting.md)
- [Advisor](./advisor.md)
