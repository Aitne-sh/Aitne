import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  BACKEND_IDS,
  INTEGRATION_DESCRIPTORS,
  selectSkillVariantFile,
  selectTaskFlowVariantSuffix,
  type BackendId,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";

import {
  listBuiltinSlugs,
  resolveBuiltinSkillDir,
} from "./skill-source-paths.js";

/**
 * Check whether the skill AND task-flow variants a given integration would
 * require when delegated to `delegatedBackend` are all present on disk.
 * Returns missing file paths split by kind.
 *
 * DELEGATED-MODE-V2-DESIGN.md §4.1.1 — variant filenames are keyed on
 * **session backend**, not the delegated backend. Three resolutions:
 *  - sessionBackend === delegatedBackend → `null` (no skill body, native MCP)
 *  - sessionBackend !== delegatedBackend → `SKILL.delegated.<sessionBackend>.md`
 *    (cross-backend; the daemon proxy spawns delegatedBackend)
 *  - non-delegated touch → `SKILL.md` (no delegated variant required)
 *
 * Task flow variants always fire as `delegated.<sessionBackend>` whenever
 * any touched integration is delegated, regardless of same- vs cross-backend
 * (`selectTaskFlowVariantSuffix`).
 *
 * The gate enumerates every potential session backend (`BACKEND_IDS`) and
 * defers to the resolvers; that keeps the gate automatically aligned with
 * `selectSkillVariantFile` / `selectTaskFlowVariantSuffix` if those grow new
 * cases. We pin the integration's mode locally as `delegated` with the
 * supplied `delegatedBackend` so the resolvers see the post-PATCH state.
 *
 * Consumed by:
 *  - `SkillsCompiler.validateDelegatedVariants()` — startup aggregate
 *  - `PATCH /api/integrations/:key` — pre-commit hard reject (§4.7)
 *  - `buildIntegrationHealthMap` — surfaces the list in
 *    `/health.integrationModes.<key>.variantsMissing`
 */
