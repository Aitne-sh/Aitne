import { describe, expect, it } from "vitest";

import {
  aliasVaultPath,
  findShadowingAliases,
  VAULT_PATH_ALIASES,
} from "./context-vault-aliases.js";

describe("aliasVaultPath", () => {
  describe("loose top-level files", () => {
    it("legacy today.md → canonical state/today.md", () => {
      const r = aliasVaultPath("today.md");
      expect(r).toEqual({
        canonicalPath: "state/today.md",
        legacyPath: "today.md",
        aliased: true,
      });
    });
    it("legacy today (extensionless) → state/today", () => {
      const r = aliasVaultPath("today");
      expect(r.canonicalPath).toBe("state/today");
      expect(r.aliased).toBe(true);
    });
    it("legacy yesterday.md → state/yesterday.md", () => {
      expect(aliasVaultPath("yesterday.md").canonicalPath).toBe(
        "state/yesterday.md",
      );
    });
    it("legacy roadmap.md → plans/roadmap.md", () => {
      expect(aliasVaultPath("roadmap.md").canonicalPath).toBe(
        "plans/roadmap.md",
      );
    });
    it("today.md.bak is NOT aliased (exactOnly)", () => {
      const r = aliasVaultPath("today.md.bak");
      expect(r.aliased).toBe(false);
    });
  });

  describe("identity (legacy user/)", () => {
    it("legacy user/profile.md → identity/profile.md", () => {
      expect(aliasVaultPath("user/profile.md").canonicalPath).toBe(
        "identity/profile.md",
      );
    });
    it("legacy user/_index.md → identity/_index.md", () => {
      expect(aliasVaultPath("user/_index.md").canonicalPath).toBe(
        "identity/_index.md",
      );
    });
  });

  describe("legacy rules/", () => {
    it("rules/management.md → policies/management.md", () => {
      expect(aliasVaultPath("rules/management.md").canonicalPath).toBe(
        "policies/management.md",
      );
    });
    it("rules/policies/foo.md → policies/management-captures/foo.md (longest-prefix-first)", () => {
      expect(aliasVaultPath("rules/policies/foo.md").canonicalPath).toBe(
        "policies/management-captures/foo.md",
      );
    });
    it("rules/policies/_index.md → policies/management-captures/_index.md", () => {
      expect(aliasVaultPath("rules/policies/_index.md").canonicalPath).toBe(
        "policies/management-captures/_index.md",
      );
    });
    it("rules/redaction.md → policies/redaction.md", () => {
      expect(aliasVaultPath("rules/redaction.md").canonicalPath).toBe(
        "policies/redaction.md",
      );
    });
  });

  describe("legacy routines/", () => {
    it("routines/morning.md → policies/routines/morning.md", () => {
      expect(aliasVaultPath("routines/morning.md").canonicalPath).toBe(
        "policies/routines/morning.md",
      );
    });
    it("routines/custom/foo.md → policies/routines/custom/foo.md", () => {
      expect(aliasVaultPath("routines/custom/foo.md").canonicalPath).toBe(
        "policies/routines/custom/foo.md",
      );
    });
  });

  describe("activity-scan rename (v0.1.11)", () => {
    it("policies/routines/hourly.md → policies/routines/activity-scan.md", () => {
      expect(aliasVaultPath("policies/routines/hourly.md").canonicalPath).toBe(
        "policies/routines/activity-scan.md",
      );
    });
    it("routines/hourly.md → policies/routines/activity-scan.md", () => {
      expect(aliasVaultPath("routines/hourly.md").canonicalPath).toBe(
        "policies/routines/activity-scan.md",
      );
    });
    it("knowledge/dossiers/hourly.md → knowledge/dossiers/activity-scan.md", () => {
      expect(aliasVaultPath("knowledge/dossiers/hourly.md").canonicalPath).toBe(
        "knowledge/dossiers/activity-scan.md",
      );
    });
    it("dossiers/hourly.md → knowledge/dossiers/activity-scan.md", () => {
      expect(aliasVaultPath("dossiers/hourly.md").canonicalPath).toBe(
        "knowledge/dossiers/activity-scan.md",
      );
    });
    it("does not alias hourly-prefixed siblings", () => {
      expect(aliasVaultPath("policies/routines/hourly-notes.md").canonicalPath).toBe(
        "policies/routines/hourly-notes.md",
      );
    });
  });

  describe("legacy projects/", () => {
    it("projects/foo.md → plans/projects/foo.md", () => {
      expect(aliasVaultPath("projects/foo.md").canonicalPath).toBe(
        "plans/projects/foo.md",
      );
    });
    it("projects/_active.base → plans/projects/_active.base", () => {
      expect(aliasVaultPath("projects/_active.base").canonicalPath).toBe(
        "plans/projects/_active.base",
      );
    });
  });

  describe("legacy journals", () => {
    it("daily/2026-05-25.md → journal/daily/2026-05-25.md", () => {
      expect(aliasVaultPath("daily/2026-05-25.md").canonicalPath).toBe(
        "journal/daily/2026-05-25.md",
      );
    });
    it("weekly/2026-W21.md → journal/weekly/2026-W21.md", () => {
      expect(aliasVaultPath("weekly/2026-W21.md").canonicalPath).toBe(
        "journal/weekly/2026-W21.md",
      );
    });
    it("monthly/2026-05.md → journal/monthly/2026-05.md", () => {
      expect(aliasVaultPath("monthly/2026-05.md").canonicalPath).toBe(
        "journal/monthly/2026-05.md",
      );
    });
  });

  describe("legacy agent/", () => {
    it("agent/journal.md → journal/agent.md", () => {
      expect(aliasVaultPath("agent/journal.md").canonicalPath).toBe(
        "journal/agent.md",
      );
    });
    it("agent/journal (extensionless) → journal/agent", () => {
      expect(aliasVaultPath("agent/journal").canonicalPath).toBe(
        "journal/agent",
      );
    });
    it("agent/profile-questions.md → state/profile-questions.md", () => {
      expect(aliasVaultPath("agent/profile-questions.md").canonicalPath).toBe(
        "state/profile-questions.md",
      );
    });
    it("agent/scratch/2026-05-25-foo.md → state/scratch/2026-05-25-foo.md", () => {
      expect(
        aliasVaultPath("agent/scratch/2026-05-25-foo.md").canonicalPath,
      ).toBe("state/scratch/2026-05-25-foo.md");
    });
  });

  describe("legacy git/<slug>/", () => {
    it("git/myrepo/overview.md → knowledge/repos/myrepo/overview.md", () => {
      expect(aliasVaultPath("git/myrepo/overview.md").canonicalPath).toBe(
        "knowledge/repos/myrepo/overview.md",
      );
    });
    it("git/myrepo/overview (extensionless) → knowledge/repos/myrepo/overview", () => {
      expect(aliasVaultPath("git/myrepo/overview").canonicalPath).toBe(
        "knowledge/repos/myrepo/overview",
      );
    });
    it("git/myrepo/journal/2026-05-25.md → journal/repos/myrepo/2026-05-25.md", () => {
      expect(
        aliasVaultPath("git/myrepo/journal/2026-05-25.md").canonicalPath,
      ).toBe("journal/repos/myrepo/2026-05-25.md");
    });
    it("git/<slug>/journal/<date> (extensionless)", () => {
      expect(
        aliasVaultPath("git/myrepo/journal/2026-05-25").canonicalPath,
      ).toBe("journal/repos/myrepo/2026-05-25");
    });
  });

  describe("legacy management entities", () => {
    it("work/_index.md → knowledge/entities/work/_index.md", () => {
      expect(aliasVaultPath("work/_index.md").canonicalPath).toBe(
        "knowledge/entities/work/_index.md",
      );
    });
    it("work/meetings/foo.md → knowledge/entities/work/meetings/foo.md", () => {
      expect(aliasVaultPath("work/meetings/foo.md").canonicalPath).toBe(
        "knowledge/entities/work/meetings/foo.md",
      );
    });
    it("travel/trips/foo.md → knowledge/entities/travel/trips/foo.md", () => {
      expect(aliasVaultPath("travel/trips/foo.md").canonicalPath).toBe(
        "knowledge/entities/travel/trips/foo.md",
      );
    });
    it("non-domain top-level dir is not aliased", () => {
      expect(aliasVaultPath("garage/foo.md").aliased).toBe(false);
    });
    it("domain index/entity without a .md suffix keeps the bare stem", () => {
      // Exercises the `: ""` (no-suffix) branch of both regex matchers.
      expect(aliasVaultPath("work/_index").canonicalPath).toBe(
        "knowledge/entities/work/_index",
      );
      expect(aliasVaultPath("work/meetings/foo").canonicalPath).toBe(
        "knowledge/entities/work/meetings/foo",
      );
    });
  });

  describe("legacy activity views", () => {
    it("_activity/notion.md → state/activity/notion.md", () => {
      expect(aliasVaultPath("_activity/notion.md").canonicalPath).toBe(
        "state/activity/notion.md",
      );
    });
  });

  describe("legacy inbox", () => {
    it("inbox/2026-05-25-foo.md → state/inbox/2026-05-25-foo.md", () => {
      expect(aliasVaultPath("inbox/2026-05-25-foo.md").canonicalPath).toBe(
        "state/inbox/2026-05-25-foo.md",
      );
    });
  });

  describe("legacy dossiers", () => {
    it("dossiers/foo.md → knowledge/dossiers/foo.md", () => {
      expect(aliasVaultPath("dossiers/foo.md").canonicalPath).toBe(
        "knowledge/dossiers/foo.md",
      );
    });
  });

  describe("canonical (no-op) inputs", () => {
    it("identity/profile.md is unchanged", () => {
      const r = aliasVaultPath("identity/profile.md");
      expect(r).toEqual({
        canonicalPath: "identity/profile.md",
        legacyPath: "identity/profile.md",
        aliased: false,
      });
    });
    it("state/today.md is unchanged", () => {
      expect(aliasVaultPath("state/today.md").aliased).toBe(false);
    });
    it("policies/management.md is unchanged", () => {
      expect(aliasVaultPath("policies/management.md").aliased).toBe(false);
    });
    it("plans/projects/foo.md is unchanged", () => {
      expect(aliasVaultPath("plans/projects/foo.md").aliased).toBe(false);
    });
    it("journal/daily/2026-05-25.md is unchanged", () => {
      expect(aliasVaultPath("journal/daily/2026-05-25.md").aliased).toBe(false);
    });
    it("knowledge/wiki/foo/20_wiki/bar.md is unchanged", () => {
      expect(aliasVaultPath("knowledge/wiki/foo/20_wiki/bar.md").aliased).toBe(
        false,
      );
    });
    it("_index.md is unchanged", () => {
      expect(aliasVaultPath("_index.md").aliased).toBe(false);
    });
    it(".context-vault-version marker is unchanged", () => {
      expect(aliasVaultPath(".context-vault-version").aliased).toBe(false);
    });
  });

  describe("input normalisation", () => {
    it("leading slash is stripped", () => {
      expect(aliasVaultPath("/today.md").canonicalPath).toBe("state/today.md");
    });
    it("unknown path is returned verbatim", () => {
      const r = aliasVaultPath("totally/unknown.md");
      expect(r.aliased).toBe(false);
      expect(r.canonicalPath).toBe("totally/unknown.md");
    });
  });

  describe("idempotency", () => {
    it("calling twice returns the same canonical path", () => {
      const first = aliasVaultPath("user/profile.md");
      const second = aliasVaultPath(first.canonicalPath);
      expect(second.canonicalPath).toBe(first.canonicalPath);
      expect(second.aliased).toBe(false);
    });
  });
});

describe("findShadowingAliases", () => {
  it("the static table is in longest-prefix-first order — no shadows", () => {
    expect(findShadowingAliases()).toEqual([]);
  });
  it("the table is non-empty", () => {
    expect(VAULT_PATH_ALIASES.length).toBeGreaterThan(0);
  });
  it("flags a mis-ordered table where a shorter prefix precedes a longer one", () => {
    const earlier = { fromPrefix: "rules/", toPrefix: "policies/" };
    const shadowed = {
      fromPrefix: "rules/policies/",
      toPrefix: "policies/management-captures/",
    };
    const unrelated = { fromPrefix: "inbox/", toPrefix: "state/inbox/" };
    const exact = {
      fromPrefix: "agent/journal",
      toPrefix: "journal/agent",
      exactOnly: true,
    };
    // `rules/policies/` starts with `rules/`, so the shorter prefix shadows
    // it. The `exactOnly` entry is skipped by the guard above the push.
    expect(findShadowingAliases([earlier, shadowed, unrelated, exact])).toEqual([
      { earlier, shadowed },
    ]);
  });
});
