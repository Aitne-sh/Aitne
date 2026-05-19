import { describe, expect, it } from "vitest";
import {
  wikiBridgeProposalSchema,
  wikiFilePatchSchema,
  wikiWorkspaceCreateSchema,
  wikiWorkspacePatchSchema,
  wikiWorkspaceProbeSchema,
} from "./wiki.js";

describe("wikiWorkspaceCreateSchema", () => {
  it("defaults kind to 'internal' when omitted", () => {
    const result = wikiWorkspaceCreateSchema.parse({});
    expect(result.kind).toBe("internal");
    expect(result.rootPath).toBeUndefined();
  });

  it("accepts internal mode without a rootPath", () => {
    expect(() =>
      wikiWorkspaceCreateSchema.parse({ kind: "internal", name: "scratch" }),
    ).not.toThrow();
  });

  it("rejects external mode without a rootPath", () => {
    const parsed = wikiWorkspaceCreateSchema.safeParse({ kind: "external" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) =>
        i.path.includes("rootPath"),
      );
      expect(issue?.message).toBe("rootPath is required for external mode");
    }
  });

  it("accepts external mode with a rootPath", () => {
    const result = wikiWorkspaceCreateSchema.parse({
      kind: "external",
      rootPath: "/Users/me/wiki",
    });
    expect(result.kind).toBe("external");
    expect(result.rootPath).toBe("/Users/me/wiki");
  });
});

describe("wikiWorkspacePatchSchema", () => {
  it("requires at least one field", () => {
    const parsed = wikiWorkspacePatchSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("accepts a single-field patch", () => {
    expect(() =>
      wikiWorkspacePatchSchema.parse({ language: "ja" }),
    ).not.toThrow();
  });
});

describe("wikiWorkspaceProbeSchema", () => {
  it("requires rootPath", () => {
    expect(wikiWorkspaceProbeSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a valid rootPath", () => {
    expect(
      wikiWorkspaceProbeSchema.parse({ rootPath: "/tmp/wiki" }).rootPath,
    ).toBe("/tmp/wiki");
  });
});

describe("wikiFilePatchSchema", () => {
  it("rejects empty content", () => {
    expect(
      wikiFilePatchSchema.safeParse({ mode: "append", content: "" }).success,
    ).toBe(false);
  });

  it("accepts append and prepend modes", () => {
    expect(() =>
      wikiFilePatchSchema.parse({ mode: "append", content: "x" }),
    ).not.toThrow();
    expect(() =>
      wikiFilePatchSchema.parse({ mode: "prepend", content: "x" }),
    ).not.toThrow();
  });
});

describe("wikiBridgeProposalSchema", () => {
  it("accepts a minimal explicit proposal", () => {
    const parsed = wikiBridgeProposalSchema.parse({
      trigger: "explicit",
      summary: "Insight",
      excerpt: "Source line.",
      sourceKind: "dm",
      sourceRef: "msg-1",
    });
    expect(parsed.trigger).toBe("explicit");
    expect(parsed.confidence).toBeUndefined();
  });

  it("rejects confidence outside 0–1", () => {
    const tooHigh = wikiBridgeProposalSchema.safeParse({
      trigger: "self_judged",
      summary: "x",
      excerpt: "y",
      sourceKind: "dm",
      sourceRef: "m",
      confidence: 1.5,
    });
    expect(tooHigh.success).toBe(false);
  });
});
