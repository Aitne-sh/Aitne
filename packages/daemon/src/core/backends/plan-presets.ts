/**
 * Process-key default-presets module.
 *
 * Aitne is designed to run on provider API keys (`ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY`). Headless-agent
 * subscription policies (notably Anthropic's, which prohibits running
 * the Claude Agent SDK on a Claude Pro/Max subscription) made
 * subscription-plan-driven routing inappropriate at distribution time
 * and were removed in 2026-04. The CLI-login fallback is still honored
 * for backends with no configured API key, but it is not the documented
 * operating mode.
 *
 * What this file does:
 *   - Drives the seed model selection from each process key's default
 *     tier (`getDefaultTierForProcessKey`). Lite-tier keys seed Haiku
 *     (Claude) / gpt-5.4-mini (Codex) / flash-lite (Gemini); medium-tier
 *     keys seed Sonnet / gpt-5.4 / 3.1-flash-lite-preview; high-tier keys seed
 *     Opus / gpt-5.4 / 3.1-pro-preview. (Codex's high tier collapses to
 *     gpt-5.4 by default via `SEED_HIGH_TIER_OVERRIDE` in model-registry.ts
 *     — gpt-5.5 is Opus-priced and operator-pinned, not the silent default.)
 *   - Exposes `setMainBackend(db, backendId)` — writes
 *     `backend_global_defaults.default_backend` only. No preset
 *     application, no per-process row mutation. The dashboard's main-
 *     switch confirm dialog calls this directly.
 *   - Exposes `applyDefaultPresets(db, options?)` — seeds every
 *     configurable process_backend_config row at install time. Re-
 *     callable from the dashboard "Reset to defaults" button.
 *   - Preserves `previewMainSwitchImpact()` so the dashboard can warn
 *     about user-pinned cross-backend rows that would survive a switch.
 *
 * Tier-to-model resolution lives in `model-registry.ts:defaultModelForTier`.
 */

import type Database from "better-sqlite3";
import {
  CONFIGURABLE_PROCESS_KEYS,
  getDefaultTierForProcessKey,
  isBackendId,
  type BackendId,
  type BackendModelTier,
  type ProcessKey,
  type ProcessModelTier,
} from "@aitne/shared";
import { createLogger } from "../../logging.js";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  defaultModelForTier,
  findRegisteredModel,
} from "./model-registry.js";
import { setProcessBackendConfig } from "./process-config-cascade.js";

const logger = createLogger("default-presets");

/**
 * Per-execution envelope applied to seeded rows. Used to bound the
 * worst-case dispatch cost; operators can widen them per-row from the
 * dashboard. The "lite" envelope is intentionally tighter — these tasks
 * are short-shaped tool sequences, not free-form chat. The "high"
 * envelope is generous because a high-tier seed implies the task is
 * one-shot, generative, and benefits from extra reasoning room.
 *
 * Values are sized for the Claude SDK / OpenCode (Anthropic-backed)
 * runtime: both abort mid-turn when the running cost crosses
 * `maxBudgetUsd`. Codex and Gemini have no in-flight cost enforcement
 * (Codex CLI / Gemini CLI run to completion, then the daemon checks the
 * actual cost), so an identical $0.20 ceiling fails sessions that a
 * Claude run would have truncated and returned partially. `applyBackendBudgetFactor`
 * raises the post-hoc ceiling for those backends so equivalent work
 * lands inside the cap.
 */
const ENVELOPE_BY_TIER: Record<
  BackendModelTier,
  { maxTurns: number; maxBudgetUsd: number }
> = {
  lite:   { maxTurns: 20, maxBudgetUsd: 0.2 },
  medium: { maxTurns: 50, maxBudgetUsd: 1.0 },
  high:   { maxTurns: 80, maxBudgetUsd: 3.0 },
};

/**
 * Per-backend post-hoc budget multipliers. Applied to every envelope's
 * `maxBudgetUsd` (tier nominal AND per-process override) by
 * `applyBackendBudgetFactor`. `maxTurns` is unaffected — turns are about
 * shape, not cost.
 *
 * Claude / OpenCode = 1.0 (SDK aborts mid-turn at the cap, so the
 * nominal value also bounds the actual). Codex / Gemini are scaled up so
 * the post-hoc check matches the *effective* spend a Claude session
 * lands on after mid-turn abort, rather than rejecting any single turn
 * that would have been truncated.
 *
 * Targets: lite $0.20 → $0.50, medium $1.00 → $1.50, high $3.00 → $5.00.
 */
