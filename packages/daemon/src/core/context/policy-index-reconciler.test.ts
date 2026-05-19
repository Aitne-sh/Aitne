import { describe, expect, it } from "vitest";
import {
  bucketPolicies,
  extractActivePoliciesSection,
  renderActivePoliciesSection,
  renderPolicyIndex,
  upsertManagementRulesActivePolicies,
  type PolicySnapshotEntry,
} from "./policy-index-reconciler.js";

const ACTIVE: PolicySnapshotEntry = {
  slug: "morning-finance",
  status: "active",
  cadence: "0 7 * * *",
  linkedRoutine: "morning-finance",
  linkedDossier: "finance",
  why: "Daily Moneytree balance and transactions snapshot.",
  createdAt: "2026-04-01",
  removedAt: null,
};

const PAUSED: PolicySnapshotEntry = {
  slug: "weekly-review",
  status: "paused",
  cadence: "0 18 * * 0",
  linkedRoutine: "weekly-review",
  linkedDossier: null,
  why: "Sunday weekly hand-off — paused while traveling.",
  createdAt: "2026-03-15",
  removedAt: null,
};

const REMOVED_OLD: PolicySnapshotEntry = {
  slug: "old-thing",
  status: "removed",
  cadence: null,
  linkedRoutine: null,
  linkedDossier: null,
  why: "Merged into morning-finance.",
  createdAt: "2026-02-01",
  removedAt: "2026-04-10",
};

const REMOVED_RECENT: PolicySnapshotEntry = {
  ...REMOVED_OLD,
  slug: "newer-thing",
  removedAt: "2026-04-20",
  why: "User said stop.",
};

describe("bucketPolicies", () => {
  it("splits by status and sorts active/paused by slug", () => {
    const buckets = bucketPolicies([PAUSED, ACTIVE]);
    expect(buckets.active.map((p) => p.slug)).toEqual(["morning-finance"]);
    expect(buckets.paused.map((p) => p.slug)).toEqual(["weekly-review"]);
    expect(buckets.removed).toEqual([]);
  });

  it("orders removed by removedAt descending then slug", () => {
    const buckets = bucketPolicies([REMOVED_OLD, REMOVED_RECENT]);
    expect(buckets.removed.map((p) => p.slug)).toEqual([
      "newer-thing",
      "old-thing",
    ]);
  });

  it("orders a null-removedAt removed entry below dated ones (defensive `?? \"\"` branch)", () => {
    // Defensive: status=removed should always carry a removedAt, but a
    // malformed snapshot (frontmatter missing `updated:`) would arrive
    // with removedAt=null. The comparator's `?? ""` short-circuit treats
    // null as an empty string, sorting it last in descending order.
    const dated: PolicySnapshotEntry = {
      ...REMOVED_OLD,
      slug: "dated",
      removedAt: "2026-04-15",
    };
    const nullDate: PolicySnapshotEntry = {
      ...REMOVED_OLD,
      slug: "nodate",
      removedAt: null,
    };
    // Pass a sort of 3 to force comparator calls with both directions
    // so the `?? ""` nullish-coalesce on each side hits both branches.
    const anotherDated: PolicySnapshotEntry = {
      ...REMOVED_OLD,
      slug: "more-dated",
      removedAt: "2026-04-25",
    };
    // Order matters for branch coverage: with nullDate at the END,
    // V8's insertion sort eventually calls comparator(nullDate, dated)
    // — `a.removedAt ?? ""` then takes its right branch (line 81).
    // With nullDate at the FRONT in a separate pass, the same applies
    // to `b.removedAt ?? ""` (line 82).
    const tailFirst = bucketPolicies([dated, anotherDated, nullDate]);
    expect(tailFirst.removed.map((p) => p.slug)).toEqual([
      "more-dated",
      "dated",
      "nodate",
    ]);
    const headFirst = bucketPolicies([nullDate, dated, anotherDated]);
    expect(headFirst.removed.map((p) => p.slug)).toEqual([
      "more-dated",
      "dated",
      "nodate",
    ]);
  });

  it("falls back to slug ordering when two removed entries share a removedAt", () => {
    // When two removed policies share the same removedAt timestamp, the
    // sort comparator must tiebreak by slug ascending — not preserve
    // insertion order. This pins line 84 of the comparator.
    const sameDay = "2026-04-22";
    const z: PolicySnapshotEntry = {
      ...REMOVED_OLD,
      slug: "z-removed",
      removedAt: sameDay,
    };
    const a: PolicySnapshotEntry = {
      ...REMOVED_OLD,
      slug: "a-removed",
      removedAt: sameDay,
    };
    // Pass z first to verify that the comparator (not insertion order)
    // yields a-removed → z-removed.
    const buckets = bucketPolicies([z, a]);
    expect(buckets.removed.map((p) => p.slug)).toEqual([
      "a-removed",
      "z-removed",
    ]);
  });
});

