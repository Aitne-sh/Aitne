/**
 * Frontmatter parser for the six-class vault contract
 * (CONTEXT_VAULT_REDESIGN_PLAN.md §5).
 *
 * Parses the advisory `kind` / `authority` / `mutability` / `slug` / `title`
 * fields from a Markdown file's YAML frontmatter and returns structured
 * advisories that the daemon's write-step uses to log warnings.
 *
 * **Phase 1 contract (advisory only).** A missing or malformed field logs
 * a warning and proceeds; nothing rejects the write. The Phase 2 cut-over
 * is gated behind `runtimeSettings.contextVault.enforceFrontmatter` (not
 * exposed yet) — when that lands, the same advisory shape will become a
 * 4xx structured-error response.
 *
 * **Coexistence with `context-frontmatter.ts`.** The legacy validator
 * (`type`, `owner`, `updated`, plus daily-skeleton / policy-file rules)
 * is unchanged and remains the strict gate for the surfaces it already
 * covers. The new parser is additive: it reads the new fields without
 * interpreting the old ones, so a file can carry both shapes during the
 * Phase 1 → Phase 2 transition. The single YAML extractor is shared via
 * `readContextFrontmatterValues` so the two paths cannot diverge on what
 * they consider "frontmatter."
 */

import { readContextFrontmatterValues } from "../context-frontmatter-extract.js";

/** Class — top-level directory class in the six-class layout. */
export const VAULT_FRONTMATTER_KINDS = [
  "identity",
  "state",
  "plan",
  "journal",
  "knowledge",
  "policy",
] as const;
export type VaultFrontmatterKind = (typeof VAULT_FRONTMATTER_KINDS)[number];

/** Authority — who owns the file. */
export const VAULT_FRONTMATTER_AUTHORITIES = [
  "user",
  "agent",
  "mixed",
] as const;
export type VaultFrontmatterAuthority =
  (typeof VAULT_FRONTMATTER_AUTHORITIES)[number];

/** Mutability — how writes are permitted to modify the file. */
export const VAULT_FRONTMATTER_MUTABILITIES = [
  "replace",
  "patch",
  "append",
  "readonly",
] as const;
export type VaultFrontmatterMutability =
  (typeof VAULT_FRONTMATTER_MUTABILITIES)[number];

/**
 * Parsed vault frontmatter. Every field is optional in Phase 1 — a file
 * without any of the new fields produces an object where every property
 * is `undefined`. Field-level advisories surface in `advisories`.
 */
export interface VaultFrontmatter {
  kind?: VaultFrontmatterKind;
  authority?: VaultFrontmatterAuthority;
  mutability?: VaultFrontmatterMutability;
  slug?: string;
  title?: string;
}

export type VaultFrontmatterAdvisoryCode =
  | "missing_frontmatter"
  | "missing_kind"
  | "missing_authority"
  | "missing_mutability"
  | "invalid_kind"
  | "invalid_authority"
  | "invalid_mutability"
  | "kind_path_mismatch"
  | "invalid_slug";

export interface VaultFrontmatterAdvisory {
  code: VaultFrontmatterAdvisoryCode;
  message: string;
}

