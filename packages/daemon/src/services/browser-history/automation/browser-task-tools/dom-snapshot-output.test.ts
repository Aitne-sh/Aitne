/**
 * dom-snapshot-output — §5 / §13 coverage.
 */

import { describe, expect, it } from "vitest";

import {
  clampMaxNodes,
  DOM_SNAPSHOT_DEFAULT_MAX_NODES,
  DOM_SNAPSHOT_MAX_BYTES,
  renderAccessibilityTree,
} from "./dom-snapshot-output.js";

describe("clampMaxNodes", () => {
  it("clamps below 1 to 1", () => {
    expect(clampMaxNodes(0)).toBe(1);
    expect(clampMaxNodes(-10)).toBe(1);
  });

  it("clamps above 5000 to 5000", () => {
    expect(clampMaxNodes(1_000_000)).toBe(5000);
  });

  it("rounds non-integer values down", () => {
    expect(clampMaxNodes(3.7)).toBe(3);
  });

  it("passes finite-range values through", () => {
    expect(clampMaxNodes(100)).toBe(100);
  });

  it("treats NaN as 1 (defensive)", () => {
    expect(clampMaxNodes(NaN)).toBe(1);
  });
});

describe("renderAccessibilityTree", () => {
  it("returns empty when root is null", () => {
    const r = renderAccessibilityTree({ root: null });
    expect(r.ariaTree).toBe("");
    expect(r.nodesRendered).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("renders a single-node tree", () => {
    const r = renderAccessibilityTree({
      root: { role: "button", name: "Sign in" },
    });
    expect(r.ariaTree).toBe('- button "Sign in"');
    expect(r.nodesRendered).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("renders nested children with indent", () => {
    const r = renderAccessibilityTree({
      root: {
        role: "main",
        name: "page",
        children: [
          { role: "heading", name: "Title" },
          {
            role: "form",
            children: [
              { role: "textbox", name: "Email", value: "user@example.com" },
              { role: "button", name: "Submit" },
            ],
          },
        ],
      },
    });
    expect(r.ariaTree).toContain('- main "page"');
    expect(r.ariaTree).toContain('  - heading "Title"');
    expect(r.ariaTree).toContain('  - form');
    expect(r.ariaTree).toContain('    - textbox "Email" value="user@example.com"');
    expect(r.ariaTree).toContain('    - button "Submit"');
    expect(r.nodesRendered).toBe(5);
  });

  it("includes focused / checked / expanded flags", () => {
    const r = renderAccessibilityTree({
      root: {
        role: "checkbox",
        name: "Remember me",
        focused: true,
        checked: true,
      },
    });
    expect(r.ariaTree).toContain("focused");
    expect(r.ariaTree).toContain("checked");
  });

  it("emits checked=mixed", () => {
    const r = renderAccessibilityTree({
      root: { role: "checkbox", name: "Tri", checked: "mixed" },
    });
    expect(r.ariaTree).toContain("checked=mixed");
  });

  it("includes value and description when present", () => {
    const r = renderAccessibilityTree({
      root: {
        role: "slider",
        name: "Volume",
        value: 42,
        description: "0 to 100",
      },
    });
    expect(r.ariaTree).toContain("value=\"42\"");
    expect(r.ariaTree).toContain('desc="0 to 100"');
  });

  it("truncates long labels to 120 chars with ellipsis", () => {
    const long = "x".repeat(200);
    const r = renderAccessibilityTree({
      root: { role: "button", name: long },
    });
    expect(r.ariaTree).toContain("xxx...");
    expect(r.ariaTree.length).toBeLessThan(200);
  });

  it("truncates on node count cap", () => {
    const children = Array.from({ length: 50 }, (_, i) => ({
      role: "listitem",
      name: `Item ${i}`,
    }));
    const r = renderAccessibilityTree({
      root: { role: "list", children },
      maxNodes: 10,
    });
    expect(r.truncated).toBe(true);
    expect(r.nodesRendered).toBeLessThanOrEqual(10);
  });

  it("truncates on byte cap", () => {
    // Build a deep tree whose serialised form will exceed 32 KB.
    const children = Array.from({ length: 5000 }, (_, i) => ({
      role: "listitem",
      name: `Item ${i} `.repeat(20),
    }));
    const r = renderAccessibilityTree({
      root: { role: "list", children },
      maxNodes: 5000,
    });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.ariaTree, "utf8")).toBeLessThanOrEqual(
      DOM_SNAPSHOT_MAX_BYTES,
    );
  });

  it("falls back to 'node' when role is missing or empty", () => {
    const r = renderAccessibilityTree({
      root: { name: "no-role" },
    });
    expect(r.ariaTree).toContain("- node ");
    const r2 = renderAccessibilityTree({
      root: { role: "", name: "blank-role" },
    });
    expect(r2.ariaTree).toContain("- node ");
  });

  it("uses default maxNodes when omitted", () => {
    const r = renderAccessibilityTree({ root: { role: "button" } });
    expect(r.nodesRendered).toBe(1);
    // The default constant is a positive integer.
    expect(DOM_SNAPSHOT_DEFAULT_MAX_NODES).toBeGreaterThan(0);
  });

  it("does not render a description when it is null or empty", () => {
    const r = renderAccessibilityTree({
      root: { role: "button", name: "Go", description: "" },
    });
    expect(r.ariaTree).not.toContain("desc=");
  });

  it("does not render value when null", () => {
    const r = renderAccessibilityTree({
      root: { role: "textbox", name: "Email", value: null },
    });
    expect(r.ariaTree).not.toContain("value=");
  });

  it("does not render value when empty string", () => {
    const r = renderAccessibilityTree({
      root: { role: "textbox", name: "Email", value: "" },
    });
    expect(r.ariaTree).not.toContain("value=");
  });

  it("renders the expanded flag", () => {
    const r = renderAccessibilityTree({
      root: { role: "treeitem", name: "Folder", expanded: true },
    });
    expect(r.ariaTree).toContain("expanded");
  });

  it("collapses whitespace in labels", () => {
    const r = renderAccessibilityTree({
      root: {
        role: "button",
        name: "  multi   line\n\tlabel  ",
      },
    });
    expect(r.ariaTree).toContain('"multi line label"');
  });
});