describe("renderPolicyIndex", () => {
  it("renders frontmatter, active table, removed table", () => {
    const buckets = bucketPolicies([ACTIVE, PAUSED, REMOVED_OLD]);
    const rendered = renderPolicyIndex(buckets, "2026-04-25");
    expect(rendered).toContain("type: index");
    expect(rendered).toContain("owner: agent");
    expect(rendered).toContain("updated: 2026-04-25");
    expect(rendered).toContain("# Policy index");
    expect(rendered).toContain("## Active");
    expect(rendered).toContain("## Removed");
    expect(rendered).toContain("| morning-finance | active | `0 7 * * *` |");
    expect(rendered).toContain("| weekly-review | paused | `0 18 * * 0` |");
    expect(rendered).toContain("| old-thing | 2026-04-10 |");
  });

  it("emits an empty active table when nothing active or paused", () => {
    const buckets = bucketPolicies([]);
    const rendered = renderPolicyIndex(buckets, "2026-04-25");
    expect(rendered).toMatch(/## Active\n\n\| Slug \|.+\|\n\|---\|/);
    expect(rendered).toMatch(/## Removed\n\n\| Slug \|/);
  });

  it("escapes pipe characters in why cells", () => {
    const tricky: PolicySnapshotEntry = {
      ...ACTIVE,
      slug: "tricky",
      why: "Logs balance | transactions to dossier.",
    };
    const buckets = bucketPolicies([tricky]);
    const rendered = renderPolicyIndex(buckets, "2026-04-25");
    expect(rendered).toContain("Logs balance \\| transactions");
  });

  it("renders em-dash for a removed entry with null removedAt and empty why", () => {
    // Defensive: a removed snapshot whose frontmatter lacked `updated:` and
    // whose body had no `## Why` section. The Removed table must render
    // em-dashes for both the date column AND the why column instead of
    // crashing.
    const broken: PolicySnapshotEntry = {
      slug: "broken",
      status: "removed",
      cadence: null,
      linkedRoutine: null,
      linkedDossier: null,
      why: "   ", // whitespace-only -> escapeCell returns EM_DASH
      createdAt: "2026-01-01",
      removedAt: null,
    };
    const buckets = bucketPolicies([broken]);
    const rendered = renderPolicyIndex(buckets, "2026-04-25");
    expect(rendered).toContain("| broken | — | — |");
  });

  it("renders em-dash for missing linked fields", () => {
    const minimal: PolicySnapshotEntry = {
      slug: "passive",
      status: "active",
      cadence: null,
      linkedRoutine: null,
      linkedDossier: null,
      why: "Triggered when DM matches X.",
      createdAt: "2026-04-25",
      removedAt: null,
    };
    const buckets = bucketPolicies([minimal]);
    const rendered = renderPolicyIndex(buckets, "2026-04-25");
    expect(rendered).toContain("| passive | active | — | — | — |");
  });
});

describe("renderActivePoliciesSection", () => {
  it("renders the management.md section with shorter columns", () => {
    const buckets = bucketPolicies([ACTIVE, PAUSED]);
    const section = renderActivePoliciesSection(buckets);
    expect(section.startsWith("## Active Policies\n")).toBe(true);
    expect(section).toContain("Auto-maintained by the daemon");
    expect(section).toContain("[[rules/policies/_index.md]]");
    expect(section).toContain("| Slug | Status | Cadence | Why |");
    expect(section).toContain(
      "| morning-finance | active | `0 7 * * *` | Daily Moneytree balance and transactions snapshot. |",
    );
    expect(section).not.toContain("Linked routine");
  });

  it("renders an empty-state message when no active or paused policies", () => {
    const section = renderActivePoliciesSection(bucketPolicies([]));
    expect(section).toContain("_No active policies yet._");
    expect(section).not.toContain("| Slug |");
  });

  it("ignores removed policies in the rendered section", () => {
    const section = renderActivePoliciesSection(
      bucketPolicies([REMOVED_OLD]),
    );
    expect(section).toContain("_No active policies yet._");
  });
});

describe("upsertManagementRulesActivePolicies", () => {
  const SECTION = "## Active Policies\n\n_No active policies yet._";
  const NEW_SECTION = "## Active Policies\n\n| Slug | Status |\n|---|---|\n| a | active |";

  it("returns just the section when content is empty", () => {
    expect(upsertManagementRulesActivePolicies("", SECTION)).toBe(
      `${SECTION}\n`,
    );
  });

  it("appends at the end when no Active Policies section exists", () => {
    const before = "# Management rules\n\n## Source of Truth\n\nbody\n";
    const result = upsertManagementRulesActivePolicies(before, SECTION);
    expect(result.endsWith(`\n\n${SECTION}\n`)).toBe(true);
    expect(result).toContain("## Source of Truth");
  });

  it("replaces an existing section in place", () => {
    const before =
      "# Management rules\n\n## Active Policies\n\nold body\n\n## Notes\n\nx\n";
    const result = upsertManagementRulesActivePolicies(before, NEW_SECTION);
    expect(result).toContain(NEW_SECTION);
    expect(result).not.toContain("old body");
    // Notes section is preserved
    expect(result).toContain("## Notes");
    expect(result).toContain("\nx\n");
  });

  it("preserves earlier sections verbatim", () => {
    const before =
      "# Management rules\n\nintro paragraph\n\n## Source of Truth\n\n| col |\n|---|\n| row |\n";
    const result = upsertManagementRulesActivePolicies(before, SECTION);
    expect(result).toContain("intro paragraph");
    expect(result).toContain("| row |");
  });

  it("is idempotent over multiple applications", () => {
    const before = "# Management rules\n\n## Notes\n\nx\n";
    const once = upsertManagementRulesActivePolicies(before, SECTION);
    const twice = upsertManagementRulesActivePolicies(once, SECTION);
    expect(twice).toBe(once);
  });

  it("places the section flush at the start when the section is the only H2", () => {
    // Existing content opens with the Active Policies section itself
    // (no preceding heading or paragraph). The splice yields an empty
    // `before`, hitting the `before ? … : ""` false branch on the
    // `beforePart` ternary.
    const before = "## Active Policies\n\nold body\n";
    const result = upsertManagementRulesActivePolicies(before, NEW_SECTION);
    expect(result.startsWith(NEW_SECTION)).toBe(true);
    expect(result).not.toContain("old body");
  });

  it("ends with exactly one trailing newline", () => {
    const before = "# Management rules\n\n## Notes\n\nx\n";
    const result = upsertManagementRulesActivePolicies(before, SECTION);
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
  });
});

describe("extractActivePoliciesSection", () => {
  it("returns null when the section is absent", () => {
    const content = "# Management rules\n\n## Notes\n\nx\n";
    expect(extractActivePoliciesSection(content)).toBeNull();
  });

  it("returns the section text up to the next H2", () => {
    const content =
      "# Management rules\n\n## Active Policies\n\n| a |\n|---|\n| b |\n\n## Notes\n\nz\n";
    const extracted = extractActivePoliciesSection(content);
    expect(extracted).toContain("## Active Policies");
    expect(extracted).toContain("| b |");
    expect(extracted).not.toContain("## Notes");
  });

  it("returns the section even when at end of file", () => {
    const content = "# Management rules\n\n## Active Policies\n\nbody\n";
    const extracted = extractActivePoliciesSection(content);
    expect(extracted).toContain("## Active Policies");
    expect(extracted).toContain("body");
  });
});
