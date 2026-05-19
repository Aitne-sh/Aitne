/**
 * Single source of truth for product brand identity.
 *
 * Three tiers — keep them distinct:
 *
 *   APP_NAME              The product / brand. Static. What the software is called.
 *                         Imported by TS code (env-writer, Slack manifest, dashboard
 *                         title, daemon startup logs, the CLI instruction-file
 *                         header) and substituted into the `{APP_NAME}` token in
 *                         markdown templates (task-flows, agent-profiles, skills)
 *                         via `substituteBrandTokens` at materialization time.
 *
 *   AGENT_ROLE_DESCRIPTOR The LLM's role anchor. "personal agent" is a high-prior
 *                         phrase in instruction-tuning data; keeping it stable
 *                         under rebrands preserves role activation independent of
 *                         the proper-noun product name.
 *
 *   agentDisplayName      User-customizable proper noun the agent uses to sign
 *                         messages. DB-backed setting (PA_AGENT_DISPLAY_NAME env
 *                         override). Defaults to APP_NAME but the user may rename
 *                         their instance to anything ("Sage", "Alfred", etc.).
 *                         Defined in agent-identity.ts.
 *
 * To rebrand the product, two coordinated changes are required:
 *
 *   1. Update APP_NAME below. This propagates automatically through:
 *      - TS imports (search the workspace for `APP_NAME` from this module).
 *      - The `{APP_NAME}` token in agent-assets/{agent-profiles,task-flows,
 *        skills}/, resolved at runtime by:
 *          · prompts.ts loadFlow() / loadFlowVariant()  (task-flows)
 *          · skills-compiler.ts read-from-src wraps + post-cpSync walk +
 *            partial/reference inliner wraps             (agent-profiles, skills)
 *
 *   2. Sweep human-facing markdown that does NOT flow through token resolution
 *      (those files are read by humans on GitHub and by FTS5 indexers, both of
 *      which want the literal name on disk). One-liner:
 *        rg -l '<old-name>' agent-assets/docs/ agent-assets/templates/ README.md \
 *          | xargs sed -i '' 's/<old-name>/<new-name>/g'
 *      Then restart the daemon so the docs FTS5 index reseeds with the new
 *      content. (`docs/design/` is intentionally out of scope — historical
 *      design corpus, not user-facing.)
 *
 * Existing users who explicitly set agentDisplayName (e.g. "PersonalAgent" from
 * a v1 install) keep their value because DB > default. Do not "fix" that.
 *
 * The OS-keychain label prefix (`secret-client-linux.ts` and the macOS
 * Keychain analogue) is intentionally NOT tied to APP_NAME. It is a stable
 * interface — changing it would orphan every secret stored under the old
 * prefix and require users to re-enter all credentials.
 */
export const APP_NAME = "Aitne";

export const AGENT_ROLE_DESCRIPTOR = "personal agent";

/**
 * Short tagline used wherever the brand needs a one-line hook. "Aitne" alone
 * is a coined word with no prior — the tagline tells a first-time reader
 * what the product feels like in five words. Two parallel clauses, each
 * ending with a terminal period; downstream concatenation must defer to
 * `joinTaglineWithSentence` to avoid `..` doubling.
 *
 * The role anchor ("personal agent") is NOT carried by this tagline — it
 * lives in `AGENT_ROLE_DESCRIPTOR` and is emitted into every prompt via the
 * `<agent_identity>` block, which is what actually drives LLM activation.
 * Decoupling lets the tagline be punchy without weakening role anchoring.
 *
 * Use cases: README.md subtitle, docs landing page lead, dashboard welcome
 * heading, OS app metadata. Prefer plain `APP_NAME` in body text once the
 * brand has been introduced — repeating the tagline reads as marketing copy.
 */
export const APP_TAGLINE = "Always on. Always yours.";

/**
 * Combine tagline with a trailing description sentence without producing
 * `..` when the tagline already ends in a period (e.g. "Always on. Always
 * yours." + ". Monitor..." would otherwise read "yours.. Monitor"). Used by
 * `<meta description>` and any markdown lead that needs a punctuation-safe
 * concatenation.
 */
export function joinTaglineWithSentence(tagline: string, sentence: string): string {
  const trimmed = tagline.trimEnd();
  const ends = /[.!?…]$/.test(trimmed);
  return `${trimmed}${ends ? "" : "."} ${sentence}`;
}

/**
 * Replace `{APP_NAME}` tokens in markdown content read from agent-assets/.
 * Called by prompts.ts (task-flow loader) and skills-compiler.ts (agent-profile
 * and skill materializer) at the disk-read boundary, so downstream transforms
 * see the resolved product name.
 *
 * Unknown tokens like `{event_data[X]}` and `{context}` are left untouched —
 * those are resolved later by `resolveTemplate` in prompt-utils.ts.
 *
 * Uses a function replacer so a future APP_NAME containing `$&`, `$1`, etc.
 * (regex back-reference syntax) is inserted verbatim instead of being
 * interpreted by `String.prototype.replace`. Defensive — the current value
 * "Aitne" has no special chars, but the rebrand contract is "change one
 * constant," not "change one constant AND audit it for $-escapes."
 */
export function substituteBrandTokens(content: string): string {
  return content.replace(/\{APP_NAME\}/g, () => APP_NAME);
}
