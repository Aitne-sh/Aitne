import { describe, it, expect } from "vitest";
import { pickCards } from "./docs-qa-suggested";
import type { DocDetailResponse } from "@/lib/api-types";

function doc(
  overrides: Partial<DocDetailResponse["frontmatter"]> & { slug: string; title: string },
): DocDetailResponse {
  return {
    slug: overrides.slug,
    body: "",
    anchors: [],
    frontmatter: {
      slug: overrides.slug,
      title: overrides.title,
      category: overrides.category ?? "concepts",
      summary: overrides.summary ?? "",
      tags: overrides.tags ?? [],
      process_keys: overrides.process_keys ?? [],
      config_keys: overrides.config_keys ?? [],
      ask_examples: overrides.ask_examples ?? [],
      related: overrides.related ?? [],
      ...(overrides.section ? { section: overrides.section } : {}),
      ...(overrides.status ? { status: overrides.status } : {}),
    },
  };
}

describe("pickCards", () => {
  it("returns up to 2 own examples + 1 from a related doc", () => {
    const cards = pickCards({
      currentDoc: doc({
        slug: "concepts/agent-day",
        title: "Agent Day",
        ask_examples: ["What is the agent day?", "When does it roll over?"],
        related: ["features/routines/morning-routine"],
      }),
      relatedDoc: doc({
        slug: "features/routines/morning-routine",
        title: "Morning Routine",
        ask_examples: ["When does morning routine run?"],
      }),
    });
    expect(cards).toHaveLength(3);
    expect(cards[0]?.question).toBe("What is the agent day?");
    expect(cards[1]?.question).toBe("When does it roll over?");
    expect(cards[2]?.question).toBe("When does morning routine run?");
    expect(cards[2]?.source).toBe("via Morning Routine");
  });

  it("returns own examples only when no related doc has examples", () => {
    const cards = pickCards({
      currentDoc: doc({
        slug: "concepts/agent-day",
        title: "Agent Day",
        ask_examples: ["A", "B"],
      }),
      relatedDoc: undefined,
    });
    expect(cards.map((c) => c.question)).toEqual(["A", "B"]);
  });

  it("caps at 3 cards even if own examples + related is bigger", () => {
    const cards = pickCards({
      currentDoc: doc({
        slug: "concepts/agent-day",
        title: "Agent Day",
        ask_examples: ["A", "B", "C", "D"],
      }),
      relatedDoc: doc({
        slug: "x",
        title: "X",
        ask_examples: ["E"],
      }),
    });
    expect(cards).toHaveLength(3);
    // own first two, then the related — the third own is dropped.
    expect(cards.map((c) => c.question)).toEqual(["A", "B", "E"]);
  });

  it("returns [] for the empty state when allAskExamples is unavailable", () => {
    expect(pickCards({ currentDoc: undefined, relatedDoc: undefined })).toEqual([]);
  });
});
