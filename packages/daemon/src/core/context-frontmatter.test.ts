import { describe, expect, it } from "vitest";
import {
  expectedFrontmatterForPath,
  shouldValidateContextFileFrontmatter,
  validateContextFileFrontmatter,
  validateDailySkeletonFrontmatter,
} from "./context-frontmatter.js";

function validContent(overrides: string[] = []): string {
  return [
    "---",
    "# ignored comment",
    'type: "user"',
    "owner: 'shared'",
    "updated: 2026-04-21",
    "tags: [profile]",
    ...overrides,
    "---",
    "# User",
    "",
  ].join("\n");
}

describe("shouldValidateContextFileFrontmatter", () => {
  it("targets user/rules/projects/git-repos/daily/weekly/monthly/dossiers markdown files and context-index.md", () => {
    expect(shouldValidateContextFileFrontmatter("identity/profile.md")).toBe(true);
    expect(shouldValidateContextFileFrontmatter("policies/management.md")).toBe(true);
    expect(shouldValidateContextFileFrontmatter("plans/projects/example.md")).toBe(true);
    expect(
      shouldValidateContextFileFrontmatter(
        "knowledge/repos/legacy-registry/example.md",
      ),
    ).toBe(true);
    expect(shouldValidateContextFileFrontmatter("journal/daily/2026-04-21.md")).toBe(true);
    expect(shouldValidateContextFileFrontmatter("journal/weekly/2026-W17.md")).toBe(true);
    expect(shouldValidateContextFileFrontmatter("journal/monthly/2026-04.md")).toBe(true);
    expect(shouldValidateContextFileFrontmatter("knowledge/dossiers/hourly.md")).toBe(true);
    // contextIndex was folded into rootIndex (_index.md) — both validate.
    expect(shouldValidateContextFileFrontmatter("_index.md")).toBe(true);
    expect(shouldValidateContextFileFrontmatter("roadmap.md")).toBe(false);
    expect(shouldValidateContextFileFrontmatter("plans/projects/_active.base")).toBe(false);
  });

  it("excludes policies/agents/<slug>/agent.md (agent-definition schema, not rule schema)", () => {
    // Agent definitions carry agentDefinitionSchema frontmatter (no type/owner/
    // updated). They must be skipped by the generic validator so neither the
    // write chokepoint nor the Vault Health scan demands `type`. Regression for
    // `policies/agents/<slug>/agent.md frontmatter requires \`type\`.`
    expect(
      shouldValidateContextFileFrontmatter("policies/agents/say-hi/agent.md"),
    ).toBe(false);
    // sibling policies/ files still validate
    expect(shouldValidateContextFileFrontmatter("policies/agents-list.md")).toBe(true);
  });
});

