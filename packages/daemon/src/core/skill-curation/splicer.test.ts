import { describe, expect, it, vi } from "vitest";
import { hasCurationAnchors, spliceCurationAnchors } from "./splicer.js";

describe("spliceCurationAnchors", () => {
  it("substitutes anchor with rendered overlay content", () => {
    const md = [
      "## Notes",
      "",
      `<!-- CURATION:convention_notes id="x" -->`,
      "",
      "## Tail",
    ].join("\n");
    const result = spliceCurationAnchors(md, (id, kind) => {
      if (id === "x" && kind === "convention_notes") {
        return { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] };
      }
      return null;
    });
    expect(result.body).toContain("- **T.** Plain rule.");
    expect(result.body).not.toContain("CURATION:");
    expect(result.warnings).toHaveLength(0);
  });

  it("strips anchor when overlay is null", () => {
    const md = [
      "## Notes",
      "",
      `<!-- CURATION:convention_notes id="x" -->`,
      "",
      "## Tail",
    ].join("\n");
    const result = spliceCurationAnchors(md, () => null);
    expect(result.body).not.toContain("CURATION:");
    expect(result.body.split("\n")).toEqual(["## Notes", "", "", "## Tail"]);
  });

  it("warns and drops when payload kind differs from anchor kind", () => {
    const md = `<!-- CURATION:convention_notes id="x" -->`;
    const result = spliceCurationAnchors(md, () => ({
      kind: "knowledge_layout",
      files: [{ path: "a.md", purpose: "purpose words", sections: [{ heading: "## H", contains: "yyyyy" }] }],
    }));
    expect(result.warnings.find((w) => w.code === "splicer_kind_mismatch")).toBeDefined();
  });

  it("warns and drops orphan anchor (id not in declaration)", () => {
    const md = `<!-- CURATION:convention_notes id="orphan" -->`;
    const result = spliceCurationAnchors(md, () => null, { knownSectionIds: new Set(["other"]) });
    expect(result.warnings.find((w) => w.code === "splicer_orphan_anchor")).toBeDefined();
    expect(result.body).not.toContain("CURATION:");
  });

  it("preserves non-anchor lines verbatim", () => {
    const md = ["# Top", "Plain prose.", "- bullet"].join("\n");
    const result = spliceCurationAnchors(md, () => null);
    expect(result.body).toBe(md);
  });

  it("captures resolveOverlay errors as splicer_render_error and drops the line", () => {
    // Covers lines 65-71 — the try/catch around `resolveOverlay`. When the
    // resolver throws (e.g. a corrupt overlay envelope), the splicer must
    // emit a `splicer_render_error` warning and strip the anchor instead of
    // propagating the exception up into the SkillsCompiler hot path.
    const md = `<!-- CURATION:convention_notes id="x" -->`;
    const result = spliceCurationAnchors(md, () => {
      throw new Error("overlay JSON corrupt");
    });
    const err = result.warnings.find((w) => w.code === "splicer_render_error");
    expect(err).toBeDefined();
    expect(err?.message).toContain("overlay JSON corrupt");
    expect(result.body).not.toContain("CURATION:");
  });

  it("captures renderCurationSection Error throws as splicer_render_error", async () => {
    // Covers lines 88-93 — the try/catch around `renderCurationSection`.
    // We mock the renderer module so the call throws even though the
    // payload kind matches the anchor (so we get past the line 76 guard).
    vi.resetModules();
    vi.doMock("./render/index.js", () => ({
      renderCurationSection: () => {
        throw new Error("renderer blew up");
      },
    }));
    const { spliceCurationAnchors: splice } = await import("./splicer.js");
    const md = `<!-- CURATION:convention_notes id="x" -->`;
    const result = splice(md, () => ({
      kind: "convention_notes",
      notes: [{ topic: "T", rule: "Plain rule." }],
    }));
    const err = result.warnings.find((w) => w.code === "splicer_render_error");
    expect(err).toBeDefined();
    expect(err?.message).toContain("renderer blew up");
    vi.doUnmock("./render/index.js");
    vi.resetModules();
  });

  it("captures renderCurationSection non-Error throws via String() coercion", async () => {
    // Covers line 91 — the `err instanceof Error ? err.message : String(err)`
    // branch in the renderer's catch block. Mock the renderer to throw a
    // raw string so the splicer falls through to String(err) coercion.
    vi.resetModules();
    vi.doMock("./render/index.js", () => ({
      renderCurationSection: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string panic";
      },
    }));
    const { spliceCurationAnchors: splice } = await import("./splicer.js");
    const md = `<!-- CURATION:convention_notes id="x" -->`;
    const result = splice(md, () => ({
      kind: "convention_notes",
      notes: [{ topic: "T", rule: "Plain rule." }],
    }));
    const err = result.warnings.find((w) => w.code === "splicer_render_error");
    expect(err?.message).toBe("raw string panic");
    vi.doUnmock("./render/index.js");
    vi.resetModules();
  });

  it("captures non-Error throws as their string form", () => {
    // Covers the `err instanceof Error ? err.message : String(err)` branch
    // in the resolveOverlay catch block — non-Error throw values are
    // stringified.
    const md = `<!-- CURATION:convention_notes id="x" -->`;
    const result = spliceCurationAnchors(md, () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string thrown";
    });
    const err = result.warnings.find((w) => w.code === "splicer_render_error");
    expect(err?.message).toBe("string thrown");
  });

  it("handles multiple anchors of different kinds", () => {
    const md = [
      "## A",
      `<!-- CURATION:convention_notes id="a" -->`,
      "## B",
      `<!-- CURATION:cross_references id="b" -->`,
    ].join("\n");
    const result = spliceCurationAnchors(md, (id, kind) => {
      if (id === "a") return { kind: "convention_notes", notes: [{ topic: "T", rule: "Plain rule." }] };
      if (id === "b") return { kind: "cross_references", refs: [{ from_path: "x.md", to_path: "y.md", relation: "related" }] };
      return null;
    });
    expect(result.body).toContain("- **T.**");
    expect(result.body).toContain("`x.md`");
  });
});

describe("hasCurationAnchors", () => {
  it("detects anchor presence", () => {
    expect(hasCurationAnchors(`<!-- CURATION:convention_notes id="x" -->`)).toBe(true);
    expect(hasCurationAnchors("plain content")).toBe(false);
  });
});
