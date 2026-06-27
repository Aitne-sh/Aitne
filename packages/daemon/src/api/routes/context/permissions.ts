// drift-allow-file: write-permission whitelist documents legacy alias
// targets (`agent/journal`, etc.) so future maintainers understand why
// the rule maps to a six-class destination.
import type { ApiDependencies } from "../../server.js";
import { classifyContextWriteStaleness } from "../../../core/context-staleness.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("context-api");

/**
 * Write-permission whitelist (CONTEXT_VAULT_REDESIGN_PLAN.md §7.1).
 *
 * After the six-class restructure the table collapses from 26 explicit
 * patterns to one per class prefix plus a small number of exceptions
 * (`CREATE_ONLY_PUT`, `git/{slug}` placeholders, lifecycle DELETEs).
 * Legacy URLs (`PUT /api/context/today.md` etc.) are normalised by the
 * API alias resolver before this table is consulted, so canonical paths
 * are the only inputs we have to enumerate.
 */
export const CONTEXT_WRITE_PERMISSIONS: Record<string, string[]> = {
  // Top-level survivors.
  _index: ["PUT", "PATCH"],

  // state/
  "state/today": ["PUT", "PATCH"],
  "state/yesterday": ["PUT", "PATCH"],
  "state/profile-questions": ["PUT", "PATCH"],
  "state/inbox/*": ["PUT", "PATCH", "DELETE"],
  "state/scratch/*": ["PUT", "PATCH", "DELETE"],
  "state/activity/*": ["PUT", "PATCH"],

  // identity/
  "identity/_index": ["PUT", "PATCH"],
  "identity/*": ["PUT", "PATCH"],

  // plans/
  "plans/roadmap": ["PUT", "PATCH"],
  "plans/projects/_index": ["PUT", "PATCH"],
  "plans/projects/_active": ["PUT"],
  "plans/projects/*": ["PUT", "PATCH"],

  // policies/ — DELETE intentionally omitted for management-captures:
  // policy files use `status: removed` in lieu of physical deletion so
  // the captured history (origin DM, why, linked routine) survives.
  "policies/_index": ["PUT", "PATCH"],
  "policies/management": ["PUT", "PATCH"],
  // Feedback Learning Loop (FEEDBACK_LEARNING_LOOP_DESIGN.md §4 Phase 2).
  // Global agent-scope lessons folded nightly by routine.evening_review.
  // Without this row the consolidation PATCH/PUT 403s — the per-agent
  // scope already rides the `policies/agents/{slug}/{file}` wildcard, but
  // the global file matches no rule (no blanket `policies/*`). Like every
  // other `policies/` write it trips `shouldRefreshPromptContext`, so a
  // nightly lesson write invalidates the owner-session prompt cache —
  // desirable (new lessons take effect next turn) and it fires at night.
  "policies/agent-lessons": ["PUT", "PATCH"],
  "policies/mcp": ["PUT", "PATCH"],
  "policies/redaction": ["PUT", "PATCH"],
  "policies/journal-format": ["PUT", "PATCH"],
  "policies/journal-export": ["PUT", "PATCH"],
  "policies/integrations": ["PUT", "PATCH"],
  "policies/management-captures/_index": ["PUT", "PATCH"],
  "policies/management-captures/*": ["PUT", "PATCH"],
  "policies/routines/_index": ["PUT", "PATCH"],
  "policies/routines/*": ["PUT", "PATCH"],
  // Legacy custom-routine files (inert since the Agents-hub redesign —
  // recurring work is an Agent now). Writes stay validated and DELETE
  // remains so the agent can clean a leftover file up when the user asks.
  "policies/routines/custom/*": ["PUT", "PATCH", "DELETE"],
  // User Agent definitions (AGENT_DEFINITIONS_DESIGN.md §9.5 / §3.3). The
  // dashboard's "+ New Agent" scaffold and the YAML editor write user Agents
  // to `policies/agents/<slug>/agent.md` through the context-vault chokepoint;
  // DELETE retires one. Built-in Agents never live here — they ship under
  // `agent-assets/agents/` and their overrides live in the DB, so this path
  // only ever owns user-authored definitions. `{slug}/{file}` matches the
  // two-segment `policies/agents/<slug>/agent` form `normalizeContextPath`
  // produces (the `.md` extension is stripped before the whitelist check).
  "policies/agents/{slug}/{file}": ["PUT", "PATCH", "DELETE"],

  // journal/ — append-only narrative. `journal/agent.md` is
  // `CREATE_ONLY_PUT` and only accepts append-style PATCH.
  "journal/daily/*": ["PUT", "PATCH"],
  "journal/weekly/*": ["PUT", "PATCH"],
  "journal/monthly/*": ["PUT", "PATCH"],
  "journal/agent": ["PUT", "PATCH"],
  "journal/repos/{slug}/{date}": ["PUT", "PATCH"],

  // knowledge/ — dossiers + per-repo overviews + entity files.
  "knowledge/dossiers/_index": ["PUT", "PATCH"],
  "knowledge/dossiers/*": ["PUT", "PATCH"],
  "knowledge/repos/{slug}/overview": ["PUT", "PATCH"],
  // Legacy git-repos registry preserved read-only under
  // knowledge/repos/legacy-registry/ — left writable so the user can
  // clean up dangling entries; no new writes target this path.
  "knowledge/repos/legacy-registry/*": ["PUT", "PATCH"],
  "knowledge/entities/{domain}/_index": ["PUT", "PATCH"],
  "knowledge/entities/{domain}/{typePlural}/{slug}": ["PUT", "PATCH"],

  // research/ — browser-history research-cluster journals
  // (BROWSER_HISTORY_INTEGRATION_PLAN). The routine.research_dispatch /
  // research_wiki_summary / research_cluster_update task-flows persist the
  // per-cluster journal via PUT/PATCH /api/context/research/<slug>.md (plus
  // `<slug>-assistance-<date>.md` and `<slug>-wiki.md`). These are flat,
  // single-segment files under research/. DELETE is intentionally omitted —
  // concluding a cluster *preserves* its journal (commands-research.ts), so
  // there is no agent-driven delete path. Without this entry every research
  // write returned 403 context.write_forbidden, silently breaking the flow.
  "research/*": ["PUT", "PATCH"],
};