const BACKEND_BUDGET_FACTOR: Partial<
  Record<BackendId, Record<BackendModelTier, number>>
> = {
  codex:  { lite: 2.5, medium: 1.5, high: 5 / 3 },
  gemini: { lite: 2.5, medium: 1.5, high: 5 / 3 },
};

/**
 * Scale a `maxBudgetUsd` for the given backend + tier. Exported so the
 * cross-backend cascade in `process-config-cascade.ts` can apply the
 * same factor to its INHERITOR_DEFAULTS when an operator edits
 * `message.dm` on a non-Claude backend.
 *
 * Rounds to 2 decimals so the DB-stored cents-precision value is stable.
 */
export function applyBackendBudgetFactor(
  backendId: BackendId,
  tier: BackendModelTier,
  baseBudgetUsd: number,
): number {
  const factor = BACKEND_BUDGET_FACTOR[backendId]?.[tier] ?? 1;
  if (factor === 1) return baseBudgetUsd;
  return Math.round(baseBudgetUsd * factor * 100) / 100;
}

/**
 * Per-process envelope overrides. Layered on top of `ENVELOPE_BY_TIER` so
 * a process key whose worst-case cost is structurally heavier (or lighter)
 * than its tier's nominal envelope can be sized correctly without burning
 * a whole tier on the difference.
 *
 * **Lock-step invariant.** Every entry here MUST equal the corresponding
 * `(max_turns, max_budget_usd)` in the schema-seed row in `schema.ts`.
 * `applyDefaultPresets` is the only writer of these envelopes after
 * install — both `force:false` (main-backend cascade) and `force:true`
 * (Reset) take their values from this map. If schema and override
 * diverge, the override wins on any apply-defaults call and silently
 * reshapes the envelope. The `preserves every schema-seed envelope`
 * regression test in `plan-presets.test.ts` walks every row and pins
 * this for all configurable process keys.
 *
 * Inclusion rule: a process key needs an entry here iff its schema-seed
 * envelope differs from `ENVELOPE_BY_TIER[<its default tier>]`. Process
 * keys whose schema seed matches the bare tier envelope (e.g.
 * `message.mention` / `dashboard.chat` = medium 50/$1.00) do not need
 * an entry. (`message.dm` USED to be such a key, but now carries a
 * wider $5.00 ceiling — see its entry below.)
 */
const ENVELOPE_OVERRIDES_BY_PROCESS_KEY: Partial<
  Record<ProcessKey, { maxTurns: number; maxBudgetUsd: number }>
