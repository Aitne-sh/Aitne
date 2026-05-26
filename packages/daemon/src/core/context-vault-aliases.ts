/**
 * Legacy vault-path alias resolver (CONTEXT_VAULT_REDESIGN_PLAN.md
 * §7.3 + §14.3 + v4 V8).
 *
 * **Why it exists.** The vault restructure moves files from
 * `user/` / `rules/` / `routines/` / `projects/` / `daily/` / etc. into
 * six class directories (`identity/`, `state/`, `plans/`, `journal/`,
 * `knowledge/`, `policies/`). All daemon code is updated in lockstep, but
 * shipped agent assets (≥186 `curl` invocations across task-flows and
 * SKILL.md files) still spell paths the old way until the PR-6 content
 * sweep lands. Without a translation layer, every legacy `curl -X PATCH
 * /api/context/today.md` would 404 the moment the new layout boots.
 *
 * **Why not HTTP 308.** The shipped `curl` invocations omit `-L`, so an
 * HTTP 3xx would terminate the request rather than follow it. The
 * resolver therefore performs the mapping **in-process before any HTTP
 * routing**, and the route handler emits its normal `200/201/4xx` for
 * the canonical path.
 *
 * **Where to call it.** Anywhere the daemon converts a vault-path
 * string into a filesystem read/write — primarily the
 * `/api/context/<path>` chokepoint in `api/routes/context/index.ts`,
 * and the snapshot-restore + DB path-key migration in `setup-migrate.ts`.
 * The single helper guarantees old and new spellings cannot drift.
 *
 * **Scope.** Only the path *string* is translated. PATCH section names,
 * HTTP verbs, request bodies, and snapshot trigger labels are all left
 * untouched — the legacy aliases are 1:1 with the new spellings, no
 * shape changes ride along.
 *
 * **Lifecycle.** The alias is intended to live for **one minor release**
 * (one `aitne` version) — long enough for the PR-6 agent-asset content
 * sweep to rewrite every shipped reference. After that the aliases stay
 * but emit an operator-visible warning, and the final removal lands in
 * the subsequent minor release. The mechanism itself is idempotent and
 * cheap; the lifetime cap is for prose-correctness, not safety.
 */

/**
 * Outcome of a single alias resolution.
 *
 *  - `result.aliased = false` → the path was already in canonical form
 *    (or did not match any legacy pattern). The handler proceeds as is.
 *  - `result.aliased = true`  → the path was legacy. `canonicalPath` is
 *    what the handler should treat as the request target; `legacyPath`
 *    is what the client originally sent (for telemetry + warning
 *    headers).
 */
export interface VaultPathAliasResult {
  readonly canonicalPath: string;
  readonly legacyPath: string;
  readonly aliased: boolean;
}

/**
 * Vault-path alias table. Each entry maps a legacy *path prefix* (with
 * trailing slash if it's a directory; bare filename otherwise) to its
 * canonical six-class equivalent.
 *
 * **Order matters.** Longer / more-specific prefixes must come first so
 * `rules/policies/` rewrites before the more general `rules/` would
 * shadow it. The exported `VAULT_PATH_ALIASES` constant is the sorted
 * source of truth — entries here MUST be added in longest-prefix-first
 * order at write time so a reader can scan top-down without reordering.
 */
export interface VaultPathAlias {
  readonly fromPrefix: string;
  readonly toPrefix: string;
  /**
   * Optional sentinel for the "exact bare filename" case (e.g.
   * `today.md` ↔ `today`). When set, the alias only fires if the input
   * matches the prefix exactly OR the prefix followed by `.md`. This
   * prevents a stray `today.md.bak` from being silently aliased.
   */
  readonly exactOnly?: boolean;
}

/**
 * Sorted longest-prefix-first. Used by `aliasVaultPath` to translate
 * legacy paths and by the migration's JSON-blob rewrite step
 * (`rewriteJsonBlobs` in `db/migrations/context-vault-restructure.ts`)
 * to rewrite vault paths embedded in `agent_actions.detail`,
 * `observations.payload`, and `messages.metadata`.
 */
