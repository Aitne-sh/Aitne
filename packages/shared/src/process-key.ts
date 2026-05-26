import type { Event, MessageEvent } from "./types.js";
import { isMessageEvent } from "./types.js";

export const CONFIGURABLE_PROCESS_KEYS = [
  "routine.morning_routine",
  // morning-routine-optimization.md Phase 5 — pipeline split keys. The
  // parent `routine.morning_routine` key stays as the pipeline-entry
  // envelope read by the pre-routine gate (`morningRoutineRanToday`),
  // but the underlying LLM work flows through these two stages so each
  // can be tier/budget tuned independently from `/settings/models`.
  // Stage A = today.md synthesis (medium, retains $1.00-class envelope
  // with a tighter $0.50 cap reflecting the shrunk task-flow). Stage B
  // = daily journal authoring (lite, $0.10 envelope — minimal skill
  // bundle + journal-format spec keeps it comfortably under cold-start
  // floor). `applyDefaultPresets` cascades both on a main-backend
  // switch via the standard CONFIGURABLE iteration.
  "routine.morning_routine_today",
  "routine.morning_routine_journal",
  "routine.evening_review",
  "routine.weekly_review",
  // routine.monthly_review stays registered as a known ProcessKey so the
  // task-flow / windows / context-builder branches remain wired, but the
  // routine itself is gated OFF by default (kill switch in
  // packages/daemon/src/settings/runtime-settings.ts:monthlyReviewEnabled).
  // Re-enable path: Mirror+Prune redesign — see the header note in
  // agent-assets/task-flows/routine.monthly_review.md.
  "routine.monthly_review",
  "routine.hourly_check",
  "message.dm",
  "message.mention",
  "dashboard.chat",
  "dashboard.docs_qa",
  "agent.task",
  // SCHEDULED-DM-IMPLEMENTATION-PLAN §5.3 — DM-tone scheduled sessions
  // (morning briefing, etc.) resolve to this key so the dashboard
  // /settings/models surface can target tier/budget independently of
  // the non-DM `agent.task` family.
  "agent.dm_task",
  "calendar.change",
  "gmail_classify",
  "github.pull_request.review_requested",
  "github.assigned",
  "github.security_alert",
  "github.workflow_run.failed",
  "git.push.detected",
  "git.local_ahead.stale",
  "git.push.force_pushed",
  "git.branch.created",
  "git.tag.created",
  "git.merge_to_default",
  "git.project.init",
  "git.project.update",
  // Architecture section refresh — one-shot agent session that reads the
  // repo and produces a deep architecture analysis to fill the
  // `## Architecture` block of `git/<slug>/overview.md`. Auto-enqueued
  // from the manual `POST /repositories/:id/management/init` endpoint and
  // from the dashboard's "Refresh architecture" button. The agent submits
  // the section markdown via the chokepoint
  // `PUT /api/repositories/:id/architecture-section`; daemon performs the
  // section replacement so other sections (Notable Changes, Daily Activity
  // Log) cannot be overwritten by accident.
  "git.project.refresh_architecture",
  // P6 (git-lifecycle-and-triggers.md Decision 8) — heavy-tier one-shot
  // session that re-conforms existing context/projects/<slug>.md and
  // context/git-repos/<slug>.md files to the current template. Triggered
  // from the dashboard's "Apply current template" button only; the daemon
  // pre-backups every target file before enqueue so the agent's writes
  // are reversible from `processResult` on failure.
  "git.project.retemplate",
  // P22 — skill self-optimization (appendix p22-skill-self-optimization.md).
  // Cron-fired at the operator's chosen cadence (daily/weekly/monthly). Runs
  // in an isolated workdir under ~/.personal-agent/optimizer-workdir/<run-id>/
  // with allowedTools = curl(skill-curation API) + Read only — no Edit/Write.
  // Operator-configurable from /settings/self-learning.
  "routine.skill_curation",
  // cost-reduction-structural §A — per-observation summarizer. Listed as
  // configurable so `applyDefaultPresets` re-seeds it on a main-backend
  // switch (the install seed pins to claude+Haiku, but a Gemini-only
  // operator should land on a Gemini binding so the worker stays on
  // the same backend lane). Surfaces on /settings/models per the design
  // doc's "Operator can override" requirement.
  "observation.summarize",
  // cost-reduction-structural §B — Stage 2 lite-tier triage that decides
  // log_only vs. escalate before the dispatcher spawns the full Stage 3
  // hourly_check session. Same delegation rationale as
  // `observation.summarize`: the operator may pin a different lite model
  // per backend, and `applyDefaultPresets` re-seeds the row when the
  // main-backend switch fires.
  "routine.hourly_check.triage",
  // docs/design/appendices/routine-data-acquisition.md §6.2 — pre-pass fetcher that the
  // routine dispatchers (morning / today_refresh / hourly_check / evening /
  // weekly / monthly) spawn before the main routine session. Lite tier
  // (Haiku-class) by default; reads an `<acquisition-plan>` block of
  // (integration, mode, window) tuples and POSTs each fetched item to
  // `/api/observations` so the main session reads from a unified
  // observations table. Configurable so /settings/models can re-pin and
  // applyDefaultPresets re-seeds across a main-backend switch.
  "routine.fetch_window",
  // Roadmap-refresh sits in the routine family but, unlike the other
  // review routines, it is NOT in `ROUTINE_WINDOWS` — so it does not get
  // the lite-tier `routine.fetch_window` pre-pass. In `native` integration
  // mode this means the synthesis session itself drives the Calendar
  // (90d) / Mail / Notion MCP fan-out, which routinely tips the medium-
  // tier $1.00 envelope (see schema seed for sizing rationale + the
  // matching envelope override in plan-presets.ts).
  //
  // Exposed as configurable so operators whose native-mode fan-out runs
  // hotter than the seed can widen the envelope from /settings/models
  // (and so applyDefaultPresets re-seeds the row on a main-backend
  // switch, mirroring the other configurable routines).
  "routine.roadmap_refresh",
  // WIKI_BUILDER_DESIGN.md Phase 1 — internal wiki builder surfaces.
  // These are configurable but not delegated: URL ingestion, synthesis,
  // and Q&A each get an independent backend/model/budget row.
  "wiki.ingest_url",
  "wiki.compile",
  "wiki.ask",
  // WIKI_BUILDER_DESIGN.md Phase 3 — operational commands.
  //   wiki.lint     — health pass; writes `90_meta/health/<YYYY-MM-DD>.md`
  //                   and may append a `# Candidates` section to
  //                   `90_meta/taxonomy.md` for owner review.
  //   wiki.trace    — chronological evolution of an idea across raw / wiki
  //                   / outputs; writes `30_outputs/<YYYY-MM-DD>-trace-<slug>.md`.
  //   wiki.connect  — bridges two domains; writes
  //                   `30_outputs/<YYYY-MM-DD>-connect-<slug>.md`.
  // Operational triad — same medium-tier default as the other wiki keys
  // so /settings/models and applyDefaultPresets cover them on a backend
  // switch.
  "wiki.lint",
  "wiki.trace",
  "wiki.connect",
  // Both `routine.today_refresh` and `git.lifecycle.poll` carry
  // schema-seed rows with non-default envelopes (20/$0.30 and 20/$0.20
  // respectively). They live in CONFIGURABLE so `applyDefaultPresets`
  // cascades them on a main-backend switch — without this, the schema
  // seed pins them permanently to claude regardless of the operator's
  // chosen main. /settings/models also surfaces them for operator
  // visibility (legitimate use: pin a cheaper model for the drift-
  // refresh / git poll loops).
  "routine.today_refresh",
  "git.lifecycle.poll",
  // BROWSER_HISTORY_INTEGRATION_PLAN P3 — research-cluster engagement.
  //   routine.research_cluster_update  — nightly per-cluster journal
  //     append at the agent-day boundary. Lite tier; one row per cluster
  //     per day with new activity.
  //   routine.research_offer_dm        — seventh-pass two-option offer
  //     composition. Poller enqueues this when a cluster qualifies and
  //     the rate-limit gate passes. Lite tier; one DM per fire, no
  //     WebFetch.
  //   routine.research_dispatch        — accept path for the "research"
  //     option (natural-language reply or `!research accept <slug>`).
  //     Medium tier; runs WebSearch + WebFetch to compose a parallel
  //     external research dive. Claude-only per §10.3 backend safety
  //     floor (attacker-controlled prose surface).
  //   routine.research_wiki_summary    — accept path for the
  //     "summarise" option (natural-language reply or `!research wiki
  //     <slug>`). Medium tier; writes a wiki note into Obsidian inbox
  //     / Notion / local context per integration availability.
  "routine.research_cluster_update",
  "routine.research_offer_dm",
  "routine.research_dispatch",
  "routine.research_wiki_summary",
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.8 — Instance S health
  // check. Lite tier; 6h cadence; reads `/api/browser-history/managed/
  // status`, surfaces a summary in the agent journal when state is
  // non-`ready`. Does NOT DM the user — DMs are sent deterministically
  // by the `reauth-detector` in `managed-chromium-supervisor.ts`. This
  // routine is for the agent's own awareness only.
  "routine.managed_sync_health_check",
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.13 — scheduler / routine
  // driven invocations of the Instance A browser-automation workflow
  // surface. User-driven invocations from a DM stay under `message.dm`;
  // this key is only emitted from `agent_schedule` rows that name a
  // workflow (e.g. "every morning at 07:00, screenshotPage
  // https://news.ycombinator.com"). Medium tier so the operator can
  // pin a heavier model for shopping comparison / multi-step
  // extraction workflows if needed. Backend safety floor: Claude only
  // (workflow outputs include attacker-controlled prose; Claude's
  // PreToolUse hook + absolute-block layer is the strongest
  // enforcement surface; see plan §8.13 backend-floor rationale).
  "routine.browser_automation_request",
] as const;