> = {
  // ── Medium-tier WIDER envelope ────────────────────────────────────────
  //
  // `message.dm` is the operator's primary conversational surface. Each
  // turn re-processes the full DM history (which can carry prior
  // browser-task reports + screenshots) and routinely runs $0.70-0.80 on
  // Sonnet, hugging the old $1.00 medium nominal. Legitimate multi-step
  // turns (dispatch a browser task, answer a follow-up, do real tool
  // work) tipped over $1.00 mid-turn and surfaced a
  // BackendQuotaError(max_budget_usd) to the user even when the work
  // itself succeeded. $5.00 is a per-turn CEILING, not a target. Kept in
  // lock-step with the schema-seed row; bumped for upgrading installs by
  // migration 0006. (message.mention / dashboard.chat stay on the bare
  // medium nominal and need no entry.)
  "message.dm": { maxTurns: 50, maxBudgetUsd: 5.0 },
  // ── Medium-tier tighter envelopes ────────────────────────────────────
  //
  // `routine.today_refresh` is drift-triggered. A typical refresh on
  // Sonnet runs ~$0.10 in 4 turns, but a busy-calendar drift (many/large
  // pending calendar observations) compounded by a 409 morning-lock retry
  // loop tripped the prior $0.30 cap and surfaced
  // BackendQuotaError(max_budget_usd) with no fallback. Realigned to
  // $0.50 — the medium-tier 20-turn peer dashboard.docs_qa value, well
  // under the superset morning_routine_today ($2.00). Bumped for upgrading
  // installs by migration 0009; keep in lock-step with the schema-seed row.
  "routine.today_refresh": { maxTurns: 20, maxBudgetUsd: 0.5 },
  // Above medium nominal: V2-disabled monolithic path absorbs fetch +
  // synthesis in one session and tripped $1 on Sonnet. Lock-step with
  // the schema-seed row.
  "routine.morning_routine": { maxTurns: 50, maxBudgetUsd: 2.0 },
  // routine.evening_review — medium tier, but connector-capable (it reaches
  // the calendar connector in native / delegated-same-backend modes, like
  // morning_routine) and many-turn: its ~130 K cached prefix (full preset +
  // the ~25 K user-scope claude.ai connector schemas + the untruncated
  // <today> Agent Log) is re-read on every one of its ~28 curl-driven turns,
  // so a busy day tips the bare $1.00 medium nominal mid-turn and surfaces
  // BackendQuotaError(max_budget_usd). Realigned to $2.00 to match its
  // morning_routine sibling (also medium, connector-capable, many-turn).
  // Bumped for upgrading installs by migration 0017; keep in lock-step with
  // the schema-seed row.
  "routine.evening_review": { maxTurns: 50, maxBudgetUsd: 2.0 },
  // morning-routine-optimization.md Phase 5 — Stage A of the split
  // pipeline. Originally seeded at $0.50, realigned to $1.50 when the
  // task-flow body stayed at ~34 KB instead of shrinking. The
  // sonnet-4-6 → sonnet-5 default bump (more tokens per text + more
  // agentic = more prefix re-reads per run) pushed real runs to
  // ~$1.50-1.69 in 29 turns, so the SDK's mid-turn abort produced a
  // daily BackendQuotaError(max_budget_usd) fail followed by the
  // today.md-health retry chain re-running the whole session — a
  // fail+retry day costs MORE (~$2.0-2.2 across both runs) than one
  // completed run under a wider cap, and risks a half-written
  // today.md. Realigned to $2.00, matching the parent
  // routine.morning_routine and its structural twin
  // routine.evening_review (both medium-tier, connector-capable,
  // many-turn). Stage A sharing the parent's ceiling is accepted: the
  // parent envelope only bounds the V2-disabled monolithic path, not
  // a Stage A + parent sum. Bumped for upgrading installs by
  // migration 0025; keep in lock-step with the corresponding
  // schema-seed row.
  "routine.morning_routine_today": { maxTurns: 50, maxBudgetUsd: 2.0 },
  // morning-routine-optimization.md Phase 5 — Stage B is template-
  // driven daily-journal authoring on lite tier. The original $0.10 cap
  // was sized to a 15 KB prompt projection; production showed Stage B's
  // assembled prompt at ~21 KB and Haiku cache_creation alone (charged
  // at 1.25x input) consumes ~$0.06 on cold start. A single Bash
  // tool round-trip then tipped over $0.10 mid-turn, producing
  // BackendQuotaError(max_budget_usd) before Stage B could PUT
  // `daily/<yesterday>.md` — the user-facing journal was silently
  // missing for every recurring run. Realigned to $0.30: 3x the
  // observed typical spend (matching the headroom convention also
  // used by routine.today_refresh) and below the lite-tier nominal
  // ceiling so the cap still binds in pathological cases. Keep in
  // lock-step with the corresponding schema-seed row.
  "routine.morning_routine_journal": { maxTurns: 20, maxBudgetUsd: 0.3 },
  // `dashboard.docs_qa` is a focused QA panel, hard-clamped to medium
  // tier per §10.1. INHERITOR_DEFAULTS in process-config-cascade.ts
  // mirrors this envelope so cascade writes from message.dm don't bleed
  // the source's caps into the inheritor.
  "dashboard.docs_qa": { maxTurns: 20, maxBudgetUsd: 0.5 },
  // `git.project.update` is an operator-driven update pass — narrower
  // than the medium-tier nominal. `retemplate` is wider because re-template
  // work is structurally unbounded by shape. init stays on the medium
  // default 50/$1.00 (no override needed).
  "git.project.update": { maxTurns: 30, maxBudgetUsd: 0.5 },
  "git.project.retemplate": { maxTurns: 100, maxBudgetUsd: 2.0 },
  // P22 skill self-optimization. Read-only workdir besides curation API;
  // wider turn count (60) for survey work, tighter $ cap ($0.5) since
  // proposals are bounded by per-run rate limit (max 20).
  "routine.skill_curation": { maxTurns: 60, maxBudgetUsd: 0.5 },
  // `routine.roadmap_refresh` is NOT in `ROUTINE_WINDOWS`, so its
  // dispatcher does not attach a `routine.fetch_window` pre-pass. In
  // `native` integration mode the synthesis session itself drives the
  // Calendar (90d) / Mail / Notion MCP fan-out — that fan-out blew past
  // the medium-tier nominal $1.00 cap and surfaced as
  // BackendQuotaError(max_budget_usd) on Sonnet 4.6. 60 turns / $3.00
  // matches the high-tier envelope ceiling, sized so the cap still
  // binds well before runaway but accommodates a native-mode session
  // that does both fetch and synthesise in one run.
  "routine.roadmap_refresh": { maxTurns: 60, maxBudgetUsd: 3.0 },
  // ── WIKI_BUILDER_DESIGN.md Phase 1 ────────────────────────────────────
  //
  // `ingest_url` is bounded like a focused importer (note: schema seed
  // says $1.00; align here so apply-defaults reproduces the install
  // value rather than silently shrinking it). `compile` can fan in many
  // raw notes and intentionally gets a larger synthesis envelope.
  "wiki.ingest_url": { maxTurns: 30, maxBudgetUsd: 1.0 },
  "wiki.compile": { maxTurns: 100, maxBudgetUsd: 5.0 },
  // WIKI_BUILDER_DESIGN.md Phase 3 — lint is a structured pass over the
  // index + recent log entries; its envelope is intentionally tighter
  // than the medium-tier default (50/$1.00). wiki.ask, wiki.trace, and
  // wiki.connect deliberately sit on the medium tier default and are
  // NOT listed here.
  "wiki.lint": { maxTurns: 40, maxBudgetUsd: 0.5 },
  // ── Lite-tier tighter envelopes ──────────────────────────────────────
  //
  // cost-reduction-structural §A — per-observation summarizer. Single
  // non-tool model call per observation; 1 turn / $0.05 is the absolute
  // ceiling. The dispatcher clamps allowedToolsOverride to [] so this
  // envelope is defense-in-depth on top of the prompt's "no tools"
  // contract.
  "observation.summarize": { maxTurns: 1, maxBudgetUsd: 0.05 },
  // cost-reduction-structural §B — Stage 2 lite-tier triage. Strict
  // JSON-only output (~2K input / ~50 output) decides log_only vs
  // escalate. 1 turn / $0.05 mirrors observation.summarize.
  "routine.activity_scan.triage": { maxTurns: 1, maxBudgetUsd: 0.05 },
  // docs/design/appendices/routine-data-acquisition.md §6.2 / §6.9 pre-pass fetcher.
  // The lite-tier nominal ($0.20) under-provisioned the morning fan-out
  // (2 mail providers × N accounts + calendar + notion) and tripped
  // BackendQuotaError(max_budget_usd) mid-fetch — widened to $0.50 so
  // the cap still binds well before runaway but accommodates the real
  // worst-case fan-out. Keep in lock-step with the corresponding
  // schema-seed row.
  //
  // maxTurns 10 → 20 (FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.3, 2026-07-01):
  // the N4 cut to 10 was sized from ONE install's tail (P50=3 / P95=6 /
  // P99=8 over 502 runs) whose measured max=11 already exceeded the cap.
  // Turn demand is data-dependent — item volume (>200 items → multiple
  // submit_observations batches), per-item thread-detail wandering on
  // Haiku, pagination, ToolSearch schema loads — and a different install's
  // distribution sits to the right of the reference one: production runs
  // were killed by the SDK at `error_max_turns` with no final turn to emit
  // the closing JSON, then retried 3× at full cost (~$0.57/tick wasted).
  // N4's own rationale stands: turns bound WANDER, not cost —
  // max_budget_usd $0.50 remains the stop-loss, and a wander session at
  // ~$0.02/turn trips the budget cap long before 20 runaway turns matter.
  // Bumped for upgrading installs by migration 0021; keep in lock-step
  // with the schema-seed row.
  "routine.fetch_window": { maxTurns: 20, maxBudgetUsd: 0.5 },
  // BROWSER_HISTORY_INTEGRATION_PLAN P3 — keep these in lock-step with
  // the schema seed rows (research_offer_dm has NO seed row — this
  // entry is its only default, materialized on main-backend switch or
  // Reset).
  //
  // cluster_update / offer_dm budgets are STOP-LOSSES sized to cover
  // one cold-prompt-cache run, not per-run cost targets
  // (RESEARCH_CLUSTER_COST_FIX_PLAN.md RC2/F3): the SDK budget check
  // only fires between turns, and a cold run writes the full session
  // prefix to prompt cache (~$0.13-0.30 observed on Haiku) before the
  // check can abort — the original floor values ($0.05/$0.02) killed
  // every cold run AFTER the money was spent and the journal was never
  // written. With the F1 per-agent-day enqueue stamp, cluster_update
  // runs at most once per cluster per day, so $0.50 bounds daily spend
  // per cluster. Bumped for upgrading installs by migration 0012.
  // research_dispatch carries the WebFetch fan-out; sits at the bare
  // medium nominal (50/$1.00). research_wiki_summary is tighter
  // (30/$0.50) — it reads the cluster journal the agent already wrote
  // and composes from it, with bounded external work.
  "routine.research_cluster_update": { maxTurns: 5, maxBudgetUsd: 0.5 },
  "routine.research_offer_dm": { maxTurns: 5, maxBudgetUsd: 0.15 },
  "routine.research_dispatch": { maxTurns: 50, maxBudgetUsd: 1.0 },
  "routine.research_wiki_summary": { maxTurns: 30, maxBudgetUsd: 0.5 },
  // BROWSER_TASK_REDESIGN_PLAN.md §5 — open-ended browser sub-agent.
  // Medium-tier nominal is 50/$1.00; the §5 envelope picks a tighter
  // 30-turn cap because the per-turn cost rises with multimodal
  // screenshot input (one PNG ≤ 1MB per visual confirmation, and the
  // typical sub-agent loop captures 4-5 over its lifetime). 30 turns
  // keeps the upper bound bounded while $1.00 absorbs the screenshot
  // cost without tripping BackendQuotaError. Lock-step with the
  // schema-seed row.
  "browser_task": { maxTurns: 30, maxBudgetUsd: 1.0 },
  // BACKGROUND_TASK_RUNNER_DESIGN.md §6 — generic detached worker. The
  // medium-tier nominal (50/$1.00) is too tight for long-running research
  // / multi-repo audits, so the seed picks 40 turns / $2.00 (the
  // medium-tier base in background-task-budget.ts). Kept in lock-step
  // with the schema-seed row so a force=true backend-switch reset
  // preserves this envelope instead of clobbering it to the tier default.
  "background_task": { maxTurns: 40, maxBudgetUsd: 2.0 },
};

