/**
 * Declarative injection policy table (CONTEXT_VAULT_REDESIGN_PLAN.md §8 +
 * v4.2 V20 amendment).
 *
 * Single source of truth for two parallel opt-out registries that used to
 * live in two different modules:
 *
 *  1. `context-builder.ts:resolveAlwaysInjectionPolicy` — narrow event types
 *     that opt out of the heavy `<user>` / `<management_rules>` blocks.
 *  2. `policy-files.ts:POLICY_KEY_GLOBAL_OPTOUT` — process keys that opt out
 *     of the global `*` policy-file registry merge.
 *
 * Both registries track *the same architectural concern*: "this routine is
 * narrow; do not pay budget for the wide-path always-injected content."
 * Maintaining them in two files meant the next author adding a narrow
 * routine had to make two coordinated edits + update a CLAUDE.md footnote.
 * v4.2 V20 consolidates both behind `getInjectionPolicy(eventOrProcessKey)`.
 *
 * **Routine event types and routine process keys are the same string**
 * (e.g. `routine.morning_routine_journal`). Other process keys (e.g.
 * `message.dm`) have no opt-out today, so the function's "default" branch
 * carries them on the wide path. If a future opt-out targets one of the
 * non-routine surfaces, that decision lives here too.
 *
 * **Location rationale**: lives in its own module to break the import
 * cycle that would form if `getInjectionPolicy` lived in `context-builder.ts`
 * — `context-builder.ts` imports from `policy-files.ts`, and
 * `policy-files.ts` now imports from this module. Putting the table in a
 * leaf module keeps both consumers acyclic.
 */

/**
 * Heavy always-injected blocks that an opt-out can shed.
 *
 * CONTEXT_VAULT_REDESIGN_PLAN.md §8.1 line 505 lists three keys —
 * `user`, `management_rules`, `output_language_policy`. The third is
 * intentionally omitted here today: `<output_language_policy>` is
 * injected unconditionally by ContextBuilder (no event currently
 * opts out) and adding it as a `AlwaysBlockKey` without a paired
 * consumer at the injection site would be dead schema that the test
 * suite would silently rubber-stamp. When a future routine
 * legitimately needs to shed the language block, the right shape is
 * to (a) extend this enum, (b) plumb the check into the
 * `<output_language_policy>` emitter, and (c) update the byte-identity
 * regression guard in `injection-policy.test.ts` — all in the same PR.
 *
 * `classes: ReadonlyArray<InjectedClass>` (the second §8.1 field) is
 * also deferred: ContextBuilder still assembles per-event blocks via
 * hardcoded path emitters, not class-prefix-driven walks. §6 Phase 2
 * is the natural moment to introduce it.
 */
export type AlwaysBlockKey = "user" | "management_rules";

/**
 * The unified policy returned by `getInjectionPolicy`. Both
 * `context-builder.ts` and `policy-files.ts` read this single shape.
 */
export interface InjectionPolicy {
  /**
   * Which heavy blocks to inject under `<user>` / `<management_rules>`.
   * Empty set ⇔ neither block is injected (the narrowest opt-out today).
   */
  readonly alwaysBlocks: ReadonlySet<AlwaysBlockKey>;
  /**
   * Whether `resolvePolicyRefs(eventOrProcessKey)` should merge the
   * registry's `*` row. `false` ⇔ event/process key was in the legacy
   * `POLICY_KEY_GLOBAL_OPTOUT` set. The key must then re-declare any
   * baseline policy file (e.g. `policies/redaction.md`) inline in its own
   * `POLICY_FILE_REGISTRY` row.
   */
  readonly policyFileGlobalMerge: boolean;
}

/**
 * Pre-allocated set shapes — `getInjectionPolicy` returns frozen shared
 * instances so callers can compare with `Set.has` without per-call alloc.
 */
const ALL_BLOCKS: ReadonlySet<AlwaysBlockKey> = new Set<AlwaysBlockKey>([
  "user",
  "management_rules",
]);
const USER_ONLY: ReadonlySet<AlwaysBlockKey> = new Set<AlwaysBlockKey>([
  "user",
]);
const NO_BLOCKS: ReadonlySet<AlwaysBlockKey> = new Set<AlwaysBlockKey>();

const DEFAULT_POLICY: InjectionPolicy = {
  alwaysBlocks: ALL_BLOCKS,
  policyFileGlobalMerge: true,
};

