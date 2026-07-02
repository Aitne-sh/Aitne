# Evaluation & Improvement Plan — Autonomy + Self-Improvement Loop

Status: SHIPPED 2026-07-01; adversarial re-review + hardening same day (see "Post-ship re-review" below) — all five work packages implemented in one session (WP1 SELF_IMPROVEMENT_PHASE2 v1 incl. the new `lesson-maintenance` builtin and the POST /api/notify trackNotification fix; WP2 worker self-verification, migration 0023; WP3 no_success_criteria lint; WP4 agent_chronic_failure activity-scan escalation, incl. a min-observations-floor exemption for chronic escalations; WP5 tuning graduation with one-time owner DM). Notable deviation: WP1's normalizer is self-contained (carry/bump/transcribe/derive) and runs in the context-write pipeline + a daily 17:40 sweep — see SELF_IMPROVEMENT_PHASE2_DESIGN.md status header.
Companion docs: SELF_IMPROVEMENT_PHASE2_DESIGN.md (WP1 source design), BACKGROUND_TASK_RUNNER_DESIGN.md (WP2 substrate), docs/design/appendices/feedback-learning-loop.md (Phase 1 summary — note: the full FEEDBACK_LEARNING_LOOP_DESIGN.md is gitignored and currently missing from disk)

## Context

The product goal is twofold: (1) the agent autonomously acts for the user and completes tasks at or above expected quality; (2) it improves itself via daily/weekly self-reflection loops. A full audit (3 parallel code audits, 2026-07-01) evaluated whether the implementation achieves this.

### Evaluation verdict

**Autonomy pipeline — largely achieved.** Routines/pollers/triggers, deterministic "should I act?" gate (`scheduler/activity-scan-gate.ts`), per-process budget/turn envelopes (`plan-presets.ts`), fail-loud background tasks, prompt-quality frame/clarify-back/playbooks (shipped 2026-06-30) are all implemented and wired.

**Daily/weekly loops — structurally implemented, but with three material gaps:**

1. **No semantic quality verification anywhere.** "Completed" = the worker called `finish()`. `success_criteria` checks are mechanical only (file exists, heading count, notification delivered). Nothing verifies a result satisfies its objective — the largest gap vs "at-or-above-expected quality".
2. **Lesson store runs without the agreed quality gates.** `SELF_IMPROVEMENT_PHASE2_DESIGN.md` v1 scope (A3: numeric cf, deterministic normalizer, contradiction detection, graduated expiration; A2.1: outcome rollup) is entirely design-only. Today: no confidence values, contradiction handling is LLM prose only, expiration is a stale flag the LLM may ignore.
3. **Weekly self-tuning is permanently in shadow mode** (`selfTuningEnabled=false`) with no defined graduation path. Recommendations/verdicts are recorded; nothing ever actuates.

Minor: user-created Agents often lack `success_criteria` (criteriaHitRate=null → no quality signal); chronically failing agents are invisible to the user until the Friday weekly review (backendFailureDmAlerts stays off by design); `FEEDBACK_LEARNING_LOOP_DESIGN.md` is gitignored AND missing from disk (authoritative design lost; only `docs/design/appendices/feedback-learning-loop.md` summary remains).

**User decisions (asked 2026-07-01):** reaction wiring stays DROPPED; artifact verification = worker self-verification (prompt-side + structural, no separate LLM judge leg); self-tuning = define graduation criteria, no auto-enable.

**Explicitly culled** (not in this plan): reaction/emoji wiring (user decision), retroactive transcript mining (nightly loop already covers; low incremental value), active elicitation (previously dropped, agree), A2.2 per-lesson attribution (stays deferred — signals too sparse), widen-retry generalization beyond fetch_window (envelopes just right-sized, no failure data supporting need), browser_task self-verification (different verification substrate — final-confirm gate + screenshots; note symmetry for follow-up), `feedbackOutcomeWeight*` knobs (no binding site until A2.2).

---

## Work packages (priority order)

