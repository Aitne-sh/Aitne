import type {
  ClusterSnapshot,
  DormantClusterEntry,
  WeeklyInterestsSummary,
} from "./weekly-interests-summary.js";

/**
 * WEEKLY_INTERESTS_REFLECTION_PLAN.md §8 + §10.3 — pure templating +
 * delimited-block replacement for the four reflection target files.
 *
 * Two write modes (per §8):
 *
 * - **Mode A** — embed a `<!-- BEGIN aitne:browser-interests v1 … --> …
 *   <!-- END … -->` block in a file that has user-authored content
 *   (`user/profile.md`, `user/_index.md`, `projects/<slug>.md`). The
 *   block is replaced in place on every refresh; if absent, it's
 *   appended once with a leading blank line so it never welds onto the
 *   prior section.
 *
 * - **Mode B** — wholly daemon-owned rewrite of `user/research-themes.md`.
 *   The frontmatter declares `owner: aitne-browser-history`; the entire
 *   file is regenerated each pass.
 *
 * All renderers are pure functions of typed inputs (`WeeklyInterestsSummary`
 * + ancillary). No DB, no FS, no LLM. Markdown- and HTML-comment-significant
 * characters in cluster `displayName`s are escaped by `escapeForMd` /
 * `escapeForHtmlComment` so a poisoned cluster name cannot break the block
 * delimiters or inject markdown structure.
 */

const BEGIN_MARKER = "<!-- BEGIN aitne:browser-interests v1";
const END_MARKER = "<!-- END aitne:browser-interests v1";

/**
 * Escape characters that would otherwise (a) break markdown link
 * brackets, (b) close the auto-block's HTML comment delimiter, or (c)
 * inject markdown headings into a bullet body.
 *
 * The transform is one-way (lossy on `]`/backticks/`#`) — these are
 * agent-visible substitutions, not data the user is meant to read out
 * of the auto-block. Cluster display names are usually short
 * lowercase-with-hyphens identifiers, so escaping is a no-op in
 * practice; the transform is the safety net for renamed clusters that
 * a user could push punctuation into.
 */
