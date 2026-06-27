import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isValidSkillSlug,
  missingDelegatedVariants,
  missingNativeVariants,
  parseSkillFrontmatter,
  READ_SENSITIVE_API_PREFIXES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  validateBuiltinSkillSourceTree,
} from "./skills-compiler-variants.js";
import { listReadSensitiveGetPathKeys } from "../safety/risk-classifier.js";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R6 — `adaptSkillForCli` is deleted.
 * Source SKILL.md frontmatter is now byte-identical across all four
 * backends post-materialisation; no per-backend frontmatter fork.
 * `when_to_use:` has been stripped from every built-in SKILL.md (sister
 * doc Phase 0.1) so the field is no longer part of the schema. Coverage
 * for the new compile path lives in `renderSkillIndexBlock` /
 * `parseSkillFrontmatter` / `validateBuiltinSkillSourceTree` tests below.
 */
describe("parseSkillFrontmatter", () => {
  it("extracts single-line `name` and `description`", () => {
    const out = parseSkillFrontmatter(
      "---\nname: mail\ndescription: Load when reading mail.\n---\n# body\n",
    );
    expect(out.name).toBe("mail");
    expect(out.description).toBe("Load when reading mail.");
  });

  it("returns null fields when no frontmatter", () => {
    const out = parseSkillFrontmatter("# body only\n");
    expect(out).toEqual({ name: null, description: null });
  });

  it("returns null fields when frontmatter is unclosed", () => {
    const out = parseSkillFrontmatter("---\nname: x\n");
    expect(out).toEqual({ name: null, description: null });
  });
});

/**
 * Unit tests for `missingDelegatedVariants`. Consumed by
 * `/api/integrations/:key` (pre-commit reject when the user flips to
 * delegated) and `/health.integrationModes.*.variantsMissing`; silent bugs
 * here would let a delegated-mode flip succeed with no variant file on
 * disk, dropping the session back to direct `/api/*` calls that the route
 * middleware then 410-gates.
 *
 * The real skill slugs and task-flow keys come from the shared
 * `INTEGRATION_DESCRIPTORS` registry, so the test sets up a miniature
 * `agent-assets/` tree mirroring what the registry declares.
 */