const DEFAULT_PROCESS_KEYS = [
  // `routine.morning_routine_initial` retired by
  // `docs/design/appendices/morning-routine-optimization.md` Phase 7
  // (2026-05-16). The first-run branch now flows through the parent
  // `routine.morning_routine` envelope; the daemon-prepared
  // `<roadmap_skeleton>` block lets the medium-tier Stage A populate
  // `roadmap.md` inline without an Opus session. Variant detection
  // happens in `MorningRoutinePipelineOrchestrator.buildRoadmapSkeletonBlock`
  // (yesterday.md present = recurring; absent = first-run).
  "routine.user_profile_sweep",
  "schedule.approaching",
  "integration_drift_sync",
  "setup",
  // KNOWLEDGE-IMPORT — owner uploads a Markdown/text file from the
  // dashboard Knowledge page; a one-shot heavy session reads it and
  // routes its contents into the appropriate user/*.md files. The
  // owner is in the loop via the dashboard, so it is reactive — the
  // session honors the dashboard's backend/model picker through the
  // requestedBackendId/requestedModelId override.
  "knowledge.import",
  // DELEGATED-TASK-MODE-DESIGN.md §8.1 — task mode resolves the model
  // tier server-side via these ProcessKeys. `delegated_task` runs at
  // light tier by default; `delegated_task_heavy` is opt-in via the
  // `delegatedTaskHeavyEnabled` config flag (Approve-tier, see §17).
  // Neither key is selectable per-request — callers pass a task body
  // and the daemon resolves the binding internally — but they ARE
  // configurable: a `process_backend_config` row pinning `main_model`
  // for the active backend takes precedence over the canonical-proxy
  // fallback (`resolveTaskModel` → `resolveProcessKeyModel`). That lets
  // an operator pin Haiku 4.5 for `delegated_task` on Claude or wire
  // Opus 4.7 for `delegated_task_heavy` from the dashboard's process-
  // config card.
  "delegated_task",
  "delegated_task_heavy",
] as const;