/**
 * Resolve the seed `(model, envelope)` for a configurable process key on
 * the given backend. The model is selected by the process key's default
 * tier (lite / medium / high) and the backend's per-tier canonical pick
 * from `defaultModelForTier`. A per-process entry in
 * `ENVELOPE_OVERRIDES_BY_PROCESS_KEY` wins over the tier envelope when
 * the worst-case shape of that key diverges from its tier's nominal cost.
 */
export function resolveDefaultBindingFor(
  backendId: BackendId,
  processKey: ProcessKey,
): { model: string; maxTurns: number; maxBudgetUsd: number } {
  const tier = getDefaultTierForProcessKey(processKey);
  const envelope =
    ENVELOPE_OVERRIDES_BY_PROCESS_KEY[processKey] ?? ENVELOPE_BY_TIER[tier];
  return {
    model: defaultModelForTier(backendId, tier),
    maxTurns: envelope.maxTurns,
    maxBudgetUsd: applyBackendBudgetFactor(
      backendId,
      tier,
      envelope.maxBudgetUsd,
    ),
  };
}

/**
 * Result shape of `applyDefaultPresets`. `defaultsUpdated` matches the
 * legacy preset return so callers (setup wizard, dashboard reset
 * button) can decide whether to mirror the envelope into live
 * `AgentConfig`.
 */
