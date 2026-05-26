import { describe, it, expect } from "vitest";
import {
  bucketByDomain,
  entityDirToDomain,
  formatLastTouched,
  formatSources,
  isDomainIndexPath,
  relativeDomainIndexPath,
  renderDomainIndex,
  type DomainIndexEntityInput,
} from "./domain-index-reconciler.js";

/**
 * docs/design/21-management-registry-and-entities.md §17 — pure-logic
 * tests for the domain-index reconciler. Coverage gate requires 100%
 * (vitest.config.ts curated set).
 */

const E_FOO: DomainIndexEntityInput = {
  path: "work/meetings/2026-12-04-foo.md",
  domain: "work",
  type: "meeting",
  title: "Foo 1on1",
  status: "upcoming",
  date: "2026-12-04",
  lastSyncedAt: "2026-12-04T10:00:00Z",
  sourceKeys: ["zoom"],
};

const E_ARCHIVED: DomainIndexEntityInput = {
  path: "work/meetings/2025-08-old.md",
  domain: "work",
  type: "meeting",
  title: "Old | risky title", // pipe must escape
  status: "archived",
  date: "2025-08-01",
  lastSyncedAt: null,
  sourceKeys: ["docs", "zoom"],
};

const E_PROJECT: DomainIndexEntityInput = {
  path: "work/projects/acme.md",
  domain: "work",
  type: "project",
  title: "Acme renewal",
  status: "active",
  date: null,
  lastSyncedAt: "2026-12-03T10:00:00Z",
  sourceKeys: ["notion"],
};

describe("bucketByDomain", () => {
  it("returns one bucket per known domain (empty when no rows)", () => {
    const result = bucketByDomain([]);
    expect(result.byDomain.get("work")).toEqual([]);
    expect(result.byDomain.get("travel")).toEqual([]);
    expect(result.byDomain.get("personal")).toEqual([]);
  });

  it("groups by domain field", () => {
    const result = bucketByDomain([E_FOO, E_PROJECT]);
    expect(result.byDomain.get("work")).toHaveLength(2);
    expect(result.byDomain.get("personal")).toEqual([]);
  });

  it("orders by status, then date desc, then path", () => {
    const result = bucketByDomain([E_ARCHIVED, E_FOO, E_PROJECT]);
    const work = result.byDomain.get("work")!;
    expect(work.map((e) => e.path)).toEqual([
      "work/meetings/2026-12-04-foo.md", // upcoming
      "work/projects/acme.md",            // active
      "work/meetings/2025-08-old.md",     // archived
    ]);
  });

  it("falls back to lastSyncedAt for the date sort key", () => {
    const a: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/a.md",
      date: null,
      lastSyncedAt: "2026-11-01T00:00:00Z",
    };
    const b: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/b.md",
      date: null,
      lastSyncedAt: "2026-12-01T00:00:00Z",
    };
    const work = bucketByDomain([a, b]).byDomain.get("work")!;
    expect(work.map((e) => e.path)).toEqual([
      "work/meetings/b.md",
      "work/meetings/a.md",
    ]);
  });

  it("treats unknown statuses as the middle precedence", () => {
    const a: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/a.md",
      status: "weird",
      date: "2026-12-01",
    };
    const b: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/b.md",
      status: null,
      date: "2026-12-02",
    };
    const c: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/c.md",
      status: "done",
      date: "2026-12-03",
    };
    const work = bucketByDomain([c, a, b]).byDomain.get("work")!;
    expect(work.map((e) => e.path)).toEqual([
      "work/meetings/b.md", // null → 2 (middle)
      "work/meetings/a.md", // unknown → 2 (middle)
      "work/meetings/c.md", // done → 3
    ]);
  });

  it("uses path as the final tiebreaker", () => {
    const a: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/a.md",
    };
    const b: DomainIndexEntityInput = {
      ...E_FOO,
      path: "work/meetings/b.md",
    };
    const work = bucketByDomain([b, a]).byDomain.get("work")!;
    expect(work.map((e) => e.path)).toEqual([
      "work/meetings/a.md",
      "work/meetings/b.md",
    ]);
  });
});

