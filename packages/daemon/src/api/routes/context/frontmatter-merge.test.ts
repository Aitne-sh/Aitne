import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { deepMergePlainObjects, mergeFrontmatter } from "./frontmatter-merge.js";

describe("deepMergePlainObjects", () => {
  it("merges nested objects key-by-key without clobbering sibling keys", () => {
    const base = { sources: { gmail: { external_id: "g1" } }, keep: 1 };
    const out = deepMergePlainObjects(base, {
      sources: { notion: { external_id: "n1" } },
    });
    expect(out).toEqual({
      sources: { gmail: { external_id: "g1" }, notion: { external_id: "n1" } },
      keep: 1,
    });
  });

  it("scalars, arrays, and null replace; objects do not deep-merge into non-objects", () => {
    const out = deepMergePlainObjects(
      { a: 1, list: [1, 2], obj: { x: 1 }, n: { y: 1 } },
      { a: 2, list: [3], obj: "now-a-scalar", n: null },
    );
    expect(out).toEqual({ a: 2, list: [3], obj: "now-a-scalar", n: null });
  });

  it("does not mutate the inputs", () => {
    const base = { sources: { gmail: { id: "g1" } } };
    const partial = { sources: { gmail: { id: "g2" } } };
    deepMergePlainObjects(base, partial);
    expect(base.sources.gmail.id).toBe("g1");
    expect(partial.sources.gmail.id).toBe("g2");
  });
});

describe("mergeFrontmatter", () => {
  it("merges into an existing nested frontmatter block and preserves the body verbatim", () => {
    const file =
      "---\ntype: meeting\nsources:\n  gmail:\n    external_id: g1\n---\n# Meeting\n\nbody line\n";
    const res = mergeFrontmatter(file, {
      sources: { notion: { external_id: "n1" } },
      last_synced_at: "2026-06-02T12:00:00Z",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Body untouched.
    expect(res.content.endsWith("# Meeting\n\nbody line\n")).toBe(true);
    // Re-parse the merged frontmatter and assert the deep-merge result.
    const fm = yaml.load(
      /^---\n([\s\S]*?)\n---\n/.exec(res.content)![1],
    ) as Record<string, unknown>;
    expect(fm).toEqual({
      type: "meeting",
      sources: {
        gmail: { external_id: "g1" },
        notion: { external_id: "n1" },
      },
      last_synced_at: "2026-06-02T12:00:00Z",
    });
  });

  it("creates a frontmatter block when the file has none", () => {
    const res = mergeFrontmatter("# Plain note\n\nhi\n", { sources: { x: { id: "1" } } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content.startsWith("---\n")).toBe(true);
    expect(res.content.endsWith("# Plain note\n\nhi\n")).toBe(true);
  });

  it("rejects a file whose existing frontmatter is invalid YAML", () => {
    const res = mergeFrontmatter("---\nfoo: : :\n  bad\n---\nbody\n", { a: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/not valid YAML/);
  });

  it("rejects when the existing frontmatter is a YAML scalar/array, not a mapping", () => {
    const res = mergeFrontmatter("---\n- just\n- a\n- list\n---\nbody\n", { a: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/not a YAML mapping/);
  });

  it("preserves CRLF line endings when the source file uses them", () => {
    const file = "---\r\ntype: meeting\r\n---\r\n# H\r\n";
    const res = mergeFrontmatter(file, { last_synced_at: "z" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content.includes("\r\n")).toBe(true);
    expect(res.content.endsWith("# H\r\n")).toBe(true);
    expect(/(?<!\r)\n/.test(res.content)).toBe(false);
  });

  it("treats an empty frontmatter block as an empty base", () => {
    const res = mergeFrontmatter("---\n---\nbody\n", { a: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fm = yaml.load(/^---\n([\s\S]*?)\n---\n/.exec(res.content)![1]);
    expect(fm).toEqual({ a: 1 });
  });
});