/**
 * Paths where PUT is only allowed when the file does not yet exist.
 * Subsequent writes must go through PATCH (append). This enforces the
 * append-only contract at the API level rather than relying on prompt
 * compliance alone.
 *
 * The contract has two sides — PUT-after-creation is denied here; the
 * PATCH handler additionally restricts these paths to {@link APPEND_ONLY_PATCH_MODES},
 * so `mode:"replace"` / `"clear"` / `"clear_before"` cannot erase existing
 * sections behind the agent's back.
 */
export const CREATE_ONLY_PUT = new Set(["journal/agent"]);

/**
 * PATCH modes that count as "append-style" for paths in {@link CREATE_ONLY_PUT}.
 * Every other mode (`"replace"`, `"clear"`, `"clear_before"`) MUST be
 * rejected on append-only paths — otherwise a prompt-injected agent (or
 * any caller with a valid bearer token) could PATCH `agent/journal` with
 * `mode:"replace"` against a section and destroy historical entries the
 * "create-only PUT" gate was meant to protect.
 */
export const APPEND_ONLY_PATCH_MODES = new Set<string>([
  "append",
  "append_to_file",
]);

/**
 * Slug regex shared by `{slug}` and `{date}` placeholders. Matches the
 * sanitized output of `deriveSlug` (a-z, 0-9, dot, underscore, dash) and
 * `YYYY-MM-DD` date strings without further validation — the route
 * handler does the canonical date validation when it parses the URL.
 */
export const PLACEHOLDER_SEGMENT_RE = /^[a-z0-9._-]+$/;

export function patternToRegex(pattern: string): RegExp {
  // Escape regex metachars except the placeholder syntax we control.
  const escaped = pattern.replace(/[.+^$()|\\]/g, "\\$&");
  // `{name}` → one allowed segment.
  const withSegments = escaped.replace(/\\?\{[^}]+\\?\}/g, "[a-z0-9._-]+");
  // `/*` at end → exactly one trailing segment.
  const withTail = withSegments.replace(/\/\*$/, "/[^/]+");
  return new RegExp("^" + withTail + "$");
}