describe("missingDelegatedVariants", () => {
  let workspace: string;
  let skillsRoot: string;
  let taskFlowsRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-variants-"));
    skillsRoot = join(workspace, "agent-assets", "skills");
    taskFlowsRoot = join(workspace, "agent-assets", "task-flows");
    mkdirSync(join(skillsRoot, "mail"), { recursive: true });
    mkdirSync(join(skillsRoot, "external-services"), { recursive: true });
    mkdirSync(taskFlowsRoot, { recursive: true });
    // INTEGRATION_NATIVE_MODE_DESIGN.md §8.1 — `message.received.dm` /
    // `message.received.dm_first` are listed in gmail/google_calendar/
    // notion `taskFlowsTouched` so the native DM variants resolve. Their
    // delegated variants are intentionally absent (the base files carry
    // inline mode markers). `missingVariantsForMode` accepts a missing
    // variant when the base file exists. Write the base files here so
    // these tests focus on the variants that actually MUST exist on disk.
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm.md"),
      "placeholder base dm\n",
      "utf-8",
    );
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm_first.md"),
      "placeholder base dm_first\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeVariant(relPath: string) {
    writeFileSync(join(workspace, relPath), "placeholder\n", "utf-8");
  }

  it("DELEGATED-MODE-V2 §4.1.1 — gmail × claude: same-backend resolves to null (no skill body), so only the cross-backend variants for codex / gemini sessions are required, plus the activity_scan task-flow for all three session backends", () => {
    writeVariant("agent-assets/skills/mail/SKILL.delegated.codex.md");
    writeVariant("agent-assets/skills/mail/SKILL.delegated.gemini.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.claude.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.codex.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.gemini.md");
    const result = missingDelegatedVariants(workspace, "gmail", "claude");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("DELEGATED-MODE-V2 §4.1.1 — gmail × codex: same-backend (codex) resolves null; cross-backend variants for claude / gemini sessions are required", () => {
    writeVariant("agent-assets/skills/mail/SKILL.delegated.claude.md");
    writeVariant("agent-assets/skills/mail/SKILL.delegated.gemini.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.claude.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.codex.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.gemini.md");
    const result = missingDelegatedVariants(workspace, "gmail", "codex");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("DELEGATED-MODE-V2 §4.1.1 — google_calendar × claude needs external-services {codex, gemini} variants + activity_scan {claude, codex, gemini} variants", () => {
    writeVariant("agent-assets/skills/external-services/SKILL.delegated.codex.md");
    writeVariant("agent-assets/skills/external-services/SKILL.delegated.gemini.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.claude.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.codex.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.delegated.gemini.md");
    const result = missingDelegatedVariants(workspace, "google_calendar", "claude");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("DELEGATED-MODE-V2 §4.1.1 — gmail surfaces every cross-backend skill variant + every session-backend task-flow variant when none exist on disk", () => {
    const result = missingDelegatedVariants(workspace, "gmail", "claude");
    // claude is the delegatedBackend → same-backend → null → no file required.
    // codex / gemini are cross-backend → SKILL.delegated.<sessionBackend>.md
    // required for each.
    expect(result.skills.sort()).toEqual([
      join(skillsRoot, "mail", "SKILL.delegated.codex.md"),
      join(skillsRoot, "mail", "SKILL.delegated.gemini.md"),
    ].sort());
    // selectTaskFlowVariantSuffix returns `delegated.<sessionBackend>` for
    // every session backend when any touched integration is delegated.
    expect(result.taskFlows.sort()).toEqual([
      join(taskFlowsRoot, "routine.activity_scan.delegated.claude.md"),
      join(taskFlowsRoot, "routine.activity_scan.delegated.codex.md"),
      join(taskFlowsRoot, "routine.activity_scan.delegated.gemini.md"),
    ].sort());
  });

  it("DELEGATED-MODE-V2 §4.1.1 — notion × claude: same-backend skill resolves null; cross-backend variants for codex / gemini sessions are required", () => {
    mkdirSync(join(skillsRoot, "notion"), { recursive: true });
    const result = missingDelegatedVariants(workspace, "notion", "claude");
    expect(result.skills.sort()).toEqual([
      join(skillsRoot, "notion", "SKILL.delegated.codex.md"),
      join(skillsRoot, "notion", "SKILL.delegated.gemini.md"),
    ].sort());
    expect(result.taskFlows.sort()).toEqual([
      join(taskFlowsRoot, "routine.activity_scan.delegated.claude.md"),
      join(taskFlowsRoot, "routine.activity_scan.delegated.codex.md"),
      join(taskFlowsRoot, "routine.activity_scan.delegated.gemini.md"),
    ].sort());
  });
});

/**
 * Integrity test against the real `agent-assets/` tree. Catches the class
 * of bug where the integrations registry advertises a `taskFlowsTouched`
 * entry (or `skillsTouched` slug) that has no `*.delegated.<backend>.md`
 * file on disk — a state in which `PATCH /api/integrations/:key` rejects
 * every delegated flip with HTTP 400 `missing_variants`, making delegated
 * mode unreachable for that integration. The unit tests above exercise
 * the helper in synthetic workspaces; this test pins the real registry
 * against the real assets so adding a touch entry without authoring the
 * matching file fails loudly.
 */
describe("missingDelegatedVariants — real agent-assets integrity", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  for (const integrationKey of INTEGRATION_KEYS) {
    const descriptor = INTEGRATION_DESCRIPTORS[integrationKey];
    const declaredBackends = Object.keys(descriptor.backendConnectors) as BackendId[];

    for (const backendId of declaredBackends) {
      it(`${integrationKey} → ${backendId}: every advertised variant exists on disk`, () => {
        const result = missingDelegatedVariants(
          repoRoot,
          integrationKey as IntegrationKey,
          backendId,
        );
        expect(result).toEqual({ skills: [], taskFlows: [] });
      });
    }
  }
});

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §7.4 / §12.3 — native-mode skill
 * variant resolution. Mirrors the existing `missingDelegatedVariants`
 * unit tests but pinned on the new `missingNativeVariants` helper.
 */
describe("missingNativeVariants", () => {
  let workspace: string;
  let skillsRoot: string;
  let taskFlowsRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-native-variants-"));
    skillsRoot = join(workspace, "agent-assets", "skills");
    taskFlowsRoot = join(workspace, "agent-assets", "task-flows");
    mkdirSync(join(skillsRoot, "mail"), { recursive: true });
    mkdirSync(join(skillsRoot, "external-services"), { recursive: true });
    mkdirSync(join(skillsRoot, "notion"), { recursive: true });
    mkdirSync(taskFlowsRoot, { recursive: true });
    // Mirror the delegated-variant tests' setup: write the base DM /
    // dm_first files so the `missingVariantsForMode` leniency check
    // accepts the absence of `message.received.dm.native.<backend>.md`
    // for the OTHER session backends (the helper only requires the
    // native binding's backend variant, but the loader path needs the
    // base file to fall back to for completeness).
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm.md"),
      "placeholder base dm\n",
      "utf-8",
    );
    writeFileSync(
      join(taskFlowsRoot, "message.received.dm_first.md"),
      "placeholder base dm_first\n",
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeVariant(relPath: string) {
    writeFileSync(join(workspace, relPath), "placeholder\n", "utf-8");
  }

  it("§5.4.1 — gmail × claude: native binding requires only the SKILL.native.claude.md skill variant + the routine.activity_scan.native.claude.md task-flow variant; other session backends resolve to `disabled` and need no file", () => {
    // Native is always same-backend by construction. A claude binding
    // therefore only needs the variant authored for claude sessions —
    // codex / gemini sessions land on `disabled` per §5.4.1's safety
    // degrade and need no file.
    writeVariant("agent-assets/skills/mail/SKILL.native.claude.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.native.claude.md");
    const result = missingNativeVariants(workspace, "gmail", "claude");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§5.4.1 — gmail × codex: native binding requires the codex variant only", () => {
    writeVariant("agent-assets/skills/mail/SKILL.native.codex.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.native.codex.md");
    const result = missingNativeVariants(workspace, "gmail", "codex");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§5.4.1 — gmail × gemini: native binding requires the gemini variant only", () => {
    writeVariant("agent-assets/skills/mail/SKILL.native.gemini.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.native.gemini.md");
    const result = missingNativeVariants(workspace, "gmail", "gemini");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§8.5 — surfaces both the missing skill variant AND task-flow variant when neither exists on disk", () => {
    const result = missingNativeVariants(workspace, "gmail", "claude");
    expect(result.skills).toEqual([
      join(skillsRoot, "mail", "SKILL.native.claude.md"),
    ]);
    expect(result.taskFlows).toEqual([
      join(taskFlowsRoot, "routine.activity_scan.native.claude.md"),
    ]);
  });

  it("§5.4.1 — google_calendar × codex: native binding requires the external-services native.codex.md skill + activity_scan.native.codex.md task-flow", () => {
    writeVariant("agent-assets/skills/external-services/SKILL.native.codex.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.native.codex.md");
    const result = missingNativeVariants(workspace, "google_calendar", "codex");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§5.4.1 — notion × gemini: native binding requires only the gemini variant (gemini ships a user-installed Notion MCP descriptor)", () => {
    writeVariant("agent-assets/skills/notion/SKILL.native.gemini.md");
    writeVariant("agent-assets/task-flows/routine.activity_scan.native.gemini.md");
    const result = missingNativeVariants(workspace, "notion", "gemini");
    expect(result).toEqual({ skills: [], taskFlows: [] });
  });

  it("§7.4 — same-backend native ALWAYS emits an explicit skill body (no `sameBackendDropsSkillBody` shortcut). The notion descriptor declares `sameBackendDropsSkillBody: ['notion']` for the delegated path, but native must emit SKILL.native.claude.md regardless.", () => {
    // The descriptor's `sameBackendDropsSkillBody: ["notion"]` flag
    // resolves to `null` for `same-backend` delegated AND every
    // touched integration declares the slug in that set. Native must
    // not honour the flag — §7.5 of the design pins explicit native
    // bodies. With no variant on disk, the helper surfaces it.
    const result = missingNativeVariants(workspace, "notion", "claude");
    expect(result.skills).toContain(
      join(skillsRoot, "notion", "SKILL.native.claude.md"),
    );
  });
});

describe("isValidSkillSlug — docs/design/appendices/opencode-backend.md §10 D6", () => {
  it("accepts lowercase alphanumeric + hyphen up to 64 chars", () => {
    expect(isValidSkillSlug("mail")).toBe(true);
    expect(isValidSkillSlug("user-profile")).toBe(true);
    expect(isValidSkillSlug("a")).toBe(true);
    expect(isValidSkillSlug("a".repeat(64))).toBe(true);
    expect(isValidSkillSlug("with-123-numbers")).toBe(true);
  });

  it("rejects names that opencode would silently drop", () => {
    expect(isValidSkillSlug("")).toBe(false);
    expect(isValidSkillSlug("a".repeat(65))).toBe(false);
    expect(isValidSkillSlug("Has-Capital")).toBe(false);
    expect(isValidSkillSlug("under_score")).toBe(false);
    expect(isValidSkillSlug("space inside")).toBe(false);
    expect(isValidSkillSlug("dot.separator")).toBe(false);
  });

  it("regression — every checked-in built-in skill slug conforms", () => {
    // Audit: walk `agent-assets/skills/` and assert every directory
    // name passes the lint. Catches a future skill addition that
    // accidentally introduces an invalid slug before opencode silently
    // rejects it at runtime.
    const here = dirname(fileURLToPath(import.meta.url));
    const skillsRoot = resolve(here, "..", "..", "..", "..", "agent-assets", "skills");
    if (!existsSync(skillsRoot)) {
      // Non-standard layout — skip without failing; the direct
      // conformance assertions above still cover the lint behaviour.
      return;
    }
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Top-level slugs only — nested category dirs like `wiki/<slug>/`
      // are walked separately through `listBuiltinSlugs` in production.
      expect(isValidSkillSlug(entry.name)).toBe(true);
    }
  });
});

/**
 * docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — build-time invariant
 * pass. Refuses to boot on malformed source trees so the daemon can't
 * limp along with skills the model will mis-load on description.
 */
describe("validateBuiltinSkillSourceTree", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "pa-validate-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("passes on a clean tree", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "ok");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      "---\nname: ok\ndescription: short.\n---\nbody\n",
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).not.toThrow();
  });

  it("throws when a description exceeds the cap", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "longdesc");
    mkdirSync(skillsRoot, { recursive: true });
    const overLong = "x".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      `---\nname: longdesc\ndescription: ${overLong}\n---\nbody\n`,
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).toThrow(/description_too_long/);
  });

  it("throws when a built-in slug violates `[a-z0-9-]{1,64}`", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "Bad_Slug");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      "---\nname: bad\ndescription: short.\n---\nbody\n",
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).toThrow(/invalid_slug/);
  });

  it("throws when a SKILL.md is missing `name`", () => {
    const skillsRoot = join(workspace, "agent-assets", "skills", "noname");
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(
      join(skillsRoot, "SKILL.md"),
      "---\ndescription: x.\n---\nbody\n",
      "utf-8",
    );
    expect(() => validateBuiltinSkillSourceTree(
      join(workspace, "agent-assets", "skills"),
    )).toThrow(/missing_frontmatter_name/);
  });

  it("is a no-op when the skills dir is absent (test workspaces)", () => {
    expect(() =>
      validateBuiltinSkillSourceTree(join(workspace, "no-skills-here")),
    ).not.toThrow();
  });
});

