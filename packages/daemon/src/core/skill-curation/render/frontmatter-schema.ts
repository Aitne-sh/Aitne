// P22 §1.4.5 — frontmatter_schema renderer.
//
// Per-glob block. Type info renders as inline backtick fragments.

import type { FrontmatterSchemaValue } from "@aitne/shared";

export const RENDERER_VERSION = "frontmatter_schema/1";

function renderRequired(field: FrontmatterSchemaValue["file_types"][number]["required"][number]): string {
  return `\`${field.key}: ${field.example}\``;
}

function renderConventional(field: FrontmatterSchemaValue["file_types"][number]["conventional"][number]): string {
  return `\`${field.key}\``;
}

export function renderFrontmatterSchema(payload: FrontmatterSchemaValue): string {
  const blocks: string[] = [];
  for (const ft of payload.file_types) {
    const lines: string[] = [`**\`${ft.glob}\`**`];
    if (ft.required.length > 0) {
      lines.push(`- Required: ${ft.required.map(renderRequired).join(" · ")}`);
    }
    if (ft.conventional.length > 0) {
      lines.push(`- Conventional: ${ft.conventional.map(renderConventional).join(" · ")}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