/**
 * Union of every known ProcessKey at compile time. Exported so tests
 * and tooling can enumerate the full set without re-listing it (e.g.,
 * the P6 tier-ceiling lint walks every `routine.*` key here).
 */
export const ALL_PROCESS_KEYS = [
  ...CONFIGURABLE_PROCESS_KEYS,
  ...DEFAULT_PROCESS_KEYS,
] as const;

type ConfigurableProcessKey = (typeof CONFIGURABLE_PROCESS_KEYS)[number];
type KnownProcessKey = (typeof ALL_PROCESS_KEYS)[number];
/**
 * Process keys identify dispatch surfaces (DM, routine, observer event,
 * scheduled task, custom routine, etc.). The union is widened to `string`
 * because custom-routine keys (`routine.custom.<slug>`) are user-supplied
 * at runtime — we cannot enumerate them at compile time. Trade-off: a
 * literal typo like `"messasge.dm"` typechecks. Use `isProcessKey()` at
 * boundaries that care (DB write, dispatcher routing) to assert the
 * value belongs to the known set.
 */
export type ProcessKey = KnownProcessKey | string;
/**
 * See {@link BackendModelTier} in `backend.ts` for the tier semantics. The
 * two are kept aligned by the test in `process-key.test.ts`.
 */
export type ProcessModelTier = "lite" | "medium" | "high";

