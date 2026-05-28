/**
 * Pure helpers for the `dom_snapshot` tool —
 * BROWSER_TASK_REDESIGN_PLAN.md §5.
 *
 * Playwright's `page.accessibility.snapshot()` returns a tree shape
 * `{ role, name, value, children, ... }`. The runner serialises that
 * into a compact text outline (one node per indented line) and
 * truncates the result to fit the per-call budget:
 *
 *   - Hard cap: 32 KB (the tool table in §5 says "≤ 32 KB").
 *   - Default node cap: 1500 (peak `maxNodes` schema-side is 5000).
 *
 * The serialiser is a pure tree walk + render. No I/O. 100% covered.
 */

/** §5 — hard byte cap on the rendered output. */
export const DOM_SNAPSHOT_MAX_BYTES = 32 * 1024;

/** Default `maxNodes` when the caller does not pass one. */
export const DOM_SNAPSHOT_DEFAULT_MAX_NODES = 1500;

/** Shape Playwright's `Accessibility.snapshot()` returns. We type it
 *  structurally so the runner's I/O wrapper can hand us the result
 *  without importing playwright-core into this pure module. */
export interface AccessibilityNodeLike {
  role?: string | null;
  name?: string | null;
  value?: string | number | null;
  description?: string | null;
  children?: ReadonlyArray<AccessibilityNodeLike> | null;
  // Other fields (focused, checked, expanded, level, …) are present
  // on the Playwright shape but we render only the load-bearing ones
  // for the agent.
  focused?: boolean | null;
  checked?: boolean | "mixed" | null;
  expanded?: boolean | null;
}

export interface DomSnapshotRenderInput {
  root: AccessibilityNodeLike | null;
  maxNodes?: number;
}

export interface DomSnapshotRenderResult {
  /** The rendered aria-tree outline (≤ 32 KB). */
  ariaTree: string;
  /** Number of nodes actually rendered. */
  nodesRendered: number;
  /** True when the renderer truncated either by node count or byte
   *  budget. The runner surfaces this in the tool response so the
   *  agent knows to use a more specific `selector` if needed. */
  truncated: boolean;
}

export function renderAccessibilityTree(
  input: DomSnapshotRenderInput,
): DomSnapshotRenderResult {
  if (!input.root) {
    return { ariaTree: "", nodesRendered: 0, truncated: false };
  }
  const maxNodes = clampMaxNodes(input.maxNodes ?? DOM_SNAPSHOT_DEFAULT_MAX_NODES);
  const lines: string[] = [];
  let nodesRendered = 0;
  let truncated = false;
  let byteBudget = DOM_SNAPSHOT_MAX_BYTES;

  const stack: Array<{ node: AccessibilityNodeLike; depth: number }> = [
    { node: input.root, depth: 0 },
  ];
  while (stack.length > 0) {
    const top = stack.shift()!;
    if (nodesRendered >= maxNodes) {
      truncated = true;
      break;
    }
    const line = renderNode(top.node, top.depth);
    // Each line carries its trailing `\n` for the byte budget.
    const lineLen = Buffer.byteLength(line, "utf8") + 1;
    if (lineLen > byteBudget) {
      truncated = true;
      break;
    }
    lines.push(line);
    nodesRendered += 1;
    byteBudget -= lineLen;
    if (top.node.children) {
      // BFS-ish: append children to the front so order is preserved
      // and the depth label is correct. Walking DFS-then-children
      // keeps the output readable (each subtree appears contiguous).
      const childEntries = top.node.children.map((child) => ({
        node: child,
        depth: top.depth + 1,
      }));
      stack.unshift(...childEntries);
    }
  }
  return {
    ariaTree: lines.join("\n"),
    nodesRendered,
    truncated,
  };
}

function renderNode(
  node: AccessibilityNodeLike,
  depth: number,
): string {
  const indent = "  ".repeat(depth);
  const role = (node.role ?? "node").trim() || "node";
  const fragments: string[] = [role];
  if (typeof node.name === "string" && node.name.length > 0) {
    fragments.push(`"${truncateLabel(node.name)}"`);
  }
  if (node.value !== null && node.value !== undefined && `${node.value}`.length > 0) {
    fragments.push(`value="${truncateLabel(`${node.value}`)}"`);
  }
  if (node.description && node.description.length > 0) {
    fragments.push(`desc="${truncateLabel(node.description)}"`);
  }
  if (node.focused === true) fragments.push("focused");
  if (node.checked === true) fragments.push("checked");
  if (node.checked === "mixed") fragments.push("checked=mixed");
  if (node.expanded === true) fragments.push("expanded");
  return `${indent}- ${fragments.join(" ")}`;
}

function truncateLabel(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/** Clamp `maxNodes` to the schema range. */
export function clampMaxNodes(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  if (value > 5000) return 5000;
  return Math.floor(value);
}
