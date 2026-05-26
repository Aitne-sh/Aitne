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