/**
 * Resolve the injection policy for an event type / process key string.
 * Routine event types and routine process keys are the same string, so
 * this function works for both call sites without translation.
 *
 * **Past precedents** (kept here for the next author's benchmark — these
 * mirror the prose that used to live above `resolveAlwaysInjectionPolicy`):
 *
 *  - **Stage B** (`routine.morning_routine_journal`) — Phase 5 of
 *    `morning-routine-optimization.md`. Drops `<management_rules>` because
 *    the journal author reads `<journal_skeleton>` + `policies/journal-format.md`
 *    and never SoT bindings. Keeps `<user>` for the people roster and
 *    redaction-aware wikilinks. Also drops the `*` policy-file merge
 *    because the lite-tier skill bundle never invokes MCP; the redaction
 *    policy is re-declared inline.
 *  - **Hourly check** (`routine.hourly_check`) — task-flow §"Execution
 *    budget" explicitly tells the agent NOT to read roadmap / projects /
 *    user files unless an observation warrants it.
 *  - **Today refresh** (`routine.today_refresh`) — dashboard-triggered
 *    manual rewrite of `today.md ## User Schedule`. Skill bundle is
 *    `[context, today, external-services]`; no identity-aware text.
 *  - **Observer events** (`github.*`, `git.*`, `schedule.approaching`) —
 *    `observer.md` profile is structural classification (diff / commit /
 *    payload vs. category routing); operator identity does not enter the
 *    loop. Bundles never carry `<user>`-reading skills.
 *  - **`scheduled.task`** — close-the-loop discipline is self-contained via
 *    `<today>` + `<task_context>`. NOT generalised to `scheduled.dm` because
 *    `morning_briefing` legitimately reads `<user>` for name resolution
 *    and notification preferences.
 *
 * Out of scope here: `<today>` (small + always cited), `<agent_identity>`,
 * `<current_time>`, `<settings>`, `<output_language_policy>`,
 * `<integration_modes>`. When a routine has no need for `<today>` either,
 * the right pattern is a dedicated slim builder (see `buildFetchWindowContext`),
 * not a third boolean on this struct.
 */
export function getInjectionPolicy(eventOrProcessKey: string): InjectionPolicy {
  // Stage B — drops <management_rules> AND opts out of `*` policy merge.
  if (eventOrProcessKey === "routine.morning_routine_journal") {
    return {
      alwaysBlocks: USER_ONLY,
      policyFileGlobalMerge: false,
    };
  }

  // Narrow routines (hourly check, today refresh) — drop both heavy
  // blocks. `*` policy merge is preserved (redaction.md is non-negotiable).
  if (
    eventOrProcessKey === "routine.hourly_check" ||
    eventOrProcessKey === "routine.today_refresh"
  ) {
    return {
      alwaysBlocks: NO_BLOCKS,
      policyFileGlobalMerge: true,
    };
  }

  // Observer bucket — github.* / git.* / schedule.approaching.
  if (
    eventOrProcessKey.startsWith("github.") ||
    eventOrProcessKey.startsWith("git.") ||
    eventOrProcessKey === "schedule.approaching"
  ) {
    return {
      alwaysBlocks: NO_BLOCKS,
      policyFileGlobalMerge: true,
    };
  }

  // scheduled.task — close-the-loop, no identity dependency.
  if (eventOrProcessKey === "scheduled.task") {
    return {
      alwaysBlocks: NO_BLOCKS,
      policyFileGlobalMerge: true,
    };
  }

  return DEFAULT_POLICY;
}

/**
 * FEEDBACK_LEARNING_LOOP_DESIGN.md §5 — the Stage-3 *opt-in* resolver for the
 * feedback learning-loop's `<agent_lessons>` blocks.
 *
 * Co-located with `getInjectionPolicy` on purpose: this module is the single
 * source of truth for "which surface sees which always-/sometimes-injected
 * block", and the design explicitly rejects scattering an
 * `isMessageEvent(event) || isNotifyDecidingRoutine(event)` check across
 * `context-builder.ts` (it would re-introduce the fragmentation V20
 * consolidated away). `<agent_lessons>` is **default-off** — only the handful
 * of surfaces below want it — so it is an *opt-in* resolver, not a member of
 * the `alwaysBlocks` *opt-out* set (which is for default-*on* heavy blocks a
 * narrow routine sheds; a positive opt-out member would be the wrong polarity).
 *
 * Three fields, matching the design's documented shape:
 *
 *  - `global` — inject `policies/agent-lessons.md ## Lessons` (scope `agent`:
 *    global agent-operating behaviour — notification discipline, filter
 *    quality). Phase 3 consumer: `ContextBuilder`.
 *  - `slim`   — use the hard-2048-byte, top-N-by-score variant on the hourly
 *    notify turn (§6). Only `routine.hourly_check` sets it. Implies `global`.
 *  - `self`   — eligible for the per-agent `policies/agents/<slug>/lessons.md`
 *    block (scope `agent:<slug>`). **Phase 4 consumer.** The builder reads it
 *    next to `<agent_identity>` and gates it on a resolved, path-safe slug
 *    stamped onto `event.data.agentId` at the dispatch site — `self === true`
 *    here means "this surface *may* carry self lessons"; an actual injection
 *    additionally requires the run to be bound to an Agent. `hourly_check`
 *    keeps `self: false` so the slim notify turn never carries a second block.
 *
 * **Surface keying is grounded in the real event-type strings build() sees,
 * not the design's prose shorthand:**
 *  - DM / dashboard messages arrive as `message.*` (dashboard DMs included —
 *    they are `message.*` with `platform="dashboard"`).
 *  - The morning routine's *notify-deciding* stage builds context as
 *    `routine.morning_routine_today` (Stage A). The umbrella
 *    `routine.morning_routine` never reaches `build()` (the orchestrator
 *    decomposes it into the two stage events), and Stage B
 *    (`routine.morning_routine_journal`) is a lite journal author that decides
 *    no notifications — injecting lessons there would be wasted bytes against
 *    the §0 cost constraint. So Stage A is keyed, the umbrella and Stage B are
 *    not.
 *  - `routine.hourly_check` is the escalated Stage-3 LLM/notify turn (gate
 *    Layers 1–3 are code and build no prompt), so the slim block bites exactly
 *    where the notify decision is made. The `.triage` lite classification is
 *    intentionally excluded.
 *  - `scheduled.task` is **binding-aware** (Phase 4). A *bare* scheduled.task
 *    (generic close-the-loop task, observer-emitted cron, roadmap refresh — no
 *    resolved Agent) gets nothing, preserving the §5 last-row opt-out. A
 *    scheduled.task that *resolves to an Agent* (`agentBound`, a user-defined
 *    task-output Agent — `report-writer` et al.) is the §5 "Defined-agent
 *    execution" row: it gets global + self so feedback on the Agent's output
 *    reaches that Agent (requirement #3). The builder supplies the binding fact
 *    via `opts.agentBound` so the decision still lives in this one module rather
 *    than fragmenting a `resolveAgentId() != null` check into `context-builder.ts`.
 *  - Everything else — observers, `fetch_window`, `today_refresh`, and any
 *    unlisted key — gets nothing (the §5 "this surface gets almost nothing"
 *    row, mirroring `buildFetchWindowContext`).
 */
