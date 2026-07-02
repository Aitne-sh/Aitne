# Routine Cost-Reduction Plan — evening_review & morning_routine (2026-07)

> Status: **verified + P0/P1/P2 implemented** (2026-07-01). Originally a draft
> proposal; every evidence claim was then re-verified against the live install DB
> (`~/.personal-agent/data/personal_agent.db`, read-only), `~/.personal-agent/logs/daemon.log`,
> and current source. Four mechanism claims were corrected, one proposed
> remediation was invalidated, and one new real bug was found (and fixed) in the
> process — see §4.5 "Verification corrections". P3 items remain deferred behind
> observation gates (§5.4).
> Root-level `*_PLAN.md` is gitignored (working artifact, not committed).

## 1. Purpose / Goal

**Reduce the cost of the daily review routines without degrading their output quality**, by
**eliminating wasteful *repeated* execution** rather than by cutting the work they do.

The three goals in priority order:

1. **No quality regression.** Every file the routines are responsible for
   (`state/today.md`, `plans/roadmap.md`, `identity/profile.md`, lesson stores, dossiers,
   journal) must keep being produced/updated to the same standard. Cost cuts that risk a
   missed `today.md` or a dropped roadmap line are rejected.
2. **Prevent wasteful repeated execution.** The dominant avoidable cost was a routine
   **hitting its per-turn budget cap mid-run, failing, and re-running the whole thing** (double
   execution, re-paying the cold-cache prefix), plus **recurring wasted turns** from API-shape
   retries, dead probes, and un-batched reads.
3. **Reduce cost.** After (1) and (2), trim the intrinsic per-run footprint (turns × re-read
   prefix) via instruction tightening and effort tuning.

Non-goal: dropping steps that produce required output.

## 2. Scope

| Routine | Process key | Cap (was → now) | Shed? | Task-flow size | In scope |
|---|---|---|---|---|---|
| Evening Review | `routine.evening_review` | $2.00 (`plan-presets.ts:186`) | yes (`["project"]`) | ~20 KB | ✅ |
| Morning Routine (Stage A) | `routine.morning_routine_today` | **$1.50 → $2.00** (`plan-presets.ts:202`, migration 0025) | no (needs connectors) | ~34 KB | ✅ |
| Morning Journal (Stage B) | `routine.morning_routine_journal` | $0.30, Haiku | — | ~6 KB | ⛔ already lean |

## 3. Cost model (why context, not output, is the bill)

Both routines are **~99% context/cache cost, ~1% output.** The agent drives the daemon REST API
(`localhost:8321`) over many turns; on every turn the SDK re-reads the whole cached prompt
prefix:

```
cost ≈ (prefix_size × turns) × cache-read-rate  +  cache-write(prefix once)  +  output
```

- Evening 07-02 (UTC) success: **$1.7735**, 21 turns, 17 curls — output only ~$0.22.
- Trigger for the spike: the `claude-sonnet-4-6 → claude-sonnet-5` default bump
  (`shared/src/model-registry.ts:26`, ~2026-06-30): more tokens for the same text
  **and more agentic** (more turns → more prefix re-reads). Evening went
  **$0.11–0.38 (4-6 era) → $1.77 (≈5×)**; promptLen 36k→44k (evening), 59–64k (morning).
- **Every avoided turn ≈ one full prefix cache-read avoided** — the biggest lever.
- **A capped-then-retried run pays the cold prefix twice.**

## 4. Findings (all DB/log claims re-verified 2026-07-01)

### 4.1 Shared root causes — CONFIRMED

