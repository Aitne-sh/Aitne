/**
 * Skill source-path conventions for `agent-assets/skills/`.
 *
 * Most built-in skills sit at the root of the skills directory as
 * `<slug>/SKILL.md`. The wiki subsystem (WIKI_BUILDER_DESIGN.md §9.1)
 * groups its bundle under a `wiki/` category subdirectory:
 * `wiki/<wiki-slug>/SKILL.md`. Slugs remain globally unique — the
 * subdirectory is purely an authoring-layout choice — so callers that
 * key by slug (manifest, dispatcher, session-dir destination) don't
 * change.
 *
 * Everything that resolves a slug → source directory must funnel
 * through this module so the convention stays single-sourced.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Slug-prefix → category-subdirectory map. Each entry means
 * "slugs starting with this prefix live under `<root>/<subdir>/`".
 * Order does not matter — prefixes must be disjoint.
 */
const SKILL_CATEGORY_PREFIXES: ReadonlyArray<{ prefix: string; subdir: string }> = [
  { prefix: "wiki-", subdir: "wiki" },
];

const CATEGORY_SUBDIRS = new Set(SKILL_CATEGORY_PREFIXES.map(({ subdir }) => subdir));

/**
 * Is `name` a category subdir under `agent-assets/skills/`? Used by
 * scanners to decide whether to recurse one level instead of treating
 * the entry as a slug.
 */
export function isSkillCategorySubdir(name: string): boolean {
  return CATEGORY_SUBDIRS.has(name);
}

/** Resolve `<skillsRoot>/[<category>/]<slug>` for a given slug. */
export function resolveBuiltinSkillDir(skillsRoot: string, slug: string): string {
  for (const { prefix, subdir } of SKILL_CATEGORY_PREFIXES) {
    if (slug.startsWith(prefix)) {
      return join(skillsRoot, subdir, slug);
    }
  }
  return join(skillsRoot, slug);
}

/**
 * Enumerate every slug-style directory. A directory is treated as a
 * slug unless its name matches a known category subdir
 * ({@link isSkillCategorySubdir}); category dirs are recursed one level
 * deep. SKILL.md presence is not required — the curation scanners need
 * to enumerate slug dirs that carry only `curation.json`.
 *
 * The two output flavours below differ only in payload shape:
 * `listBuiltinSlugs` returns slugs (for set-membership / prune use
 * cases) and `listBuiltinSkillDirs` returns both slug and the resolved
 * source directory (for read use cases).
 */
function walkSlugDirs(
  skillsRoot: string,
): ReadonlyArray<{ slug: string; dir: string }> {
  if (!existsSync(skillsRoot)) return [];
  const out: Array<{ slug: string; dir: string }> = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const childRoot = join(skillsRoot, entry.name);
    if (isSkillCategorySubdir(entry.name)) {
      // Recurse one level — grandchild directories are slug dirs.
      for (const sub of readdirSync(childRoot, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        out.push({ slug: sub.name, dir: join(childRoot, sub.name) });
      }
      continue;
    }
    out.push({ slug: entry.name, dir: childRoot });
  }
  return out;
}

export function listBuiltinSlugs(skillsRoot: string): string[] {
  return walkSlugDirs(skillsRoot).map((entry) => entry.slug);
}

export function listBuiltinSkillDirs(
  skillsRoot: string,
): ReadonlyArray<{ slug: string; dir: string }> {
  return walkSlugDirs(skillsRoot);
}
