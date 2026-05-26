import type { CustomRoutineParseError } from "../custom-routine-scheduler.js";

/**
 * Pure validators for routine rulebooks and `.base` YAML files.
 *
 * Built-in routine rulebooks (`routines/*.md`, excluding `_index`) drive
 * the morning / evening / weekly task-flow prompts and must declare the
 * canonical frontmatter shape so the loader can dispatch by slug + type.
 *
 * Custom routines (`policies/routines/custom/*.md`) are user-authored and parsed
 * by `parseCustomRoutineSpec`; we only translate the structured error
 * into a human-readable message here so the API can surface a 400
 * response that the agent can self-correct from in-session.
 *
 * `.base` files (today: only `plans/projects/_active.base`) carry the active
 * project list as inline YAML. Validation is deliberately syntactic
 * (no schema check) so the file can evolve without a daemon edit; the
 * loader does the per-row validation when it parses.
 */

/**
 * Validate the canonical built-in routine rulebook shape:
 *   - YAML frontmatter present
 *   - `type: rule`
 *   - `slug` matches the filename (relative to `routines/`)
 *   - `## Checks` section is present in the body
 *
 * Returns a human-readable error message string, or `null` if the file
 * is valid. The caller maps `null` to 200 and any string to 400.
 */
export function validateBuiltInRoutineRulebook(
  path: string,
  content: string,
): string | null {
  const frontmatter = extractRoutineFrontmatter(content);
  if (frontmatter === null) {
    return "Routine rulebooks require YAML frontmatter.";
  }

  const expectedSlug = path.slice("policies/routines/".length);
  const typeRaw = readRoutineFrontmatterScalar(frontmatter, "type");
  if (!typeRaw) {
    return "Routine rulebooks require `type: rule` in frontmatter.";
  }
  if (typeRaw !== "rule") {
    return "Routine rulebooks must declare `type: rule`.";
  }

  const slugRaw = readRoutineFrontmatterScalar(frontmatter, "slug");
  if (!slugRaw) {
    return "Routine rulebooks require a `slug` frontmatter field.";
  }
  if (slugRaw !== expectedSlug) {
    return `Routine rulebook slug must match the filename (${expectedSlug}).`;
  }

  if (!/^##\s+Checks\s*$/m.test(content)) {
    return "Routine rulebooks require a `## Checks` section.";
  }

  return null;
}

/**
 * Translate a structured `CustomRoutineParseError` from
 * `parseCustomRoutineSpec` into a human-readable string suitable for
 * the API error response.
 */
export function explainCustomRoutineValidationError(
  error: CustomRoutineParseError,
): string {
  switch (error.kind) {
    case "missing_field":
      return `Custom routine files require \`${error.field}\` in frontmatter.`;
    case "invalid_cron":
      return `Invalid cron expression: \`${error.value}\`.`;
    case "invalid_slug":
      return `Custom routine slug is invalid or does not match the filename: \`${error.value}\`.`;
    case "invalid_type":
      return `Custom routines must declare \`type: rule\`, got \`${error.value}\`.`;
    case "invalid_process_key":
      return `Custom routine \`process_key\` must match the filename-derived key, got \`${error.value}\`.`;
    case "invalid_enabled":
      return `Custom routine \`enabled\` must be \`true\` or \`false\`, got \`${error.value}\`.`;
    case "invalid_tier":
      return `Custom routine \`backend_tier\` must be \`light\` or \`heavy\`, got \`${error.value}\`.`;
    case "invalid_budget":
      return `Custom routine \`max_budget_usd\` must be a positive number, got \`${error.value}\`.`;
    case "missing_checks_section":
      return "Custom routines require a `## Checks` section.";
    case "no_frontmatter":
      return "Custom routines require YAML frontmatter.";
  }
}

/**
 * Extract the YAML frontmatter body (without the `---` delimiters)
 * from a markdown file, or return `null` if no frontmatter block is
 * present at the start of the file. Accepts both LF and CRLF line
 * endings on the opening delimiter so Windows-edited files do not
 * round-trip as "no frontmatter".
 */
export function extractRoutineFrontmatter(content: string): string | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return null;
  }
  const afterOpen = content.startsWith("---\r\n") ? 5 : 4;
  const endIdx = content.indexOf("\n---", afterOpen - 1);
  if (endIdx < 0) return null;
  return content.slice(afterOpen, endIdx);
}

/**
 * Read a single top-level scalar field from a routine frontmatter
 * block. Quoted strings (single or double) have the quotes stripped;
 * everything else is returned trimmed verbatim. Returns `null` if the
 * field is absent.
 */
export function readRoutineFrontmatterScalar(
  frontmatter: string,
  field: string,
): string | null {
  const re = new RegExp(`^${field}\\s*:\\s*(.+?)\\s*$`, "m");
  const match = frontmatter.match(re);
  if (!match) return null;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Syntactic gate for `.base` YAML context files.
 *
 * Only rejects files that are obviously broken — tabs in indentation,
 * odd indent counts, non-mapping non-list lines. The schema check (what
 * fields must be present) belongs in the loader; the API gate exists
 * so that a malformed PATCH cannot wedge the project-list reader.
 */
export function validateBaseYamlSyntax(content: string): string | null {
  if (content.trim().length === 0) {
    return ".base files must not be empty.";
  }

  const lines = content.split("\n");
  let sawMeaningfulLine = false;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const lineNo = index + 1;
    if (raw.includes("\t")) {
      return `.base YAML may not contain tab indentation (line ${lineNo}).`;
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    sawMeaningfulLine = true;

    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      return `.base YAML uses 2-space indentation (line ${lineNo}).`;
    }

    const isListItem = /^-\s+\S/.test(trimmed);
    const isMapping = /^[^:#][^:]*:\s*(?:.*)?$/.test(trimmed);
    if (!isListItem && !isMapping) {
      return `Invalid .base YAML structure on line ${lineNo}.`;
    }
  }

  if (!sawMeaningfulLine) {
    return ".base files must contain at least one mapping entry.";
  }

  return null;
}
