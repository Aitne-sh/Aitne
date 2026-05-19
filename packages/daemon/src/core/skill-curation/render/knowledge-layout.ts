// P22 §1.4.5 — knowledge_layout renderer.
//
// Compact tabular form when ≥3 files; bullet form below that. The
// template emits no headings — the surrounding SKILL.md owns the title.

import type { KnowledgeLayoutValue } from "@aitne/shared";

export const RENDERER_VERSION = "knowledge_layout/1";

const TABLE_THRESHOLD = 3;

function joinSections(file: KnowledgeLayoutValue["files"][number]): string {
  return file.sections
    .map((section) => {
      const writers = section.writers && section.writers.length > 1
        ? ` _(${section.writers.join(", ")})_`
        : "";
      return `${section.heading.replace(/^#+\s*/, "")}${writers}`;
    })
    .join(" · ");
}

function renderRow(file: KnowledgeLayoutValue["files"][number]): string {
  const sections = joinSections(file);
  return `| \`${file.path}\` | ${file.purpose} | ${sections} |`;
}

function renderBullet(file: KnowledgeLayoutValue["files"][number]): string {
  const sections = joinSections(file);
  return `- \`${file.path}\` — ${file.purpose} (${sections})`;
}

export function renderKnowledgeLayout(payload: KnowledgeLayoutValue): string {
  const files = payload.files;
  if (files.length === 0) return "";

  if (files.length >= TABLE_THRESHOLD) {
    const header = "| File | Purpose | Sections |";
    const sep = "|---|---|---|";
    return [header, sep, ...files.map(renderRow)].join("\n");
  }

  return files.map(renderBullet).join("\n");
}
