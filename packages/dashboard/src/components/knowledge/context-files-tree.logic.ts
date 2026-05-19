/**
 * Pure tree-building helpers for the Knowledge → Context Files sidebar.
 *
 * The daemon's `/context/list/:dir` endpoint returns a flat list of files
 * where a name may itself contain `/` (e.g. `aitne/overview.md`,
 * `aitne/journal/2026-05-06.md` under `git/`, or `policies/foo.md` under
 * `rules/`). The sidebar groups those into a nested, collapsible tree so
 * each per-slug subdirectory does not blow up the visible list as the
 * number of slugs grows.
 */

export type ContextTreeNode =
  | { kind: "file"; name: string; relPath: string }
  | { kind: "dir"; name: string; relPath: string; children: ContextTreeNode[] };

export function buildContextTree(files: { name: string }[]): ContextTreeNode[] {
  const root: ContextTreeNode[] = [];

  for (const f of files) {
    const segments = f.name.split("/");
    let level: ContextTreeNode[] = root;
    let relPath = "";

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      relPath = relPath ? `${relPath}/${segment}` : segment;

      if (isLast) {
        level.push({ kind: "file", name: segment, relPath });
      } else {
        let dir = level.find(
          (n): n is ContextTreeNode & { kind: "dir" } =>
            n.kind === "dir" && n.name === segment,
        );
        if (!dir) {
          dir = { kind: "dir", name: segment, relPath, children: [] };
          level.push(dir);
        }
        level = dir.children;
      }
    }
  }

  // Folders first, then files; alphabetical within each group. This is a
  // deliberate departure from the API's filesystem order — readdirSync
  // order is OS-dependent, so deterministic sort wins on UX even if it
  // costs a small reorder for date-named folders like `journal/`.
  const sortNodes = (nodes: ContextTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.kind === "dir") sortNodes(n.children);
    }
  };
  sortNodes(root);

  return root;
}

/**
 * Selection paths used by the sidebar strip the `.md` extension only —
 * `.base` (Obsidian Bases) keeps its extension verbatim. Mirrors the
 * `displayPathLabel` rule used for top-level files.
 */
export function selectionPathFor(topDir: string, fileRelPath: string): string {
  return `${topDir}/${fileRelPath.replace(/\.md$/, "")}`;
}