export interface VaultFrontmatterParseResult {
  values: VaultFrontmatter;
  advisories: VaultFrontmatterAdvisory[];
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MAX_LENGTH = 128;

/**
 * Map from frontmatter `kind` value to its enforcing top-level directory.
 * `plan` and `policy` are singular in frontmatter but plural in the path
 * (`plans/`, `policies/`); the lookup is keyed by the frontmatter value.
 */
const KIND_TO_PATH_PREFIX: Readonly<Record<VaultFrontmatterKind, string>> = {
  identity: "identity/",
  state: "state/",
  plan: "plans/",
  journal: "journal/",
  knowledge: "knowledge/",
  policy: "policies/",
};

/**
 * Parse the optional vault frontmatter from a Markdown file. Returns the
 * parsed values plus a list of advisories that callers (the write-step
 * chokepoint) translate into structured log warnings.
 *
 * `relativePath` is required so a stated `kind` can be cross-checked
 * against the path's top-level directory. Pass the path the writer is
 * targeting (e.g. `identity/profile.md`); the helper is a no-op for any
 * non-`.md` path and for files that are out-of-scope per §5.3.
 */
export function parseVaultFrontmatter(
  content: string,
  relativePath: string,
): VaultFrontmatterParseResult {
  const result: VaultFrontmatterParseResult = {
    values: {},
    advisories: [],
  };

  if (!shouldParseVaultFrontmatter(relativePath)) return result;

  const values = readContextFrontmatterValues(content);
  if (values === null) {
    result.advisories.push({
      code: "missing_frontmatter",
      message: `${relativePath} has no YAML frontmatter; vault contract requires \`kind\`, \`authority\`, \`mutability\`.`,
    });
    return result;
  }

  const kindRaw = values.kind;
  if (!kindRaw) {
    result.advisories.push({
      code: "missing_kind",
      message: `${relativePath} frontmatter missing \`kind\` (one of: ${VAULT_FRONTMATTER_KINDS.join(", ")}).`,
    });
  } else if (!isKind(kindRaw)) {
    result.advisories.push({
      code: "invalid_kind",
      message: `${relativePath} frontmatter \`kind: ${kindRaw}\` is not one of: ${VAULT_FRONTMATTER_KINDS.join(", ")}.`,
    });
  } else {
    result.values.kind = kindRaw;
    const expectedPrefix = KIND_TO_PATH_PREFIX[kindRaw];
    if (!relativePath.startsWith(expectedPrefix)) {
      result.advisories.push({
        code: "kind_path_mismatch",
        message: `${relativePath} declares \`kind: ${kindRaw}\` but path does not begin with \`${expectedPrefix}\`.`,
      });
    }
  }

  const authorityRaw = values.authority;
  if (!authorityRaw) {
    result.advisories.push({
      code: "missing_authority",
      message: `${relativePath} frontmatter missing \`authority\` (one of: ${VAULT_FRONTMATTER_AUTHORITIES.join(", ")}).`,
    });
  } else if (!isAuthority(authorityRaw)) {
    result.advisories.push({
      code: "invalid_authority",
      message: `${relativePath} frontmatter \`authority: ${authorityRaw}\` is not one of: ${VAULT_FRONTMATTER_AUTHORITIES.join(", ")}.`,
    });
  } else {
    result.values.authority = authorityRaw;
  }

  const mutabilityRaw = values.mutability;
  if (!mutabilityRaw) {
    result.advisories.push({
      code: "missing_mutability",
      message: `${relativePath} frontmatter missing \`mutability\` (one of: ${VAULT_FRONTMATTER_MUTABILITIES.join(", ")}).`,
    });
  } else if (!isMutability(mutabilityRaw)) {
    result.advisories.push({
      code: "invalid_mutability",
      message: `${relativePath} frontmatter \`mutability: ${mutabilityRaw}\` is not one of: ${VAULT_FRONTMATTER_MUTABILITIES.join(", ")}.`,
    });
  } else {
    result.values.mutability = mutabilityRaw;
  }

  const slugRaw = values.slug;
  if (slugRaw) {
    if (slugRaw.length > SLUG_MAX_LENGTH || !SLUG_RE.test(slugRaw)) {
      result.advisories.push({
        code: "invalid_slug",
        message: `${relativePath} frontmatter \`slug: ${slugRaw}\` must be kebab-case (a-z, 0-9, hyphen), 1-${SLUG_MAX_LENGTH} chars, no leading/trailing hyphen.`,
      });
    } else {
      result.values.slug = slugRaw;
    }
  }

  const titleRaw = values.title;
  if (titleRaw) {
    result.values.title = titleRaw;
  }

  return result;
}

/**
 * The set of writeable vault paths whose frontmatter the new parser
 * advises on. Phase 1 scope: any `.md` file under one of the six class
 * directories OR a legacy top-level path that still maps cleanly under
 * the upcoming layout (so the alias resolver in PR-3 transparently
 * routes both). `_index.md` files are excluded — they are
 * machine-rebuilt or user-curated navigation, not authored content.
 */
export function shouldParseVaultFrontmatter(relativePath: string): boolean {
  if (!relativePath.endsWith(".md")) return false;
  if (relativePath.endsWith("/_index.md")) return false;
  if (relativePath === "_index.md") return false;

  // New six-class prefixes (the layout PR-3 lands).
  for (const prefix of Object.values(KIND_TO_PATH_PREFIX)) {
    if (relativePath.startsWith(prefix)) return true;
  }

  // Legacy prefixes that map 1:1 under the new layout. The advisory still
  // applies pre-migration so authors writing new content during the
  // transition can opt into the new fields early.
  const legacyPrefixes = [
    "user/",
    "rules/",
    "routines/",
    "projects/",
    "daily/",
    "weekly/",
    "monthly/",
    "dossiers/",
    "inbox/",
    "agent/",
    "git/",
  ];
  for (const prefix of legacyPrefixes) {
    if (relativePath.startsWith(prefix)) return true;
  }

  // Loose top-level files that pass through the rewriter.
  if (
    relativePath === "today.md" ||
    relativePath === "yesterday.md" ||
    relativePath === "roadmap.md"
  ) {
    return true;
  }

  return false;
}

function isKind(value: string): value is VaultFrontmatterKind {
  return (VAULT_FRONTMATTER_KINDS as readonly string[]).includes(value);
}
function isAuthority(value: string): value is VaultFrontmatterAuthority {
  return (VAULT_FRONTMATTER_AUTHORITIES as readonly string[]).includes(value);
}
function isMutability(value: string): value is VaultFrontmatterMutability {
  return (VAULT_FRONTMATTER_MUTABILITIES as readonly string[]).includes(value);
}
