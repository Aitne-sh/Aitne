---
doc_type: reference
doc_status: active
project: personal-agent
area: advisor
owner: aitne
created: 2026-04-16
updated: 2026-05-18
tags:
  - "project/personal-agent"
  - "doc/reference"
  - "area/advisor"
  - "state/active"
aliases:
  - "advisor tool"
  - "server-side advisor"
related:
  - "./index.md"
  - "./setup-guide.md"
  - "./troubleshooting.md"
  - "./maintenance.md"
---
# Advisor — Server-side Second Reviewer

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.2.98`) exposes a **server-side** advisor tool typed `advisor_20260301`. When enabled, the SDK injects this tool into the model's tool list; the main model decides when to call it, and the Anthropic API executes the call against a second reviewer model (seeing the full session transcript) and returns the review as an `advisor_tool_result` content block.

This document explains the feature as implemented in the SDK, the gating PersonalAgent has control over, the gating **Anthropic** has control over (experimental feature flag, firstParty dispatch, model compatibility), and the handful of explicit PersonalAgent trade-offs.

## What PersonalAgent Controls

```
backend_global_defaults.advisor_enabled: 0 | 1
backend_global_defaults.advisor_model:   NULL | 'claude-sonnet-4-6' | 'claude-opus-4-6'
```

These get mirrored into `AgentConfig` via `applyConfigUpdates` so the daemon's next session picks them up without a restart. When both are set, `ClaudeCodeCore.buildAdvisorSettings()` passes `{settings: {advisorModel}}` into `query()` (advisor is a `Settings` field, **not** a direct `Options` field — the plan spec got this wrong; the correction is in `buildAdvisorSettings`).

That's the extent of PersonalAgent's control. Everything else is decided by the SDK + Anthropic's servers.

## What the SDK / Anthropic Controls

Inside `@anthropic-ai/claude-agent-sdk`'s `cli.js`, the master gate is a function named `QI()`:

```javascript
function QI() {
  if (process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) return false;
  if (dq() !== "firstParty" || !zq6()) return false;
  return h8("tengu_sage_compass2", {}).enabled ?? false;
}
```

Meaning advisor is **silently unavailable** unless all four conditions hold:

1. **`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`** env var is unset.
2. **`dq() === "firstParty"`** — the SDK is routing through Anthropic direct (not `CLAUDE_CODE_USE_BEDROCK` / `USE_VERTEX` / `USE_FOUNDRY` / `USE_MANTLE` / `USE_ANTHROPIC_AWS`). PersonalAgent's default Claude Code path (whether via `ANTHROPIC_API_KEY` or the CLI subscription fallback) is firstParty, so this typically holds.
3. **`zq6()`** — requires firstParty/anthropicAws/foundry dispatch AND `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is unset.
4. **`tengu_sage_compass2`** GrowthBook feature flag is enabled for this user's account. **This is an experimental gating flag controlled by Anthropic.** Your PersonalAgent setup may configure `advisor_enabled=1` and the SDK will still skip advisor if the flag is off for your account. There is no client-side way to check this — `QI()` is called internally and its result is only visible via debug log lines (`[AdvisorTool] Skipping advisor - ...`).

Additional per-call compatibility checks (`sQ4`):

- **Base model** must match `opus-4-6` or `sonnet-4-6` (case-insensitive substring). **Haiku and Opus 4.7 / 4.8 cannot call advisor.** If a PersonalAgent process is pinned to Haiku or to `claude-opus-4-8` (the current default for the heavy tier) — or to the legacy `claude-opus-4-7` — advisor is silently skipped — no error, no warning.
- **Advisor model** must also match `opus-4-6` or `sonnet-4-6`. Anthropic only permits these two as valid advisors; PersonalAgent's Zod schema + dashboard dropdown enforce the same constraint at the settings boundary so a user can't accidentally pick an SDK-incompatible advisor.

