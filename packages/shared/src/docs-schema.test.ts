import { describe, expect, it } from "vitest";
import {
  DOCS_SCHEMA_VERSION,
  docsFrontmatterSchema,
  parseCitationTokens,
  slugifyAnchor,
} from "./docs-schema.js";

describe("docsFrontmatterSchema", () => {
  const minimal = {
    schema_version: DOCS_SCHEMA_VERSION,
    slug: "features/routines/morning-routine",
    title: "Morning Routine",
    category: "features" as const,
    summary: "The autonomous routine that runs once per agent-day.",
  };

  it("accepts the minimal required set", () => {
    const parsed = docsFrontmatterSchema.parse(minimal);
    expect(parsed.title).toBe("Morning Routine");
    expect(parsed.category).toBe("features");
  });

  it("accepts the full recommended-plus-optional set", () => {
    const parsed = docsFrontmatterSchema.parse({
      ...minimal,
      id: "morning-routine",
      aliases: ["morning_routine", "daily morning routine"],
      section: "routines",
      tags: ["routine", "autonomous", "daily", "heavy-tier", "core"],
      status: "stable" as const,
      ask_examples: [
        "When does morning routine run?",
        "How do I disable morning routine?",
      ],
      locale: "en-US",
      created: "2026-04-25",
      updated: "2026-04-25",
      review_due: "2026-10-01",
      keywords: ["morning", "day plan", "04:00"],
      related: ["concepts/routines", "features/memory-files/today"],
      prerequisites: ["concepts/agent-day"],
      ui_anchors: ["/settings/routines", "/"],
      process_keys: ["routine.morning_routine"],
      config_keys: ["dayBoundaryHour", "morningRoutineHour"],
      extra: { custom_lifecycle_hint: "monthly" },
    });
    expect(parsed.tags).toContain("routine");
    expect(parsed.related?.[0]).toBe("concepts/routines");
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    const result = docsFrontmatterSchema.safeParse({ ...minimal, tag: ["x"] });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { title, ...withoutTitle } = minimal;
    void title;
    const result = docsFrontmatterSchema.safeParse(withoutTitle);
    expect(result.success).toBe(false);
  });

  it("rejects schema_version mismatch", () => {
    const result = docsFrontmatterSchema.safeParse({
      ...minimal,
      schema_version: 99,
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed slug", () => {
    const result = docsFrontmatterSchema.safeParse({
      ...minimal,
      slug: "Features/Routines/MorningRoutine",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown category", () => {
    const result = docsFrontmatterSchema.safeParse({
      ...minimal,
      category: "blog",
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed ui_anchors entry", () => {
    const result = docsFrontmatterSchema.safeParse({
      ...minimal,
      ui_anchors: ["no-leading-slash"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed date", () => {
    const result = docsFrontmatterSchema.safeParse({
      ...minimal,
      created: "April 25, 2026",
    });
    expect(result.success).toBe(false);
  });
});

describe("slugifyAnchor", () => {
  it("matches the Markdown renderer's heading rule", () => {
    expect(slugifyAnchor("What It Outputs")).toBe("what-it-outputs");
    expect(slugifyAnchor("Step 1 — first run")).toBe("step-1-first-run");
    expect(slugifyAnchor("In One Sentence")).toBe("in-one-sentence");
  });

  it("collapses repeated whitespace and dashes", () => {
    expect(slugifyAnchor("a   b -- c")).toBe("a-b-c");
  });
});

describe("parseCitationTokens", () => {
  it("extracts a slug-only citation", () => {
    const tokens = parseCitationTokens("see [doc:concepts/agent-day] for more");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.slug).toBe("concepts/agent-day");
    expect(tokens[0]!.anchor).toBeNull();
  });

  it("extracts a slug+anchor citation", () => {
    const tokens = parseCitationTokens(
      "see [doc:features/routines/morning-routine#what-it-outputs] for more",
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.slug).toBe("features/routines/morning-routine");
    expect(tokens[0]!.anchor).toBe("what-it-outputs");
  });

  it("extracts multiple citations and preserves order", () => {
    const tokens = parseCitationTokens(
      "[doc:glossary] and [doc:concepts/routines#tldr] together",
    );
    expect(tokens.map((t) => t.slug)).toEqual(["glossary", "concepts/routines"]);
    expect(tokens[1]!.anchor).toBe("tldr");
  });

  it("ignores non-matching brackets", () => {
    expect(parseCitationTokens("[note:not-a-doc]")).toEqual([]);
  });
});