const PROCESS_MODEL_TIERS: readonly ProcessModelTier[] = ["lite", "medium", "high"] as const;

/** Type guard over `ProcessModelTier`. Accepts `null` / `undefined` so it
 *  can fold directly into DB-row checks without an extra `!= null` guard. */
export function isProcessTier(value: unknown): value is ProcessModelTier {
  return typeof value === "string"
    && (PROCESS_MODEL_TIERS as readonly string[]).includes(value);
}

const processKeySet = new Set<string>(ALL_PROCESS_KEYS);

// Per-process default tier. The three tiers map to model size in the
// backend's lineup:
//
//   - `lite` — Haiku-class. Used for delegated proxy calls and short-shape
//     observer-fired tasks (mail/gmail classifier, github/git event
//     triage, calendar.change, integration drift sync, the
//     `delegated_task` invoker family). These have a small fixed-shape
//     contract and tolerate the lower instruction-following capability of
//     a lite-tier model in exchange for an order-of-magnitude lower cost.
//   - `medium` — Sonnet-class. Default for owner-in-the-loop main agent
//     work (DMs, mentions, dashboard chat, hourly check, daily/weekly/
//     monthly reviews, scheduled DM tasks, agent.task). Also the tier
//     that absorbs structured routines whose output is template-driven.
//   - `high` — Opus-class. Reserved for one-shot generative work whose
//     output quality directly drives the agent's downstream behaviour
//     for hours, or for owner-uploaded knowledge imports / project
//     retempling where mistakes corrupt curated files. After the
//     2026-05-16 "no Opus by default" pass, no install-time seeded
//     surface defaults to `high` — `delegated_task_heavy` is the only
//     `high`-tagged process key, and it is opt-in (gated by the
//     `delegatedTaskHeavyEnabled` config flag). Operators can pin any
//     other process key to `high` per-row from `/settings/models`.
//
// Rationale (see docs/design/09-safety-cost.md):
// - High-tier headroom is finite (Anthropic API spend, OpenAI rate
//   limits). DMs default to medium so a chat-y user cannot silently
//   exhaust the high-tier budget; the dashboard chat picker and
//   `agent_schedule.model` remain explicit escape hatches for high.
// - `routine.morning_routine` is **medium** in this table because Sonnet
//   4.6 handles the structured day-plan synthesis cleanly. The first-run
//   ("initial") variant is no longer a separate process key —
//   `morning-routine-optimization.md` Phase 7 retired
//   `routine.morning_routine_initial`. The Stage A pipeline picks up the
//   daemon-prepared `<roadmap_skeleton>` block when yesterday.md is
//   absent and populates roadmap.md inline on medium tier.
// - Routines that summarize / aggregate existing context (evening, weekly,
//   monthly review) are template-driven; medium tier handles them.
// - `setup` is **medium** (Sonnet). The wizard runs once per install
//   and the management-rules document it produces drives every
//   downstream routine (Morning Routine reads it; the dashboard
//   surfaces it verbatim). The two-turn contract is enforced by the
//   task-flow's "Hard rules for Turn 1" block — the deterministic
//   gate, not the model tier, is what holds the contract. Sonnet
//   handles the structured Q&A → rules emission cleanly, and Aitne's
//   default cost posture is "Sonnet is sufficient — do not silently
//   spend Opus headroom on one-shots". Operators who want Opus-grade
//   reasoning can pin per-row from /settings/models after install.
const DEFAULT_PROCESS_TIERS: Record<KnownProcessKey, ProcessModelTier> = {
  "routine.morning_routine": "medium",
  // morning-routine-optimization.md Phase 5 — Stage A is structured
  // synthesis work bundling inbox triage + today.md PUT + schedule
  // fan-out; Sonnet's instruction-following is the documented
  // ceiling-of-acceptable per the design doc's "Why medium not lite".
  "routine.morning_routine_today": "medium",
  // Stage B is template-driven daily-journal authoring fed by a
  // daemon-prepared skeleton; the ~12 KB skill bundle + ~3 KB
  // task-flow body clears the lite cold-start floor.
  "routine.morning_routine_journal": "lite",
  "routine.evening_review": "medium",
  "routine.weekly_review": "medium",
  "routine.monthly_review": "medium",
  "routine.hourly_check": "medium",
  "routine.roadmap_refresh": "medium",
  "routine.today_refresh": "medium",
  // User-profile sweep is a short summarization + routing pass over the
  // current agent-day's DM traffic. Medium-tier so it does not steal
  // high-tier headroom from morning_routine; it also runs with a minimal
  // 2-skill manifest ([context, user-profile]) to sidestep the
  // selection-dilution failure mode the DM-time capture block fights.
  "routine.user_profile_sweep": "medium",
  "message.dm": "medium",
  "message.mention": "medium",
  "dashboard.chat": "medium",
  // DOCS_QA_DESIGN.md §10.1 — medium tier is hard-forced regardless of
  // message.dm's pinned tier; the inheritance cascade in §10.2 cascades
  // backend choice but re-resolves the model at the inheritor's tier.
  "dashboard.docs_qa": "medium",
  "agent.task": "medium",
  // Briefing composition is structured-output work that fits comfortably
  // in medium tier; operators can override per-process via the dashboard.
  "agent.dm_task": "medium",
  "schedule.approaching": "medium",
  // Integration drift / calendar / mail / github / git observer-fired
  // tasks are short-shape probes — lite tier is sufficient and keeps the
  // hourly-check cadence's per-call cost negligible.
  "integration_drift_sync": "lite",
  "calendar.change": "lite",
  "setup": "medium",
  "gmail_classify": "lite",
  "github.pull_request.review_requested": "lite",
  "github.assigned": "lite",
  "github.security_alert": "lite",
  "github.workflow_run.failed": "lite",
  "git.push.detected": "lite",
  "git.local_ahead.stale": "lite",
  "git.push.force_pushed": "lite",
  "git.branch.created": "lite",
  "git.tag.created": "lite",
  "git.merge_to_default": "lite",
  // git.project.* are one-shot, generative, quality-sensitive surfaces
  // (mistakes corrupt curated project narratives). Medium tier (Sonnet)
  // by default across init / update / retemplate / refresh_architecture;
  // operators who want Opus-grade analysis can pin per-row from
  // /settings/models.
  "git.project.init": "medium",
  "git.project.update": "medium",
  "git.project.refresh_architecture": "medium",
  "git.project.retemplate": "medium",
  "git.lifecycle.poll": "lite",
  "wiki.ingest_url": "medium",
  "wiki.compile": "medium",
  "wiki.ask": "medium",
  // WIKI_BUILDER_DESIGN.md Phase 3 — operational triad runs at the same
  // medium tier as ingest/compile/ask. Lint is a structured pass over the
  // index + recent log entries; trace and connect synthesize across
  // existing wiki notes — both are template-driven enough for Sonnet
  // (no Opus-grade headroom required).
  "wiki.lint": "medium",
  "wiki.trace": "medium",
  "wiki.connect": "medium",
  // P22 — short-output curation work (typed-payload submissions). Medium
  // is the right default; the operator can pin high from
  // /settings/self-learning if they observe systematic low-quality
  // proposals.
  "routine.skill_curation": "medium",
  // Knowledge import is one-shot, generative, and quality-sensitive
  // (mistakes here corrupt user/*.md). Medium tier (Sonnet) by default
  // to align with Aitne's "no Opus by default" cost posture; the
  // dashboard upload form may override per-run via the model picker so
  // operators can opt into Opus for an individual upload when the
  // source document is unusually subtle.
  "knowledge.import": "medium",
  // DELEGATED-TASK-MODE-DESIGN.md §8.1 — task mode amortizes one
  // planning turn over the actual tool calls; lite tier keeps the
  // overhead from dominating the per-call cost. `delegated_task_heavy`
  // is opt-in and used only when the integration's dashboard config
  // flips it on (`delegatedTaskHeavyEnabled`); when enabled it runs at
  // high tier for the rare destructive write that needs Opus-grade
  // judgment.
  "delegated_task": "lite",
  "delegated_task_heavy": "high",
  // cost-reduction-structural §A — small fixed-shape classification call
  // per observation. Lite tier (Haiku-class) keeps per-observation cost
  // negligible; the per-source prompt prefix benefits from the 5-min
  // Anthropic prompt cache after the first call in each window.
  "observation.summarize": "lite",
  // cost-reduction-structural §B — Stage 2 triage call. Strict JSON-only
  // output, ~2K input / ~50 output. Lite tier so the gate's "escalate vs
  // log only" decision pays a fraction of a Stage 3 medium-tier session.
  "routine.hourly_check.triage": "lite",
  // docs/design/appendices/routine-data-acquisition.md §6.2 / P3 — mechanical fetch.
  // Lite tier (Haiku-class) is the right ceiling for fan-out window
  // queries that POST observations; the main routine session reads the
  // observations table at medium tier (Sonnet) for the decision work.
  "routine.fetch_window": "lite",
  // BROWSER_HISTORY_INTEGRATION_PLAN P3:
  //   cluster_update — templated daily journal append; lite tier
  //     (Haiku-class). Pre-Pass: NO. One-shot per cluster per day.
  //   research_offer_dm — seventh-pass two-option offer composition.
  //     Lite tier (Haiku-class); poller-driven, one DM per fire.
  //   research_dispatch — parallel external research with WebSearch +
  //     WebFetch. Medium tier (Sonnet-class). Claude-only per §10.3.
  //   research_wiki_summary — composes a wiki note from the cluster
  //     journal + delta API. Medium tier.
  "routine.research_cluster_update": "lite",
  "routine.research_offer_dm": "lite",
  "routine.research_dispatch": "medium",
  "routine.research_wiki_summary": "medium",
  // Managed Chromium health-check awareness routine; lite tier because
  // the task is a single GET + journal append.
  "routine.managed_sync_health_check": "lite",
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.13 — Instance A workflow
  // invocation entry point. Medium tier (Sonnet-class) because the
  // session orchestrates one or more workflows (input shaping,
  // post-run summarisation, optional follow-up DM); lite tier is too
  // narrow when comparison-shopping workflows emit multi-vendor
  // structured output the agent must condense for the user.
  "routine.browser_automation_request": "medium",
};