- S1 Sonnet 5 turn inflation (evening 21–28 turns vs 4-6's 6–15).
- S2 Large re-read prefix (full preset; morning additionally not shed → carries the ~25K
  user-scope connector schemas). Shed set is exactly `{research_cluster_update,
  evening_review}` (`claude-code-core.ts:235-238`); morning legitimately cannot shed (its
  mail/calendar path needs the user-scope `mcp__claude_ai_*` connectors).
- S3 Under-sized caps meet a pricier model → mid-run `BackendQuotaError(max_budget_usd)`.

### 4.2 Evening Review — CONFIRMED (with two mechanism corrections, see §4.5)

- E1 Roadmap lock-dance on an empty `## Long-term Plans` (log 28024→28027→28030; section
  was empty). The task-flow had **no** skip-when-empty guard — only the 409 path skipped.
- E2 Journal-append 400 → retry every run (28067→28071). See correction §4.5-3.
- E3 Dead calendar "tomorrow-preview" probe in a shed session (28079).
- E4 Sequential independent reads (28013/28016/28037).
- E5 Verbose 4.6-era defensive prose (~5K tok) inflating literal-following turns.
- The 07-02 evening trace shows **zero `Skill` tool invocations** (21 turns, 17 curls) —
  relevant to the deferred P3-b preset-trim question.

### 4.3 Morning Routine — CONFIRMED (worse than evening)

- **M1 Budget-cap fail → retry = double execution.** 06-30 20:33 fail → 20:40 success;
  07-01 22:15 fail → 22:21 success (UTC). The failed primaries **really burned $1.69 and
  $1.50 (29 turns, `costSource:"sdk_partial"`) per the log**, while the DB rows recorded
  **NULL** cost/turns (not $0.00 — see §4.5-2 for the root cause, now fixed). The retries
  are cheap-ish (2–3 turns, ~$0.46–0.55: idempotent steps mean the primary's work
  persists), so a fail+retry day ≈ **$2.0–2.2 real** vs ~$1.6–1.8 for one completed run.
- **M2 `PATCH /api/agent-actions/self` → 400 `session_identity_missing`** (26304, 26515 +
  an `env | grep PA_` debug turn at 26305; recurs across many mornings: 6929, 10762,
  13082, 16751, 21268). Root cause found and fixed — §4.5-4.
- M3 Blocked curl → retry (26106→26109). See correction §4.5-5.
- M4 ~4 sequential per-source observation GETs per run (21803-21818, 26176-26186).
- M5 Biggest prefix (34KB flow + not shed + full preset → promptLen 61–64K).
- M6 Chronic instability history (06-24 5× timeout, 06-25 2× auth — confirmed in DB).
- agent.md declared stale limits 30/$0.50 (evening's declared 25/$0.50) vs runtime 50/$1.50–2.00.
  **Not merely cosmetic**: the values prefill the dashboard Definition form; a save would
  write them into `override_snapshot`, which DOES clamp runtime. Fixed (§5.1).

### 4.4 Spend context (last 7 days at verification time, DB-recorded only)

Top spenders: message.received $10.32, routine.fetch_window $10.06 (separate plan),
activity_scan $5.02, **evening_review $4.89**, **morning_routine_today $2.47**,
**morning_journal $0.70**. The three target routines ≈ 22.6% of top-8 spend — understated
because budget-failed rows carried NULL cost (fixed).

### 4.5 Verification corrections (what the draft got wrong)

1. **P0-b was aimed at the wrong mechanism.** Budget errors are already NON-retryable in
   the dispatcher (`isRetryable` rejects `BackendQuotaError`, `dispatcher-error-handling.ts:133-149`;
   same in the core's own retry, `claude-code-core.ts:1141`). Morning's second run comes from
   the **deliberate today.md-health gate**: the orchestrator swallows Stage A's throw
   (`dispatcher-morning-routine.ts:304-316`), `diagnoseTodayMdState()` (:355) sees a
   missing/stale today.md, and `scheduleMorningRetry` (:534-707) re-dispatches at
   5/10/15 min (max 3). **Decision: keep it** — it is the quality backstop that guarantees
   today.md exists; the fix is making the primary fit under its cap (P0-a + P1/P2), not
   removing the retry. Evening has no equivalent gate, which is why its 07-01 budget
   failure simply produced a missed review.
2. **New bug found: failed-row spend was being discarded.**
   `morning/orchestrator.ts recordStageFailure` read the `BackendQuotaError` for
   `failureKind/failureCode` but dropped `.spend` — so budget-failed rows landed with NULL
   `cost_usd`/`num_turns` while the log showed ~$1.5/29 turns burned. `audit.logError`
   already accepted cost fields; the orchestrator just never passed them. **Fixed** (§5.1 WP3).
   (The generic dispatcher path was already correct — `recordFailureSpendRow` wrote the
   07-01 evening partial row with cost $1.00, `sdk_partial`.)
3. **E2's mechanism corrected.** `mode:"append"` IS a valid enum for
   `PATCH /api/context/journal/agent`; the 400 (`context.invalid_body_field`) came from the
   Zod refine "**append requires `section`**" (`schemas.ts:83-88`) — the agent sent
   `{mode:"append", content}` with no section. The correct journal body is
   `{"mode":"append_to_file","content":...}` (EOF-append, no section). Fix = pin the shape
   in the task-flow (done); relaxing the endpoint was rejected — the schema is
   path-agnostic and the pinned contract suffices.
4. **M2 root cause located precisely.** The main-session env builder omitted `processKey`:
   `claude-code-core.ts:854-859` called `buildDaemonApiCliEnv` without it, so
   `PA_PROCESS_KEY` was never set and the CLI shim (`daemon-api-cli.ts:228-237`) could not
   attach `x-process-key` on the self route → 400 from `api/routes/agent.ts:469-479`.
   Same omission existed in the gemini/codex main sessions. **Fixed** (§5.1 WP2).
5. **M3's trigger corrected.** The "unquoted `&`" curl was actually **blocked by
   `bashCurlHook` because of the `-w/--write-out` flag** (file/stderr-sink format rule);
   the retry both quoted the URL and dropped `-w`. Guidance must (and now does) say both:
   quote `&` URLs AND never use `-w`.
6. **Morning "skip empty sources via fetch_report" (draft P2-a-morning) rejected as a
   quality risk**: `<fetch_report>` carries *posted* counts for the last window;
   `posted=0` ≠ `pending=0` (overnight pending observations persist). Replaced with
   batched parallel GETs (P2-c).
7. Minor: lesson maintenance job is 17:40 (roadmap 17:45). The 07-01 evening run failing
   at "$1" despite the $2.00 config was the pre-migration-0017 build still running; the
   current effective evening cap is $2.00 (07-02 succeeded at $1.77 under it).

## 5. Remediation — implemented vs deferred

### 5.1 Implemented 2026-07-01 (P0 + P1 + code WPs)

- **WP1 (P0-a): morning Stage A cap $1.50 → $2.00.**
  `plan-presets.ts:202` + schema seed (`schema.ts` Stage A row) + **migration
  `0025-morning-today-budget-bump`** (mirrors 0017: `updated_by='preset'` gate, old-band
  guards claude/opencode [1.49,1.51]→2.0 and codex/gemini [2.24,2.26]→3.0, table-absent
  guard) + lock-step tests (`plan-presets.test.ts`, `schema.test.ts`, new 0025 suite in
  `migrations.test.ts`). agent.md limits reconciled to the runtime envelope
  (morning-routine + evening-review both → 50/$2.00, with a comment explaining the
  override_snapshot footgun) + docs table updated.
  Rationale: fail($1.5–1.7) + retry(~$0.5) ≈ $2.0–2.2/day AND a half-written-today.md
  window vs one completed run ~$1.6–1.8. Net-negative cost, quality up. Stop-gap paired
  with P1/P2 so morning fits *comfortably* under $2.00.
- **WP2 (P1-a): `processKey` injection.** One-line env-builder fix in all three
  main-session sites (`claude-code-core.ts` execute, `gemini-cli-core.ts` runTurn,
  `codex-core.ts` runTurn): pass `processKey: params.processKey` into
  `buildDaemonApiCliEnv`. Kills the 2–4 debug turns/run and restores the Step 9
  self-report (journal metadata). Resume paths deferred (a resume turn has no
  `in_progress` row; the fix would only change 400→404). Side effect (improvement):
  delegated-run audit `trigger` now carries the real parent key instead of null.
- **WP3 (P0-b re-scoped): record real spend on budget-failed rows.**
  `morning/orchestrator.ts`: new module-local `extractStageSpend` (reuses the shared
  `extractFailureSpendInfo`, unwraps `BackendRouterHandledError` cause→main→fallback);
  `recordStageFailure` now lands `costUsd/costSource/numTurns/token fields` (+ spend
  modelId fallback) on the failed row via the existing `audit.logError` cost columns. No
  second row (logError UPSERTs the Stage A sentinel). Non-quota/no-spend failures
  unchanged. Note: the autonomous daily cost-cap now sees failure spend — intended
  accuracy. Explicit decision: `scheduleMorningRetry` health gate kept as-is.
- **WP4 (P1-b/c/d + P2-a/b/c/d): task-flow edits.**
  - evening: "Session constraints & turn economy" intro block (no-calendar contract for
    "prepare tomorrow" [P1-c], parallel independent GETs [P2-c], no re-GET of injected
    blocks [P2-b], pinned journal body shape [P1-b], turn-economy directive [P2-d]);
    Step 2 **skip-gate on the injected `<roadmap>`** before any lock (P2-a — safe:
    `## Long-term Plans` is injected verbatim, `roadmap-truncate.ts` only filters Agent
    Action Plan; the flow already accepts a 24h delay on 409).
  - morning: Global-rules additions (turn economy + batch the 5 independent GETs in one
    turn [P2-c], no re-GET of injected blocks [P2-b], curl rules: quote `&`, never `-w`
    [P1-d]); Step 9 telemetry paragraph generalized to "404 **or any 4xx** → one Agent Log
    line, continue, never debug headers/env".

### 5.2 Expected impact

| Change | Effect | Quality |
|---|---|---|
| WP1 cap $2.00 | kills the daily fail(~$1.5–1.7)+cold-prefix retry | ↑ no half-written today.md window |
| WP2 processKey | −2–4 turns/run + self-report restored | ↑ |
| WP3 spend recording | true cost visible in DB/cost dials (observability) | — |
| WP4 task-flows | evening ~21 → ~13–15 turns; morning −3–5 turns | neutral (steps unchanged) |

Rough target: evening **$1.77 → ~$0.9–1.2**/run; morning **~$2.0–2.2 (fail+retry) →
~$1.2–1.5**/run completed single-pass — **~40–50% reduction** with no output change.

### 5.3 Verification & rollout

- Tests: full `vitest run packages/daemon/src` green (task-flow/skill content pins
  included); daemon tsc clean.
- Post-deploy watch (next morning + evening runs):
  - morning completes in one pass under $2.00; if it still caps, the failed row now
    carries `cost_usd ≈ cap` + `num_turns` (WP3) so the DB alone shows it;
  - `agent-actions/self` returns 200 (no `session_identity_missing` in log);
  - no journal `invalid_body_field` 400; no `-w` hook blocks; no calendar probe log line;
  - evening turn count trending 21 → ~13–15; Step 2 skipped on quiet days without a lock
    round-trip.
- Measure per `agent_actions`: daily `result`, `cost_usd`, `num_turns` per process key
  (failure spend now recorded ⇒ double-execution cost is directly queryable).
- Quality guardrails: `today.md` same-day + `today_md_populated` criterion green; a week
  of roadmap/profile/lesson diffs eyeballed; evening journal + dossier writes continue.

### 5.4 Deferred (P3 — observation-gated, NOT implemented)

- **P3-a (rewritten): per-process effort knob.** The draft's "set effort medium" was a
  no-op — effort is already hardcoded `opus ? "high" : "medium"`
  (`claude-code-core.ts:851`); Sonnet 5 runs at medium today. The real lever is plumbing
  an envelope `effort` field (plan-presets → process_backend_config → backend-router →
  the query() call) and A/B-ing `low` for these bookkeeping routines. Gate: a week of
  quality diffs after P0–P2 settle.
- **P3-b: evening preset trim / partial slim.** One verified trace shows zero `Skill`
  invocations despite the "loads six skills" rationale for keeping the full preset
  (`claude-code-core.ts:219-224`). Instrument N runs first; if Skill stays unused,
  evaluate a slim-style custom prompt for evening (largest fixed prefix component).
- **P3-c: task-flow prose trim** (keep-list/rebuild-discipline blocks reworded
  outcome-focused; preserve the data-safety invariants verbatim).
- Resume-path `processKey` (needs `AgentResumeParams` change; no functional gain today).
- Optional: add `success_criteria` to evening-review's agent.md (currently `[]`) so the
  quality guardrail is machine-checked like morning's.

## 6. Appendix — key evidence anchors (log line numbers as of 2026-07-01)

- Evening 07-02 (UTC) success trace: 28006–28083 (21 turns, 17 curls, $1.7735, 0 Skill).
- Evening 07-01 miss: $1 cap (pre-0017 build), 28 turns, partial row cost $1.00 `sdk_partial`.
- Morning fail→retry: "Reached maximum budget ($1.5)" at 21829-21840 (06-30) and
  26311-26316 (07-01); spend blocks show costUsd 1.693 / 1.5, numTurns 29, `sdk_partial`;
  DB rows 8963/9163 had NULL cost (now fixed forward by WP3).
- `agent-actions/self` 400: 26304, 26515 (+ env-debug 26305).
- Journal 400: 28067 (`mode:"append"`, no section) → 28071 retry (`append_to_file`) → 200.
- Calendar probe skip: 28079. Lock dance on empty section: 28024/28027/28030.
- Curl hook block: 26106 (`-w` rejected) → 26109 quoted retry.
- Envelopes: `plan-presets.ts:186` (evening $2.0), `:202` (morning_today $2.0 post-WP1).
- Shed set: `claude-code-core.ts:235-238`. Model default: `shared/src/model-registry.ts:26`.