export interface ApplyDefaultPresetsResult {
  backend: BackendId;
  processRowsUpdated: number;
  processRowsSkipped: number;
  defaultsUpdated: boolean;
}

export interface ApplyDefaultPresetsOptions {
  /**
   * When true, overwrites rows regardless of `updated_by`. Setup wizard
   * passes `true` on first install. Dashboard "Reset" button passes
   * `false` so user-pinned rows survive.
   */
  force?: boolean;
  /**
   * When provided, also rewrites `default_backend` to this value. The
   * dashboard main-switch flow passes the new backend; the install
   * seeder passes the wizard-selected backend.
   */
  defaultBackend?: BackendId;
}

/**
 * Seed `process_backend_config` rows for every configurable process
 * key. Called from the setup wizard at first install and from the
 * dashboard's "Reset to defaults" action.
 *
 * Behaviour:
 *   - Determines the active backend from `defaults.defaultBackend` or
 *     `backend_global_defaults.default_backend` (claude as last resort).
 *   - Seeds each row with a model resolved by `resolveDefaultBindingFor`
 *     (lite tier seeds Haiku on Claude / gpt-5.4-mini on Codex /
 *     flash-lite preview on Gemini; medium tier seeds Sonnet / gpt-5.4
 *     / 3.1-flash-lite-preview; high tier seeds Opus / gpt-5.4 /
 *     3.1-pro-preview — Codex's high tier intentionally collapses to
 *     gpt-5.4, see `SEED_HIGH_TIER_OVERRIDE`).
 *   - Updates `default_lite_model` / `default_medium_model` /
 *     `default_high_model` / `default_backend` on the singleton row.
 *   - Skips rows whose `updated_by='user'` unless `force: true`.
 */