export function isProcessKey(value: string): value is KnownProcessKey {
  return processKeySet.has(value);
}

export function isConfigurableProcessKey(value: string): value is ConfigurableProcessKey {
  return (CONFIGURABLE_PROCESS_KEYS as readonly string[]).includes(value);
}

/**
 * B-007 §5.8 — custom routine keys use the branded form
 * `routine.custom.<slug>` with a kebab-case slug that matches the vault
 * file `policies/routines/custom/<slug>.md`. The slug regex mirrors the
 * context API path validator so the two stay in lock-step.
 */
const CUSTOM_ROUTINE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const CUSTOM_ROUTINE_KEY_PREFIX = "routine.custom.";

export function isCustomRoutineKey(value: string): boolean {
  if (!value.startsWith(CUSTOM_ROUTINE_KEY_PREFIX)) return false;
  const slug = value.slice(CUSTOM_ROUTINE_KEY_PREFIX.length);
  if (slug.length === 0 || slug.length > 64) return false;
  return CUSTOM_ROUTINE_SLUG_PATTERN.test(slug);
}

export function customRoutineKey(slug: string): string {
  return `${CUSTOM_ROUTINE_KEY_PREFIX}${slug}`;
}

export function customRoutineSlugFromKey(key: string): string | null {
  if (!isCustomRoutineKey(key)) return null;
  return key.slice(CUSTOM_ROUTINE_KEY_PREFIX.length);
}

