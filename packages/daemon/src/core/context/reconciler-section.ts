/**
 * Reconciler-section block helpers.
 *
 * CONTEXT_VAULT_REDESIGN_PLAN.md v4 V15 — the root `<contextDir>/_index.md`
 * carries both user-curated content and a machine-rebuilt block. The block
 * is delimited by HTML comments so the user's editor renders it as
 * Markdown (Obsidian, GitHub) without exposing the markers.
 *
 * Both the boot migration (`db/migrations/context-vault-restructure.ts`) and
 * the runtime reconciler (`core/context/reconciler-runner.ts`) splice the
 * block via the helpers exported here so the two write paths cannot drift.
 */

export const RECONCILER_BLOCK_OPEN = "<!-- reconciler-section -->";
export const RECONCILER_BLOCK_CLOSE = "<!-- /reconciler-section -->";

/**
 * Matches the entire reconciler-section block — open marker through close
 * marker, inclusive. `[\s\S]` is required (not `.`) because the block body
 * spans multiple lines.
 */
export const RECONCILER_BLOCK_RE =
  /<!--\s*reconciler-section\s*-->[\s\S]*?<!--\s*\/reconciler-section\s*-->/;

/**
 * Splice `blockBody` between `<!-- reconciler-section -->` markers inside
 * `target`. If the target already contains a block, the body between the
 * markers is replaced. Otherwise a new block is appended at the end of the
 * target with a single blank-line separator.
 *
 * `blockBody` should be the body content only (no frontmatter, no top-level
 * heading) — the host file owns those.
 */
export function mergeReconcilerBlock(target: string, blockBody: string): string {
  const block = `${RECONCILER_BLOCK_OPEN}\n${blockBody.trim()}\n${RECONCILER_BLOCK_CLOSE}`;
  if (RECONCILER_BLOCK_RE.test(target)) {
    return target.replace(RECONCILER_BLOCK_RE, block);
  }
  if (target.length === 0) return `${block}\n`;
  const sep = target.endsWith("\n") ? "" : "\n";
  return `${target}${sep}\n${block}\n`;
}