**⚠ Opus 4.7 / 4.8 advisor regression (SDK 0.2.98):** After migrating the daemon's default heavy model off `claude-opus-4-6` (first to 4.7, now to `claude-opus-4-8`), Max-plan heavy sessions (which run on the current Opus generation) **silently lose advisor** — the SDK's `zR6`/`w88` allowlist still matches only `opus-4-6` / `sonnet-4-6`. Pro plan (main = Sonnet 4.6) is unaffected. This resolves automatically when the SDK updates `zR6`/`w88` to include the newer Opus generation; until then, either (a) accept the regression on Max heavy sessions, (b) manually pin affected processes to `claude-opus-4-6` via `/settings/models` if advisor is required, or (c) leave advisor disabled on Max (the preset default).

### Implications

- Enabling advisor in PersonalAgent is **best-effort**. The UI toast "Advisor settings updated" means "we wrote the config row"; it does NOT mean "the feature is live". Whether advisor actually runs in a given session depends on Anthropic's rollout state for your account.
- There is no server-side "is advisor available" query exposed by the SDK today. The SDK emits `tengu_advisor_tool_call` telemetry on every invocation — we could key off that to confirm advisor is live, but we don't currently capture it (`metrics.advisorCallRate` returns `null`).
- A Haiku-pinned process with advisor enabled is a silent no-op. The dashboard's `/settings/models` page does not warn about this today.

## Tool Description and Call Policy

The advisor tool is registered as:

```javascript
S.push({ type: "advisor_20260301", name: "advisor", model: H });
```

and surfaces to the main model as a `server_tool_use`-type tool named `"advisor"`. The tool's **description and call policy are provided by Anthropic's servers** when the tool is registered — PersonalAgent has no input into what the model sees about when/how to call it. In the SDK source the tool is described (CLI-facing, not model-facing) as:

> "Configure the Advisor Tool to consult a stronger model for guidance at key moments during a task"

The model has been trained on when this tool is appropriate, and Anthropic ships the canonical instructions with the `claude_code` system prompt preset we're already using (`systemPrompt: { type: "preset", preset: "claude_code" }`).

**Therefore: PersonalAgent does NOT ship a project-level `advisor-usage` skill.** A skill describing "when to call advisor" would duplicate or contradict the built-in guidance the model already has, and would waste context tokens on every session. This was the conclusion after inspecting the SDK source; an earlier draft of this work did include an `advisor-usage` skill, and that skill was removed.

If you find yourself wanting to override Anthropic's default policy in a way that's specific to PersonalAgent (e.g. "in routine events, never call advisor because the routine is run-to-completion and doesn't benefit from it"), the right place is NOT a skill file — it's the `character` config field (`PA_CHARACTER` env bootstrap or `PATCH /api/config { character: "..." }`) or an agent-profile-level instruction, and even then it's a last resort.

## Which Model to Pick

| Plan | Suggested advisor | Rationale |
|------|-------------------|-----------|
| Pro  | **Sonnet (enabled)** | Opus quota is effectively zero on Pro. Sonnet advisor uses the same plan window as the main session; it's free of cross-quota cost. |
| Max 5x / 20x | **Opus (opt-in)** or **disabled** | Max has enough Opus headroom to absorb Opus-advisor checkpoints on high-stakes sessions. Disabled is also a valid choice if you prefer deterministic main-model behavior. |

Sonnet-advising-Sonnet is not redundant: the advisor runs with a fresh context window and the full transcript as input, so it produces a genuinely different judgement than the main session's mid-flight self-review.

**⚠ Pro + Opus advisor warning**: Pro does not have meaningful Opus headroom. Running advisor on Opus while the plan is Pro burns Opus quota on every advisor call — usually faster than the main session burns Sonnet. The dashboard Plan/Advisor settings show a yellow warning when this combination is selected.

## Cost Model

Each advisor call sends **the entire prior conversation** (system prompt, user turns, tool calls, tool results, reasoning) as input to the advisor model, plus the advisor's reply as output:

- Input tokens ≈ total session context so far — grows with session length.
- Output tokens ≈ short review (a few hundred to a few thousand).

Rough rule of thumb: one advisor call on a 20-tool-use session costs roughly the same as the session up to that point. Two advisor calls ≈ doubles the session cost.