/**
 * docs/design/appendices/skills-unification.md Phase 1 §"Codex read-sensitive banner
 * inheritance" — `READ_SENSITIVE_API_PREFIXES` is a hand-maintained
 * mirror of `safety/risk-classifier.ts`'s `RiskTier.ReadSensitive` GET
 * surface. The runtime list is deliberately literal (no import of
 * `API_RISK`) to keep `core/skills-compiler` independent of
 * `safety/risk-classifier` at the bootstrap level — but a hand-
 * maintained mirror drifts.
 *
 * The drift surface is asymmetric:
 *
 *   - **Missing prefix** (skill body touches an RS endpoint that the
 *     mirror does not list) → Codex banner is silently skipped → the
 *     model retries on 401 instead of stopping. Real risk.
 *   - **Extra prefix** (mirror lists a path that is not RS) → banner
 *     falsely emitted for skills that touch that path → wasted prose
 *     but no incident. Low risk.
 *
 * The test below pins both directions so a future API_RISK edit cannot
 * silently regress the contract.
 */
describe("READ_SENSITIVE_API_PREFIXES drift guard vs risk-classifier", () => {
  const apiRiskPrefixes = listReadSensitiveGetPathKeys();

  it("covers every RiskTier.ReadSensitive GET endpoint declared in API_RISK", () => {
    // Every read-sensitive GET path in API_RISK must have at least one
    // prefix in READ_SENSITIVE_API_PREFIXES that it `startsWith(...)`.
    // A skill body that mentions the path will then trigger the Codex
    // banner via `skillBodyTouchesReadSensitive`.
    const uncovered: string[] = [];
    for (const apiPath of apiRiskPrefixes) {
      const covered = READ_SENSITIVE_API_PREFIXES.some((prefix) =>
        apiPath.startsWith(prefix),
      );
      if (!covered) uncovered.push(apiPath);
    }
    expect(uncovered).toEqual([]);
  });

  it("does not list a prefix that no API_RISK ReadSensitive route would match (low-risk regression)", () => {
    // Each entry in READ_SENSITIVE_API_PREFIXES should be the prefix of
    // at least one API_RISK ReadSensitive GET path. Failing here means
    // either the API_RISK entry has been moved/removed (delete the
    // mirror entry too) or the mirror entry was wrong to begin with
    // (`/api/profile-questions` was the canonical example before
    // rev3 — `slot-filled` is Autonomous, not RS, so the entry over-
    // triggered the banner on user-interview-adjacent skills).
    const unmatched: string[] = [];
    for (const prefix of READ_SENSITIVE_API_PREFIXES) {
      const matched = apiRiskPrefixes.some((apiPath) =>
        apiPath.startsWith(prefix) || prefix.startsWith(apiPath),
      );
      if (!matched) unmatched.push(prefix);
    }
    expect(unmatched).toEqual([]);
  });

  it("explicitly includes the previously-missing /api/mcp/servers prefix (regression pin)", () => {
    // `GET /api/mcp/servers` and `GET /api/mcp/servers/` are
    // RiskTier.ReadSensitive in `safety/risk-classifier.ts`. Pre-fix,
    // the mirror omitted them — any future skill that referenced an MCP
    // server listing would not trigger the Codex banner. Pin the entry
    // so a hand-maintenance pass cannot silently drop it again.
    expect(READ_SENSITIVE_API_PREFIXES).toContain("/api/mcp/servers");
  });

  it("does not list /api/profile-questions (no RS endpoint exists under it)", () => {
    // `GET /api/profile-questions/slot-filled` is RiskTier.Autonomous
    // (returns a single boolean, no personal payload). Pre-fix the
    // mirror over-listed `/api/profile-questions` which would falsely
    // banner-flag any skill that referenced /slot-filled. Pin the
    // exclusion so a future widening doesn't quietly regress.
    expect(READ_SENSITIVE_API_PREFIXES).not.toContain("/api/profile-questions");
  });
});

