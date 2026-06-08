import { describe, expect, it } from "vitest";

import {
  formatScope,
  parseScope,
  scopeKey,
  scopeNeedsRef,
  scopeSectionSlug,
  scopeStoreFile,
  type CanonicalScope,
} from "./scope-parser.js";

describe("scope-parser", () => {
  describe("parseScope", () => {
    it("parses ref-less scopes", () => {
      expect(parseScope("user", null)).toEqual({ kind: "user" });
      expect(parseScope("agent", undefined)).toEqual({ kind: "agent" });
      // A stray ref on a ref-less scope is ignored.
      expect(parseScope("user", "ignored")).toEqual({ kind: "user" });
    });

    it("parses ref-required scopes when the ref is present", () => {
      expect(parseScope("agent_slug", "report-writer")).toEqual({
        kind: "agent_slug",
        ref: "report-writer",
      });
      expect(parseScope("channel", "slack")).toEqual({
        kind: "channel",
        ref: "slack",
      });
      expect(parseScope("task", "morning_routine")).toEqual({
        kind: "task",
        ref: "morning_routine",
      });
      expect(parseScope("integration", "gmail")).toEqual({
        kind: "integration",
        ref: "gmail",
      });
    });

    it("trims surrounding whitespace from the ref", () => {
      expect(parseScope("agent_slug", "  report-writer  ")).toEqual({
        kind: "agent_slug",
        ref: "report-writer",
      });
    });

    it("returns null when a ref-required scope is missing its ref", () => {
      expect(parseScope("agent_slug", null)).toBeNull();
      expect(parseScope("agent_slug", "   ")).toBeNull();
      expect(parseScope("channel", undefined)).toBeNull();
      expect(parseScope("task", "")).toBeNull();
      expect(parseScope("integration", null)).toBeNull();
    });

    it("returns null for an unknown scope type", () => {
      expect(parseScope("bogus", "x")).toBeNull();
    });
  });

  describe("formatScope", () => {
    const cases: Array<[CanonicalScope, string]> = [
      [{ kind: "user" }, "user"],
      [{ kind: "agent" }, "agent"],
      [{ kind: "agent_slug", ref: "report-writer" }, "agent:report-writer"],
      [{ kind: "channel", ref: "slack" }, "channel:slack"],
      [{ kind: "task", ref: "morning_routine" }, "task:morning_routine"],
      [{ kind: "integration", ref: "gmail" }, "integration:gmail"],
    ];
    it.each(cases)("formats %j as %s", (scope, label) => {
      expect(formatScope(scope)).toBe(label);
    });
  });

  it("scopeKey equals formatScope", () => {
    const scope: CanonicalScope = { kind: "agent_slug", ref: "x" };
    expect(scopeKey(scope)).toBe(formatScope(scope));
  });

  describe("scopeStoreFile", () => {
    it("maps stored scopes to vault paths", () => {
      expect(scopeStoreFile({ kind: "user" })).toBe("identity/profile.md");
      expect(scopeStoreFile({ kind: "agent" })).toBe(
        "policies/agent-lessons.md",
      );
      expect(scopeStoreFile({ kind: "agent_slug", ref: "report-writer" })).toBe(
        "policies/agents/report-writer/lessons.md",
      );
    });

    it("returns null for v2 scopes not yet stored", () => {
      expect(scopeStoreFile({ kind: "channel", ref: "slack" })).toBeNull();
      expect(scopeStoreFile({ kind: "task", ref: "x" })).toBeNull();
      expect(scopeStoreFile({ kind: "integration", ref: "gmail" })).toBeNull();
    });
  });

  describe("scopeSectionSlug", () => {
    it("uses learned_context for user, lessons otherwise", () => {
      expect(scopeSectionSlug({ kind: "user" })).toBe("learned_context");
      expect(scopeSectionSlug({ kind: "agent" })).toBe("lessons");
      expect(scopeSectionSlug({ kind: "agent_slug", ref: "x" })).toBe(
        "lessons",
      );
    });
  });

  describe("scopeNeedsRef", () => {
    it("flags ref-required scope types", () => {
      expect(scopeNeedsRef("agent_slug")).toBe(true);
      expect(scopeNeedsRef("channel")).toBe(true);
      expect(scopeNeedsRef("task")).toBe(true);
      expect(scopeNeedsRef("integration")).toBe(true);
      expect(scopeNeedsRef("user")).toBe(false);
      expect(scopeNeedsRef("agent")).toBe(false);
    });
  });
});
