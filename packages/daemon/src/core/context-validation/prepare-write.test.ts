import { describe, it, expect } from "vitest";
import {
  prepareContextContentForWrite,
  validateContextContent,
  type ResolvedContextTarget,
} from "./prepare-write.js";

const TODAY_TARGET: ResolvedContextTarget = { base: "today", ext: ".md" };
const ROADMAP_TARGET: ResolvedContextTarget = { base: "roadmap", ext: ".md" };
const CUSTOM_ROUTINE_TARGET: ResolvedContextTarget = {
  base: "routines/custom/my-routine",
  ext: ".md",
};
const BUILTIN_ROUTINE_TARGET: ResolvedContextTarget = {
  base: "routines/morning",
  ext: ".md",
};
const ROUTINES_INDEX_TARGET: ResolvedContextTarget = {
  base: "routines/_index",
  ext: ".md",
};
const PROJECT_BASE_TARGET: ResolvedContextTarget = {
  base: "projects/_active",
  ext: ".base",
};
const USER_PROFILE_TARGET: ResolvedContextTarget = {
  base: "user/profile",
  ext: ".md",
};

function validTodayContent(date = "2026-04-22"): string {
  return [
    `# ${date} (Day)`,
    "> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on",
    "",
    "## User Schedule",
    "- (none)",
    "",
    "## User Tasks",
    "- (none)",
    "",
    "## Agent Plan",
    "- (none)",
    "",
    "## Agent Notes",
    "- (none)",
    "",
    "## Agent Log",
    "- (none)",
    "",
    "## Handoff",
    "- (none)",
    "",
  ].join("\n");
}

function validRoutineRulebook(slug: string): string {
  return [
    "---",
    "type: rule",
    `slug: ${slug}`,
    "---",
    `# ${slug}`,
    "",
    "## Checks",
    "- thing",
    "",
  ].join("\n");
}

function withUserFrontmatter(body: string): string {
  return [
    "---",
    "type: user",
    "owner: shared",
    "updated: 2026-04-22",
    "---",
    body,
  ].join("\n");
}

describe("validateContextContent", () => {
  it("delegates today.md to validateTodayContent", () => {
    expect(validateContextContent(TODAY_TARGET, validTodayContent())).toBeNull();
    const err = validateContextContent(TODAY_TARGET, "# Today\n\n## Agent Log\n");
    expect(err?.status).toBe(400);
    expect(err?.message).toContain("line 1");
  });

  it("threads allowLegacyToday + expectedAgentDay through", () => {
    expect(
      validateContextContent(TODAY_TARGET, "# Today\n\n## Agent Log\n", {
        allowLegacyToday: true,
      }),
    ).toBeNull();

    const wrongDate = validateContextContent(
      TODAY_TARGET,
      validTodayContent("2026-04-21"),
      { expectedAgentDay: "2026-04-22" },
    );
    expect(wrongDate?.status).toBe(400);
    expect(wrongDate?.message).toContain("2026-04-21");
  });

  it("returns a 400 with path for roadmap shape errors", () => {
    const err = validateContextContent(ROADMAP_TARGET, "# not a roadmap\n");
    expect(err?.status).toBe(400);
  });

  it("returns null for canonical roadmap content (happy path)", () => {
    const validRoadmap = [
      "# Roadmap",
      "> Last synced: 2026-04-20",
      "",
      "## Annual Goals",
      "",
      "## Quarterly Focus",
      "",
      "## Long-term Plans",
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
      "",
      "## Agent Action Plan",
      "",
      "## Recurring",
      "",
    ].join("\n");
    expect(validateContextContent(ROADMAP_TARGET, validRoadmap)).toBeNull();
  });

  it("returns a 400 for custom-routine parse failures", () => {
    const err = validateContextContent(
      CUSTOM_ROUTINE_TARGET,
      "no frontmatter content here\n",
    );
    expect(err?.status).toBe(400);
    expect(err?.message).toContain("frontmatter");
  });

  it("returns null for a valid custom-routine spec", () => {
    const content = [
      "---",
      "type: rule",
      "slug: my-routine",
      "process_key: routine.custom.my-routine",
      "cron: '0 9 * * *'",
      "enabled: true",
      "backend_tier: light",
      "max_budget_usd: 0.05",
      "---",
      "# Routine",
      "",
      "## Checks",
      "- thing",
      "",
    ].join("\n");
    expect(validateContextContent(CUSTOM_ROUTINE_TARGET, content)).toBeNull();
  });

  it("validates built-in routine rulebooks and skips routines/_index", () => {
    expect(
      validateContextContent(BUILTIN_ROUTINE_TARGET, validRoutineRulebook("morning")),
    ).toBeNull();
    expect(
      validateContextContent(BUILTIN_ROUTINE_TARGET, "no frontmatter\n## Checks\n"),
    ).toMatchObject({ status: 400 });
    // routines/_index uses the regular frontmatter path, not the rulebook gate
    expect(
      validateContextContent(ROUTINES_INDEX_TARGET, "no frontmatter\n", {
        skipFrontmatterValidation: true,
      }),
    ).toBeNull();
  });

  it("returns 422 for frontmatter violations on regular files", () => {
    const err = validateContextContent(USER_PROFILE_TARGET, "# user but no frontmatter\n");
    expect(err?.status).toBe(422);
  });

  it("respects skipFrontmatterValidation for regular files", () => {
    expect(
      validateContextContent(USER_PROFILE_TARGET, "# anything goes\n", {
        skipFrontmatterValidation: true,
      }),
    ).toBeNull();
  });

  it("dispatches .base files to the YAML syntax check", () => {
    expect(
      validateContextContent(PROJECT_BASE_TARGET, "filters:\n  active: true\n"),
    ).toBeNull();
    const err = validateContextContent(PROJECT_BASE_TARGET, "");
    expect(err?.status).toBe(400);
    expect(err?.message).toContain("must not be empty");
  });
});