/**
 * Reactive ProcessKeys — the owner is currently in the loop (DMs, mentions,
 * dashboard chat, setup wizard). Everything else is autonomous (routines,
 * scheduled tasks, calendar / Gmail triggers, custom routines).
 *
 * This classifier drives:
 *   - B-003 Phase 3 approve-tier MCP tool stripping for autonomous sessions.
 *   - Any future per-session policy that differs between "owner is present"
 *     and "agent is running unattended".
 */
const REACTIVE_PROCESS_KEYS = new Set<ProcessKey>([
  "message.dm",
  "message.mention",
  "dashboard.chat",
  "dashboard.docs_qa",
  "setup",
  "knowledge.import",
]);

export function isAutonomousProcessKey(processKey: ProcessKey): boolean {
  return !REACTIVE_PROCESS_KEYS.has(processKey);
}

/**
 * Hard tier locks that supersede operator pins, requestedTier hints, and
 * `process_backend_config` rows. Use sparingly: a lock here means we are
 * stating that the named process must run at the listed tier even if the
 * operator explicitly pinned it to something else in `/settings/models`.
 *
 * `dashboard.docs_qa` is locked to `medium` because the QA panel is a
 * doc-lookup surface, not a free-form chat — high tier would silently
 * drain the Opus quota on every "what does X do?" question. See
 * DOCS_QA_DESIGN.md §10.1.
 */