/**
 * skills-unification.md Test plan — U4a / X6 / P2 row.
 * Source-tree lints over the real `agent-assets/skills/` directory.
 * These are not testing materialisation; they assert invariants on the
 * source frontmatter that the unification + improvement plans hard-enforce.
 *
 * - U4a: no `when_to_use:` frontmatter line (Phase 0.1 + R6 cleanup).
 * - X6:  no `Bash(jq *)` in per-skill `allowed-tools` (Phase 0.8 — jq
 *        is allowed globally at the backend level instead).
 * - P2:  frontmatter keys are a strict subset of `{name, description,
 *        allowed-tools}`. Any other top-level key is a drift signal.
 */
describe("agent-assets source-tree lints (U4a / X6 / P2)", () => {
  const REPO_SKILLS_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../agent-assets/skills",
  );

  /** Enumerate flat + one-level-nested skill dirs (matches the wiki/<slug> convention). */
  function listSkillSourceDirs(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const top = join(root, entry.name);
      if (existsSync(join(top, "SKILL.md"))) {
        out.push(top);
        continue;
      }
      for (const sub of readdirSync(top, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const nested = join(top, sub.name);
        if (existsSync(join(nested, "SKILL.md"))) out.push(nested);
      }
    }
    return out;
  }

  const ALLOWED_FRONTMATTER_KEYS = new Set([
    "name",
    "description",
    "allowed-tools",
  ]);

  it("U4a — no SKILL.md declares `when_to_use:` in its frontmatter", () => {
    const offenders: string[] = [];
    for (const dir of listSkillSourceDirs(REPO_SKILLS_ROOT)) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const match = body.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      if (/^when_to_use\s*:/m.test(match[1])) {
        offenders.push(dir);
      }
    }
    expect(
      offenders,
      `when_to_use: removed per Phase 0.1 + R6 — re-introduced in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("X6 — no SKILL.md declares `Bash(jq *)` in allowed-tools (Phase 0.8)", () => {
    const offenders: string[] = [];
    for (const dir of listSkillSourceDirs(REPO_SKILLS_ROOT)) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const match = body.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      // Match either YAML list form `- Bash(jq …)` or inline `Bash(jq …)`.
      if (/Bash\s*\(\s*jq\s/m.test(match[1])) offenders.push(dir);
    }
    expect(
      offenders,
      `Bash(jq *) is globally allowed at backend level (Phase 0.8) — re-declared per-skill in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("P2 — frontmatter top-level keys are a subset of {name, description, allowed-tools}", () => {
    const offenders: { dir: string; extras: string[] }[] = [];
    for (const dir of listSkillSourceDirs(REPO_SKILLS_ROOT)) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      const match = body.match(/^---\n([\s\S]*?)\n---/);
      if (!match) continue;
      const topLevel = new Set<string>();
      for (const line of match[1].split("\n")) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
        if (m) topLevel.add(m[1]);
      }
      const extras = [...topLevel].filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
      if (extras.length > 0) offenders.push({ dir, extras });
    }
    expect(
      offenders,
      `extra frontmatter keys found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("P2 (positive) — every SKILL.md has `name:` and `description:`", () => {
    const dirs = listSkillSourceDirs(REPO_SKILLS_ROOT);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const body = readFileSync(join(dir, "SKILL.md"), "utf-8");
      expect(body, `${dir} missing name`).toMatch(/^name\s*:\s*\S/m);
      expect(body, `${dir} missing description`).toMatch(/^description\s*:\s*\S/m);
    }
  });
});