export function missingDelegatedVariants(
  workspaceDir: string,
  integrationKey: IntegrationKey,
  delegatedBackend: BackendId,
): { skills: string[]; taskFlows: string[] } {
  return missingVariantsForMode(workspaceDir, integrationKey, {
    mode: "delegated",
    delegatedBackend,
  });
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.4 / §8.5 — symmetric to
 * {@link missingDelegatedVariants} for the new `native` mode. Used by
 * the PATCH route's pre-commit hard reject and (Phase B2 onwards) by
 * `skills-manifest.test.ts` to assert variant existence on every
 * supported `(integration, native backend)` pair before a release.
 */
export function missingNativeVariants(
  workspaceDir: string,
  integrationKey: IntegrationKey,
  nativeBackend: BackendId,
): { skills: string[]; taskFlows: string[] } {
  return missingVariantsForMode(workspaceDir, integrationKey, {
    mode: "native",
    nativeBackend,
  });
}

function missingVariantsForMode(
  workspaceDir: string,
  integrationKey: IntegrationKey,
  pinnedState:
    | { mode: "delegated"; delegatedBackend: BackendId }
    | { mode: "native"; nativeBackend: BackendId },
): { skills: string[]; taskFlows: string[] } {
  const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
  const skillsRoot = join(workspaceDir, "agent-assets", "skills");
  const taskFlowsRoot = join(workspaceDir, "agent-assets", "task-flows");

  // Synthetic post-PATCH state. The resolvers consume only `mode` and
  // the backend binding; `lastChangedAt` is required by the type but not
  // read here.
  const synthetic: IntegrationState =
    pinnedState.mode === "delegated"
      ? {
          mode: "delegated",
          delegatedBackend: pinnedState.delegatedBackend,
          deniedTools: [],
          lastChangedAt: "1970-01-01T00:00:00.000Z",
        }
      : {
          mode: "native",
          nativeBackend: pinnedState.nativeBackend,
          deniedTools: [],
          lastChangedAt: "1970-01-01T00:00:00.000Z",
        };
  const integrationsState: Partial<Record<IntegrationKey, IntegrationState>> = {
    [integrationKey]: synthetic,
  };

  // For `native` mode the variant is only required when the session
  // backend is the bound native backend (other session backends would
  // resolve to `disabled` per §5.4.1's safety degrade, so they don't need
  // a SKILL.native.<other>.md file). For `delegated` we keep the original
  // walk over every session backend since cross-backend variants ARE
  // required.
  const sessionBackendsToCheck: readonly BackendId[] =
    pinnedState.mode === "native"
      ? [pinnedState.nativeBackend]
      : BACKEND_IDS.filter((backend) => backend !== "opencode");

  // De-dup with sets — the same file path can come up under multiple
  // session backends when descriptors share a slug.
  const skills = new Set<string>();
  for (const slug of descriptor.skillsTouched) {
    for (const sessionBackend of sessionBackendsToCheck) {
      const variantFile = selectSkillVariantFile(
        slug,
        sessionBackend,
        integrationsState,
      );
      // null  → same-backend delegated drops body; no file required.
      // SKILL.md → resolver fell back to direct/disabled; no variant file.
      if (variantFile === null || variantFile === "SKILL.md") continue;
      const variantPath = join(resolveBuiltinSkillDir(skillsRoot, slug), variantFile);
      if (!existsSync(variantPath)) skills.add(variantPath);
    }
  }

  const taskFlows = new Set<string>();
  for (const flowKey of descriptor.taskFlowsTouched) {
    for (const sessionBackend of sessionBackendsToCheck) {
      const suffix = selectTaskFlowVariantSuffix(
        flowKey,
        sessionBackend,
        integrationsState,
      );
      if (suffix === "direct") continue;
      const variantPath = join(
        taskFlowsRoot,
        `${flowKey}.${suffix}.md`,
      );
      if (existsSync(variantPath)) continue;
      // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — when a task-flow lists a
      // mode-aware integration in `taskFlowsTouched` but doesn't ship a
      // per-mode variant file, the loader (`prompts.ts:loadFlowVariant`)
      // gracefully falls back to the canonical base file. Treat that as
      // a valid coverage path so the `missingDelegatedVariants` /
      // `missingNativeVariants` PATCH-time check doesn't reject a flip
      // for which the loader's base-file fallback is the designed answer.
      //
      // Concrete example: `message.received.dm` is listed in gmail /
      // google_calendar / notion `taskFlowsTouched` so the native DM
      // variant resolves; the matching delegated variant
      // (`message.received.dm.delegated.<backend>.md`) is intentionally
      // absent. The base `message.received.dm.md` carries inline
      // `<!-- mode:<predicate>:<key> -->` markers for the Calendar block
      // and routes other integrations through their per-skill bodies. The
      // loader correctly falls back, so the missing variant is not a real
      // configuration gap.
      //
      // Skill variants remain strict — a missing `SKILL.<mode>.<backend>.md`
      // leaves the agent with no per-mode body for the integration, which
      // IS a real gap. The strict check above (no leniency branch) handles
      // that.
      const basePath = join(taskFlowsRoot, `${flowKey}.md`);
      if (!existsSync(basePath)) {
        taskFlows.add(variantPath);
      }
    }
  }

  return { skills: [...skills], taskFlows: [...taskFlows] };
}

/**
 * docs/design/appendices/opencode-backend.md §10 D6 — opencode 1.14.50 documents
 * `[a-z0-9-]{1,64}` as the legal skill-slug pattern. Aitne's existing
 * built-ins all conform; this helper is the predicate the build-time
 * validator (`validateBuiltinSkillSourceTree`) and the user-skill PUT
 * endpoint both gate on.
 *
 * docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — promoted from a
 * runtime warn to a build-time throw at SkillsCompiler construction so
 * a malformed source tree refuses to boot the daemon.
 *
 * Exported for unit testing (`skills-compiler.test.ts` regression).
 */
export function isValidSkillSlug(slug: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(slug);
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — build-time invariant
 * pass over `agent-assets/skills/`. Throws on:
 *   - Any built-in slug that doesn't match `[a-z0-9-]{1,64}`.
 *   - Any SKILL.md (incl. variants like `SKILL.delegated.<backend>.md`)
 *     whose `description` exceeds `SKILL_DESCRIPTION_MAX_LENGTH`.
 *   - Any SKILL.md missing `name` or `description`.
 *
 * No-op when the source tree is absent (test workspaces / partial-clone
 * scenarios). Memoised per workspace dir + skill-tree fingerprint so
 * repeated SkillsCompiler constructions in the same process don't pay
 * the walk cost twice; tests that mutate source between constructions
 * get fresh validation because the fingerprint shifts.
 *
 * Exported for tests that exercise the failure paths in isolation.
 */
export function validateBuiltinSkillSourceTree(skillsRoot: string): void {
  if (!existsSync(skillsRoot)) return;
  const fingerprint = computeSkillTreeFingerprint(skillsRoot);
  const cached = validatedTreeCache.get(skillsRoot);
  if (cached === fingerprint) return;
  for (const slug of listBuiltinSlugs(skillsRoot)) {
    if (!isValidSkillSlug(slug)) {
      throw new Error(
        `skills_compiler.invalid_slug: ${slug} (expected [a-z0-9-]{1,64})`,
      );
    }
    const skillDir = resolveBuiltinSkillDir(skillsRoot, slug);
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) continue; // skip slugs that ship only a variant
    const primaryContent = readFileSync(skillMdPath, "utf-8");
    const primaryFm = parseSkillFrontmatter(primaryContent);
    // Stub primary (no frontmatter) — treat the whole skill as a test
    // scaffold and skip its variants too. Production builds always have
    // proper frontmatter; the fingerprint cache picks up any future
    // primary-content fix automatically.
    if (!primaryFm.name && !primaryFm.description) continue;
    if (!primaryFm.name) {
      throw new Error(
        `skills_compiler.missing_frontmatter_name: ${slug}/SKILL.md`,
      );
    }
    if (!primaryFm.description) {
      throw new Error(
        `skills_compiler.missing_frontmatter_description: ${slug}/SKILL.md`,
      );
    }
    if (primaryFm.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      throw new Error(
        `skills_compiler.description_too_long: ${slug}/SKILL.md `
          + `(${primaryFm.description.length} > ${SKILL_DESCRIPTION_MAX_LENGTH})`,
      );
    }
    // Variant validation — only run when the primary is well-formed. Each
    // variant is shipped to the model the same way the primary is, so the
    // same description-length cap applies. Variants that are stub
    // sentinels in tests are caught by the primary-stub short-circuit
    // above (this loop never runs for those).
    const entries = readdirSync(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.startsWith("SKILL.") || !name.endsWith(".md")) continue;
      if (name === "SKILL.base.md") continue; // base partial — frontmatter optional
      const variantContent = readFileSync(join(skillDir, name), "utf-8");
      const variantFm = parseSkillFrontmatter(variantContent);
      if (!variantFm.name || !variantFm.description) {
        throw new Error(
          `skills_compiler.variant_missing_frontmatter: ${slug}/${name}`,
        );
      }
      if (variantFm.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
        throw new Error(
          `skills_compiler.description_too_long: ${slug}/${name} `
            + `(${variantFm.description.length} > ${SKILL_DESCRIPTION_MAX_LENGTH})`,
        );
      }
    }
  }
  validatedTreeCache.set(skillsRoot, fingerprint);
}