export const TIER_LOCKED_PROCESS_KEYS: Readonly<
  Partial<Record<ProcessKey, ProcessModelTier>>
> = {
  "dashboard.docs_qa": "medium",
};

export function getDefaultTierForProcessKey(processKey: ProcessKey): ProcessModelTier {
  if (isProcessKey(processKey)) {
    return DEFAULT_PROCESS_TIERS[processKey];
  }
  if (isCustomRoutineKey(processKey)) {
    // Custom routines default to medium. The scheduler emits an explicit
    // requestedModel sourced from the routine file's `backend_tier`
    // frontmatter, so this is just a safety net.
    return "medium";
  }
  return "medium";
}

function isDashboardChatMessage(event: MessageEvent): boolean {
  return event.platform === "dashboard" && event.isDm;
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §17 — hard caps on the `/exec` and `/run`
 * task-mode endpoints. These bound a prompt-injected caller's blast radius
 * regardless of the per-request fields they pass. `config.ts` holds the
 * *defaults* (`delegatedTaskDefaultMaxToolCalls` etc.); the constants below
 * are not user-tunable — they live here alongside the ProcessKey
 * definitions because they describe the contract of the `delegated_task` /
 * `delegated_task_heavy` execution shape itself, not the operator's
 * preferences.
 */
export const DELEGATED_TASK_HARD_CAPS = {
  /** Upper bound on `maxToolCalls` request field. */
  maxToolCalls: 15,
  /** Upper bound on `maxBudgetUsd` request field. */
  maxBudgetUsd: 0.5,
  /** Upper bound on `timeoutMs` request field. */
  maxTimeoutMs: 300_000,
  /**
   * Upper bound on the inlined `outputSchema` payload, measured as
   * `Buffer.byteLength(JSON.stringify(schema), "utf-8")`. The schema
   * lands in the subprocess system prompt and is paid as input tokens
   * on every model turn; 4 KB ≈ 1000 tokens — empirical cap (§6.4).
   */
  maxSchemaBytes: 4096,
} as const;

export function resolveProcessKey(event: Event): ProcessKey {
  if (isMessageEvent(event)) {
    if (isDashboardChatMessage(event)) {
      // The `intent` discriminator lets the QA adapter share
      // platform="dashboard" + isDm=true with chat without a second
      // platform string. `intent` is ignored on non-dashboard events
      // (defense against a malformed event from another adapter).
      return event.intent === "docs_qa" ? "dashboard.docs_qa" : "dashboard.chat";
    }
    if (event.isDm) {
      return "message.dm";
    }
    if (event.isMention) {
      return "message.mention";
    }
  }

  if (event.type === "scheduled.task") {
    return "agent.task";
  }

  if (event.type === "scheduled.dm") {
    return "agent.dm_task";
  }

  if (event.type.startsWith("setup.")) {
    return "setup";
  }

  if (event.type === "knowledge.import") {
    return "knowledge.import";
  }

  if (event.type.startsWith("calendar.")) {
    return "calendar.change";
  }

  if (isProcessKey(event.type)) {
    return event.type;
  }

  return event.type;
}