describe("validateContextFileFrontmatter", () => {
  it("accepts required fields, YAML comments, quoted scalars, and an H1", () => {
    expect(validateContextFileFrontmatter(validContent(), "identity/profile.md")).toBeNull();
  });

  it("accepts inline comments on required scalar fields", () => {
    const content = [
      "---",
      'type: "user" # kind',
      "owner: shared # canonical owner",
      "updated: 2026-04-21 # reviewed",
      "---",
      "# User",
    ].join("\n");

    expect(validateContextFileFrontmatter(content, "identity/profile.md")).toBeNull();
  });

  it("accepts the rule-owner variants used by rule templates", () => {
    for (const owner of ["agent", "shared", "user"]) {
      const content = [
        "---",
        "type: rule",
        `owner: ${owner}`,
        "updated: 2026-04-21",
        "---",
        "# Rule",
      ].join("\n");

      expect(validateContextFileFrontmatter(content, "policies/example.md")).toBeNull();
    }
  });

  it("accepts full ISO timestamps for updated", () => {
    const content = [
      "---",
      "type: weekly",
      "owner: agent",
      "updated: 2026-04-21T10:30:00.000Z",
      "---",
      "# Weekly Review 2026-W17",
    ].join("\n");

    expect(validateContextFileFrontmatter(content, "journal/weekly/2026-W17.md")).toBeNull();
  });

  it("skips paths outside the guarded prefixes", () => {
    expect(validateContextFileFrontmatter("# Today\n", "today.md")).toBeNull();
  });

  it("skips agent definitions even though they have no type/owner/updated", () => {
    const agentMd = [
      "---",
      "slug: say-hi",
      "name: Say Hi",
      "kind: user",
      "---",
      "# Say Hi",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(agentMd, "policies/agents/say-hi/agent.md"),
    ).toBeNull();
  });

  it("rejects files without opening frontmatter", () => {
    const result = validateContextFileFrontmatter("# User\n", "identity/profile.md");

    expect(result?.code).toBe("missing_frontmatter");
    expect(result?.message).toContain("requires YAML frontmatter");
  });

  it("rejects files without closing frontmatter", () => {
    const result = validateContextFileFrontmatter(
      "---\ntype: user\nowner: shared\nupdated: 2026-04-21\n# User\n",
      "identity/profile.md",
    );

    expect(result?.code).toBe("missing_frontmatter");
  });

  it("rejects missing required fields", () => {
    expect(
      validateContextFileFrontmatter(
        "---\nowner: shared\nupdated: 2026-04-21\n---\n# User\n",
        "identity/profile.md",
      )?.message,
    ).toContain("`type`");
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nupdated: 2026-04-21\n---\n# User\n",
        "identity/profile.md",
      )?.message,
    ).toContain("`owner`");
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nowner: shared\n---\n# User\n",
        "identity/profile.md",
      )?.message,
    ).toContain("`updated`");
  });

  it("rejects invalid field values", () => {
    expect(
      validateContextFileFrontmatter(
        "---\ntype: unknown\nowner: shared\nupdated: 2026-04-21\n---\n# User\n",
        "identity/profile.md",
      )?.code,
    ).toBe("invalid_type");
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nowner: nobody\nupdated: 2026-04-21\n---\n# User\n",
        "identity/profile.md",
      )?.code,
    ).toBe("invalid_owner");
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nowner: shared\nupdated: 2026-02-30\n---\n# User\n",
        "identity/profile.md",
      )?.code,
    ).toBe("invalid_updated");
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nowner: shared\nupdated: 2026-04-21Tbad\n---\n# User\n",
        "identity/profile.md",
      )?.code,
    ).toBe("invalid_updated");
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nowner: shared\nupdated: tomorrow\n---\n# User\n",
        "identity/profile.md",
      )?.code,
    ).toBe("invalid_updated");
  });

  it("rejects type and owner values that do not match the path family", () => {
    expect(
      validateContextFileFrontmatter(
        "---\ntype: user\nowner: shared\nupdated: 2026-04-21\n---\n# Project\n",
        "plans/projects/example.md",
      )?.message,
    ).toContain("type must be `project`");

    expect(
      validateContextFileFrontmatter(
        "---\ntype: project\nowner: shared\nupdated: 2026-04-21\n---\n# Repo\n",
        "knowledge/repos/legacy-registry/example.md",
      )?.message,
    ).toContain("type must be `git-repo`");

    expect(
      validateContextFileFrontmatter(
        "---\ntype: daily\nowner: user\nupdated: 2026-04-21\n---\n# 2026-04-21\n",
        "journal/daily/2026-04-21.md",
      )?.message,
    ).toContain("owner must be `agent`");

    expect(
      validateContextFileFrontmatter(
        "---\ntype: rule\nowner: shared\nupdated: 2026-04-21\n---\n# Identity index\n",
        "identity/_index.md",
      )?.message,
    ).toContain("type must be `index`");
  });

  it("rejects files without an H1 after frontmatter", () => {
    const result = validateContextFileFrontmatter(
      "---\ntype: user\nowner: shared\nupdated: 2026-04-21\n---\n## User\n",
      "identity/profile.md",
    );

    expect(result?.code).toBe("missing_h1");
  });

  describe("policies/management-captures/* — MANAGEMENT-POLICY-CAPTURE-PLAN §4.1.1", () => {
    function policyContent(overrides: Record<string, string | null> = {}): string {
      const defaults: Record<string, string | null> = {
        type: "rule",
        kind: "policy",
        owner: "agent",
        updated: "2026-04-24",
        slug: "morning-finance-check",
        status: "active",
        created_at: "2026-04-24",
        origin: "User DM 2026-04-24T14:30Z",
      };
      const merged = { ...defaults, ...overrides };
      const lines = ["---"];
      for (const [key, value] of Object.entries(merged)) {
        if (value === null) continue;
        lines.push(`${key}: ${value}`);
      }
      lines.push("---", "# Morning Finance Check", "");
      return lines.join("\n");
    }

    const POLICY_PATH = "policies/management-captures/morning-finance-check.md";

    it("accepts a fully populated policy file", () => {
      expect(
        validateContextFileFrontmatter(policyContent(), POLICY_PATH),
      ).toBeNull();
    });

    it("requires owner: agent for rules/policies/* (rejects shared)", () => {
      const result = validateContextFileFrontmatter(
        policyContent({ owner: "shared" }),
        POLICY_PATH,
      );
      expect(result?.code).toBe("invalid_owner");
      expect(result?.message).toContain("owner must be `agent`");
    });

    it("requires kind: policy", () => {
      expect(
        validateContextFileFrontmatter(
          policyContent({ kind: null }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_kind");
      expect(
        validateContextFileFrontmatter(
          policyContent({ kind: "other" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_kind");
    });

    it("requires slug to be present", () => {
      const result = validateContextFileFrontmatter(
        policyContent({ slug: null }),
        POLICY_PATH,
      );
      expect(result?.code).toBe("missing_field");
      expect(result?.message).toContain("`slug`");
    });

    it("rejects malformed slug values", () => {
      expect(
        validateContextFileFrontmatter(
          policyContent({ slug: "Bad_Slug" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_slug");
      expect(
        validateContextFileFrontmatter(
          policyContent({ slug: "-leading-hyphen" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_slug");
      expect(
        validateContextFileFrontmatter(
          policyContent({ slug: "trailing-" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_slug");
      expect(
        validateContextFileFrontmatter(
          policyContent({ slug: "a".repeat(65) }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_slug");
    });

    it("requires slug to equal the filename stem", () => {
      const result = validateContextFileFrontmatter(
        policyContent({ slug: "different-slug" }),
        POLICY_PATH,
      );
      expect(result?.code).toBe("invalid_slug");
      expect(result?.message).toContain("filename stem");
    });

    it("requires status to be present", () => {
      const result = validateContextFileFrontmatter(
        policyContent({ status: null }),
        POLICY_PATH,
      );
      expect(result?.code).toBe("missing_field");
      expect(result?.message).toContain("`status`");
    });

    it("requires status to be one of active|paused|removed", () => {
      expect(
        validateContextFileFrontmatter(
          policyContent({ status: "unknown" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_status");
      for (const status of ["active", "paused", "removed"]) {
        expect(
          validateContextFileFrontmatter(
            policyContent({ status, slug: "morning-finance-check" }),
            POLICY_PATH,
          ),
        ).toBeNull();
      }
    });

    it("requires created_at as YYYY-MM-DD", () => {
      expect(
        validateContextFileFrontmatter(
          policyContent({ created_at: null }),
          POLICY_PATH,
        )?.code,
      ).toBe("missing_field");
      expect(
        validateContextFileFrontmatter(
          policyContent({ created_at: "2026/04/24" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_created_at");
      expect(
        validateContextFileFrontmatter(
          policyContent({ created_at: "2026-04-24T10:00:00Z" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_created_at");
      expect(
        validateContextFileFrontmatter(
          policyContent({ created_at: "2026-02-30" }),
          POLICY_PATH,
        )?.code,
      ).toBe("invalid_created_at");
    });

    it("requires non-empty origin", () => {
      expect(
        validateContextFileFrontmatter(
          policyContent({ origin: null }),
          POLICY_PATH,
        )?.code,
      ).toBe("missing_field");
    });

    it("rejects block-scalar markers as the entire origin value", () => {
      // The frontmatter extractor is line-scalar only; `origin: |` would
      // pass a naive truthy check while losing the indented body. Reject
      // explicitly so the policy skill is forced to a single-line string.
      for (const marker of ["|", ">", "|-", "|+", ">-", ">+"]) {
        const result = validateContextFileFrontmatter(
          policyContent({ origin: marker }),
          POLICY_PATH,
        );
        expect(result?.code).toBe("missing_field");
        expect(result?.message).toContain("single-line string");
      }
    });

    it("validates rules/policies/_index.md as an agent-owned index", () => {
      const validIndex = [
        "---",
        "type: index",
        "owner: agent",
        "updated: 2026-04-24",
        "---",
        "# Active Policies",
      ].join("\n");
      expect(
        validateContextFileFrontmatter(validIndex, "policies/management-captures/_index.md"),
      ).toBeNull();

      const sharedOwner = [
        "---",
        "type: index",
        "owner: shared",
        "updated: 2026-04-24",
        "---",
        "# Active Policies",
      ].join("\n");
      expect(
        validateContextFileFrontmatter(sharedOwner, "policies/management-captures/_index.md")
          ?.message,
      ).toContain("owner must be `agent`");

      // _index.md must NOT trigger policy-specific guards (no kind/slug etc.)
      const indexNoKind = [
        "---",
        "type: index",
        "owner: agent",
        "updated: 2026-04-24",
        "---",
        "# Active Policies",
      ].join("\n");
      expect(
        validateContextFileFrontmatter(indexNoKind, "policies/management-captures/_index.md"),
      ).toBeNull();
    });
  });

  it("enforces the dossier/index frontmatter contract for B-004 files", () => {
    const validDossier = [
      "---",
      "type: dossier",
      "owner: agent",
      "updated: 2026-04-21",
      "---",
      "# Hourly Dossier",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(validDossier, "knowledge/dossiers/hourly.md"),
    ).toBeNull();

    const validIndex = [
      "---",
      "type: index",
      "owner: agent",
      "updated: 2026-04-21",
      "---",
      "# Context Index",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(validIndex, "context-index.md"),
    ).toBeNull();
    expect(
      validateContextFileFrontmatter(validIndex, "knowledge/dossiers/_index.md"),
    ).toBeNull();

    const wrongOwner = [
      "---",
      "type: dossier",
      "owner: user",
      "updated: 2026-04-21",
      "---",
      "# Dossier",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(wrongOwner, "knowledge/dossiers/morning.md")?.message,
    ).toContain("owner must be `agent`");

    const wrongType = [
      "---",
      "type: user",
      "owner: agent",
      "updated: 2026-04-21",
      "---",
      "# Mismatch",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(wrongType, "_index.md")?.message,
    ).toContain("type must be `index`");
  });

  it("recognises the rules/_index.md and projects/_index.md indices and the monthly/ tree", () => {
    // Pins the path-pattern arms in expectedFrontmatterByPath that the
    // existing suite skipped. Each must accept a well-formed index /
    // monthly frontmatter via the generic validator chokepoint.
    const validIndex = [
      "---",
      "type: index",
      "owner: shared",
      "updated: 2026-04-21",
      "---",
      "# Index",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(validIndex, "policies/_index.md"),
    ).toBeNull();
    expect(
      validateContextFileFrontmatter(validIndex, "plans/projects/_index.md"),
    ).toBeNull();

    const validMonthly = [
      "---",
      "type: monthly",
      "owner: agent",
      "updated: 2026-04-21",
      "---",
      "# 2026-04",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(validMonthly, "journal/monthly/2026-04.md"),
    ).toBeNull();
  });

});

describe("validateDailySkeletonFrontmatter", () => {
  // morning-routine-optimization.md §"PUT /api/context/daily/<date>
  // skeleton-preservation validator" — the five skeleton-owned
  // frontmatter fields (`date`, `weekday`, `agent_generated`,
  // `calendar_events`, `messages_handled`) must each be present
  // and well-typed; absent or malformed entries are returned as
  // per-field structured drift errors so Stage B can self-correct in
  // a single retry round-trip. `type` and `owner` are pinned by the
  // generic validator and not re-checked here.

  function dailySkeleton(overrides: Partial<Record<string, string>> = {}): string {
    const defaults: Record<string, string> = {
      date: "2026-05-15",
      weekday: "Friday",
      type: "daily",
      owner: "agent",
      agent_generated: "true",
      calendar_events: "3",
      messages_handled: "5",
      updated: "2026-05-15",
    };
    const merged = { ...defaults, ...overrides };
    const lines: string[] = ["---"];
    for (const [key, value] of Object.entries(merged)) {
      if (value === "<omit>") continue;
      lines.push(`${key}: ${value}`);
    }
    lines.push("---", "# 2026-05-15 Friday", "", "## Summary", "All good.");
    return lines.join("\n");
  }

  it("returns no drift errors for a well-formed daily file", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton(),
      "journal/daily/2026-05-15.md",
    );
    expect(errors).toEqual([]);
  });

  it("returns [] for a daily/ path that does not end in .md", () => {
    // Hits the second guard at the top of validateDailySkeletonFrontmatter
    // — a hypothetical `daily/sticky.txt` slipping in must short-circuit
    // before frontmatter extraction.
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton(),
      "journal/daily/sticky.txt",
    );
    expect(errors).toEqual([]);
  });

  it("flags each missing skeleton-owned field independently", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton({
        date: "<omit>",
        weekday: "<omit>",
        agent_generated: "<omit>",
        calendar_events: "<omit>",
        messages_handled: "<omit>",
      }),
      "journal/daily/2026-05-15.md",
    );
    // All five fields surface as separate errors in one response so
    // Stage B can fix them in a single retry.
    const fields = errors.map((e) => e.field).sort();
    expect(fields).toEqual([
      "frontmatter.agent_generated",
      "frontmatter.calendar_events",
      "frontmatter.date",
      "frontmatter.messages_handled",
      "frontmatter.weekday",
    ]);
    expect(errors.every((e) => e.received === null)).toBe(true);
  });

  it("rejects a `date` field that does not match the path stem", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton({ date: "2026-04-30" }),
      "journal/daily/2026-05-15.md",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("frontmatter.date");
    expect(errors[0]?.received).toBe("2026-04-30");
  });

  it("rejects a `weekday` outside the seven long-form English values", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton({ weekday: "Fri" }),
      "journal/daily/2026-05-15.md",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("frontmatter.weekday");
    expect(errors[0]?.received).toBe("Fri");
  });

  it("rejects `agent_generated: false` — the skeleton always emits `true`", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton({ agent_generated: "false" }),
      "journal/daily/2026-05-15.md",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("frontmatter.agent_generated");
    expect(errors[0]?.received).toBe("false");
  });

  it("rejects negative or non-integer `calendar_events`", () => {
    const negative = validateDailySkeletonFrontmatter(
      dailySkeleton({ calendar_events: "-1" }),
      "journal/daily/2026-05-15.md",
    );
    expect(negative.map((e) => e.field)).toEqual([
      "frontmatter.calendar_events",
    ]);
    const noisy = validateDailySkeletonFrontmatter(
      dailySkeleton({ calendar_events: "three" }),
      "journal/daily/2026-05-15.md",
    );
    expect(noisy.map((e) => e.field)).toEqual([
      "frontmatter.calendar_events",
    ]);
  });

  it("rejects negative or non-integer `messages_handled`", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton({ messages_handled: "five" }),
      "journal/daily/2026-05-15.md",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("frontmatter.messages_handled");
  });

  it("returns no errors for non-daily paths (gracefully scoped)", () => {
    const errors = validateDailySkeletonFrontmatter(
      dailySkeleton(),
      "journal/weekly/2026-W20.md",
    );
    expect(errors).toEqual([]);
  });

  it("returns no errors when there is no frontmatter at all — the generic validator owns that message", () => {
    const errors = validateDailySkeletonFrontmatter(
      "# Header\nBody only.",
      "journal/daily/2026-05-15.md",
    );
    expect(errors).toEqual([]);
  });
});

describe("expectedFrontmatterForPath", () => {
  it("returns null for paths outside the validated families", () => {
    expect(expectedFrontmatterForPath("settings/foo.md")).toBeNull();
    expect(expectedFrontmatterForPath("random.md")).toBeNull();
    expect(expectedFrontmatterForPath("today.md")).toBeNull();
  });

  it("treats the policies sub-index files as shared-owned index frontmatter", () => {
    expect(expectedFrontmatterForPath("policies/routines/_index.md")).toEqual({
      type: "index",
      owners: ["shared"],
    });
    expect(expectedFrontmatterForPath("policies/skills/_index.md")).toEqual({
      type: "index",
      owners: ["shared"],
    });
  });
});

describe("YAML scalar parser — quoted-string and inline-comment edge cases", () => {
  // Drives extractFrontmatter / parseYamlScalar / stripYamlInlineComment
  // through validateContextFileFrontmatter — these helpers are not
  // exported but the value of `updated` flows through them.

  it("preserves a hash that lives inside a single-quoted string", () => {
    const content = [
      "---",
      "type: user",
      "owner: shared",
      "updated: '2026-04-21' # quoted with comment",
      "---",
      "# User",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(content, "identity/profile.md"),
    ).toBeNull();
  });

  it("preserves an escaped quote inside a double-quoted string (escape branch)", () => {
    // type value carries an escaped double-quote; the scalar parser
    // must consume the \" sequence without ending the string. After
    // the escape, the value is still `user` once unwrapped.
    const content = [
      "---",
      'type: "user"',
      'owner: "shared"',
      'updated: "2026-04-21"',
      'note: "He said \\"hi\\" today # not a comment"',
      "---",
      "# User",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(content, "identity/profile.md"),
    ).toBeNull();
  });

  it("treats `#` at the start of a value as YAML comment fully (not literal)", () => {
    // A bare `#` at the start of a value triggers the inline-comment
    // strip path (i === 0 branch).
    const content = [
      "---",
      "type: user",
      "owner: shared",
      "updated: 2026-04-21",
      "tags: # whole-line comment",
      "---",
      "# User",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(content, "identity/profile.md"),
    ).toBeNull();
  });
});

describe("knowledge/sources cards (SOURCE_LIBRARY_DESIGN.md)", () => {
  it("validates the subtree and pins expected type/owner", () => {
    expect(shouldValidateContextFileFrontmatter("knowledge/sources/acme/deck.md")).toBe(true);
    expect(expectedFrontmatterForPath("knowledge/sources/_index.md")).toEqual({
      type: "index",
      owners: ["agent"],
    });
    expect(
      expectedFrontmatterForPath("knowledge/sources/acme-launch/pitch-deck.md"),
    ).toEqual({ type: "source", owners: ["agent"] });
  });

  it("accepts a well-formed source card and rejects a mistyped one", () => {
    const card = [
      "---",
      "type: source",
      "owner: agent",
      "updated: 2026-07-01",
      "source_id: src_123",
      "---",
      "# Pitch deck",
    ].join("\n");
    expect(
      validateContextFileFrontmatter(card, "knowledge/sources/acme/pitch-deck.md"),
    ).toBeNull();

    const wrongType = card.replace("type: source", "type: note");
    expect(
      validateContextFileFrontmatter(wrongType, "knowledge/sources/acme/pitch-deck.md"),
    ).toMatchObject({ code: "invalid_type" });
  });
});