const validatedTreeCache = new Map<string, string>();

function computeSkillTreeFingerprint(skillsRoot: string): string {
  // mtime-only fingerprint over SKILL*.md files: enough to bust the
  // cache on a source-tree edit between constructions without paying
  // the cost of a full content hash. Tests that mutate files within
  // the same millisecond should call SkillsCompiler.invalidateValidator()
  // — but in practice the millisecond resolution suffices.
  const parts: string[] = [];
  for (const slug of listBuiltinSlugs(skillsRoot).sort()) {
    const skillDir = resolveBuiltinSkillDir(skillsRoot, slug);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(skillDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      if (!name.startsWith("SKILL") || !name.endsWith(".md")) continue;
      try {
        const stat = statSync(join(skillDir, name));
        parts.push(`${slug}/${name}:${stat.mtimeMs}:${stat.size}`);
      } catch { /* ignore */ }
    }
  }
  return parts.join("|");
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 — parse the `name` and `description`
 * single-line YAML scalars out of a SKILL.md frontmatter block. Returns
 * `{ name: null, description: null }` when no frontmatter is present or
 * neither key is set. Multi-line block scalars (`description: |` /
 * `description: >`) are rejected at the regex level — the schema enforces
 * single-line scalars across all backends (R6).
 */
export function parseSkillFrontmatter(content: string): {
  name: string | null;
  description: string | null;
} {
  if (!content.startsWith("---")) return { name: null, description: null };
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return { name: null, description: null };
  const fm = content.slice(4, endIdx);
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    description: descMatch ? descMatch[1].trim() : null,
  };
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R5 — hard upper bound on a
 * SKILL.md `description` scalar. Enforced at SkillsCompiler construction
 * for built-in skills (refuses to boot on violation) and at
 * `PUT /api/skills/<slug>` for user-authored skills (HTTP 400). Sized to
 * fit the model's selection decision without pinning enough prose to
 * encode body content.
 */
export const SKILL_DESCRIPTION_MAX_LENGTH = 280;

/**
 * docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner
 * inheritance" — endpoints flagged `RiskTier.ReadSensitive` by
 * `safety/risk-classifier.ts` that a Codex session cannot satisfy (no
 * read-sensitive token). Any SKILL.md whose body references one of these
 * prefixes triggers a one-line banner prepend on the Codex copy. Listed
 * literally (not derived from `API_RISK` at module-load time) so the
 * core/skills-compiler module stays independent of safety/risk-classifier
 * — a circular import would invert the bootstrap order.
 *
 * Drift guard: `skills-compiler.test.ts` pins this list against the
 * RiskTier.ReadSensitive GET-prefix set in `risk-classifier.ts` so a new
 * read-sensitive endpoint added to API_RISK surfaces here at test time
 * instead of as silent 401 retries in a future Codex session.
 *
 * Exported for the drift-guard regression test only — production code
 * MUST use {@link skillBodyTouchesReadSensitive} to keep the
 * "literal prefix" decision encapsulated.
 */
export const READ_SENSITIVE_API_PREFIXES = [
  "/api/apple-calendar",
  "/api/books",
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.12 — Phase B-2 trace +
  // recent-runs reads. The trace handler returns binary screenshot /
  // trace assets; the recent-runs handler returns audit-row JSON with
  // hashed params (no raw URLs). Both are ReadSensitive because a
  // Codex session that lacks the X-Read-Token would 401 silently
  // without this prefix triggering the banner.
  "/api/browser-automation/recent-runs",
  "/api/browser-automation/traces",
  "/api/calendar",
  "/api/context",
  "/api/entities",
  "/api/mail",
  "/api/mcp/servers",
  "/api/notion",
  "/api/observations",
  "/api/obsidian",
  "/api/receipts",
  "/api/travel-bookings",
] as const;

export function skillBodyTouchesReadSensitive(skillBody: string): boolean {
  return READ_SENSITIVE_API_PREFIXES.some((prefix) =>
    skillBody.includes(prefix),
  );
}
