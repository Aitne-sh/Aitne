import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";

interface ProjectSummary {
  slug: string;
  title: string;
  state: string;
  due: string | null;
  nextMilestone: string | null;
  updated: string | null;
}

/**
 * Render the `<active_projects>` body — a sorted bullet list of the
 * non-archived project summaries pulled from
 * `${contextDir}/${CONTEXT_RELATIVE_PATHS.projects.dir}/*.md`.
 *
 * Returns `null` when the directory is absent, contains no eligible
 * files, or `contextDir` itself is `null` (degraded mode). Callers
 * wrap the returned body in the surrounding `<active_projects>` XML
 * tag.
 */
export async function renderActiveProjectsSection(
  contextDir: string | null,
): Promise<string | null> {
  if (!contextDir) return null;
  const projectsDir = join(contextDir, CONTEXT_RELATIVE_PATHS.projects.dir);
  if (!existsSync(projectsDir)) return null;

  const projectFiles = readdirSync(projectsDir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => !name.startsWith("_"));
  if (projectFiles.length === 0) return null;

  const summaries = (
    await Promise.all(
      projectFiles.map(async (name) => {
        const content = await readProjectFile(contextDir, name);
        if (!content) return null;
        return summarizeProjectFile(name, content);
      }),
    )
  )
    .filter((summary): summary is ProjectSummary => summary !== null)
    .filter((summary) => summary.state !== "archived");

  if (summaries.length === 0) return null;

  summaries.sort((a, b) => {
    const aUpdated = a.updated ?? "";
    const bUpdated = b.updated ?? "";
    if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated);
    return a.title.localeCompare(b.title);
  });

  const lines = ["# Active projects", ""];
  for (const project of summaries) {
    const parts = [`state: ${project.state}`];
    if (project.nextMilestone) {
      parts.push(`next: ${project.nextMilestone}`);
    }
    if (project.due) {
      parts.push(`due: ${project.due}`);
    }
    lines.push(
      `- ${project.title} (\`${project.slug}\`) — ${parts.join("; ")}`,
    );
  }

  return lines.join("\n");
}

async function readProjectFile(
  contextDir: string,
  name: string,
): Promise<string | null> {
  const fullPath = join(contextDir, CONTEXT_RELATIVE_PATHS.projects.dir, name);
  if (!existsSync(fullPath)) return null;
  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}

function summarizeProjectFile(
  filename: string,
  content: string,
): ProjectSummary | null {
  const slug = filename.replace(/\.md$/, "");
  const { frontmatter, body } = splitFrontmatter(content);
  const state = readFrontmatterScalar(frontmatter, "state") ?? "active";
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;

  return {
    slug,
    title,
    state,
    due: readFrontmatterScalar(frontmatter, "due"),
    nextMilestone: readFrontmatterScalar(frontmatter, "next_milestone"),
    updated: readFrontmatterScalar(frontmatter, "updated"),
  };
}

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { frontmatter: "", body: content };
  }

  const endIdx = content.indexOf("\n---", 4);
  if (endIdx < 0) {
    return { frontmatter: "", body: content };
  }

  return {
    frontmatter: content.slice(4, endIdx),
    body: content.slice(endIdx + 4).replace(/^\n+/, ""),
  };
}

function readFrontmatterScalar(
  frontmatter: string,
  key: string,
): string | null {
  if (!frontmatter) return null;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = frontmatter.match(
    new RegExp(`^${escapedKey}:\\s*(.+)$`, "m"),
  );
  if (!match) return null;

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}
