import { describe, it, expect } from "vitest";
import {
  CONTEXT_RELATIVE_PATHS,
  CONTEXT_DIR_NAMES,
  CONTEXT_BASE_FILE_STEMS,
  CONTEXT_FILE_EXTENSIONS,
  CONTEXT_FRONTMATTER_TYPES,
  dailyJournalPath,
  weeklyReviewPath,
  monthlyReviewPath,
  projectPath,
  gitRepoPath,
  gitRepoOverviewPath,
  gitRepoJournalPath,
  customRoutinePath,
  dossierPath,
  policyPath,
  agentScratchPath,
  inboxPath,
  fullPath,
  isKnownUserAreaFile,
} from "./context-paths.js";

describe("context-paths", () => {
  it("exposes top-level canonical paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.today).toBe("today.md");
    expect(CONTEXT_RELATIVE_PATHS.yesterday).toBe("yesterday.md");
    expect(CONTEXT_RELATIVE_PATHS.roadmap).toBe("roadmap.md");
    expect(CONTEXT_RELATIVE_PATHS.contextIndex).toBe("context-index.md");
    expect(CONTEXT_RELATIVE_PATHS.rootIndex).toBe("_index.md");
  });

  it("exposes user area files", () => {
    expect(CONTEXT_RELATIVE_PATHS.user.profile).toBe("user/profile.md");
    expect(CONTEXT_RELATIVE_PATHS.user.index).toBe("user/_index.md");
    expect(CONTEXT_RELATIVE_PATHS.user.people).toBe("user/people.md");
    expect(CONTEXT_RELATIVE_PATHS.user.work).toBe("user/work.md");
    expect(CONTEXT_RELATIVE_PATHS.user.expertise).toBe("user/expertise.md");
    expect(CONTEXT_RELATIVE_PATHS.user.personal).toBe("user/personal.md");
    expect(CONTEXT_RELATIVE_PATHS.user.goals).toBe("user/goals.md");
  });

  it("exposes rules paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.rules.management).toBe("rules/management.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.mcp).toBe("rules/mcp.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.journalFormat).toBe(
      "rules/journal-format.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.rules.journalExport).toBe(
      "rules/journal-export.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.rules.redaction).toBe("rules/redaction.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.index).toBe("rules/_index.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.policiesDir).toBe("rules/policies");
    expect(CONTEXT_RELATIVE_PATHS.rules.policiesIndex).toBe(
      "rules/policies/_index.md",
    );
  });

  it("exposes routine paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.routines.hourly).toBe("routines/hourly.md");
    expect(CONTEXT_RELATIVE_PATHS.routines.morning).toBe("routines/morning.md");
    expect(CONTEXT_RELATIVE_PATHS.routines.evening).toBe("routines/evening.md");
    expect(CONTEXT_RELATIVE_PATHS.routines.weekly).toBe("routines/weekly.md");
    expect(CONTEXT_RELATIVE_PATHS.routines.monthly).toBe("routines/monthly.md");
    expect(CONTEXT_RELATIVE_PATHS.routines.customDir).toBe("routines/custom");
    expect(CONTEXT_RELATIVE_PATHS.routines.index).toBe("routines/_index.md");
  });

  it("exposes projects paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.projects.index).toBe("projects/_index.md");
    expect(CONTEXT_RELATIVE_PATHS.projects.activeBase).toBe(
      "projects/_active.base",
    );
    expect(CONTEXT_RELATIVE_PATHS.projects.dir).toBe("projects");
  });

  it("exposes agent-internal paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.agent.journal).toBe("agent/journal.md");
    expect(CONTEXT_RELATIVE_PATHS.agent.scratchDir).toBe("agent/scratch");
  });

  it("builds dated / slugged paths", () => {
    expect(dailyJournalPath("2026-04-17")).toBe("daily/2026-04-17.md");
    expect(weeklyReviewPath("2026-W16")).toBe("weekly/2026-W16.md");
    expect(monthlyReviewPath("2026-04")).toBe("monthly/2026-04.md");
    expect(projectPath("personal-agent")).toBe("projects/personal-agent.md");
    expect(gitRepoPath("personal-agent")).toBe("git-repos/personal-agent.md");
    expect(gitRepoOverviewPath("acme-widgets")).toBe(
      "git/acme-widgets/overview.md",
    );
    expect(gitRepoJournalPath("acme-widgets", "2026-05-05")).toBe(
      "git/acme-widgets/journal/2026-05-05.md",
    );
    expect(customRoutinePath("tuesday-notion")).toBe(
      "routines/custom/tuesday-notion.md",
    );
    expect(dossierPath("weekly-review")).toBe("dossiers/weekly-review.md");
    expect(policyPath("morning-finance-check")).toBe(
      "rules/policies/morning-finance-check.md",
    );
    expect(agentScratchPath("2026-04-17", "draft")).toBe(
      "agent/scratch/2026-04-17-draft.md",
    );
    expect(inboxPath("2026-04-17", "note")).toBe("inbox/2026-04-17-note.md");
  });

  it("joins against a runtime contextDir", () => {
    expect(fullPath("/tmp/ctx", "today.md")).toBe("/tmp/ctx/today.md");
    expect(fullPath("/tmp/ctx", "user/profile.md")).toBe(
      "/tmp/ctx/user/profile.md",
    );
  });

  it("classifies known user-area files", () => {
    expect(isKnownUserAreaFile("user/profile.md")).toBe(true);
    expect(isKnownUserAreaFile("user/people.md")).toBe(true);
    expect(isKnownUserAreaFile("user/goals.md")).toBe(true);
    expect(isKnownUserAreaFile("user/_index.md")).toBe(false);
    expect(isKnownUserAreaFile("today.md")).toBe(false);
    expect(isKnownUserAreaFile("projects/personal-agent.md")).toBe(false);
  });

  it("lists known dir names without trailing slash", () => {
    expect(CONTEXT_DIR_NAMES).toContain("user");
    expect(CONTEXT_DIR_NAMES).toContain("rules");
    expect(CONTEXT_DIR_NAMES).toContain("rules/policies");
    expect(CONTEXT_DIR_NAMES).toContain("routines");
    expect(CONTEXT_DIR_NAMES).toContain("routines/custom");
    expect(CONTEXT_DIR_NAMES).toContain("daily");
    expect(CONTEXT_DIR_NAMES).toContain("weekly");
    expect(CONTEXT_DIR_NAMES).toContain("monthly");
    expect(CONTEXT_DIR_NAMES).toContain("dossiers");
    expect(CONTEXT_DIR_NAMES).toContain("inbox");
    expect(CONTEXT_DIR_NAMES).toContain("agent");
    expect(CONTEXT_DIR_NAMES).toContain("agent/scratch");
    expect(CONTEXT_DIR_NAMES).toContain("projects");
    expect(CONTEXT_DIR_NAMES).toContain("git-repos");
    expect(CONTEXT_DIR_NAMES).toContain("git");
    // None have a trailing slash
    for (const dir of CONTEXT_DIR_NAMES) {
      expect(dir.endsWith("/")).toBe(false);
    }
  });

  it("lists allowed file extensions", () => {
    expect(CONTEXT_FILE_EXTENSIONS).toEqual([".md", ".base"]);
  });

  it("lists reserved .base stems", () => {
    expect(CONTEXT_BASE_FILE_STEMS).toEqual(["projects/_active"]);
  });

  it("exposes valid frontmatter type values", () => {
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("project");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("git-repo");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("user");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("rule");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("daily");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("inbox");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("scratch");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("git-project");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("git-journal");
  });

  it("exposes the unified-repositories git dir constant", () => {
    expect(CONTEXT_RELATIVE_PATHS.git.dir).toBe("git");
    expect(CONTEXT_RELATIVE_PATHS.gitRepos.dir).toBe("git-repos");
  });
});