describe("formatLastTouched", () => {
  it("prefers date over lastSyncedAt", () => {
    expect(formatLastTouched(E_FOO)).toBe("2026-12-04");
  });
  it("falls back to lastSyncedAt sliced to ISO date", () => {
    expect(formatLastTouched(E_PROJECT)).toBe("2026-12-03");
  });
  it("returns em-dash when neither is set", () => {
    const e: DomainIndexEntityInput = {
      ...E_FOO,
      date: null,
      lastSyncedAt: null,
    };
    expect(formatLastTouched(e)).toBe("—");
  });
});

describe("formatSources", () => {
  it("joins keys with +", () => {
    expect(formatSources(["zoom", "docs"])).toBe("zoom+docs");
  });
  it("returns em-dash for empty input", () => {
    expect(formatSources([])).toBe("—");
  });
});

describe("renderDomainIndex", () => {
  const updated = "2026-12-05T00:00:00Z";

  it("renders the §9.7 layout", () => {
    const out = renderDomainIndex(
      "work",
      [E_FOO, E_PROJECT, E_ARCHIVED],
      updated,
    );
    expect(out).toMatchInlineSnapshot(`
      "---
      type: index
      domain: work
      auto_generated: true
      last_built: 2026-12-05T00:00:00Z
      ---
      # Work — Index

      ## Active items

      | Title | Type | Sources | Status | Last touched |
      |---|---|---|---|---|
      | Foo 1on1 | meeting | zoom | upcoming | 2026-12-04 |
      | Acme renewal | project | notion | active | 2026-12-03 |
      | Old \\| risky title | meeting | docs+zoom | archived | 2025-08-01 |
      "
    `);
  });

  it("emits a placeholder row when the bucket is empty", () => {
    const out = renderDomainIndex("travel", [], updated);
    expect(out).toContain("| — | — | — | — | — |");
  });

  it("escapes pipe characters in titles", () => {
    const out = renderDomainIndex("work", [E_ARCHIVED], updated);
    expect(out).toContain("Old \\| risky title");
  });

  it("renders byte-identical output across calls (determinism)", () => {
    const a = renderDomainIndex("work", [E_FOO, E_PROJECT], updated);
    const b = renderDomainIndex("work", [E_FOO, E_PROJECT], updated);
    expect(a).toBe(b);
  });

  it("handles entities with completely empty cells", () => {
    const e: DomainIndexEntityInput = {
      path: "work/meetings/empty.md",
      domain: "work",
      type: "meeting",
      title: "",
      status: null,
      date: null,
      lastSyncedAt: null,
      sourceKeys: [],
    };
    const out = renderDomainIndex("work", [e], updated);
    // Empty title collapses to em-dash; status renders the literal em-dash.
    expect(out).toContain("| — | meeting | — | — | — |");
  });
});

describe("path helpers", () => {
  it("relativeDomainIndexPath builds knowledge/entities/<domain>/_index.md", () => {
    expect(relativeDomainIndexPath("work")).toBe(
      "knowledge/entities/work/_index.md",
    );
  });

  it("isDomainIndexPath accepts canonical, rejects malformed", () => {
    expect(isDomainIndexPath("knowledge/entities/work/_index.md")).toBe(true);
    // Wrong root.
    expect(isDomainIndexPath("policies/_index.md")).toBe(false);
    // Domain not in the enum.
    expect(isDomainIndexPath("knowledge/entities/bogus/_index.md")).toBe(false);
    // Wrong depth (typePlural subindex).
    expect(
      isDomainIndexPath("knowledge/entities/work/meetings/_index.md"),
    ).toBe(false);
    // Wrong basename.
    expect(isDomainIndexPath("knowledge/entities/work/main.md")).toBe(false);
  });

  it("entityDirToDomain validates both segments", () => {
    expect(entityDirToDomain("work/meetings")).toBe("work");
    expect(entityDirToDomain("work/notreal")).toBeNull();
    expect(entityDirToDomain("bogus/meetings")).toBeNull();
    expect(entityDirToDomain("work")).toBeNull();
    expect(entityDirToDomain("a/b/c")).toBeNull();
  });
});