export function applyDefaultPresets(
  db: Database.Database,
  options: ApplyDefaultPresetsOptions = {},
): ApplyDefaultPresetsResult {
  const targetBackend =
    options.defaultBackend ?? readActiveBackend(db) ?? "claude";

  let processRowsUpdated = 0;
  let processRowsSkipped = 0;

  const transaction = db.transaction(() => {
    db.prepare(
      // updated_by='preset' — this re-seeds the model columns from the preset
      // table, so their provenance is system-seeded, NOT an operator pin (audit
      // A1). A future value-only default bump may forward-track a 'preset' row.
      `INSERT INTO backend_global_defaults (
         singleton,
         default_backend,
         default_lite_model,
         default_medium_model,
         default_high_model,
         updated_at,
         updated_by
       ) VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'preset')
       ON CONFLICT(singleton) DO UPDATE SET
         default_backend = excluded.default_backend,
         default_lite_model = excluded.default_lite_model,
         default_medium_model = excluded.default_medium_model,
         default_high_model = excluded.default_high_model,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = 'preset'`,
    ).run(
      targetBackend,
      liteModelFor(targetBackend),
      mediumModelFor(targetBackend),
      highModelFor(targetBackend),
    );

    for (const processKey of CONFIGURABLE_PROCESS_KEYS) {
      const existing = db
        .prepare(
          `SELECT updated_by FROM process_backend_config WHERE process_key = ?`,
        )
        .get(processKey) as { updated_by: string } | undefined;

      if (existing && existing.updated_by === "user" && !options.force) {
        processRowsSkipped += 1;
        continue;
      }

      const binding = resolveDefaultBindingFor(targetBackend, processKey);
      setProcessBackendConfig(db, {
        processKey,
        mainBackend: targetBackend,
        mainModel: binding.model,
        fallbackBackend: null,
        fallbackModel: null,
        maxTurns: binding.maxTurns,
        maxBudgetUsd: binding.maxBudgetUsd,
        updatedBy: "preset",
      });
      processRowsUpdated += 1;
    }
  });

  transaction();
  logger.info(
    {
      backend: targetBackend,
      processRowsUpdated,
      processRowsSkipped,
      force: options.force === true,
    },
    "Applied default process presets",
  );

  return {
    backend: targetBackend,
    processRowsUpdated,
    processRowsSkipped,
    defaultsUpdated: true,
  };
}