export const VAULT_PATH_ALIASES: readonly VaultPathAlias[] = [
  // Directory-prefix renames. Longest first.
  // `rules/policies/` (legacy capture dir) before `rules/`.
  { fromPrefix: "rules/policies/", toPrefix: "policies/management-captures/" },
  // `agent/scratch/` before `agent/`.
  { fromPrefix: "agent/scratch/", toPrefix: "state/scratch/" },
  // `agent/journal` (file, with or without `.md`).
  { fromPrefix: "agent/journal", toPrefix: "journal/agent", exactOnly: true },
  // `agent/profile-questions` (file, with or without `.md`).
  {
    fromPrefix: "agent/profile-questions",
    toPrefix: "state/profile-questions",
    exactOnly: true,
  },
  // Generic `rules/` and `routines/`.
  { fromPrefix: "rules/", toPrefix: "policies/" },
  { fromPrefix: "routines/", toPrefix: "policies/routines/" },
  // `projects/` → `plans/projects/`.
  { fromPrefix: "projects/", toPrefix: "plans/projects/" },
  // Journal subtrees.
  { fromPrefix: "daily/", toPrefix: "journal/daily/" },
  { fromPrefix: "weekly/", toPrefix: "journal/weekly/" },
  { fromPrefix: "monthly/", toPrefix: "journal/monthly/" },
  // Knowledge subtrees.
  { fromPrefix: "dossiers/", toPrefix: "knowledge/dossiers/" },
  // State subtrees.
  { fromPrefix: "inbox/", toPrefix: "state/inbox/" },
  { fromPrefix: "_activity/", toPrefix: "state/activity/" },
  // Identity (user/).
  { fromPrefix: "user/", toPrefix: "identity/" },
  // Loose top-level files. `exactOnly` so `today.md.bak` isn't aliased.
  { fromPrefix: "today", toPrefix: "state/today", exactOnly: true },
  { fromPrefix: "yesterday", toPrefix: "state/yesterday", exactOnly: true },
  { fromPrefix: "roadmap", toPrefix: "plans/roadmap", exactOnly: true },
] as const;

/**
 * git/<slug>/overview.md → knowledge/repos/<slug>/overview.md
 * git/<slug>/journal/<date>.md → journal/repos/<slug>/<date>.md
 *
 * These are pattern-aliases (not prefix-aliases) because the slug
 * segment is part of the canonical destination. Handled separately so
 * the prefix walker stays a pure prefix scan.
 */
const GIT_OVERVIEW_RE = /^git\/([^/]+)\/overview(\.md)?$/;
const GIT_JOURNAL_RE = /^git\/([^/]+)\/journal\/([^/]+?)(\.md)?$/;

/**
 * Management entity / domain-index pattern aliases. Domains live in
 * `packages/shared/src/management-domains.ts`; the regex matches any
 * leading segment so the pattern doesn't need to enumerate them. The
 * caller still gets a stable canonical form regardless.
 *
 * `<domain>/_index.md` → `knowledge/entities/<domain>/_index.md`
 * `<domain>/<type-plural>/<slug>(.md)?` → `knowledge/entities/<domain>/<type-plural>/<slug>(.md)?`
 *
 * Recognised domains are pinned to avoid colliding with arbitrary
 * top-level paths the user may have under the vault root. The list
 * mirrors `MANAGEMENT_DOMAINS` in `packages/shared/src/management-domains.ts`.
 */
const MANAGEMENT_DOMAIN_NAMES = [
  "work",
  "travel",
  "finance",
  "personal",
  "health",
  "learning",
] as const;

const DOMAIN_INDEX_RE = new RegExp(
  `^(?<domain>${MANAGEMENT_DOMAIN_NAMES.join("|")})/_index(\\.md)?$`,
);
const DOMAIN_ENTITY_RE = new RegExp(
  `^(?<domain>${MANAGEMENT_DOMAIN_NAMES.join("|")})/(?<typePlural>[a-z][a-z0-9-]*)/(?<slug>[^/]+?)(\\.md)?$`,
);

/**
 * Translate a vault-relative path from its legacy spelling to its
 * canonical six-class spelling. Returns the input verbatim (with
 * `aliased=false`) if no rule applies.
 *
 * Idempotent: calling the resolver on an already-canonical path is a
 * no-op. This is what makes it safe to invoke unconditionally at every
 * entry point.
 *
 * The resolver does not validate that the resulting path is reachable
 * on disk — that is the caller's job (e.g. `safePath` for the HTTP
 * route). The job here is purely string translation.
 */