**Step 0 (per user's design-doc preference):** save this evaluation + plan as a repo-root MD file, e.g. `QUALITY_LOOP_IMPROVEMENT_PLAN_2026-07.md` (English), including the FEEDBACK_LEARNING_LOOP_DESIGN.md-missing note.

**Migration numbering:** WP2 takes `0023` (only DB change in the plan). WP1 needs NO migration (cf lives in file trailers; rollup is read-only SQL).

---

### WP1 — SELF_IMPROVEMENT_PHASE2 v1: A3 quality gates + A2.1 outcome rollup (main axis)

Executes the already-approved design. Four independently shippable phases. Key design resolutions (doc-vs-code conflicts):

- **D1 — normalizer is self-contained** (no lesson identity exists): per written bullet — exact-text match vs previous file content → carry cf forward, corroboration bump `cf ← cf + (1−cf)·0.3`; else transcribed valid cf → clamp/keep; else derive `cf0 = round2(saturate(ev, K)·sourceFactor(src))` with `sourceFactor {explicit:1.0, self_critique:0.85, behavioral:0.7}`, K = feedbackPromotionThreshold; legacy unchanged bullet → conf map `{high:0.8, medium:0.5, low:0.3}`.
- **D2 — two triggers, one pure function:** synchronous branch in `core/context-validation/prepare-write.ts:prepareContextContentForWrite` for lessons-store targets (runs on every writer, file never persisted un-normalized) + daily mechanical sweep at 17:40 (before 17:45 roadmap pass) so expiration fires on zero-signal nights and hand-edited files get re-stamped.
- **D5 —** demote condition and injection floor both use `effectiveCf = cf · recencyDecay(last, now, 45d)`; eviction scoring uses persisted cf (its score already has a recency term).

**Phase 1 — cf + deterministic normalizer (~450 LOC + ~500 test):**
- `core/feedback/lesson-format.ts`: `Lesson.cf: number|null`, trailer emits `cf=` between conf and last; `lessonCf()` canonical read (null → conf map). Legacy files round-trip byte-stable.
- NEW `core/feedback/lesson-normalizer.ts` (pure): `normalizeLessonsFileContent(new, prev, opts)` — D1 rules, prose untouched, idempotent.
- `core/feedback/promotion-gate.ts`: `computeInitialCf`, `SOURCE_CF_FACTOR`, `saturate`.
- Hook: `prepare-write.ts` branch (match `policies/agent-lessons` + `policies/agents/<slug>/lessons`, reuse `isSafeAgentSlug`); thread `previousContent` from `api/routes/context/write.ts` PUT (~333) + PATCH (~826).
- `eviction-scorer.ts`: ev term → `weights.ev·log(ev+1)·lessonCf`; export `effectiveCf`.
- `lesson-injection.ts` + `context-builder.ts`: drop lessons below `confidenceFloor` before packing.
- `consolidation-prep.ts`: `<lesson cf="…">`, `<candidate cf0="…">` + note "carry cf verbatim; daemon re-stamps". `regeneralization-prep.ts`: emit cf too.
- Config knob `feedbackLessonConfidenceFloor` (default 0.25): `packages/shared/src/editable-config-keys.ts` tuple → rebuild shared → `runtime-settings.ts` schema+KEYS (coverage guard) → `config.ts` env default → dashboard `settings/lessons/page.tsx` + settings-navigation PAGE_KEYS.
- Task-flow `routine.evening_review.md` Step 4a trailer template (~line 256) gains `cf=<candidate cf0>`; `routine.monthly_review.md:293`: "omit cf=; daemon stamps it".

**Phase 2 — graduated expiration + daily sweep (~250 LOC):**
- `expirationVerdict(lesson) → keep|demote|archive`: constraint → keep; non-provisional && stale && effectiveCf < floor → demote (append `<!-- provisional -->`, reversible); provisional && last older than 2×staleDays → archive (remove bullet; raw evidence stays in feedback_signals). Re-promote: clear provisional when corroborated today && ev ≥ threshold.
- `consolidation-prep.ts`: advisory `action="keep|demote|archive"` attribute.
- NEW `core/feedback/lesson-maintenance.ts` daily sweep (mirror `roadmap-maintenance.ts` invariants: writeTracker.markWriting + snapshot + atomic write); scheduler callback + `index.ts` wiring (~1425).
- `evening_review.md`: replace "Staleness prune" (lines 270-273) with action-verdict wording.

**Phase 3 — contradiction detection + anti-whiplash (~220 LOC):**
- NEW `core/feedback/lesson-contradiction.ts` (pure): suspects by opposing kind (do-more↔do-less), negation cues (stop/don't/never/avoid…), token overlap ≥3; cap 3 suspects.
- `promotion-gate.ts`: `applyContradictionGuard` — hold non-explicit candidate as provisional when suspect cf ≥ guardCf and weightedEv < 1.5·threshold·maxCf; explicit-directive bypasses ("a user correction always wins").
- `consolidation-prep.ts`: `contradicts_ranks="2,5"` + `decision="hold-contradiction"`. Normalizer re-promote guard uses the same pairing.
- Config knob `feedbackContradictionGuardCf` (default 0.6, same 5-file plumbing).
- `evening_review.md` Step 4a: hold-contradiction handling + supersede/merge/keep-distinct adjudication.

**Phase 4 — A2.1 `<outcome_rollup>` (~150 LOC):**
- `self-performance-prep.ts`: reuse `gatherNotifications`; new `renderOutcomeRollup` — per action_type `sent/replied/corrected/ignored` + `correction_rate = corrected/(replied+corrected)` (omit at zero denominator; `acted` omitted — dormant; `ignored` never folded into rejection). Weekly block also gains correction_rate per type.
- `consolidation-prep.ts`: optional `<outcome_rollup>` element before `<consume>`; threaded from `dispatcher-scheduled-tasks.ts:prepareFeedbackWorksheet` (~1907-1986) when `feedbackOutcomeLearningEnabled` (new bool knob, default true).
- `evening_review.md` Step 4 intro: use rollup when judging promotions/demotions; never treat ignored as negative; never reward volume.
- Tracking-coverage audit: verify all delivery paths pass `signalDetector.trackNotification` (`adapters/notification-manager.ts:428,623`).

**Compat:** cf absent → null → conf-map default; injection bytes unchanged (trailers stripped); no flag day (daily sweep completes backfill in one day); worksheet changes attribute-only.

---

### WP2 — Background-task worker self-verification (user-directed shape)

**No separate LLM judge.** Self-verification runs inside the worker's existing turn budget; structural enforcement via the `finish()` MCP tool schema.

Verified facts: workers are Claude-SDK-only (`background-task-budget.ts` refuses non-claude) and the workdir-MD channel ALREADY exists — `background-task-driver.ts:194` writes `agent-assets/agent-profiles/background-task.md` as `CLAUDE.md` into the per-task cwd with `settingSources:["project"]`. So the user's suggestion maps onto: edit the existing profile + task-flow; do NOT add AGENTS.md/GEMINI.md (no reader exists).

- `services/background-task/background-task-tools.ts`: `finishArgsSchema` gains REQUIRED `verification: z.array({requirement: string≤300, met: boolean, evidence: string≤500}).min(1).max(10)` — worker cannot finish without submitting the checklist (Zod-validated at the MCP boundary, retried on failure). On any `met=false`: `outcomeDetail="completed_with_gaps"`, deterministic disclosure suffix appended to `draft` ("Note: N of M requirements not fully met: …"), `significance` prefixed — no silent degradation. Notify disposition NOT overridden (spawn-time policy is the owner's contract).
- `db/background-task-store.ts`: `verification` column (tolerant JSON parse), `markTerminal` persists it. Migration `0023-background-task-verification` (`ALTER TABLE background_task ADD COLUMN verification TEXT`, columnExists-guarded) + mirror in `schema.ts` CREATE TABLE.
- `api/routes/background-task.ts`: GET exposes `verification` + `outcomeDetail`.
- `agent-assets/task-flows/background_task.md`: new "Self-verification before finish" section — derive checklist from the brief's Expected output (fallback: Objective); attempt repair within remaining budget before finishing with `met=false`. Update finish() signature prose.
- `agent-assets/agent-profiles/background-task.md`: one principle bullet ("never claim completion your evidence doesn't support").
- `agent-assets/skills/background-task/SKILL.md`: tighten "Expected output" to "1–5 concretely verifiable requirements".
- No config knob (schema-enforced, not toggled). No POST body change, no envelope change.

---

### WP3 — success_criteria authoring universalization (small)

- `packages/shared/src/agent-lint.ts`: new non-blocking `no_success_criteria` lint (fires when definition has # Output contract but zero criteria). Covers create AND agent.md-edit path for free (`views.ts` ~539 + `validate-agent-md.ts` ~103 pass `successCriteriaCount`).
- `agent-assets/skills/agent-create/SKILL.md`: "derive 1–3 criteria from # Output" section with mechanical mapping (dated note → file_exists `{date}`; N sections → file_section_count; DMs user → notification_log type "agent"). NOT in the shared prompt-frame partial (schedule skill shares it byte-identical).
- Dashboard nudge: skip (lint is the actionable surface).

### WP4 — Chronic-failure surfacing via Activity Scan (deterministic, zero new LLM legs)

- NEW `listChronicallyFailingAgents(db, {threshold, lookbackHours:24})` in `db/agent-executions-store.ts` — last N terminal executions all error + recent. Covers built-ins and user Agents.
- `db/activity-scan-signals.ts`: `chronicAgentFailures[]` + `hoursSinceLastChronicFailureEscalation` (via gate audit rows).
- `scheduler/activity-scan-gate.ts:decideStage`: force stage3, reason `agent_chronic_failure`, 24h re-escalation throttle (const). New pure `renderSystemHealthBlock`.
- `core/dispatcher-activity-scan.ts` puts block on stage3 event data (whenever failures exist); `context-builder.ts` injects it.
- `routine.activity_scan.md`: `<system_health>` entry qualifies as Step 9 positive trigger (c); dedup pre-check still applies; suggest `/agents/<slug>` or "disable it". LLM owns phrasing under existing notify gates.
- Config knob `agentChronicFailureThreshold` (int, default 3, min 2 max 10) via standard recipe; no dashboard UI for v1. `backendFailureDmAlerts` untouched.
- Morning-routine second channel: dropped (2h scan already guarantees same-day surfacing).

### WP5 — Self-tuning graduation criteria (lightweight, NO auto-enable)

- Graduation = 3 consecutive qualifying weekly cycles (`TUNING_GRADUATION_CYCLES=3` const, not a knob). Qualifying: ≥1 recommendation, all verdicted, ≥1 apply, zero reject; zero-recommendation cycles neutral. ("Would-not-have-been-reverted" is unobservable in shadow — revert monitor only sees applied entries.)
- NEW pure `core/feedback/tuning-graduation.ts`: cycle-history append/tally/evaluate; bounded `runtime_state` blob `self_tuning.cycle_history` (last 12 cycles) — written at `prepareSelfTuningBlocks` (`dispatcher-scheduled-tasks.ts` ~2103) and `POST /api/tuning/verdicts`.
- Surfacing: one-time deterministic DM from the verdict route when graduation flips true (via existing `deps.sendNotification`, guarded by `self_tuning.graduation_notified_at` runtime_state key) + `GET /api/tuning/pending` gains `graduation:{graduated, qualifyingStreak, requiredCycles, notifiedAt}`. Weekly task-flow's "never mention tuning to the user" rule stays intact. Dashboard card: defer (`/settings/self-learning` is the skill-curation page, net-new UI).

---

## Sequencing

WP3 (small, isolated) → WP2 (main; takes migration 0023) → WP1 Phase 1→2→3→4 (each shippable) → WP4 → WP5. Batch agent-assets edits (WP1/WP2/WP3/WP4 task-flow+skill changes) to amortize full-suite runs.

## Verification

- Every phase: `pnpm --filter @aitne/shared build` before daemon tsc; 100% v8 coverage holds on touched covered modules (`core/feedback/*`, new modules); **full** `vitest run packages/daemon/src` whenever agent-assets content changes (prompt-string pins).
- WP1: new `lesson-normalizer.test.ts` (stamp/carry/bump/backfill/idempotency/prose-untouched), `lesson-contradiction.test.ts`, `lesson-maintenance.test.ts`; extend lesson-format/eviction-scorer/lesson-injection/promotion-gate/consolidation-prep/self-performance-prep/context-route tests. Migration-free — verify applySchema seeds untouched.
- WP2: `migrations.test.ts` 0023 idempotency (double-run + pre-existing column); tools/store/route tests for gap vs clean finish. End-to-end: POST a background task whose brief has a deliberately unmeetable requirement → artifact carries `completed_with_gaps` + disclosure in draft; clean task → no suffix.
- WP4: gate tests (force/throttle/audit snapshot); manual: mark an agent's executions failed ×3 in a dev DB → next scan tick escalates once, throttles 24h.
- WP5: pure-module streak tests; verdict-route one-time-DM test.
- Runtime smoke after WP1 P1: PUT a lessons file via the context API → response normalized (cf stamped); evening review next run → worksheet shows cf/cf0 attributes.

## Post-ship re-review (2026-07-01, same day)

Two independent adversarial reviewers swept the shipped diff for correctness bugs, over-engineering, and hidden runtime cost. Confirmed findings, all fixed same-day:

1. **Injection floor un-bound the highest-authority lessons (HIGH).** `effectiveCf < floor` filtered constraints and explicit corrections too; an *obeyed* directive generates no corroborating signals, so decay is monotonic and a fresh explicit correction (cf0 ≈ 0.33) vanished from injection after ~18 idle days — the obey→decay→vanish→re-correct whiplash loop. Fix: `kind=constraint` exempt from the floor; `src=explicit` floor-tested on persisted (undecayed) cf; inferred lessons keep the decayed test (design intent).
2. **Same-write instant re-promotion bypassed the promotion gate (MED-HIGH).** A freshly-written hold-provisional bullet with rounded `ev ≥ threshold` and `last = today` had its marker stripped by the normalizer in the same PATCH. Fix: re-promotion now requires GENUINE corroboration — the carry pass observed `ev` grow or `last` advance vs the previous file (`corroborated`), so new bullets and the daily sweep never re-promote.
3. **Worksheet note contradicted the graduated lifecycle (MED).** The `<existing_lessons>` note still said "drop any lesson marked stale=true" (the old hard-prune) alongside the new `action=` verdicts. Fix: note now says to honour `action=` verbatim.
4. **Chronic-failure detection: `skipped` rows broke the error streak (MED).** A gated-out dispatch (sleep/wake, morning-pending) interleaved into an error run reset the streak forever. Fix: skips are neutral in the streak walk; the lookback anchors on the newest ERROR.
5. **Heartbeat+Stage-2 ordering starved the chronic escalation (MED, config-conditional).** With `activityScanStage2Enabled=true`, every quiet tick took `heartbeat_due → stage2` and never reached the chronic clause. Fix: chronic clause moved above the heartbeat branch.
6. **Active-weave delivery could drop the gap disclosure (LOW-MED).** The task-delivery weave rules said "keep it compact" with no obligation to preserve the `Note: N of M requirements not fully met` line. Fix: explicit delivery rule — the disclosure must survive into the DM.
7. Hardening/simplification: transcribed cf on new bullets capped at `SOURCE_CF_FACTOR[src]` (anti-hallucination ceiling); provisional-marker-on-own-line cleared without leaving an entry-splitting blank line (idempotency); previous-file carry map scoped to the `## Lessons` section; the `repromoteGuard` injection hook replaced by a plain `contradictionGuardCf` option (guard built internally); unused `today` option removed end-to-end; disabled-feature sweep no longer emits a daily `skipped` audit row.

Deliberately KEPT after review (with reasons): `feedbackOutcomeLearningEnabled` kill switch (pattern-consistent with every other prompt-block toggle; zero runtime cost), `agentChronicFailureThreshold` as a config knob (approved in plan; PATCH-editable without restart), `stale=` + `action=` both on worksheet lessons (monthly regeneralization still consumes `stale=`), normalizer stats counters (they are the test oracle + sweep audit detail), the double preflight normalization on existing-file PUTs (result provably discarded; micro-cost).

Known accepted limits: same-topic non-conflicting candidates can be held one-to-two extra consolidations by the token-overlap contradiction heuristic (escape hatches: evidence accumulation, explicit corrections bypass); `src=explicit` mis-transcription widens the cf cap to 1.0 (bounded — user corrections outrank the guard regardless); no positive-reinforcement signal for obeyed lessons until A2.2; mechanical byte-cap enforcement in the sweep is a follow-up candidate.
