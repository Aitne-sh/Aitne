import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextHealthReport,
  normalizeRepairStubPath,
  REPAIRABLE_STUB_TARGETS,
  DOSSIER_FLOW_PATHS,
} from "./context-health.js";
import { POLICY_FILE_MAX_BYTES } from "./policy-files.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";

function write(path: string, contextDir: string, content: string): void {
  const full = join(contextDir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function validFrontmatter(type: string, owner: string, title: string): string {
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

/**
 * Build a minimally valid vault — every REQUIRED path exists with the
 * correct frontmatter. Tests then introduce specific deviations.
 */
function seedValidVault(contextDir: string): void {
  mkdirSync(contextDir, { recursive: true });

  // CONTEXT_VAULT_REDESIGN merged contextIndex into rootIndex (`_index.md`).
  // Write it ONCE with the agent-owned shape so the reconciler block can
  // be folded in later without violating the strict frontmatter contract.
  write(
    CONTEXT_RELATIVE_PATHS.rootIndex,
    contextDir,
    validFrontmatter("index", "agent", "Vault"),
  );
  write(CONTEXT_RELATIVE_PATHS.today, contextDir, "# Today\n");
  write(CONTEXT_RELATIVE_PATHS.roadmap, contextDir, "# Roadmap\n");

  write(CONTEXT_RELATIVE_PATHS.user.index, contextDir, validFrontmatter("index", "shared", "User"));
  write(CONTEXT_RELATIVE_PATHS.user.profile, contextDir, validFrontmatter("user", "shared", "Profile"));
  write(CONTEXT_RELATIVE_PATHS.user.people, contextDir, validFrontmatter("user", "shared", "People"));
  write(CONTEXT_RELATIVE_PATHS.user.work, contextDir, validFrontmatter("user", "shared", "Work"));
  write(CONTEXT_RELATIVE_PATHS.user.expertise, contextDir, validFrontmatter("user", "shared", "Expertise"));
  write(CONTEXT_RELATIVE_PATHS.user.personal, contextDir, validFrontmatter("user", "shared", "Personal"));
  write(CONTEXT_RELATIVE_PATHS.user.goals, contextDir, validFrontmatter("user", "shared", "Goals"));

  write(CONTEXT_RELATIVE_PATHS.rules.index, contextDir, validFrontmatter("index", "shared", "Rules"));
  write(CONTEXT_RELATIVE_PATHS.rules.management, contextDir, validFrontmatter("rule", "shared", "Management"));
  write(CONTEXT_RELATIVE_PATHS.rules.mcp, contextDir, validFrontmatter("rule", "shared", "MCP"));
  write(CONTEXT_RELATIVE_PATHS.rules.journalFormat, contextDir, validFrontmatter("rule", "shared", "Journal Format"));
  write(CONTEXT_RELATIVE_PATHS.rules.journalExport, contextDir, validFrontmatter("rule", "shared", "Journal Export"));
  write(CONTEXT_RELATIVE_PATHS.rules.redaction, contextDir, validFrontmatter("rule", "shared", "Redaction"));

  // Routines live under `policies/routines/` post-restructure, so they
  // need the rule-shaped frontmatter the policies/* prefix enforces.
  write(
    CONTEXT_RELATIVE_PATHS.routines.index,
    contextDir,
    validFrontmatter("index", "shared", "Routines"),
  );
  write(
    CONTEXT_RELATIVE_PATHS.routines.hourly,
    contextDir,
    validFrontmatter("rule", "shared", "Hourly"),
  );
  write(
    CONTEXT_RELATIVE_PATHS.routines.morning,
    contextDir,
    validFrontmatter("rule", "shared", "Morning"),
  );
  write(
    CONTEXT_RELATIVE_PATHS.routines.evening,
    contextDir,
    validFrontmatter("rule", "shared", "Evening"),
  );
  write(
    CONTEXT_RELATIVE_PATHS.routines.weekly,
    contextDir,
    validFrontmatter("rule", "shared", "Weekly"),
  );
  write(
    CONTEXT_RELATIVE_PATHS.routines.monthly,
    contextDir,
    validFrontmatter("rule", "shared", "Monthly"),
  );

  write(
    CONTEXT_RELATIVE_PATHS.projects.index,
    contextDir,
    validFrontmatter("index", "shared", "Projects"),
  );
  write(CONTEXT_RELATIVE_PATHS.projects.activeBase, contextDir, "");

  write(
    CONTEXT_RELATIVE_PATHS.dossiers.index,
    contextDir,
    validFrontmatter("index", "agent", "Dossiers"),
  );
  for (const p of DOSSIER_FLOW_PATHS) {
    write(p, contextDir, validFrontmatter("dossier", "agent", "Dossier"));
  }

  // Agent journal lives under `journal/agent.md` and falls under the
  // journal/ class; it doesn't need the strict policies-style
  // frontmatter, but the validator doesn't require one for raw journal
  // entries either (no rule prefix matches `journal/agent`).
  write(CONTEXT_RELATIVE_PATHS.agent.journal, contextDir, "# Agent Journal\n");
}

describe("buildContextHealthReport", () => {
  let tmp: string;
  let contextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-health-"));
    contextDir = join(tmp, "context");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns status 'ok' when every required file exists with a valid schema", () => {
    seedValidVault(contextDir);

    const report = buildContextHealthReport(contextDir);

    expect(report.status).toBe("ok");
    expect(report.summary).toMatchObject({
      missingFiles: 0,
      frontmatterErrors: 0,
      sizeWarnings: 0,
      indexLinkIssues: 0,
    });
  });

  it("flags missing user-area stubs as repairable errors", () => {
    seedValidVault(contextDir);
    rmSync(join(contextDir, CONTEXT_RELATIVE_PATHS.user.people));
    rmSync(join(contextDir, CONTEXT_RELATIVE_PATHS.user.work));

    const report = buildContextHealthReport(contextDir);

    expect(report.status).toBe("error");
    expect(
      report.userAreaGaps.map((issue) => issue.path).sort(),
    ).toEqual([CONTEXT_RELATIVE_PATHS.user.people, CONTEXT_RELATIVE_PATHS.user.work].sort());
    for (const issue of report.userAreaGaps) {
      expect(issue.severity).toBe("error");
      expect(issue.repairable).toBe(true);
    }
  });

  it("marks non-repairable missing files appropriately", () => {
    seedValidVault(contextDir);
    rmSync(join(contextDir, CONTEXT_RELATIVE_PATHS.rules.redaction));

    const report = buildContextHealthReport(contextDir);

    const redactionIssue = report.missingFiles.find(
      (issue) => issue.path === CONTEXT_RELATIVE_PATHS.rules.redaction,
    );
    expect(redactionIssue).toBeDefined();
    expect(redactionIssue?.repairable).toBe(false);
  });

  it("surfaces frontmatter violations through the unified validator", () => {
    seedValidVault(contextDir);
    write(CONTEXT_RELATIVE_PATHS.user.profile, contextDir, "# User\n");
    write(
      CONTEXT_RELATIVE_PATHS.dossiers.index,
      contextDir,
      validFrontmatter("dossier", "agent", "Wrong type"),
    );

    const report = buildContextHealthReport(contextDir);

    const profileIssue = report.frontmatterErrors.find(
      (issue) => issue.path === CONTEXT_RELATIVE_PATHS.user.profile,
    );
    expect(profileIssue?.code).toBe("missing_frontmatter");

    const dossierIndexIssue = report.frontmatterErrors.find(
      (issue) => issue.path === CONTEXT_RELATIVE_PATHS.dossiers.index,
    );
    expect(dossierIndexIssue?.code).toBe("invalid_type");
  });

  it("warns when a prompt-injection-capped file exceeds the per-file byte cap", () => {
    seedValidVault(contextDir);
    const bigBody = "a".repeat(POLICY_FILE_MAX_BYTES + 512);
    write(
      CONTEXT_RELATIVE_PATHS.routines.hourly,
      contextDir,
      `# Big routine\n${bigBody}`,
    );

    const report = buildContextHealthReport(contextDir);

    const warning = report.sizeWarnings.find(
      (issue) => issue.path === CONTEXT_RELATIVE_PATHS.routines.hourly,
    );
    expect(warning).toBeDefined();
    expect(warning?.bytes).toBeGreaterThan(POLICY_FILE_MAX_BYTES);
    expect(warning?.severity).toBe("warning");
  });

  it("ignores oversize daily/weekly/monthly journals (not injection-capped)", () => {
    seedValidVault(contextDir);
    const bigJournal = "b".repeat(POLICY_FILE_MAX_BYTES + 4096);
    write(
      "journal/daily/2026-04-21.md",
      contextDir,
      `${validFrontmatter("daily", "agent", "Day")}${bigJournal}`,
    );

    const report = buildContextHealthReport(contextDir);

    expect(
      report.sizeWarnings.find((issue) => issue.path === "journal/daily/2026-04-21.md"),
    ).toBeUndefined();
  });

  it("flags broken wikilinks and markdown links inside index files", () => {
    seedValidVault(contextDir);
    write(
      CONTEXT_RELATIVE_PATHS.rootIndex,
      contextDir,
      [
        validFrontmatter("index", "shared", "Vault"),
        "Links:",
        "- [[missing-one]]",
        "- [alias](./missing-two.md)",
        "- `missing-three.md` is a documented path example, not a link",
        "```",
        "- [[missing-four]]",
        "- [alias](./missing-five.md)",
        "```",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);

    const targets = report.indexLinkIssues.map((issue) => issue.target).sort();
    expect(targets).toEqual([
      "missing-one.md",
      "missing-two.md",
    ]);
    for (const issue of report.indexLinkIssues) {
      expect(issue.severity).toBe("warning");
      expect(issue.source).toBe(CONTEXT_RELATIVE_PATHS.rootIndex);
    }
  });

  it("ignores template placeholders in index links", () => {
    seedValidVault(contextDir);
    write(
      CONTEXT_RELATIVE_PATHS.rootIndex,
      contextDir,
      [
        validFrontmatter("index", "shared", "Vault"),
        "- [[projects/<slug>]]",
        "- [daily template](daily/YYYY-MM-DD.md)",
        "- [folder](projects/)",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);

    expect(report.indexLinkIssues).toEqual([]);
  });

  it("omits broken-link reports for external http(s) URLs", () => {
    seedValidVault(contextDir);
    write(
      CONTEXT_RELATIVE_PATHS.rootIndex,
      contextDir,
      [
        validFrontmatter("index", "shared", "Vault"),
        "- [Docs](https://example.com/doc.md)",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);

    expect(report.indexLinkIssues).toEqual([]);
  });

  it("returns 'warning' status when only warnings exist", () => {
    seedValidVault(contextDir);
    write(
      CONTEXT_RELATIVE_PATHS.rootIndex,
      contextDir,
      [
        // rootIndex is agent-owned after CONTEXT_VAULT_REDESIGN
        // (reconciler maintains the `<!-- reconciler-section -->` block).
        validFrontmatter("index", "agent", "Vault"),
        "- [[missing-one]]",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);

    expect(report.status).toBe("warning");
    expect(report.summary.indexLinkIssues).toBe(1);
  });

  it("exposes the full set of repairable stub targets", () => {
    expect(REPAIRABLE_STUB_TARGETS.has(CONTEXT_RELATIVE_PATHS.user.people)).toBe(true);
    expect(REPAIRABLE_STUB_TARGETS.has(CONTEXT_RELATIVE_PATHS.contextIndex)).toBe(true);
    for (const dossier of DOSSIER_FLOW_PATHS) {
      expect(REPAIRABLE_STUB_TARGETS.has(dossier)).toBe(true);
    }
    expect(REPAIRABLE_STUB_TARGETS.has(CONTEXT_RELATIVE_PATHS.rules.redaction)).toBe(false);
  });

  it("tolerates a completely missing context directory", () => {
    const report = buildContextHealthReport(join(tmp, "nonexistent"));

    expect(report.status).toBe("error");
    expect(report.summary.missingFiles).toBeGreaterThan(0);
  });

  it("ignores files inside .git, .obsidian, and .DS_Store directories during the walk", () => {
    seedValidVault(contextDir);
    // Plant ill-formed markdown files inside reserved tooling dirs. If
    // the walk visited them, the frontmatter validator would flag them
    // and the report status would degrade away from `ok`.
    write(".git/HEAD.md", contextDir, "no frontmatter at all");
    write(".obsidian/workspace.md", contextDir, "no frontmatter");
    write(".DS_Store/junk.md", contextDir, "no frontmatter");

    const report = buildContextHealthReport(contextDir);
    expect(report.status).toBe("ok");
    expect(
      report.frontmatterErrors.find((i) =>
        i.path.startsWith(".git/")
        || i.path.startsWith(".obsidian/")
        || i.path.startsWith(".DS_Store/"),
      ),
    ).toBeUndefined();
  });

  it("resolves index links that traverse one level up via ../", () => {
    seedValidVault(contextDir);
    // Place an index inside a subdirectory whose link uses `..` to
    // reach a sibling — this exercises the stack-pop branch of the
    // relative-path resolver.
    write(
      "policies/management-captures/_index.md",
      contextDir,
      [
        validFrontmatter("index", "agent", "Active Policies"),
        "Sibling: [back](../management.md)",
        "DeepBack: [up two](../../user/profile.md)",
        "Broken: [too-far](../../../escape.md)",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);
    // Both the sibling (rules/management.md) and the up-two
    // (identity/profile.md) targets exist in the seeded vault — they must
    // NOT be reported as broken links.
    const targets = report.indexLinkIssues.map((i) => i.target);
    expect(targets).not.toContain("policies/management.md");
    expect(targets).not.toContain("identity/profile.md");
    // The escape attempt must be silently dropped (resolver returned
    // null for popping past the root) — no broken-link warning either.
    expect(targets.find((t) => t.includes("escape"))).toBeUndefined();
  });

  it("ignores absolute links and links containing the unicode replacement char", () => {
    seedValidVault(contextDir);
    write(
      CONTEXT_RELATIVE_PATHS.rootIndex,
      contextDir,
      [
        validFrontmatter("index", "shared", "Vault"),
        "Absolute: [bad](/etc/passwd.md)",
        "Trailing slash: [folder](projects/)",
        "Mailto: [contact](mailto:user@example.com)",
        "Anchor only: [section](#heading)",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);
    expect(report.indexLinkIssues).toEqual([]);
  });

  it("treats wikilinks with an alias / anchor by stripping after | or #", () => {
    seedValidVault(contextDir);
    write(
      CONTEXT_RELATIVE_PATHS.rootIndex,
      contextDir,
      [
        validFrontmatter("index", "shared", "Vault"),
        "Aliased: [[identity/profile|Profile]]",
        "Anchored: [[identity/profile#Goals]]",
        "Missing aliased: [[no-such|alias]]",
      ].join("\n"),
    );

    const report = buildContextHealthReport(contextDir);
    const targets = report.indexLinkIssues.map((i) => i.target);
    expect(targets).toEqual(["no-such.md"]);
  });
});

describe("normalizeRepairStubPath", () => {
  it("appends .md when the extension is missing", () => {
    expect(normalizeRepairStubPath("user/people")).toBe("user/people.md");
    expect(normalizeRepairStubPath("context-index")).toBe("context-index.md");
  });

  it("preserves explicit .md / .base extensions", () => {
    expect(normalizeRepairStubPath("knowledge/dossiers/hourly.md")).toBe("knowledge/dossiers/hourly.md");
    expect(normalizeRepairStubPath("plans/projects/_active.base")).toBe(
      "plans/projects/_active.base",
    );
  });

  it("strips the ./ prefix", () => {
    expect(normalizeRepairStubPath("./user/people.md")).toBe("user/people.md");
  });

  it("rejects absolute paths and null bytes", () => {
    expect(normalizeRepairStubPath("/etc/passwd")).toBeNull();
    expect(normalizeRepairStubPath("user/\0hidden.md")).toBeNull();
  });

  it("rejects traversal outside the context root", () => {
    expect(normalizeRepairStubPath("../../etc/passwd.md")).toBeNull();
    expect(normalizeRepairStubPath("user/../rules/management.md")).toBeNull();
  });

  it("rejects hidden directories reserved for tooling", () => {
    expect(normalizeRepairStubPath(".git/config.md")).toBeNull();
    expect(normalizeRepairStubPath(".obsidian/workspace.md")).toBeNull();
    expect(normalizeRepairStubPath(".DS_Store/foo.md")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(normalizeRepairStubPath("")).toBeNull();
    expect(normalizeRepairStubPath("   ")).toBeNull();
  });
});
