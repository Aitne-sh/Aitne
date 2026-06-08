/**
 * Feedback Learning Loop — scope grammar (FEEDBACK_LEARNING_LOOP_DESIGN.md §3.3).
 *
 * A feedback signal / lesson carries a **scope** that decides *who sees it*.
 * This module is the single source of truth that maps the DB row's
 * `(scope_type, scope_ref)` pair onto:
 *   - a canonical, human-readable scope string (`user`, `agent`,
 *     `agent:report-writer`, `channel:slack`, …) used in worksheet XML and
 *     lesson-file headers, and
 *   - the writable vault file that stores that scope's lessons.
 *
 * Pure logic, no I/O — the §4 division-of-labour "scope parser" covered module.
 * Phase 2 only *stores* `user` + `agent`; the parser still recognises the full
 * v2 grammar (`agent_slug`, `channel`, `task`, `integration`) so forward-compat
 * rows round-trip rather than throwing, but `scopeStoreFile` returns `null` for
 * the not-yet-stored classes — the caller treats that as "surface but do not
 * persist a lesson file yet".
 */

import type { FeedbackScopeType } from "../../db/feedback-signals-store.js";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";

/** Parsed, normalised scope. `agent_slug` collapses to `kind: "agent_slug"`. */
export type CanonicalScope =
  | { kind: "user" }
  | { kind: "agent" }
  | { kind: "agent_slug"; ref: string }
  | { kind: "channel"; ref: string }
  | { kind: "task"; ref: string }
  | { kind: "integration"; ref: string };

/** Scope classes that require a `scope_ref` to be meaningful. */
const REF_REQUIRED: ReadonlySet<FeedbackScopeType> = new Set<FeedbackScopeType>([
  "agent_slug",
  "channel",
  "task",
  "integration",
]);

/**
 * Parse a `(scope_type, scope_ref)` pair into a {@link CanonicalScope}.
 * Returns `null` when the type is unknown or a ref-required class is missing
 * its ref — the caller drops such rows from the worksheet rather than guessing.
 */
export function parseScope(
  scopeType: string,
  scopeRef: string | null | undefined,
): CanonicalScope | null {
  const ref = typeof scopeRef === "string" ? scopeRef.trim() : "";
  switch (scopeType) {
    case "user":
      return { kind: "user" };
    case "agent":
      return { kind: "agent" };
    case "agent_slug":
      return ref.length > 0 ? { kind: "agent_slug", ref } : null;
    case "channel":
      return ref.length > 0 ? { kind: "channel", ref } : null;
    case "task":
      return ref.length > 0 ? { kind: "task", ref } : null;
    case "integration":
      return ref.length > 0 ? { kind: "integration", ref } : null;
    default:
      return null;
  }
}

/**
 * Canonical human-readable scope label used in worksheet XML attributes and
 * the `<!-- scope: … -->` lesson-file header. `agent:<slug>` is the literal
 * answer to requirement #3 ("feedback on a generated agent's output").
 */
export function formatScope(scope: CanonicalScope): string {
  switch (scope.kind) {
    case "user":
      return "user";
    case "agent":
      return "agent";
    case "agent_slug":
      return `agent:${scope.ref}`;
    case "channel":
      return `channel:${scope.ref}`;
    case "task":
      return `task:${scope.ref}`;
    case "integration":
      return `integration:${scope.ref}`;
  }
}

/**
 * Stable grouping key for a scope — used by the consolidation pre-step to
 * bucket unconsumed signals by `(scope_type, scope_ref)` (§4 step 1). Equal
 * for two signals that target the same lesson destination.
 */
export function scopeKey(scope: CanonicalScope): string {
  return formatScope(scope);
}

/**
 * Resolve the writable-vault relative path that stores a scope's lessons.
 *   - `user`       → `identity/profile.md` (`## Learned Context` section)
 *   - `agent`      → `policies/agent-lessons.md`
 *   - `agent:slug` → `policies/agents/<slug>/lessons.md`
 *   - everything else (v2 channel/task/integration) → `null` (not yet stored)
 */
export function scopeStoreFile(scope: CanonicalScope): string | null {
  switch (scope.kind) {
    case "user":
      return CONTEXT_RELATIVE_PATHS.user.profile;
    case "agent":
      return CONTEXT_RELATIVE_PATHS.agentLessons;
    case "agent_slug":
      return `policies/agents/${scope.ref}/lessons.md`;
    default:
      return null;
  }
}

/**
 * The markdown section a scope's lessons live under, for PATCH `section=`
 * targeting. `user` folds into the existing `## Learned Context`; lesson
 * stores use `## Lessons`.
 */
export function scopeSectionSlug(scope: CanonicalScope): string {
  return scope.kind === "user" ? "learned_context" : "lessons";
}

/**
 * True when a scope type needs a ref to be valid. Exposed for the route /
 * worksheet validators that mirror the §3.5.2 "scope_ref present iff
 * scope_type=agent_slug" rule across the extended grammar.
 */
export function scopeNeedsRef(scopeType: FeedbackScopeType): boolean {
  return REF_REQUIRED.has(scopeType);
}