export function isWriteAllowed(path: string, method: string): boolean {
  // Check exact match first
  if (CONTEXT_WRITE_PERMISSIONS[path]?.includes(method)) return true;

  // Check wildcard patterns
  for (const [pattern, methods] of Object.entries(CONTEXT_WRITE_PERMISSIONS)) {
    if (!methods.includes(method)) continue;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (path.startsWith(prefix + "/")) {
        return true;
      }
    }
    if (pattern.includes("{")) {
      if (patternToRegex(pattern).test(path)) {
        // Defense-in-depth: each replaced placeholder must match the
        // sanitized form. The regex already enforces that, but we
        // double-check the character set explicitly so a future
        // pattern with `{slug}` mid-string can't drift.
        const segments = path.split("/");
        const patternSegments = pattern.split("/");
        /* c8 ignore next 2 — segment-length mismatch after a regex match is
         * unreachable: patternToRegex already validates the full path structure. */
        if (segments.length !== patternSegments.length) continue;
        let allValid = true;
        for (let i = 0; i < segments.length; i++) {
          const lit = patternSegments[i];
          if (lit.startsWith("{") && lit.endsWith("}")) {
            if (!PLACEHOLDER_SEGMENT_RE.test(segments[i])) {
              allValid = false;
              break;
            }
          } else /* c8 ignore next 2 — literal mismatch after a full-pattern regex match
                  * is unreachable: the regex enforces exact literal equality. */
          if (lit !== segments[i]) {
            allValid = false;
            break;
          }
        }
        if (allValid) return true;
      }
    }
  }
  return false;
}

/**
 * Determine if a context file change should trigger a prompt context
 * refresh consideration. The staleness classifier decides whether the
 * matching write is loud enough to invalidate active DM sessions.
 *
 * B-007 §5.1 — user/profile.md is refreshed on PUT only (setup writes
 * the full file) but NOT on PATCH (SignalDetector appends to Raw Signals
 * frequently — refreshing on every append would thrash the owner session).
 *
 * The setup.initial PUT fires this, but it does NOT destroy the in-flight
 * setup conversation — the `onPromptContextChanged` handler in index.ts
 * skips `markActiveDmSessionsStale` while `currentSetupMode` is active.
 */
export function shouldRefreshPromptContext(
  path: string,
  method: string,
): boolean {
  if (
    path === "state/today" ||
    path === "plans/roadmap" ||
    path === "_index"
  ) {
    return true;
  }
  // Any policies/*.md edit feeds the policy-files injection hub, so
  // changes should invalidate the owner-session prompt cache.
  // policies/routines/* drives task-flow prompts.
  if (path.startsWith("policies/")) {
    return true;
  }
  if (path.startsWith("knowledge/dossiers/")) {
    return true;
  }
  if (path === "identity/profile" && method === "PUT") {
    return true;
  }
  return false;
}

export function notifyPromptContextChanged(
  deps: ApiDependencies,
  path: string,
  reason: string,
  input: Parameters<typeof classifyContextWriteStaleness>[0],
): void {
  const classification = classifyContextWriteStaleness(input);
  deps.onPromptContextChanged?.(path, reason, classification.tier, {
    tierReason: classification.tierReason,
  });
  // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — record the staleness tier in
  // `agent_actions` so the dashboard's `dm_freshness_metrics` view can
  // count loud vs. quiet writes that landed within a DM session's
  // lifetime. Best-effort: a failure here must not break the write.
  try {
    deps.db
      .prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at, completed_at)
         VALUES ('context_write', 'reactive', 'success', json(?), datetime('now'), datetime('now'))`,
      )
      .run(
        JSON.stringify({
          path,
          method: input.method,
          tier: classification.tier,
          tierReason: classification.tierReason,
          reason,
        }),
      );
  } catch (err) {
    /* c8 ignore next 5 — DB INSERT failure inside a best-effort audit path;
     * triggering requires closing the DB mid-request, which destroys the
     * test harness. */
    logger.warn(
      { err, path, method: input.method },
      "Failed to record context_write agent_actions row (Stage C metrics)",
    );
  }
}
