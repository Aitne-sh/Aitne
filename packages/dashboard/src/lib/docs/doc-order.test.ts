import { describe, it, expect } from "vitest";
import {
  CATEGORY_ORDER,
  SECTION_ORDER,
  flattenDocOrder,
  orderIndex,
  prevNext,
} from "./doc-order";
import type { DocsTreeItem } from "@/lib/api-types";

function doc(
  slug: string,
  overrides?: Partial<DocsTreeItem>,
): DocsTreeItem {
  const segments = slug.split("/");
  const category = segments[0]!;
  const section =
    segments.length > 2 ? segments[1]! : null;
  return {
    slug,
    title: slug,
    category,
    section,
    status: null,
    summary: "",
    ...overrides,
  };
}

describe("orderIndex", () => {
  it("returns the index of a known key", () => {
    expect(orderIndex(["a", "b", "c"], "b")).toBe(1);
  });
  it("returns past-the-end for unknown keys", () => {
    expect(orderIndex(["a", "b"], "z")).toBe(2);
  });
});

describe("CATEGORY_ORDER / SECTION_ORDER (sanity)", () => {
  it("includes all 7 top-level categories", () => {
    expect(CATEGORY_ORDER).toEqual([
      "getting-started",
      "concepts",
      "features",
      "guides",
      "troubleshooting",
      "reference",
      "glossary",
    ]);
  });
  it("declares features sections in design order", () => {
    expect(SECTION_ORDER.features).toEqual([
      "routines",
      "memory-files",
      "integrations",
      "messaging",
      "lifestyle",
      "operations",
    ]);
  });
});

describe("flattenDocOrder", () => {
  it("orders by category > section > slug", () => {
    const result = flattenDocOrder([
      doc("glossary"),
      doc("getting-started/01-what-is-this"),
      doc("concepts/agent-day"),
      doc("features/routines/morning-routine"),
      doc("features/memory-files/today"),
      doc("features/routines/evening-review"),
    ]);
    expect(result.map((d) => d.slug)).toEqual([
      "getting-started/01-what-is-this",
      "concepts/agent-day",
      // features → routines section first (per SECTION_ORDER), then
      // memory-files; within routines the lex order is evening-review
      // before morning-routine.
      "features/routines/evening-review",
      "features/routines/morning-routine",
      "features/memory-files/today",
      "glossary",
    ]);
  });

  it("falls back to lex when sections are unknown", () => {
    const result = flattenDocOrder([
      doc("guides/zzz"),
      doc("guides/aaa"),
      doc("guides/mmm"),
    ]);
    expect(result.map((d) => d.slug)).toEqual([
      "guides/aaa",
      "guides/mmm",
      "guides/zzz",
    ]);
  });

  it("places untyped (no-section) docs before sub-grouped ones in a category", () => {
    const result = flattenDocOrder([
      doc("features/routines/morning-routine"),
      doc("features/overview", { section: null }),
    ]);
    expect(result.map((d) => d.slug)).toEqual([
      "features/overview",
      "features/routines/morning-routine",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [doc("glossary"), doc("concepts/agent-day")];
    const before = input.map((d) => d.slug);
    flattenDocOrder(input);
    expect(input.map((d) => d.slug)).toEqual(before);
  });
});

describe("prevNext", () => {
  const ordered = flattenDocOrder([
    doc("getting-started/01-what-is-this"),
    doc("concepts/agent-day"),
    doc("features/routines/morning-routine"),
  ]);

  it("returns the linear neighbors", () => {
    expect(prevNext(ordered, "concepts/agent-day")).toEqual({
      prev: ordered[0],
      next: ordered[2],
    });
  });

  it("returns prev=null at the start of the corpus", () => {
    expect(prevNext(ordered, "getting-started/01-what-is-this")).toEqual({
      prev: null,
      next: ordered[1],
    });
  });

  it("returns next=null at the end of the corpus", () => {
    expect(prevNext(ordered, "features/routines/morning-routine")).toEqual({
      prev: ordered[1],
      next: null,
    });
  });

  it("returns both null when the slug is null or not in the corpus", () => {
    expect(prevNext(ordered, null)).toEqual({ prev: null, next: null });
    expect(prevNext(ordered, "nonexistent")).toEqual({ prev: null, next: null });
  });
});