export interface AgentLessonsInjection {
  /** Inject the global `policies/agent-lessons.md ## Lessons` block. */
  readonly global: boolean;
  /**
   * Eligible for the per-agent `policies/agents/<slug>/lessons.md` block.
   * Phase 4 consumer — gated additionally on a resolved slug at the build site.
   */
  readonly self: boolean;
  /** Use the slim, hard-2048-byte, top-N-by-score hourly notify variant. */
  readonly slim: boolean;
}

/**
 * Pre-allocated frozen shapes — `getAgentLessonsInjection` returns shared
 * instances so equality comparisons are stable and allocation-free, mirroring
 * the `ALL_BLOCKS` / `NO_BLOCKS` pattern above.
 */
const LESSONS_DM_REVIEW: AgentLessonsInjection = Object.freeze({
  global: true,
  self: true,
  slim: false,
});
const LESSONS_HOURLY: AgentLessonsInjection = Object.freeze({
  global: true,
  self: false,
  slim: true,
});
const LESSONS_NONE: AgentLessonsInjection = Object.freeze({
  global: false,
  self: false,
  slim: false,
});

/**
 * Resolve which `<agent_lessons>` block(s) a surface receives. See
 * {@link AgentLessonsInjection} for the field/keying rationale.
 *
 * `opts.agentBound` (Phase 4) tells the resolver whether this firing resolved
 * to an Agent (`resolveAgentId() != null`, surfaced by the builder as a stamped
 * `event.data.agentId`). It only changes the binding-aware `scheduled.task`
 * surface — every other key returns the same shape regardless — so a call with
 * no opts is identical to the Phase-3 behaviour.
 */
export function getAgentLessonsInjection(
  eventOrProcessKey: string,
  opts?: { agentBound?: boolean },
): AgentLessonsInjection {
  // DM / dashboard messages — the primary surface lessons calibrate.
  if (eventOrProcessKey.startsWith("message.")) {
    return LESSONS_DM_REVIEW;
  }

  switch (eventOrProcessKey) {
    // Scheduled DM tone session (morning briefing, meeting nudges, …) — same
    // conversational posture as a live DM.
    case "scheduled.dm":
    // Notify-deciding routines: morning Stage A + the review cadences. Each
    // owns a go/no-go `/api/notify` decision that lessons should calibrate.
    case "routine.morning_routine_today":
    case "routine.evening_review":
    case "routine.weekly_review":
    case "routine.monthly_review":
      return LESSONS_DM_REVIEW;

    // Hourly notify turn — slim, hard-capped notification-discipline variant.
    case "routine.hourly_check":
      return LESSONS_HOURLY;

    // Defined-agent task execution (§5 "Defined-agent execution"). A bare
    // scheduled.task stays NONE (the §5 opt-out); one that resolves to an Agent
    // gets global + self so a generated Agent sees feedback on its own output.
    case "scheduled.task":
      return opts?.agentBound ? LESSONS_DM_REVIEW : LESSONS_NONE;

    default:
      return LESSONS_NONE;
  }
}