export function escapeForMd(value: string): string {
  const intermediate = value
    // collapse the HTML-comment closer before anything else so a
    // cluster name like "x --> oops" cannot pass through
    .replace(/-->/g, "-→")
    .replace(/`/g, "'")
    .replace(/\]/g, ")")
    .replace(/\[/g, "(")
    // Heading characters at line start would inject H1-H6 inside a
    // bullet. The transform of `#` → `＃` (fullwidth) preserves visual
    // intent without giving markdown a syntax handle.
    .replace(/(^|\n)#/g, "$1＃")
    .replace(/[\r\n]+/g, " ")
    .trim();
  // The trim-then-collapse pipeline above misses one shape: when the
  // input was `<non-newline whitespace>#…` (`" #x"`, `"\t#x"`, `"\r#x"`),
  // `(^|\n)#` did not match (the leading char was neither `^` nor `\n`),
  // `[\r\n]+` only consumed `\r`s, and `.trim()` then ate the remaining
  // leading whitespace — leaving a literal `#` at byte 0 of the output.
  // After the prior cleanup steps the result is a single trimmed line,
  // so a final pass that defangs any surviving leading `#` is sufficient
  // and preserves all prior defences (mid-line `#` stays plain text;
  // headings post-collapse can only live at position 0).
  return intermediate.startsWith("#")
    ? `＃${intermediate.slice(1)}`
    : intermediate;
}

/**
 * Per the §8 invariant, BEGIN-line attributes must not contain `-->`.
 * We're not embedding user content inside attributes today (only
 * `weekStart`, `generatedAt`, etc. — daemon-controlled), but project
 * disambiguators come from filenames and could in principle contain a
 * `-`. Strip anything that would terminate the comment early.
 *
 * Exported so the writer (which independently computes the strip-time
 * regex) can apply the identical transform — otherwise the strip path
 * for a slug containing `-->` would never match the render path.
 */
export function escapeForHtmlComment(value: string): string {
  return value.replace(/-->/g, "-→");
}

/**
 * Format a cluster's foreground seconds as a compact hour figure for
 * the bullet body: `~3.2h` / `~38min` / `~12sec`.
 */
export function formatHoursCompact(sec: number): string {
  if (sec >= 3600) return `~${(sec / 3600).toFixed(1)}h`;
  if (sec >= 60) return `~${Math.round(sec / 60)}min`;
  if (sec > 0) return `~${sec}sec`;
  return "0sec";
}

/**
 * Format a cluster's bullet line for `profile.md` / project files.
 * Single line, ~10-15 tokens, links to the cluster journal at a
 * compact relative path. Numeric fields come straight from
 * `ClusterSnapshot`, so the bullet is the same byte-for-byte across
 * runs.
 */
function renderClusterBullet(cluster: ClusterSnapshot): string {
  const name = escapeForMd(cluster.displayName);
  const time = formatHoursCompact(cluster.meaningfulForegroundSec);
  return (
    `- **${name}** — ${cluster.daysActive} day${cluster.daysActive === 1 ? "" : "s"}, `
    + `${cluster.meaningfulVisits} source${cluster.meaningfulVisits === 1 ? "" : "s"}, `
    + `${time} → \`${cluster.clusterJournalPath}\``
  );
}

/**
 * Render the `## Current research themes (auto)` block bytes for
 * `user/profile.md`.
 *
 * Inputs:
 * - `clusters`: the post-`selectProfileMdThemes` list (3-7 entries).
 * - `weekStart` / `generatedAt`: attribute metadata for the BEGIN line.
 *
 * Output: full block text, including BEGIN/END markers. The caller
 * pastes this directly into the file via `replaceAutoBlock`.
 */
export function renderProfileBlock(args: {
  clusters: readonly ClusterSnapshot[];
  weekStart: string;
  generatedAt: string;
}): string {
  const bullets = args.clusters.map(renderClusterBullet).join("\n");
  return [
    `${BEGIN_MARKER} weekStart=${args.weekStart} generatedAt=${args.generatedAt} -->`,
    `## Current research themes (auto)`,
    ``,
    `_Auto-refreshed each weekly review. Full snapshot in \`user/research-themes.md\`._`,
    ``,
    bullets,
    ``,
    `${END_MARKER} -->`,
  ].join("\n");
}

/**
 * Render the per-project annotation block for `projects/<slug>.md`.
 * Returns `null` when there are no matched clusters — the caller
 * removes any pre-existing block in that case rather than writing an
 * empty "no matches this week" placeholder (noise, per §7.3).
 */
export function renderProjectBlock(args: {
  projectSlug: string;
  clusters: readonly ClusterSnapshot[];
  weekStart: string;
  generatedAt: string;
}): string | null {
  if (args.clusters.length === 0) return null;
  const slug = escapeForHtmlComment(args.projectSlug);
  const bullets = args.clusters
    .map((cluster) => {
      const name = escapeForMd(cluster.displayName);
      const time = formatHoursCompact(cluster.meaningfulForegroundSec);
      return (
        `- **${name}** (\`${cluster.slug}\`) — `
        + `${cluster.daysActive} day${cluster.daysActive === 1 ? "" : "s"}, `
        + `${cluster.meaningfulVisits} source${cluster.meaningfulVisits === 1 ? "" : "s"}, `
        + `${time}. [Cluster journal](../research/${cluster.slug}.md)`
      );
    })
    .join("\n");
  return [
    `${BEGIN_MARKER} project=${slug} weekStart=${args.weekStart} generatedAt=${args.generatedAt} -->`,
    `## Related browser research (auto, refreshed weekly)`,
    ``,
    `This week's browser activity related to **${escapeForMd(args.projectSlug)}**:`,
    ``,
    bullets,
    ``,
    `${END_MARKER} project=${slug} -->`,
  ].join("\n");
}

/**
 * Render the one-line `_index.md` entry pointing at
 * `research-themes.md`. Same Mode-A delimited-block convention, with
 * the disambiguator `target=research-themes`.
 */
export function renderIndexEntryBlock(args: {
  generatedAt: string;
}): string {
  const dateOnly = args.generatedAt.slice(0, 10);
  return [
    `${BEGIN_MARKER} target=research-themes -->`,
    `- \`research-themes.md\` — Auto-generated weekly snapshot of current research themes from browser activity. Last refreshed: ${dateOnly}.`,
    `${END_MARKER} target=research-themes -->`,
  ].join("\n");
}

/**
 * Render the wholly-owned `user/research-themes.md` file (Mode B).
 * Includes frontmatter, full cluster list (up to 20 entries), and the
 * "Dormant since last week" tail.
 */
export function renderResearchThemesFile(
  summary: WeeklyInterestsSummary,
): string {
  const generatedDate = summary.generatedAt.slice(0, 10);
  const lines: string[] = [];
  lines.push(`---`);
  lines.push(`type: user`);
  lines.push(`owner: aitne-browser-history`);
  lines.push(`updated: ${generatedDate}`);
  lines.push(`generated_at: ${summary.generatedAt}`);
  lines.push(`week_start: ${summary.weekStart}`);
  lines.push(`week_end: ${summary.weekEnd}`);
  lines.push(`clusters_active: ${summary.clusters.length}`);
  lines.push(
    `clusters_dormant_since_last_week: ${summary.dormantSinceLastWeek.length}`,
  );
  lines.push(`---`);
  lines.push(``);
  lines.push(`# Research themes — week of ${summary.weekStart}`);
  lines.push(``);
  lines.push(
    `<!-- Daemon-owned. Manual edits are overwritten by the next weekly_review pass. -->`,
  );
  lines.push(``);

  lines.push(`## Active themes`);
  lines.push(``);
  if (summary.clusters.length === 0) {
    lines.push(
      `_No active research themes this week. The reflection will refresh once browser activity resumes._`,
    );
    lines.push(``);
  } else {
    for (const cluster of summary.clusters) {
      lines.push(renderActiveClusterSection(cluster));
      lines.push(``);
    }
  }

  lines.push(`## Dormant since last week`);
  lines.push(``);
  if (summary.dormantSinceLastWeek.length === 0) {
    lines.push(`_No themes went dormant this week._`);
    lines.push(``);
  } else {
    lines.push(
      `These themes appeared in last week's snapshot but had no meaningful activity in the past 7 days:`,
    );
    lines.push(``);
    for (const dormant of summary.dormantSinceLastWeek) {
      lines.push(renderDormantBullet(dormant));
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function renderActiveClusterSection(cluster: ClusterSnapshot): string {
  const name = escapeForMd(cluster.displayName);
  const time = formatHoursCompact(cluster.meaningfulForegroundSec);
  const topDomains = cluster.topDomains.length > 0
    ? cluster.topDomains.map(escapeForMd).join(", ")
    : "_(no domain data)_";
  const statusLine = cluster.statusChange === "new"
    ? "new this week"
    : "active (continued)";
  return [
    `### ${name} (\`${cluster.slug}\`)`,
    `- **Days active**: ${cluster.daysActive}`,
    `- **Meaningful visits**: ${cluster.meaningfulVisits}`,
    `- **Foreground time**: ${time}`,
    `- **Top domains**: ${topDomains}`,
    // Drop the `context/` prefix from the display text. The link target
    // stays `../<clusterJournalPath>` (relative to
    // `user/research-themes.md`, so it correctly resolves to
    // `context/research/<slug>.md`); the visible text matches the
    // path the user would actually navigate to in the vault root.
    // Earlier drafts (§7.2 sample) had a redundant `context/` prefix
    // in the display text that didn't match any real on-disk path.
    `- **Cluster journal**: [${cluster.clusterJournalPath}](../${cluster.clusterJournalPath})`,
    `- **Last week's status**: ${statusLine}`,
  ].join("\n");
}

function renderDormantBullet(dormant: DormantClusterEntry): string {
  const name = escapeForMd(dormant.displayName);
  return `- **${name}** (\`${dormant.slug}\`) — last activity ${dormant.lastActivity}`;
}

/**
 * Match BEGIN/END markers, with optional disambiguator. The pattern is
 * non-greedy across newlines (`[^]*?`) so back-to-back blocks in a
 * pathological file don't get fused.
 *
 * **Prefix-collision guard**: the BEGIN side requires a literal space
 * after the disambiguator, which is always present in the renderer
 * output (`project=<slug> weekStart=...` or `target=research-themes
 * -->`). Without the trailing space, searching for `project=aitne`
 * would prefix-match a `project=aitne-foo` BEGIN line and — when a
 * shorter-slug END appears later in the file — fuse multiple blocks
 * into a single replacement.
 */
function buildBlockRegex(disambiguator: string | null): RegExp {
  if (disambiguator !== null) {
    const escaped = disambiguator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `${escapeRegex(BEGIN_MARKER)} ${escaped} [^]*?${escapeRegex(END_MARKER)} ${escaped} -->`,
      "m",
    );
  }
  // For the unscoped profile.md block, the disambiguator is `weekStart=…`
  // — match BEGIN_MARKER through END_MARKER without a trailing
  // disambiguator on the close.
  return new RegExp(
    `${escapeRegex(BEGIN_MARKER)}[^]*?${escapeRegex(END_MARKER)} -->`,
    "m",
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace an existing `aitne:browser-interests v1` auto-block in
 * `fileContent`, or append `newBlockContent` to the end of the file if
 * no matching block exists.
 *
 * `disambiguator` is the `target=…` / `project=…` attribute that
 * appears on both BEGIN and END lines, for `_index.md` and project
 * files. Pass `null` for `profile.md` where the block is unique.
 *
 * On append, the helper ensures exactly one blank line between the
 * prior file content and the new block, regardless of whether the file
 * ended in `\n` or `\n\n`. This keeps the diff minimal across runs.
 */
export function replaceAutoBlock(
  fileContent: string,
  newBlockContent: string,
  disambiguator: string | null = null,
): string {
  const pattern = buildBlockRegex(disambiguator);
  if (pattern.test(fileContent)) {
    return fileContent.replace(pattern, newBlockContent);
  }
  // Append. Normalise the trailing whitespace so the inserted block
  // always sits two newlines below the prior content.
  const trimmedTail = fileContent.replace(/\s*$/, "");
  const separator = trimmedTail.length === 0 ? "" : "\n\n";
  return `${trimmedTail}${separator}${newBlockContent}\n`;
}

/**
 * Strip every `aitne:browser-interests v1` auto-block from
 * `fileContent`, including any disambiguator. Used by the cleanup
 * endpoint.
 *
 * Returns `{ content, blocksRemoved }`. `blocksRemoved === 0` is
 * idempotent — the caller can safely re-invoke without an error.
 */
export function stripAllAutoBlocks(
  fileContent: string,
): { content: string; blocksRemoved: number } {
  let blocksRemoved = 0;
  let content = fileContent;
  // Greedy strip — the `(?: \S+=\S+)*` BEGIN-attribute glob plus the
  // optional END-disambiguator covers `target=…`, `project=…`, the
  // weekStart/generatedAt attributes (which appear on BEGIN only), and
  // any future attribute we add to the BEGIN line without an END
  // counterpart.
  const pattern = new RegExp(
    `${escapeRegex(BEGIN_MARKER)}[^]*?${escapeRegex(END_MARKER)}(?: [^>]*?)? -->\\s*`,
    "m",
  );
  while (pattern.test(content)) {
    content = content.replace(pattern, "");
    blocksRemoved += 1;
  }
  // Restore one trailing newline if the original had one and we ate it.
  if (
    fileContent.length > 0
    && fileContent.endsWith("\n")
    && !content.endsWith("\n")
  ) {
    content += "\n";
  }
  return { content, blocksRemoved };
}
