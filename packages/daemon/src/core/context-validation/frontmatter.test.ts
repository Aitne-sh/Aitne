import { describe, expect, it } from "vitest";

import {
  parseVaultFrontmatter,
  shouldParseVaultFrontmatter,
  VAULT_FRONTMATTER_AUTHORITIES,
  VAULT_FRONTMATTER_KINDS,
  VAULT_FRONTMATTER_MUTABILITIES,
} from "./frontmatter.js";

function fm(body: string): string {
  return `---\n${body}\n---\n# Heading\n\nContent.\n`;
}

describe("parseVaultFrontmatter", () => {
  it("returns empty result for non-md paths", () => {
    const result = parseVaultFrontmatter("anything", "identity/profile.txt");
    expect(result.values).toEqual({});
    expect(result.advisories).toEqual([]);
  });

  it("returns empty result for _index.md (navigation-only)", () => {
    const result = parseVaultFrontmatter("body", "identity/_index.md");
    expect(result.advisories).toEqual([]);
  });

  it("returns empty result for out-of-scope path", () => {
    const result = parseVaultFrontmatter("body", "random/path.md");
    expect(result.advisories).toEqual([]);
  });

  it("emits missing_frontmatter advisory when no YAML preamble", () => {
    const result = parseVaultFrontmatter("# Heading\n\nBody.\n", "identity/profile.md");
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]!.code).toBe("missing_frontmatter");
    expect(result.values).toEqual({});
  });

  it("emits per-field advisories when fields are missing", () => {
    const content = fm("type: user\nowner: shared\nupdated: 2026-05-25");
    const result = parseVaultFrontmatter(content, "identity/profile.md");
    const codes = result.advisories.map((a) => a.code);
    expect(codes).toContain("missing_kind");
    expect(codes).toContain("missing_authority");
    expect(codes).toContain("missing_mutability");
  });

  it("accepts a valid identity file with all new fields", () => {
    const content = fm(
      "kind: identity\nauthority: user\nmutability: replace\nslug: profile\ntitle: Operator profile",
    );
    const result = parseVaultFrontmatter(content, "identity/profile.md");
    expect(result.advisories).toEqual([]);
    expect(result.values).toEqual({
      kind: "identity",
      authority: "user",
      mutability: "replace",
      slug: "profile",
      title: "Operator profile",
    });
  });

  it("flags invalid kind value", () => {
    const content = fm("kind: bogus\nauthority: user\nmutability: replace");
    const result = parseVaultFrontmatter(content, "identity/profile.md");
    const advisory = result.advisories.find((a) => a.code === "invalid_kind");
    expect(advisory).toBeDefined();
    expect(result.values.kind).toBeUndefined();
  });

  it("flags kind/path mismatch", () => {
    const content = fm("kind: identity\nauthority: user\nmutability: replace");
    const result = parseVaultFrontmatter(content, "state/today.md");
    const advisory = result.advisories.find(
      (a) => a.code === "kind_path_mismatch",
    );
    expect(advisory).toBeDefined();
    // kind value still parsed (just flagged); mismatch is advisory.
    expect(result.values.kind).toBe("identity");
  });

  it("maps plan kind to plans/ prefix", () => {
    const content = fm("kind: plan\nauthority: mixed\nmutability: patch");
    const result = parseVaultFrontmatter(content, "plans/roadmap.md");
    expect(result.advisories.find((a) => a.code === "kind_path_mismatch")).toBeUndefined();
  });

  it("maps policy kind to policies/ prefix", () => {
    const content = fm("kind: policy\nauthority: user\nmutability: replace");
    const result = parseVaultFrontmatter(content, "policies/management.md");
    expect(result.advisories.find((a) => a.code === "kind_path_mismatch")).toBeUndefined();
  });

  it("flags invalid authority value", () => {
    const content = fm("kind: identity\nauthority: robot\nmutability: replace");
    const result = parseVaultFrontmatter(content, "identity/profile.md");
    const advisory = result.advisories.find((a) => a.code === "invalid_authority");
    expect(advisory).toBeDefined();
    expect(result.values.authority).toBeUndefined();
  });

  it("flags invalid mutability value", () => {
    const content = fm("kind: identity\nauthority: user\nmutability: locked");
    const result = parseVaultFrontmatter(content, "identity/profile.md");
    const advisory = result.advisories.find((a) => a.code === "invalid_mutability");
    expect(advisory).toBeDefined();
    expect(result.values.mutability).toBeUndefined();
  });

  it("flags invalid slug pattern", () => {
    const content = fm(
      "kind: identity\nauthority: user\nmutability: replace\nslug: Bad_Slug",
    );
    const result = parseVaultFrontmatter(content, "identity/profile.md");
    const advisory = result.advisories.find((a) => a.code === "invalid_slug");
    expect(advisory).toBeDefined();
    expect(result.values.slug).toBeUndefined();
  });

  it("supports legacy paths during transition", () => {
    // Pre-migration path; still scoped for advisory.
    const content = fm("kind: identity\nauthority: user\nmutability: replace");
    const result = parseVaultFrontmatter(content, "user/profile.md");
    // user/ → identity/ alias; advisory mismatches because not yet migrated.
    const advisory = result.advisories.find(
      (a) => a.code === "kind_path_mismatch",
    );
    expect(advisory).toBeDefined();
  });

  it("accepts loose top-level files", () => {
    expect(shouldParseVaultFrontmatter("today.md")).toBe(true);
    expect(shouldParseVaultFrontmatter("yesterday.md")).toBe(true);
    expect(shouldParseVaultFrontmatter("roadmap.md")).toBe(true);
  });

  it("rejects paths outside scope", () => {
    expect(shouldParseVaultFrontmatter("random.md")).toBe(false);
    expect(shouldParseVaultFrontmatter("identity/_index.md")).toBe(false);
    expect(shouldParseVaultFrontmatter("identity/profile.txt")).toBe(false);
  });
});

describe("VAULT_FRONTMATTER enum exports", () => {
  it("kinds align with the six-class layout", () => {
    expect(VAULT_FRONTMATTER_KINDS).toEqual([
      "identity",
      "state",
      "plan",
      "journal",
      "knowledge",
      "policy",
    ]);
  });

  it("authorities are user/agent/mixed", () => {
    expect(VAULT_FRONTMATTER_AUTHORITIES).toEqual(["user", "agent", "mixed"]);
  });

  it("mutability matches the §5.3 contract", () => {
    expect(VAULT_FRONTMATTER_MUTABILITIES).toEqual([
      "replace",
      "patch",
      "append",
      "readonly",
    ]);
  });
});