describe("prepareContextContentForWrite", () => {
  it("passes valid non-roadmap content through verbatim", () => {
    const content = validTodayContent();
    expect(prepareContextContentForWrite(TODAY_TARGET, content)).toEqual({
      ok: true,
      content,
    });
  });

  it("surfaces a non-roadmap validation error verbatim", () => {
    const result = prepareContextContentForWrite(
      TODAY_TARGET,
      "# Today\n\n## Agent Log\n",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain("line 1");
    }
  });

  it("threads allowLegacyToday + expectedAgentDay through for non-roadmap targets", () => {
    // Exercises the `options?.<flag>` defined-branch of the non-roadmap
    // pass-through, complementing the no-options test above.
    expect(
      prepareContextContentForWrite(TODAY_TARGET, "# Today\n\n## Agent Log\n", {
        allowLegacyToday: true,
      }),
    ).toEqual({ ok: true, content: "# Today\n\n## Agent Log\n" });

    const reject = prepareContextContentForWrite(
      TODAY_TARGET,
      validTodayContent("2026-04-21"),
      { expectedAgentDay: "2026-04-22" },
    );
    expect(reject.ok).toBe(false);
    if (!reject.ok) {
      expect(reject.status).toBe(400);
      expect(reject.message).toContain("2026-04-21");
    }
  });

  // Canonical-shape fixture borrowed from roadmap-validate.test.ts.
  // Deep schema is tested there; here we only need a payload the
  // wrapping pipeline accepts so we can verify it routes to the
  // roadmap branch and the normalizer.
  const validRoadmap = [
    "# Roadmap",
    "> Last synced: 2026-04-20",
    "",
    "## Annual Goals",
    "",
    "## Quarterly Focus",
    "",
    "## Long-term Plans",
    "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->",
    "",
    "## Agent Action Plan",
    "",
    "## Recurring",
    "",
  ].join("\n");

  it("accepts canonical roadmap content (ok=true)", () => {
    const result = prepareContextContentForWrite(ROADMAP_TARGET, validRoadmap);
    expect(result.ok).toBe(true);
  });

  it("returns 400 for malformed roadmap content", () => {
    const result = prepareContextContentForWrite(ROADMAP_TARGET, "# not a roadmap\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("bypasses validation when disableRoadmapValidation is set", () => {
    const result = prepareContextContentForWrite(ROADMAP_TARGET, "anything\n", {
      disableRoadmapValidation: true,
    });
    expect(result).toEqual({ ok: true, content: "anything\n" });
  });

  it("runs the transition check when previousRoadmapContent is supplied", () => {
    // Identical previous + new is a valid no-op transition for the
    // transition validator (no rows added or moved).
    const result = prepareContextContentForWrite(ROADMAP_TARGET, validRoadmap, {
      previousRoadmapContent: validRoadmap,
      today: "2026-04-22",
    });
    expect(result.ok).toBe(true);
  });

  it("returns 400 with path when the transition check fails", () => {
    // Drop the only long-term plan row to trigger the
    // `validateRoadmapTransition` retention-window guard, exercising the
    // failure branch in prepareContextContentForWrite.
    const next = validRoadmap.replace(
      "- [2026-Q3] US study prep — Source: dm 2026-04-19 — Review: 2026-05-17 — ReviewCount: 0  <!-- id: rm-20260419-111111 -->\n",
      "",
    );
    const result = prepareContextContentForWrite(ROADMAP_TARGET, next, {
      previousRoadmapContent: validRoadmap,
      today: "2026-04-22",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain("retention window");
    }
  });

  it("validates user/profile frontmatter end-to-end", () => {
    const ok = prepareContextContentForWrite(
      USER_PROFILE_TARGET,
      withUserFrontmatter("# User\n\n## Identity\n"),
    );
    expect(ok.ok).toBe(true);
  });
});
