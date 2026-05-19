import { describe, expect, it } from "vitest";
import {
  containsDecisionLanguage,
  noDecisionLanguage,
  noEmbeddedMarkers,
} from "./decision-language.js";

describe("containsDecisionLanguage", () => {
  it("rejects when/then constructions", () => {
    expect(containsDecisionLanguage("when user mentions X then write Y")).toBe(true);
  });

  it("rejects if/do constructions", () => {
    expect(containsDecisionLanguage("if a goal is set do append it")).toBe(true);
  });

  it("rejects before/should constructions", () => {
    expect(containsDecisionLanguage("before saving a doc you should validate")).toBe(true);
  });

  it("rejects bare must/always/never", () => {
    expect(containsDecisionLanguage("entries must be sorted")).toBe(true);
    expect(containsDecisionLanguage("always include the date")).toBe(true);
    expect(containsDecisionLanguage("never delete files")).toBe(true);
  });

  it("accepts descriptive prose", () => {
    expect(containsDecisionLanguage("All entries follow the [YYYY-MM-DD] prefix")).toBe(false);
    expect(containsDecisionLanguage("Date entries are written as [YYYY-MM-DD]")).toBe(false);
    expect(containsDecisionLanguage("Slugs are kebab-case, no leading digits")).toBe(false);
    expect(containsDecisionLanguage("user/profile.md owns identity facts")).toBe(false);
  });

  it("noDecisionLanguage is the negation", () => {
    expect(noDecisionLanguage("must do X")).toBe(false);
    expect(noDecisionLanguage("kebab-case slugs")).toBe(true);
  });
});

describe("noEmbeddedMarkers", () => {
  it("rejects CURATION anchors", () => {
    expect(noEmbeddedMarkers("text <!-- CURATION:routing_table id=\"x\" --> more")).toBe(false);
  });

  it("rejects safety/mode/integration_modes/today_write_lock_id markers", () => {
    expect(noEmbeddedMarkers("<!-- safety:approve -->")).toBe(false);
    expect(noEmbeddedMarkers("<!-- mode:direct:gmail -->")).toBe(false);
    expect(noEmbeddedMarkers("<integration_modes>foo</integration_modes>")).toBe(false);
    expect(noEmbeddedMarkers("<!-- today_write_lock_id=42 -->")).toBe(false);
  });

  it("accepts plain prose", () => {
    expect(noEmbeddedMarkers("a perfectly normal sentence")).toBe(true);
    expect(noEmbeddedMarkers("comments like <!-- foo --> are fine outside the marker set")).toBe(true);
  });
});