export function aliasVaultPath(relativePath: string): VaultPathAliasResult {
  // Defensive normalisation — strip a leading slash so the resolver can
  // be called with either form. Trailing slashes are preserved
  // (callers like the migration manifest use `state/inbox/` as a dir).
  const input =
    relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;

  // Already canonical — fast path.
  if (isCanonicalSixClassPath(input)) {
    return { canonicalPath: input, legacyPath: input, aliased: false };
  }

  // Pattern aliases first (git fanout + management entities).
  const gitOverview = GIT_OVERVIEW_RE.exec(input);
  if (gitOverview) {
    const slug = gitOverview[1]!;
    const suffix = gitOverview[2] ?? "";
    return {
      canonicalPath: `knowledge/repos/${slug}/overview${suffix}`,
      legacyPath: input,
      aliased: true,
    };
  }
  const gitJournal = GIT_JOURNAL_RE.exec(input);
  if (gitJournal) {
    const slug = gitJournal[1]!;
    const date = gitJournal[2]!;
    const suffix = gitJournal[3] ?? "";
    return {
      canonicalPath: `journal/repos/${slug}/${date}${suffix}`,
      legacyPath: input,
      aliased: true,
    };
  }
  const domainIndex = DOMAIN_INDEX_RE.exec(input);
  if (domainIndex) {
    const { domain } = domainIndex.groups!;
    const suffix = input.endsWith(".md") ? ".md" : "";
    return {
      canonicalPath: `knowledge/entities/${domain}/_index${suffix}`,
      legacyPath: input,
      aliased: true,
    };
  }
  const domainEntity = DOMAIN_ENTITY_RE.exec(input);
  if (domainEntity) {
    const { domain, typePlural, slug } = domainEntity.groups!;
    const suffix = input.endsWith(".md") ? ".md" : "";
    return {
      canonicalPath: `knowledge/entities/${domain}/${typePlural}/${slug}${suffix}`,
      legacyPath: input,
      aliased: true,
    };
  }

  // Prefix aliases.
  for (const alias of VAULT_PATH_ALIASES) {
    if (alias.exactOnly) {
      if (input === alias.fromPrefix) {
        return {
          canonicalPath: alias.toPrefix,
          legacyPath: input,
          aliased: true,
        };
      }
      if (input === `${alias.fromPrefix}.md`) {
        return {
          canonicalPath: `${alias.toPrefix}.md`,
          legacyPath: input,
          aliased: true,
        };
      }
      continue;
    }
    if (input.startsWith(alias.fromPrefix)) {
      return {
        canonicalPath: alias.toPrefix + input.slice(alias.fromPrefix.length),
        legacyPath: input,
        aliased: true,
      };
    }
  }

  return { canonicalPath: input, legacyPath: input, aliased: false };
}

/**
 * The six top-level classes the new layout uses. A path that already
 * starts with one of these is canonical and the resolver short-circuits.
 */
const CANONICAL_PREFIXES = [
  "identity/",
  "state/",
  "plans/",
  "journal/",
  "knowledge/",
  "policies/",
] as const;

function isCanonicalSixClassPath(input: string): boolean {
  if (input === "_index.md" || input === "_index") return true;
  // `.context-vault-version` is a runtime marker that lives at the
  // contextDir root; it's not a "vault content" path but consumers
  // sometimes round-trip it.
  if (input === ".context-vault-version") return true;
  for (const prefix of CANONICAL_PREFIXES) {
    if (input.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Diagnostic helper — returns every alias entry whose `fromPrefix` would
 * shadow another. Used by a peer test to assert the static table stays
 * in longest-prefix-first order.
 */
export function findShadowingAliases(): Array<{
  earlier: VaultPathAlias;
  shadowed: VaultPathAlias;
}> {
  const shadows: Array<{ earlier: VaultPathAlias; shadowed: VaultPathAlias }> =
    [];
  for (let i = 0; i < VAULT_PATH_ALIASES.length; i++) {
    const earlier = VAULT_PATH_ALIASES[i]!;
    for (let j = i + 1; j < VAULT_PATH_ALIASES.length; j++) {
      const later = VAULT_PATH_ALIASES[j]!;
      if (earlier.exactOnly || later.exactOnly) continue;
      if (later.fromPrefix.startsWith(earlier.fromPrefix)) {
        shadows.push({ earlier, shadowed: later });
      }
    }
  }
  return shadows;
}
