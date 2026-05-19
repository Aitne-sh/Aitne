import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureSkeletonFiles,
  FALLBACK_PLACEHOLDERS,
  resolveTemplatesRoot,
} from "./skeleton.js";
import { CONTEXT_DIR_NAMES, CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { validateRoadmap } from "./roadmap-validate.js";
import { isRoadmapStale } from "../config.js";

/**
 * Frontmatter matching the production templates. Test fixtures need to
 * ship with the same shape production templates do so their content
 * survives the skeleton pass unchanged.
 */
function withFrontmatter(type: string, owner: string, title: string): string {
  return [
    "---",
    `type: ${type}`,
    `owner: ${owner}`,
    "updated: 2026-04-21",
    "---",
    `# ${title}`,
    "",
  ].join("\n");
}

function seedTemplateTree(workspaceDir: string): void {
  const root = join(workspaceDir, "agent-assets", "templates");
  mkdirSync(join(root, "rules"), { recursive: true });
  mkdirSync(join(root, "rules", "policies"), { recursive: true });
  mkdirSync(join(root, "user"), { recursive: true });
  mkdirSync(join(root, "routines"), { recursive: true });
  writeFileSync(join(root, "_index.md"), "# Vault index\n");
  writeFileSync(
    join(root, "rules", "management.md"),
    withFrontmatter("rule", "shared", "Management"),
  );
  writeFileSync(
    join(root, "rules", "redaction.md"),
    withFrontmatter("rule", "shared", "Redaction"),
  );
  // MANAGEMENT-POLICY-CAPTURE-PLAN §5.3 — policies sub-index is
  // agent-owned; make sure the seeded fixture mirrors the real
  // `agent-assets/templates/rules/policies/_index.md` shape so a
  // regression in skeleton seeding (e.g. recursive copy stops at the
  // first directory level) is caught.
  writeFileSync(
    join(root, "rules", "policies", "_index.md"),
    withFrontmatter("index", "agent", "Active Policies"),
  );
  writeFileSync(
    join(root, "user", "profile.md"),
    withFrontmatter("user", "shared", "Profile"),
  );
  writeFileSync(
    join(root, "user", "people.md"),
    withFrontmatter("user", "shared", "People"),
  );
  writeFileSync(
    join(root, "user", "work.md"),
    withFrontmatter("user", "shared", "Work"),
  );
  writeFileSync(
    join(root, "user", "expertise.md"),
    withFrontmatter("user", "shared", "Expertise"),
  );
  writeFileSync(
    join(root, "user", "personal.md"),
    withFrontmatter("user", "shared", "Personal"),
  );
  writeFileSync(
    join(root, "user", "goals.md"),
    withFrontmatter("user", "shared", "Goals"),
  );
  writeFileSync(join(root, "routines", "hourly.md"), "# Hourly\n");
  // README.md at top level — must be skipped by copy helper.
  writeFileSync(join(root, "README.md"), "# repo docs only\n");
}

describe("ensureSkeletonFiles", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-skeleton-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("materializes every canonical subdirectory even without a templates tree", () => {
    const contextDir = join(tmpRoot, "vault");
    mkdirSync(contextDir, { recursive: true });

    ensureSkeletonFiles(contextDir, join(tmpRoot, "nonexistent-workspace"));

    for (const sub of CONTEXT_DIR_NAMES) {
      expect(existsSync(join(contextDir, sub))).toBe(true);
    }
    // Placeholders still land even when templates are unavailable, so
    // the dashboard and `/api/context/*` can immediately PATCH them.
    expect(existsSync(join(contextDir, "today.md"))).toBe(true);
    expect(existsSync(join(contextDir, "roadmap.md"))).toBe(true);
    const roadmap = readFileSync(join(contextDir, "roadmap.md"), "utf-8");
    expect(roadmap).toMatch(/^# Roadmap\n> Last synced: /);
    expect(roadmap).toContain("## Agent Action Plan");
    // Fresh-install roadmap MUST contain `(Not yet configured)` so that
    // `config.ts:isRoadmapStale` correctly flags it and the
    // `roadmap_refresh` catch-up hooks in `index.ts` (search for
    // "skeleton has '(Not yet configured)'") actually fire. Without this
    // marker the catch-up never runs until the mtime crosses 15 days,
    // which leaves a fresh install with an empty roadmap for two weeks.
    expect(roadmap).toContain("(Not yet configured)");
  });

  it("fresh-install roadmap is isRoadmapStale-true AND passes validateRoadmap", () => {
    // The skeleton's roadmap lives in a narrow compatibility window: it
    // must (a) contain `(Not yet configured)` so `config.ts:isRoadmapStale`
    // flags it and the `roadmap_refresh` catch-up in `index.ts:1857` fires,
    // AND (b) carry a well-formed `> Last synced: YYYY-MM-DD` line on row 2
    // so any agent-initiated PATCH before the first `roadmap_refresh` run
    // does not 422 out of `context.ts:validateRoadmap`. Using the Unix
    // epoch (`1970-01-01`) satisfies both — it is a valid YMD for the
    // regex but so obviously stale it can never be mistaken for a real
    // sync timestamp. A regression here (e.g. a future refactor drops
    // either marker) would silently leave every fresh install with an
    // empty, unrefreshable roadmap. This test catches that at CI.
    const contextDir = join(tmpRoot, "vault");
    mkdirSync(contextDir, { recursive: true });

    ensureSkeletonFiles(contextDir, join(tmpRoot, "nonexistent-workspace"));

    expect(isRoadmapStale(contextDir)).toBe(true);

    const roadmap = readFileSync(join(contextDir, "roadmap.md"), "utf-8");
    const validation = validateRoadmap(roadmap);
    expect(validation.ok).toBe(true);
    expect(validation.error).toBeUndefined();
  });

  it("shape canary: FALLBACK_PLACEHOLDERS matches agent-assets/templates byte-for-byte", () => {
    // Drift guard (course 5 of the design audit): `today.md` and
    // `roadmap.md` are produced either by copying the shipped template
    // or by writing the inline fallback string. The two paths MUST
    // produce identical bytes — otherwise an install that resolved the
    // templates tree diverges from one that fell back to the inline
    // string, and either the templates or the synthesizer has silently
    // drifted. This test reads the repo-level templates directly (no
    // `workspaceDir` indirection) so CI catches drift at PR review.
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
    );
    const templatesRoot = join(repoRoot, "agent-assets", "templates");

    for (const rel of [
      CONTEXT_RELATIVE_PATHS.today,
      CONTEXT_RELATIVE_PATHS.roadmap,
    ]) {
      const templateBody = readFileSync(join(templatesRoot, rel), "utf-8");
      expect(templateBody).toBe(FALLBACK_PLACEHOLDERS[rel]);
    }
  });

  it("copies template files, skips README.md, and preserves existing user content", () => {
    const workspaceDir = tmpRoot;
    seedTemplateTree(workspaceDir);
    const contextDir = join(tmpRoot, "vault");
    mkdirSync(join(contextDir, "rules"), { recursive: true });
    // Pre-existing user edit must survive the seed. The content already
    // carries a valid frontmatter block so the backfill leaves it alone.
    const existingManagement = withFrontmatter(
      "rule",
      "shared",
      "User Edited Management",
    );
    writeFileSync(
      join(contextDir, "rules", "management.md"),
      existingManagement,
    );

    ensureSkeletonFiles(contextDir, workspaceDir);

    expect(readFileSync(join(contextDir, "rules", "management.md"), "utf-8")).toBe(
      existingManagement,
    );
    expect(readFileSync(join(contextDir, "rules", "redaction.md"), "utf-8")).toBe(
      withFrontmatter("rule", "shared", "Redaction"),
    );
    // MANAGEMENT-POLICY-CAPTURE-PLAN §5.3 — the agent-owned policies
    // sub-index must land via the recursive template walker, not just
    // exist as an empty directory created by `CONTEXT_DIR_NAMES`.
    expect(
      readFileSync(
        join(contextDir, "rules", "policies", "_index.md"),
        "utf-8",
      ),
    ).toBe(withFrontmatter("index", "agent", "Active Policies"));
    expect(readFileSync(join(contextDir, "user", "profile.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "Profile"),
    );
    expect(readFileSync(join(contextDir, "user", "people.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "People"),
    );
    expect(readFileSync(join(contextDir, "user", "work.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "Work"),
    );
    expect(readFileSync(join(contextDir, "user", "expertise.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "Expertise"),
    );
    expect(readFileSync(join(contextDir, "user", "personal.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "Personal"),
    );
    expect(readFileSync(join(contextDir, "user", "goals.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "Goals"),
    );
    expect(readFileSync(join(contextDir, "_index.md"), "utf-8")).toBe(
      "# Vault index\n",
    );
    // README.md from templates root is a doc artefact — must not leak.
    expect(existsSync(join(contextDir, "README.md"))).toBe(false);
  });

  it("can skip rules/management.md while seeding the rest of the skeleton", () => {
    const workspaceDir = tmpRoot;
    seedTemplateTree(workspaceDir);
    const contextDir = join(tmpRoot, "vault");

    ensureSkeletonFiles(contextDir, workspaceDir, { skipManagementRules: true });

    expect(existsSync(join(contextDir, "rules", "management.md"))).toBe(false);
    expect(readFileSync(join(contextDir, "rules", "redaction.md"), "utf-8")).toBe(
      withFrontmatter("rule", "shared", "Redaction"),
    );
    expect(readFileSync(join(contextDir, "user", "profile.md"), "utf-8")).toBe(
      withFrontmatter("user", "shared", "Profile"),
    );
    expect(existsSync(join(contextDir, "today.md"))).toBe(true);
  });

  it("honors PA_TEMPLATES_DIR over the workspace and module-derived fallbacks", () => {
    // Seed two distinct trees: workspaceDir (which would otherwise win
    // over the module-derived path) AND a separate env-override tree.
    // PA_TEMPLATES_DIR must take precedence — its sentinel file lands
    // in the vault while the workspace fixture's does not.
    const envTree = join(tmpRoot, "env-override-tree");
    mkdirSync(envTree, { recursive: true });
    writeFileSync(join(envTree, "_index.md"), "# Env-override index\n");
    writeFileSync(join(envTree, "envonly.md"), "from env override\n");

    seedTemplateTree(tmpRoot); // <tmpRoot>/agent-assets/templates/

    const contextDir = join(tmpRoot, "vault");
    mkdirSync(contextDir, { recursive: true });

    vi.stubEnv("PA_TEMPLATES_DIR", envTree);
    try {
      const resolved = resolveTemplatesRoot(tmpRoot);
      expect(resolved).toBe(resolve(envTree));

      ensureSkeletonFiles(contextDir, tmpRoot);
      expect(readFileSync(join(contextDir, "_index.md"), "utf-8")).toBe(
        "# Env-override index\n",
      );
      expect(readFileSync(join(contextDir, "envonly.md"), "utf-8")).toBe(
        "from env override\n",
      );
      // Workspace-tree-only fixture must NOT have leaked through.
      expect(existsSync(join(contextDir, "rules", "redaction.md"))).toBe(
        false,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores PA_TEMPLATES_DIR when set to an empty string (falls through to workspaceDir)", () => {
    // The `envOverride.length > 0` guard skips a zero-length value so a
    // shell `PA_TEMPLATES_DIR=` doesn't poison the candidates list.
    seedTemplateTree(tmpRoot);
    const contextDir = join(tmpRoot, "vault");
    mkdirSync(contextDir, { recursive: true });

    vi.stubEnv("PA_TEMPLATES_DIR", "");
    try {
      ensureSkeletonFiles(contextDir, tmpRoot);
      expect(readFileSync(join(contextDir, "rules", "redaction.md"), "utf-8")).toBe(
        withFrontmatter("rule", "shared", "Redaction"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is idempotent across repeated calls", () => {
    const workspaceDir = tmpRoot;
    seedTemplateTree(workspaceDir);
    const contextDir = join(tmpRoot, "vault");

    ensureSkeletonFiles(contextDir, workspaceDir);
    const firstTodayBytes = readFileSync(join(contextDir, "today.md"), "utf-8");

    // User edits today.md — second pass must NOT clobber it.
    writeFileSync(join(contextDir, "today.md"), "# My custom today\n");
    ensureSkeletonFiles(contextDir, workspaceDir);

    expect(readFileSync(join(contextDir, "today.md"), "utf-8")).toBe(
      "# My custom today\n",
    );
    expect(firstTodayBytes).not.toBe("# My custom today\n");
  });
});
