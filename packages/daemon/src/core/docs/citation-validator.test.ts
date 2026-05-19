import { describe, it, expect } from "vitest";
import {
  createStreamingValidator,
  validateAndRewrite,
  type DocsCitationLookup,
} from "./citation-validator.js";

function makeStubLookup(
  rows: Record<string, string[]>,
): DocsCitationLookup {
  return {
    anchorsForSlug(slug: string) {
      return rows[slug] ?? null;
    },
  };
}

describe("validateAndRewrite", () => {
  const lookup = makeStubLookup({
    "features/routines/morning-routine": ["in-one-sentence", "what-it-does", "what-it-outputs"],
    "concepts/agent-day": ["tldr", "definitions"],
    glossary: ["agent-day", "tier"],
  });

  it("forwards a fully valid citation unchanged", () => {
    const out = validateAndRewrite(
      "Morning routine produces today.md [doc:features/routines/morning-routine#what-it-outputs].",
      lookup,
    );
    expect(out.text).toBe(
      "Morning routine produces today.md [doc:features/routines/morning-routine#what-it-outputs].",
    );
    expect(out.validCount).toBe(1);
    expect(out.anchorMissing).toEqual([]);
    expect(out.slugMissing).toEqual([]);
  });

  it("rewrites an unknown anchor to slug-only", () => {
    const out = validateAndRewrite(
      "See [doc:features/routines/morning-routine#hallucinated-anchor] for more.",
      lookup,
    );
    expect(out.text).toBe("See [doc:features/routines/morning-routine] for more.");
    expect(out.anchorMissing).toEqual([
      {
        slug: "features/routines/morning-routine",
        anchor: "hallucinated-anchor",
      },
    ]);
    expect(out.validCount).toBe(0);
  });

  it("strips a citation whose slug is unknown", () => {
    const out = validateAndRewrite(
      "Per [doc:not/a/real/doc#foo] this should vanish.",
      lookup,
    );
    expect(out.text).toBe("Per  this should vanish.");
    expect(out.slugMissing).toEqual([
      { slug: "not/a/real/doc", anchor: "foo" },
    ]);
  });

  it("accepts a slug-only citation", () => {
    const out = validateAndRewrite(
      "Background [doc:glossary] is a fine citation form.",
      lookup,
    );
    expect(out.text).toBe(
      "Background [doc:glossary] is a fine citation form.",
    );
    expect(out.validCount).toBe(1);
  });

  it("processes multiple citations in order", () => {
    const out = validateAndRewrite(
      "[doc:concepts/agent-day#tldr] then [doc:concepts/agent-day#nope] then [doc:no-such].",
      lookup,
    );
    expect(out.text).toBe(
      "[doc:concepts/agent-day#tldr] then [doc:concepts/agent-day] then .",
    );
    expect(out.validCount).toBe(1);
    expect(out.anchorMissing.length).toBe(1);
    expect(out.slugMissing.length).toBe(1);
  });
});

describe("createStreamingValidator", () => {
  const lookup = makeStubLookup({
    "features/routines/morning-routine": ["in-one-sentence", "what-it-outputs"],
    glossary: ["agent-day"],
  });

  it("forwards plain text with no citation immediately", () => {
    const v = createStreamingValidator(lookup);
    expect(v.feed("Hello world. ")).toBe("Hello world. ");
    expect(v.feed("Another line.")).toBe("Another line.");
    expect(v.flush()).toBe("");
  });

  it("buffers across an in-progress [doc: token until it closes", () => {
    const v = createStreamingValidator(lookup);
    expect(v.feed("Body. [doc:features/routines/")).toBe("Body. ");
    expect(v.feed("morning-routine#what-it-outputs] tail.")).toBe(
      "[doc:features/routines/morning-routine#what-it-outputs] tail.",
    );
    expect(v.flush()).toBe("");
    const snap = v.snapshot();
    expect(snap.validCount).toBe(1);
  });

  it("rewrites a streamed token whose anchor is missing", () => {
    const v = createStreamingValidator(lookup);
    expect(v.feed("Body. [doc:features/routines/")).toBe("Body. ");
    expect(v.feed("morning-routine#nope] tail.")).toBe(
      "[doc:features/routines/morning-routine] tail.",
    );
    const snap = v.snapshot();
    expect(snap.anchorMissing).toBe(1);
  });

  it("forwards an unterminated [doc: at end-of-stream as raw text", () => {
    const v = createStreamingValidator(lookup);
    expect(v.feed("trailing [doc:partial-no-")).toBe("trailing ");
    // No flushable token yet — tail still in buffer.
    expect(v.flush()).toBe("[doc:partial-no-");
  });

  it("forwards a runaway 'looks like a token but isn't' string after MAX_TOKEN_LEN", () => {
    const v = createStreamingValidator(lookup);
    const fake = "[doc:" + "x".repeat(300) + " not actually a citation, no close bracket here either";
    // Should eventually flush as-is (pure plaintext that opened with `[doc:`).
    const out = v.feed(fake);
    expect(out).toBe(fake);
  });

  it("handles tightly-packed tokens across two deltas", () => {
    const v = createStreamingValidator(lookup);
    const a = v.feed("[doc:glossary#agent-day][do");
    const b = v.feed("c:glossary#agent-day]");
    expect(a + b).toBe("[doc:glossary#agent-day][doc:glossary#agent-day]");
    expect(v.flush()).toBe("");
    expect(v.snapshot().validCount).toBe(2);
  });
});
