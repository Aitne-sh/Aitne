/**
 * B-003 Phase 4 — per-tool allowlist transitions.
 *
 * `tool_allowlist` has three meaningful states:
 *
 *   - `null`        → all tools implicitly allowed.
 *   - `[]`          → explicitly no tools allowed.
 *   - `[a, b, ...]` → only these tools allowed.
 *
 * The card renders one checkbox per tool; `deriveToolState` answers "is this
 * tool allowed given the current allowlist?" for the checkbox value, and
 * `toggleToolAllowlist` computes the next allowlist value on click.
 *
 * Normalization invariant: if the new explicit array would equal the full
 * probe tool set, we collapse to `null` so the server stays in the "all
 * allowed" state the user can later narrow. This keeps the UI's three
 * logical states legible (`null` vs `[subset]` vs `[]`).
 */

export function deriveToolState(
  allowlist: string[] | null,
  toolName: string,
): "allowed" | "blocked" {
  if (allowlist === null) return "allowed";
  return allowlist.includes(toolName) ? "allowed" : "blocked";
}

export function toggleToolAllowlist(
  allowlist: string[] | null,
  toolName: string,
  allTools: string[],
): string[] | null {
  // Dedupe+sort the "full set" for canonical equality.
  const canonical = Array.from(new Set(allTools)).sort();
  const canonicalSet = new Set(canonical);

  // Materialize current state into an explicit set so we can mutate uniformly.
  const current = new Set<string>(
    allowlist === null ? canonical : allowlist.filter((t) => canonicalSet.has(t)),
  );

  if (current.has(toolName)) {
    current.delete(toolName);
  } else if (canonicalSet.has(toolName)) {
    current.add(toolName);
  } else {
    // Toggling a tool name we don't know about — ignore. Callers that pass
    // a tool outside `allTools` are misusing the API; returning input
    // unchanged keeps the UI deterministic rather than throwing.
    return allowlist;
  }

  // Normalize: every known tool allowed → `null`. Makes "I turned them all
  // back on" go back to the implicit state rather than staying as an
  // explicit full list.
  if (current.size === canonical.length) return null;

  return Array.from(current).sort();
}
