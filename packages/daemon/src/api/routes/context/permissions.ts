import type { ApiDependencies } from "../../server.js";
import { classifyContextWriteStaleness } from "../../../core/context-staleness.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("context-api");

// B-007 §5.1 — write-permission whitelist for the new layout.
export const CONTEXT_WRITE_PERMISSIONS: Record<string, string[]> = {
  // Top-level survivors.
  today: ["PUT", "PATCH"],
  yesterday: ["PUT", "PATCH"],
  roadmap: ["PUT", "PATCH"],
  _index: ["PUT", "PATCH"],
  "context-index": ["PUT", "PATCH"],

  // user/* covers fixed area files AND the §5.5 growth pattern
  // (e.g. `user/health/sleep-log.md` after an area promotion).
  "user/*": ["PUT", "PATCH"],

  // Natural-language rulebooks — §5.8.
  "rules/_index": ["PUT", "PATCH"],
  // DELETE intentionally omitted. Policy files under `rules/policies/`
  // use `status: removed` in lieu of physical deletion so the captured
  // history (origin DM, why, linked routine) survives. See
  // MANAGEMENT-POLICY-CAPTURE-PLAN.md §4.6 / §5.1.
  "rules/*": ["PUT", "PATCH"],
  "routines/_index": ["PUT", "PATCH"],
  "routines/*": ["PUT", "PATCH"],
  // B-007 §5.8 Q3 — custom routines support DELETE so the agent can
  // retire a routine when the user asks via DM. The scheduler re-reads
  // the directory via `onCustomRoutinesChanged` and unregisters the
  // cron job on the next reload pass.
  "routines/custom/*": ["PUT", "PATCH", "DELETE"],

  // Projects (`.base` permitted via CONTEXT_FILE_EXTENSIONS).
  "projects/_index": ["PUT", "PATCH"],
  "projects/_active": ["PUT"],
  "projects/*": ["PUT", "PATCH"],

  // Lightweight registry for watched git repos that are not promoted to a
  // full project page.
  // @deprecated Pre-cutover layout (see docs/design/appendices/unified-repositories.md);
  // retained for transitional reads of legacy files. New writes route to
  // `git/<slug>/{overview,journal/<YYYY-MM-DD>}`.
  "git-repos/*": ["PUT", "PATCH"],

  // Unified repositories — per-repo project overview + per-day journal.
  // The two specific patterns below carry write permission; arbitrary
  // paths under `git/` are NOT writable to keep the layout disciplined.
  // See docs/design/appendices/unified-repositories.md §4.5.
  "git/{slug}/overview": ["PUT", "PATCH"],
  "git/{slug}/journal/{date}": ["PUT", "PATCH"],

  // Journal & reviews.
  "daily/*": ["PUT", "PATCH"],
  "weekly/*": ["PUT", "PATCH"],
  "monthly/*": ["PUT", "PATCH"],

  // Dossiers + inbox + agent self-areas.
  "dossiers/_index": ["PUT", "PATCH"],
  "dossiers/*": ["PUT", "PATCH"],
  // B-007 §5.9 Step 4 / §5.3 — morning routine triages each inbox file and
  // moves the original to `agent/scratch/inbox-YYYY-MM-DD-*.md`. Both sides
  // of the move need DELETE: inbox for the post-triage cleanup, scratch for
  // the eventual 48h TTL retention sweep (§6.5).
  "inbox/*": ["PUT", "PATCH", "DELETE"],
  "agent/journal": ["PUT", "PATCH"],
  "agent/scratch/*": ["PUT", "PATCH", "DELETE"],
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
export const CREATE_ONLY_PUT = new Set(["agent/journal"]);

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
export function shouldRefreshPromptContext(path: string, method: string): boolean {
  if (
    path === "today" ||
    path === "roadmap" ||
    path === "context-index"
  ) {
    return true;
  }
  // B-007 — any rules/*.md file feeds the policy-files injection hub, so
  // edits to any of them should invalidate the owner-session prompt cache.
  // Routine rulebooks (`routines/*.md`) similarly drive task-flow prompts.
  if (path.startsWith("rules/") || path.startsWith("routines/")) {
    return true;
  }
  if (path.startsWith("dossiers/")) {
    return true;
  }
  if (path === "user/profile" && method === "PUT") {
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