/**
 * Set the active main backend. Writes `default_backend` and ensures the
 * chosen backend's `backends.enabled = 1`. Does not mutate
 * `process_backend_config` rows or `default_lite_model` /
 * `default_medium_model` / `default_high_model`. Callers that want a full
 * re-seed should call `applyDefaultPresets({ defaultBackend })` afterwards.
 *
 * The enable bump is intentional: a backend chosen as main is the
 * actively-routed default. Without flipping `enabled`, the wire-boundary
 * validator (chat SSE, fallback enable check) and the
 * `BackendStatusRow.enabled` flag stay false, leaving the dashboard in a
 * "main backend exists but is disabled" state — a contradiction the
 * setup wizard previously stumbled into. Idempotent: already-enabled
 * rows just bump `updated_at`.
 */
export function setMainBackend(
  db: Database.Database,
  backendId: BackendId,
): void {
  const tx = db.transaction(() => {
    db.prepare(
      // On INSERT (no row yet) the models are seeded from the preset table →
      // updated_by='preset'. On CONFLICT only default_backend changes; the model
      // columns (and thus their provenance) are left as-is, so updated_by is NOT
      // overwritten — switching the active backend must not silently re-classify
      // an operator's model pin (audit A1).
      `INSERT INTO backend_global_defaults (
         singleton,
         default_backend,
         default_lite_model,
         default_medium_model,
         default_high_model,
         updated_at,
         updated_by
       ) VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'preset')
       ON CONFLICT(singleton) DO UPDATE SET
         default_backend = excluded.default_backend,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      backendId,
      liteModelFor(backendId),
      mediumModelFor(backendId),
      highModelFor(backendId),
    );

    db.prepare(
      `UPDATE backends
          SET enabled = 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    ).run(backendId);
  });
  tx();
}

/**
 * Preview a prospective main-switch without writing. Returns the
 * cross-backend pins the operator would keep (rows with `updated_by =
 * 'user'` whose `main_backend` differs from the target). The dashboard
 * shows these in the confirm dialog so the operator can decide whether
 * to keep them or click "Reset to defaults" after switching.
 */
export function previewMainSwitchImpact(
  db: Database.Database,
  targetBackend: BackendId,
): {
  preservedCrossBackendPins: Array<{
    processKey: string;
    pinnedBackend: BackendId;
    pinnedModel: string;
  }>;
} {
  const rows = db
    .prepare(
      `SELECT process_key, main_backend, main_model
         FROM process_backend_config
        WHERE updated_by = 'user'`,
    )
    .all() as Array<{
      process_key: string;
      main_backend: string;
      main_model: string;
    }>;

  const preservedCrossBackendPins: Array<{
    processKey: string;
    pinnedBackend: BackendId;
    pinnedModel: string;
  }> = [];

  for (const row of rows) {
    if (!isBackendId(row.main_backend)) continue;
    if (row.main_backend === targetBackend) continue;
    preservedCrossBackendPins.push({
      processKey: row.process_key,
      pinnedBackend: row.main_backend,
      pinnedModel: row.main_model,
    });
  }
  return { preservedCrossBackendPins };
}

/**
 * Infer the tier of a (backend, model) pair from the model registry.
 * Used by the dashboard's process-config card to render the tier badge
 * next to a pinned row. Returns `null` when the model is unknown.
 */
export function inferTierForModel(
  backendId: BackendId,
  modelId: string,
): ProcessModelTier | null {
  const model = findRegisteredModel(backendId, modelId);
  return model?.tier ?? null;
}

// ── Internal helpers ────────────────────────────────────────────────────

function readActiveBackend(db: Database.Database): BackendId | null {
  try {
    const row = db
      .prepare(
        `SELECT default_backend FROM backend_global_defaults WHERE singleton = 1`,
      )
      .get() as { default_backend: string } | undefined;
    if (!row || !isBackendId(row.default_backend)) return null;
    return row.default_backend;
  } catch {
    return null;
  }
}

function liteModelFor(backendId: BackendId): string {
  if (backendId === "claude") return DEFAULT_CLAUDE_LITE_MODEL;
  return defaultModelForTier(backendId, "lite");
}

function mediumModelFor(backendId: BackendId): string {
  if (backendId === "claude") return DEFAULT_CLAUDE_MEDIUM_MODEL;
  return defaultModelForTier(backendId, "medium");
}

function highModelFor(backendId: BackendId): string {
  if (backendId === "claude") return DEFAULT_CLAUDE_HIGH_MODEL;
  return defaultModelForTier(backendId, "high");
}
