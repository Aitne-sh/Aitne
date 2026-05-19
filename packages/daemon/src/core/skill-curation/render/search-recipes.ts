// P22 §1.4.5 — search_recipes renderer.
//
// Two-column table (If you need to know… | Read) when ≥3 recipes; bullet
// form below that. Notes render as footnotes (same convention as routing_table).

import type { SearchRecipesValue } from "@aitne/shared";

export const RENDERER_VERSION = "search_recipes/1";

const TABLE_THRESHOLD = 3;

function read(recipe: SearchRecipesValue["recipes"][number]): string {
  if (recipe.lookup_section) {
    return `\`${recipe.lookup_path} ${recipe.lookup_section}\``;
  }
  return `\`${recipe.lookup_path}\``;
}

export function renderSearchRecipes(payload: SearchRecipesValue): string {
  const { recipes } = payload;
  if (recipes.length === 0) return "";

  if (recipes.length >= TABLE_THRESHOLD) {
    const footnotes: string[] = [];
    const header = "| If you need to know… | Read |";
    const sep = "|---|---|";
    const rows = recipes.map((recipe, idx) => {
      const ref = recipe.note ? ` [^${idx + 1}]` : "";
      if (recipe.note) footnotes.push(`[^${idx + 1}]: ${recipe.note}`);
      return `| ${recipe.question_shape}${ref} | ${read(recipe)} |`;
    });
    const out = [header, sep, ...rows];
    if (footnotes.length > 0) out.push("", ...footnotes);
    return out.join("\n");
  }

  return recipes
    .map((recipe) => {
      const note = recipe.note ? ` — ${recipe.note}` : "";
      return `- ${recipe.question_shape} → ${read(recipe)}${note}`;
    })
    .join("\n");
}
