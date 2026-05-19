import { describe, expect, it } from "vitest";
import {
  classifyDiff,
  diffCapsFor,
  exceedsDiffCaps,
  payloadEntryCount,
} from "./classify-diff.js";
import type { CurationPayloadValue } from "@aitne/shared";

const kl = (files: Array<{ path: string; purpose: string; sections: Array<{ heading: string; contains: string }> }>): CurationPayloadValue => ({
  kind: "knowledge_layout",
  files,
});

describe("classifyDiff: knowledge_layout", () => {
  it("identifies pure additions", () => {
    const prev = kl([
      { path: "a.md", purpose: "p1", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const next = kl([
      { path: "a.md", purpose: "p1", sections: [{ heading: "## H", contains: "yyyyy" }] },
      { path: "b.md", purpose: "p2", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    expect(diff.kind).toBe("additive_only");
    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(0);
  });

  it("identifies removals as destructive", () => {
    const prev = kl([
      { path: "a.md", purpose: "p1", sections: [{ heading: "## H", contains: "yyyyy" }] },
      { path: "b.md", purpose: "p2", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const next = kl([
      { path: "a.md", purpose: "p1", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    expect(diff.kind).toBe("destructive");
    expect(diff.removals).toBe(1);
  });

  it("identifies modifications as mixed when combined with additions", () => {
    const prev = kl([
      { path: "a.md", purpose: "p1", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const next = kl([
      { path: "a.md", purpose: "p1 changed", sections: [{ heading: "## H", contains: "yyyyy" }] },
      { path: "b.md", purpose: "new",        sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    expect(diff.kind).toBe("mixed");
    expect(diff.additions).toBe(1);
    expect(diff.modifications).toBe(1);
  });

  it("identifies cosmetic-only changes (whitespace / NFC noise)", () => {
    const prev = kl([
      { path: "a.md", purpose: "concise text", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const next = kl([
      { path: "a.md", purpose: "  concise   text  ", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    expect(diff.kind).toBe("cosmetic_only");
    expect(diff.additions).toBe(0);
    expect(diff.modifications).toBe(0);
  });

  it("treats path case-insensitively (identifier normalization)", () => {
    const prev = kl([
      { path: "user/Profile.md", purpose: "p", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const next = kl([
      { path: "user/profile.md", purpose: "p", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    // Same primary key after lower-casing → cosmetic
    expect(diff.removals).toBe(0);
    expect(diff.additions).toBe(0);
  });

  it("ignores array order changes", () => {
    const prev = kl([
      { path: "a.md", purpose: "p", sections: [{ heading: "## H", contains: "yyyyy" }] },
      { path: "b.md", purpose: "q", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const next = kl([
      { path: "b.md", purpose: "q", sections: [{ heading: "## H", contains: "yyyyy" }] },
      { path: "a.md", purpose: "p", sections: [{ heading: "## H", contains: "yyyyy" }] },
    ]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    expect(diff.additions).toBe(0);
    expect(diff.removals).toBe(0);
    expect(diff.modifications).toBe(0);
  });
});

describe("classifyDiff: routing_table", () => {
  it("uses the (trigger, dest_path, dest_section) tuple as primary key", () => {
    const prev: CurationPayloadValue = {
      kind: "routing_table",
      rules: [
        { trigger_pattern: "user mentions doctor visit", destination_path: "user/personal.md", destination_section: "## Health", destination_mode: "append" },
      ],
    };
    const next: CurationPayloadValue = {
      kind: "routing_table",
      rules: [
        { trigger_pattern: "user mentions doctor visit", destination_path: "user/personal.md", destination_section: "## Health", destination_mode: "append", note: "ok" },
      ],
    };
    const diff = classifyDiff(prev, next, "routing_table");
    expect(diff.modifications).toBe(1);
  });
});

describe("classifyDiff: frontmatter_schema", () => {
  it("forces destructive on required[] removal", () => {
    const prev: CurationPayloadValue = {
      kind: "frontmatter_schema",
      file_types: [{
        glob: "projects/*.md",
        required: [
          { key: "type", type: "enum", example: "project" },
          { key: "owner", type: "string", example: "shared" },
        ],
        conventional: [],
      }],
    };
    const next: CurationPayloadValue = {
      kind: "frontmatter_schema",
      file_types: [{
        glob: "projects/*.md",
        required: [
          { key: "type", type: "enum", example: "project" },
        ],
        conventional: [],
      }],
    };
    const diff = classifyDiff(prev, next, "frontmatter_schema");
    expect(diff.kind).toBe("destructive");
  });

  it("does not flag conventional[] removal as destructive", () => {
    const prev: CurationPayloadValue = {
      kind: "frontmatter_schema",
      file_types: [{
        glob: "projects/*.md",
        required: [{ key: "type", type: "enum", example: "project" }],
        conventional: [{ key: "slug", purpose: "kebab-case" }],
      }],
    };
    const next: CurationPayloadValue = {
      kind: "frontmatter_schema",
      file_types: [{
        glob: "projects/*.md",
        required: [{ key: "type", type: "enum", example: "project" }],
        conventional: [],
      }],
    };
    const diff = classifyDiff(prev, next, "frontmatter_schema");
    expect(diff.kind).not.toBe("destructive");
  });
});

describe("diffCapsFor / exceedsDiffCaps", () => {
  it("scales caps with prevSize within bounds", () => {
    expect(diffCapsFor("convention_notes", 0)).toEqual({ additions: 5, modifications: 1, removals: 2 });
    expect(diffCapsFor("convention_notes", 10)).toEqual({ additions: 5, modifications: 2, removals: 2 });
    expect(diffCapsFor("convention_notes", 20)).toEqual({ additions: 10, modifications: 4, removals: 2 });
  });

  it("rejects when removals exceed cap", () => {
    const r = exceedsDiffCaps(
      { additions: 0, modifications: 0, removals: 5, cosmeticOnly: false, isAdditiveOnly: false, kind: "destructive" },
      "convention_notes",
      0,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects when modifications exceed cap (covers lines 322-324)", () => {
    // For prevSize=10 the modifications cap is Math.max(1, ceil(10*0.2)) = 2.
    // 5 modifications must trip the second branch and return a reason
    // string mentioning the cap value.
    const r = exceedsDiffCaps(
      { additions: 0, modifications: 5, removals: 0, cosmeticOnly: false, isAdditiveOnly: false, kind: "mixed" },
      "convention_notes",
      10,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("modifications");
      expect(r.reason).toContain("5");
    }
  });

  it("rejects when additions exceed cap (covers lines 326-327)", () => {
    // For prevSize=2 the additions cap is Math.max(5, ceil(2*0.5)) = 5.
    // 99 additions must trip the third branch.
    const r = exceedsDiffCaps(
      { additions: 99, modifications: 0, removals: 0, cosmeticOnly: false, isAdditiveOnly: true, kind: "additive_only" },
      "convention_notes",
      2,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("additions");
      expect(r.reason).toContain("99");
    }
  });

  it("returns ok when all counts are within caps", () => {
    // Sanity — confirms the happy path returns `{ ok: true }`.
    const r = exceedsDiffCaps(
      { additions: 1, modifications: 1, removals: 0, cosmeticOnly: false, isAdditiveOnly: false, kind: "mixed" },
      "convention_notes",
      10,
    );
    expect(r.ok).toBe(true);
  });
});

describe("classifyDiff: search_recipes / convention_notes / cross_references", () => {
  it("classifies search_recipes additions/removals via question_shape", () => {
    const prev: CurationPayloadValue = {
      kind: "search_recipes",
      recipes: [
        { question_shape: "where do I track meeting notes", lookup_path: "today.md" },
      ],
    };
    const next: CurationPayloadValue = {
      kind: "search_recipes",
      recipes: [
        { question_shape: "where do I track meeting notes", lookup_path: "today.md" },
        { question_shape: "where do reading list entries live", lookup_path: "books.md" },
      ],
    };
    const diff = classifyDiff(prev, next, "search_recipes");
    expect(diff.kind).toBe("additive_only");
    expect(diff.additions).toBe(1);
  });

  it("classifies convention_notes additions via topic key", () => {
    const prev: CurationPayloadValue = {
      kind: "convention_notes",
      notes: [{ topic: "Dates", rule: "Entries are written as [YYYY-MM-DD]." }],
    };
    const next: CurationPayloadValue = {
      kind: "convention_notes",
      notes: [
        { topic: "Dates", rule: "Entries are written as [YYYY-MM-DD]." },
        { topic: "Mentions", rule: "People are referenced by full name." },
      ],
    };
    const diff = classifyDiff(prev, next, "convention_notes");
    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(0);
  });

  it("classifies cross_references via (from_path, to_path) pair", () => {
    const prev: CurationPayloadValue = {
      kind: "cross_references",
      refs: [{ from_path: "user/profile.md", to_path: "today.md", relation: "see also" }],
    };
    const next: CurationPayloadValue = {
      kind: "cross_references",
      refs: [
        { from_path: "user/profile.md", to_path: "today.md", relation: "see also" },
        { from_path: "user/profile.md", to_path: "user/health.md", relation: "linked" },
      ],
    };
    const diff = classifyDiff(prev, next, "cross_references");
    expect(diff.additions).toBe(1);
  });
});

describe("classifyDiff: kind-mismatch guard", () => {
  it("throws when prev.kind disagrees with the requested kind (covers 284-287)", () => {
    const prev: CurationPayloadValue = {
      kind: "convention_notes",
      notes: [{ topic: "T", rule: "Plain rule." }],
    };
    const next: CurationPayloadValue = {
      kind: "convention_notes",
      notes: [{ topic: "T", rule: "Plain rule." }],
    };
    expect(() => classifyDiff(prev, next, "knowledge_layout")).toThrow(/kind mismatch/);
  });
});

describe("payloadEntryCount", () => {
  it("counts knowledge_layout files", () => {
    expect(payloadEntryCount({ kind: "knowledge_layout", files: [] })).toBe(0);
    expect(payloadEntryCount({
      kind: "knowledge_layout",
      files: [
        { path: "a.md", purpose: "p", sections: [{ heading: "## H", contains: "x" }] },
        { path: "b.md", purpose: "q", sections: [] },
      ],
    })).toBe(2);
  });

  it("counts routing_table rules", () => {
    expect(payloadEntryCount({ kind: "routing_table", rules: [] })).toBe(0);
    expect(payloadEntryCount({
      kind: "routing_table",
      rules: [
        { trigger_pattern: "doc", destination_path: "a.md", destination_section: "## S", destination_mode: "append" },
        { trigger_pattern: "task", destination_path: "b.md", destination_section: "## T", destination_mode: "append" },
      ],
    })).toBe(2);
  });

  it("counts frontmatter_schema file_types", () => {
    expect(payloadEntryCount({ kind: "frontmatter_schema", file_types: [] })).toBe(0);
    expect(payloadEntryCount({
      kind: "frontmatter_schema",
      file_types: [
        { glob: "projects/*.md", required: [{ key: "type", type: "string", example: "project" }], conventional: [] },
      ],
    })).toBe(1);
  });

  it("counts search_recipes recipes", () => {
    expect(payloadEntryCount({ kind: "search_recipes", recipes: [] })).toBe(0);
    expect(payloadEntryCount({
      kind: "search_recipes",
      recipes: [
        { question_shape: "where do I track X", lookup_path: "today.md" },
        { question_shape: "where does Y live", lookup_path: "user.md" },
      ],
    })).toBe(2);
  });

  it("counts convention_notes notes", () => {
    expect(payloadEntryCount({ kind: "convention_notes", notes: [] })).toBe(0);
    expect(payloadEntryCount({ kind: "convention_notes", notes: [{ topic: "t", rule: "Plain rule." }] })).toBe(1);
  });

  it("counts cross_references refs", () => {
    expect(payloadEntryCount({ kind: "cross_references", refs: [] })).toBe(0);
    expect(payloadEntryCount({
      kind: "cross_references",
      refs: [
        { from_path: "a.md", to_path: "b.md", relation: "see also" },
        { from_path: "c.md", to_path: "d.md", relation: "linked" },
      ],
    })).toBe(2);
  });
});

describe("structurallyEqual — complete branch coverage", () => {
  // These tests exercise structurallyEqual's internal branches via classifyDiff.
  // structurallyEqual is a generic unknown comparator; the tests inject extra
  // typed fields via `as unknown` casts to reach guards that CurationPayloadValue
  // doesn't naturally trigger.

  it("same-type numeric field: counts modification when value differs (covers return false via scalar fallthrough, line 92)", () => {
    // structurallyEqual(1, 2): same type "number", not string/array/object → return false
    const prev = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _n: 1 }],
    } as unknown as CurationPayloadValue;
    const next = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _n: 2 }],
    } as unknown as CurationPayloadValue;
    const diff = classifyDiff(prev, next, "convention_notes");
    expect(diff.modifications).toBe(1);
    expect(diff.kind).toBe("mixed");
  });

  it("same-type numeric field: no modification when value is identical", () => {
    const prev = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _n: 42 }],
    } as unknown as CurationPayloadValue;
    const next = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _n: 42 }],
    } as unknown as CurationPayloadValue;
    expect(classifyDiff(prev, next, "convention_notes").modifications).toBe(0);
  });

  it("boolean field flip triggers modification (covers scalar return false with boolean type)", () => {
    const prev = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _flag: false }],
    } as unknown as CurationPayloadValue;
    const next = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _flag: true }],
    } as unknown as CurationPayloadValue;
    expect(classifyDiff(prev, next, "convention_notes").modifications).toBe(1);
  });

  it("different-type field between prev and next triggers modification (covers typeof a !== typeof b early-return, line 62)", () => {
    // structurallyEqual(true, 1): typeof "boolean" !== typeof "number" → return false at line 62
    const prev = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _typed: true }],   // boolean
    } as unknown as CurationPayloadValue;
    const next = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _typed: 1 }],      // number
    } as unknown as CurationPayloadValue;
    expect(classifyDiff(prev, next, "convention_notes").modifications).toBe(1);
  });

  it("array element at same index differs → modification (covers return false inside array loop, line 70)", () => {
    // sections array is compared element-by-element; different heading at index 0
    // triggers !structurallyEqual(a[i], b[i]) → return false
    const prev = kl([{ path: "a.md", purpose: "p", sections: [{ heading: "## Old", contains: "x" }] }]);
    const next = kl([{ path: "a.md", purpose: "p", sections: [{ heading: "## New", contains: "x" }] }]);
    const diff = classifyDiff(prev, next, "knowledge_layout");
    expect(diff.modifications).toBe(1);
  });

  it("objects with different key names triggers modification (covers aKeys[i] !== bKeys[i] early-return, line 79)", () => {
    // structurallyEqual({topic:"T", rule:"r", _old:1}, {topic:"T", rule:"r", _new:1}):
    // sorted keys differ at position 0 → return false at the key-mismatch check
    const prev = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _old: 1 }],
    } as unknown as CurationPayloadValue;
    const next = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _new: 1 }],
    } as unknown as CurationPayloadValue;
    expect(classifyDiff(prev, next, "convention_notes").modifications).toBe(1);
  });

  it("null field changing to an object (same typeof 'object') triggers modification (covers null branch at line 63)", () => {
    // structurallyEqual(null, {}) — both typeof "object", so line 62 (typeof check)
    // does NOT early-return. Line 63 (a === null || b === null) catches it and
    // returns null === {} = false, counting as a modification.
    const prev = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _obj: null }],     // null (typeof "object")
    } as unknown as CurationPayloadValue;
    const next = {
      kind: "convention_notes" as const,
      notes: [{ topic: "T", rule: "r", _obj: { nested: 1 } }],  // object
    } as unknown as CurationPayloadValue;
    expect(classifyDiff(prev, next, "convention_notes").modifications).toBe(1);
  });
});

describe("classifyDiff: frontmatter_schema — new glob addition (covers !ftPrev continue, line 193)", () => {
  it("adding a new file_type glob is classified as an addition, not destructive", () => {
    // When next.file_types has a glob absent from prev, the inner required-removal
    // check must skip it (if (!ftPrev) continue). No required fields are being
    // removed from a brand-new entry, so the result should be additive_only.
    const prev: CurationPayloadValue = {
      kind: "frontmatter_schema",
      file_types: [
        {
          glob: "projects/*.md",
          required: [{ key: "type", type: "enum", example: "project" }],
          conventional: [],
        },
      ],
    };
    const next: CurationPayloadValue = {
      kind: "frontmatter_schema",
      file_types: [
        {
          glob: "projects/*.md",
          required: [{ key: "type", type: "enum", example: "project" }],
          conventional: [],
        },
        {
          glob: "tasks/*.md",
          required: [{ key: "status", type: "enum", example: "open" }],
          conventional: [],
        },
      ],
    };
    const diff = classifyDiff(prev, next, "frontmatter_schema");
    expect(diff.additions).toBe(1);
    expect(diff.removals).toBe(0);
    expect(diff.kind).toBe("additive_only");
  });
});
