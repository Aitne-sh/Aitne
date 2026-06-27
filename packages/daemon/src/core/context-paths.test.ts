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
  activityViewPath,
  entityPath,
  entityDomainIndexPath,
  fullPath,
  isKnownUserAreaFile,
} from "./context-paths.js";

describe("context-paths (six-class layout)", () => {
  it("exposes top-level canonical paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.today).toBe("state/today.md");
    expect(CONTEXT_RELATIVE_PATHS.yesterday).toBe("state/yesterday.md");
    expect(CONTEXT_RELATIVE_PATHS.roadmap).toBe("plans/roadmap.md");
    expect(CONTEXT_RELATIVE_PATHS.rootIndex).toBe("_index.md");
    // contextIndex folded into rootIndex.
    expect(CONTEXT_RELATIVE_PATHS.contextIndex).toBe("_index.md");
  });

  it("exposes identity (user) area files", () => {
    expect(CONTEXT_RELATIVE_PATHS.user.profile).toBe("identity/profile.md");
    expect(CONTEXT_RELATIVE_PATHS.user.index).toBe("identity/_index.md");
    expect(CONTEXT_RELATIVE_PATHS.user.people).toBe("identity/people.md");
    expect(CONTEXT_RELATIVE_PATHS.user.work).toBe("identity/work.md");
    expect(CONTEXT_RELATIVE_PATHS.user.expertise).toBe("identity/expertise.md");
    expect(CONTEXT_RELATIVE_PATHS.user.personal).toBe("identity/personal.md");
    expect(CONTEXT_RELATIVE_PATHS.user.goals).toBe("identity/goals.md");
  });

  it("exposes policies (rules) paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.rules.management).toBe("policies/management.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.mcp).toBe("policies/mcp.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.journalFormat).toBe(
      "policies/journal-format.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.rules.journalExport).toBe(
      "policies/journal-export.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.rules.redaction).toBe("policies/redaction.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.index).toBe("policies/_index.md");
    expect(CONTEXT_RELATIVE_PATHS.rules.policiesDir).toBe(
      "policies/management-captures",
    );
    expect(CONTEXT_RELATIVE_PATHS.rules.policiesIndex).toBe(
      "policies/management-captures/_index.md",
    );
  });

  it("exposes routine paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.routines.activityScan).toBe(
      "policies/routines/activity-scan.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.routines.morning).toBe(
      "policies/routines/morning.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.routines.evening).toBe(
      "policies/routines/evening.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.routines.weekly).toBe(
      "policies/routines/weekly.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.routines.monthly).toBe(
      "policies/routines/monthly.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.routines.customDir).toBe(
      "policies/routines/custom",
    );
    expect(CONTEXT_RELATIVE_PATHS.routines.index).toBe(
      "policies/routines/_index.md",
    );
  });

  it("exposes plans/projects paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.projects.index).toBe(
      "plans/projects/_index.md",
    );
    expect(CONTEXT_RELATIVE_PATHS.projects.activeBase).toBe(
      "plans/projects/_active.base",
    );
    expect(CONTEXT_RELATIVE_PATHS.projects.dir).toBe("plans/projects");
  });

  it("exposes agent-internal paths", () => {
    expect(CONTEXT_RELATIVE_PATHS.agent.journal).toBe("journal/agent.md");
    expect(CONTEXT_RELATIVE_PATHS.agent.scratchDir).toBe("state/scratch");
    expect(CONTEXT_RELATIVE_PATHS.agent.profileQuestions).toBe(
      "state/profile-questions.md",
    );
  });

  it("builds dated / slugged paths", () => {
    expect(dailyJournalPath("2026-04-17")).toBe("journal/daily/2026-04-17.md");
    expect(weeklyReviewPath("2026-W16")).toBe("journal/weekly/2026-W16.md");
    expect(monthlyReviewPath("2026-04")).toBe("journal/monthly/2026-04.md");
    expect(projectPath("personal-agent")).toBe(
      "plans/projects/personal-agent.md",
    );
    // Legacy registry path preserved under knowledge/repos/legacy-registry/.
    expect(gitRepoPath("personal-agent")).toBe(
      "knowledge/repos/legacy-registry/personal-agent.md",
    );
    expect(gitRepoOverviewPath("acme-widgets")).toBe(
      "knowledge/repos/acme-widgets/overview.md",
    );
    expect(gitRepoJournalPath("acme-widgets", "2026-05-05")).toBe(
      "journal/repos/acme-widgets/2026-05-05.md",
    );
    expect(customRoutinePath("tuesday-notion")).toBe(
      "policies/routines/custom/tuesday-notion.md",
    );
    expect(dossierPath("weekly-review")).toBe(
      "knowledge/dossiers/weekly-review.md",
    );
    expect(policyPath("morning-finance-check")).toBe(
      "policies/management-captures/morning-finance-check.md",
    );
    expect(agentScratchPath("2026-04-17", "draft")).toBe(
      "state/scratch/2026-04-17-draft.md",
    );
    expect(inboxPath("2026-04-17", "note")).toBe(
      "state/inbox/2026-04-17-note.md",
    );
  });

  it("derives activity-view and knowledge-entity paths", () => {
    expect(activityViewPath("gmail")).toBe("state/activity/gmail.md");
    expect(entityPath("work", "meetings", "kickoff")).toBe(
      "knowledge/entities/work/meetings/kickoff.md",
    );
    expect(entityDomainIndexPath("work")).toBe(
      "knowledge/entities/work/_index.md",
    );
  });

  it("joins against a runtime contextDir", () => {
    expect(fullPath("/tmp/ctx", "state/today.md")).toBe(
      "/tmp/ctx/state/today.md",
    );
    expect(fullPath("/tmp/ctx", "identity/profile.md")).toBe(
      "/tmp/ctx/identity/profile.md",
    );
  });

  it("classifies known identity-area files", () => {
    expect(isKnownUserAreaFile("identity/profile.md")).toBe(true);
    expect(isKnownUserAreaFile("identity/people.md")).toBe(true);
    expect(isKnownUserAreaFile("identity/goals.md")).toBe(true);
    expect(isKnownUserAreaFile("identity/_index.md")).toBe(false);
    expect(isKnownUserAreaFile("state/today.md")).toBe(false);
    expect(isKnownUserAreaFile("plans/projects/personal-agent.md")).toBe(false);
  });

  it("lists known dir names for the six-class layout", () => {
    expect(CONTEXT_DIR_NAMES).toContain("identity");
    expect(CONTEXT_DIR_NAMES).toContain("state");
    expect(CONTEXT_DIR_NAMES).toContain("state/inbox");
    expect(CONTEXT_DIR_NAMES).toContain("state/scratch");
    expect(CONTEXT_DIR_NAMES).toContain("state/activity");
    expect(CONTEXT_DIR_NAMES).toContain("plans");
    expect(CONTEXT_DIR_NAMES).toContain("plans/projects");
    expect(CONTEXT_DIR_NAMES).toContain("journal");
    expect(CONTEXT_DIR_NAMES).toContain("journal/daily");
    expect(CONTEXT_DIR_NAMES).toContain("journal/weekly");
    expect(CONTEXT_DIR_NAMES).toContain("journal/monthly");
    expect(CONTEXT_DIR_NAMES).toContain("journal/repos");
    expect(CONTEXT_DIR_NAMES).toContain("knowledge");
    expect(CONTEXT_DIR_NAMES).toContain("knowledge/dossiers");
    expect(CONTEXT_DIR_NAMES).toContain("knowledge/wiki");
    expect(CONTEXT_DIR_NAMES).toContain("knowledge/repos");
    expect(CONTEXT_DIR_NAMES).toContain("knowledge/entities");
    expect(CONTEXT_DIR_NAMES).toContain("policies");
    expect(CONTEXT_DIR_NAMES).toContain("policies/routines");
    expect(CONTEXT_DIR_NAMES).toContain("policies/routines/custom");
    expect(CONTEXT_DIR_NAMES).toContain("policies/management-captures");
    expect(CONTEXT_DIR_NAMES).toContain("policies/skills");
    // None have a trailing slash.
    for (const dir of CONTEXT_DIR_NAMES) {
      expect(dir.endsWith("/")).toBe(false);
    }
  });

  it("lists allowed file extensions", () => {
    expect(CONTEXT_FILE_EXTENSIONS).toEqual([".md", ".base"]);
  });

  it("lists reserved .base stems under the new plans/projects/ path", () => {
    expect(CONTEXT_BASE_FILE_STEMS).toEqual(["plans/projects/_active"]);
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
    // v4 V10 additions.
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("agent_questions");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("activity-log");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("meeting");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("trip");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("receipt");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("book");
    expect(CONTEXT_FRONTMATTER_TYPES).toContain("note");
  });

  it("exposes the unified-repositories git dir constant", () => {
    expect(CONTEXT_RELATIVE_PATHS.git.dir).toBe("knowledge/repos");
    expect(CONTEXT_RELATIVE_PATHS.gitRepos.dir).toBe(
      "knowledge/repos/legacy-registry",
    );
  });
});
