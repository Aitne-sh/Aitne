import { describe, it, expect } from "vitest";
import { deriveFooterVisibility } from "./docs-content-footer";

describe("deriveFooterVisibility", () => {
  it("hides everything while the tree query is still fetching, even when related slugs exist", () => {
    expect(
      deriveFooterVisibility({
        treeIsFetched: false,
        hasPrev: true,
        hasNext: true,
        relatedCount: 3,
      }),
    ).toEqual({ showNeighbors: false, showRelated: false });
  });

  it("shows neighbors and related once the tree is fetched and the inputs warrant", () => {
    expect(
      deriveFooterVisibility({
        treeIsFetched: true,
        hasPrev: true,
        hasNext: false,
        relatedCount: 1,
      }),
    ).toEqual({ showNeighbors: true, showRelated: true });
  });

  it("hides the related section when no related slugs are listed", () => {
    expect(
      deriveFooterVisibility({
        treeIsFetched: true,
        hasPrev: false,
        hasNext: true,
        relatedCount: 0,
      }),
    ).toEqual({ showNeighbors: true, showRelated: false });
  });

  it("hides the neighbors row when both prev and next are absent", () => {
    expect(
      deriveFooterVisibility({
        treeIsFetched: true,
        hasPrev: false,
        hasNext: false,
        relatedCount: 2,
      }),
    ).toEqual({ showNeighbors: false, showRelated: true });
  });

  it("returns false-false on a doc with no neighbors and no related — caller renders nothing", () => {
    expect(
      deriveFooterVisibility({
        treeIsFetched: true,
        hasPrev: false,
        hasNext: false,
        relatedCount: 0,
      }),
    ).toEqual({ showNeighbors: false, showRelated: false });
  });
});