## PersonalAgent Wiring

1. **Migration v16** adds `advisor_enabled` + `advisor_model` to `backend_global_defaults`. Default: disabled.
2. **`runtimeSettingsSchema`** exposes the same two fields; `applyConfigUpdates` writes to the in-memory `AgentConfig` so changes reflect on the next SDK call without restart.
3. **`ClaudeCodeCore.buildAdvisorSettings()`** translates the config into `{ settings: { advisorModel } }` and spreads it into every `query()` call.
4. **Defaults**: advisor is off out of the box. Operators opt in from `/settings/models` → Advisor section.
5. **API**: `GET /api/backends/advisor`, `PUT /api/backends/advisor`.

### Explicit Opus — how callers reach Opus

The default seed pins every configurable process (including `message.dm`, `dashboard.chat`, `agent.task`) to Sonnet. Heavy (Opus) is registered but no row seeds with it; operators opt in per row from `/settings/models`.

Even when no row pins Opus, the explicit-Opus escape hatches **do** reach Opus:

- `/chat` dashboard model picker — can select any registered model on any enabled backend (cross-backend superset), including Claude Opus
- `agent_schedule.model = 'opus'`
- `POST /api/agent/run-now { requestedModel: 'opus' }`

The scheduler and `run-now` paths use `BackendRouter.resolveBinding`'s **tier override**: the caller passes `requestedTier`, and when the pinned model's registry tier doesn't match, the router swaps the main model to a canonical choice from the model registry (`claude-opus-4-8`) on the same backend, preserving the pre-existing fallback only if it too matches the requested tier. See `resolveBinding` → `maybeApplyTierOverride` in `backend-router.ts`.

The dashboard picker uses a **superset override**: the wire protocol accepts `{ requestedBackendId, requestedModelId }` in `POST /api/chat/messages`, validated against the enabled-backends list + model registry on the SSE boundary. When present, `resolveBinding` uses the exact pair as `main` and drops fallback (you picked a specific backend — we won't silently reroute to a different one). The legacy `requestedModel: "sonnet" | "opus"` form is still accepted by the scheduler/run-now paths, and mutually exclusive with the pair on the `/chat/messages` endpoint.

Invariants of the override path:

- **Unknown pinned model is preserved.** If the user manually pinned a custom/fine-tuned model id that isn't in the registry, the router trusts the explicit user choice and does NOT substitute a canonical registry model, even if the caller requests a specific tier.
- **Fallback is only preserved if tier-compatible.** A wrong-tier fallback (e.g. Sonnet fallback under an Opus request) is dropped — routing the failure to a model of the wrong tier would defeat the explicit request.
- **No observability of the override is surfaced yet.** It's logged at `debug` level only. Cost tracker will show the real model; the processes-page pin will continue to show the pin. There is no "overridden to Opus for this run" badge. Track `metrics.advisorCallRate` and cost-by-model if you need to verify an override fired.

## Disabling

```bash
curl -X PUT http://localhost:8321/api/backends/advisor \
  -H "Authorization: Bearer $PA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

Or set `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in the daemon's environment to force the SDK gate off regardless of the PersonalAgent config row.

## Why Not `escalate`?

Prior to this change, a Sonnet session could call `POST /api/escalate` to launch a separate Opus session on the same correlation ID. That endpoint was removed because:

- Automatic handoff encouraged the agent to over-estimate "complexity" and burn Opus quota on questions Sonnet could have answered.
- Escalate was effectively an instant-quota-kill switch on the lighter-tier subscriptions backing the daemon's Claude session.
- Advisor solves the same user need — "get a stronger opinion on this" — in-session, without spawning a new Opus session.

`/api/escalate` now returns `410 Gone`. The remaining explicit-Opus paths are dashboard chat model picker, `agent_schedule.model='opus'`, and `/api/agent/run-now {requestedModel:'opus'}`.

## Related documents

- [Documentation index](./index.md)
- [Setup guide](./setup-guide.md)
- [Troubleshooting guide](./troubleshooting.md)
- [Maintenance playbook](./maintenance.md)
