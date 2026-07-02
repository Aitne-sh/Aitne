/**
 * Pure grouping helpers for the plans/projects sidebar section. The daemon
 * list route attaches `meta: {title, state}` to project files; the sidebar
 * groups them by lifecycle state instead of dumping raw slug filenames.
 *
 * Projects stay flat on disk (one `plans/projects/<slug>.md` per project —
 * the layout the `<active_projects>` injection and Obsidian basename
 * wikilinks depend on); readability is a presentation concern handled here.
 */

import { selectionPathFor } from "./context-files-tree.logic";

export interface ProjectListEntry {
  name: string;
  meta?: { title: string; state: string };
}

export interface ProjectItem {
  slug: string;
  title: string;
  state: string;
  selectionPath: string;
}

export type ProjectGroupKey = "active" | "on-hold" | "archived";

export interface ProjectGroup {
  key: ProjectGroupKey;
  label: string;
  items: ProjectItem[];
}

export interface GroupedProjects {
  groups: ProjectGroup[];
  /** Meta-less companions (e.g. `_active.base`) — listed after the groups. */
  other: { name: string; selectionPath: string }[];
}

const GROUP_ORDER: { key: ProjectGroupKey; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "on-hold", label: "On hold" },
  { key: "archived", label: "Archived" },
];

function groupKeyFor(state: string): ProjectGroupKey {
  const normalized = state.toLowerCase();
  if (normalized === "archived") return "archived";
  if (normalized === "on-hold" || normalized === "on_hold") return "on-hold";
  // active, incubating, and anything unrecognized surface up top — an
  // unknown state should never hide a project.
  return "active";
}

export function groupProjects(
  files: ProjectListEntry[],
  topDir = "plans/projects",
): GroupedProjects {
  const buckets = new Map<ProjectGroupKey, ProjectItem[]>();
  const other: GroupedProjects["other"] = [];

  for (const file of files) {
    if (file.name === "_index.md") continue; // surfaced via TOP_FILES-style nav, not the tree
    if (file.meta) {
      const item: ProjectItem = {
        slug: file.name.replace(/\.md$/, ""),
        title: file.meta.title,
        state: file.meta.state.toLowerCase(),
        selectionPath: selectionPathFor(topDir, file.name),
      };
      const key = groupKeyFor(file.meta.state);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(item);
      else buckets.set(key, [item]);
    } else {
      other.push({
        name: file.name,
        selectionPath: selectionPathFor(topDir, file.name),
      });
    }
  }

  const groups: ProjectGroup[] = [];
  for (const { key, label } of GROUP_ORDER) {
    const items = buckets.get(key);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.title.localeCompare(b.title));
    groups.push({ key, label, items });
  }
  other.sort((a, b) => a.name.localeCompare(b.name));

  return { groups, other };
}
