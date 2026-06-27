import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { agentDefinitionSchema } from "@aitne/shared";

import {
  enumerateCustomRoutines,
  type CustomRoutineSpec,
} from "../custom-routines.js";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";
import { renderAgentMarkdown } from "./agent-frontmatter.js";
import { definitionToFrontmatter } from "./loader.js";
import { isBuiltinAgentSlug } from "./builtin-registry.js";
import { getAgent } from "../../db/agents-store.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("custom-routine-migration");

/**
 * One-time converter: legacy custom routines → user Agents
 * (AGENTS_HUB_REDESIGN_PLAN.md §3).
 *
 * The retired `CustomRoutineScheduler` fired `policies/routines/custom/
 * <slug>.md` files through its own node-cron path — invisible to `/agents`,
 * no metrics, no execution history, a second enable switch. This converter
 * runs at boot BEFORE the agents loader (so the loader pairs the fresh
 * definitions with `recurring_schedules` rows in the same pass), turning each
 * valid spec into `policies/agents/<slug>/agent.md`:
 *
 *   - frontmatter: cron schedule, tier, `max_budget_usd`, the spec's
 *     `enabled` (a disabled routine migrates disabled — intent preserved);
 *   - body: the routine's body after the legacy frontmatter (the `## Checks`
 *     section), which the Agents pipeline uses as `task_prompt`.
 *
 * The source file is never deleted (user vault content): it is rewritten in
 * place with `enabled: false` + a `migrated_to_agent:` marker so it is
 * visibly inert. Invalid specs are left untouched and logged — they never
 * fired under the old scheduler either.
 *
 * Idempotent via the `runtime_state` flag; a fresh install (no custom dir)
 * is a flagged no-op.
 */
export const CUSTOM_ROUTINES_MIGRATED_KEY = "custom_routines.migrated_to_agents";

export interface CustomRoutineMigrationOptions {
  /** Context-vault root (the directory holding `policies/`). */
  contextDir: string;
  /** User agents root — `<contextDir>/policies/agents`. */
  userDir: string;
  /** IANA timezone the generated cron schedule is pinned to. */
  timezone: string;
  now?: () => number;
}

export interface CustomRoutineMigrationResult {
  /** False when the runtime_state flag showed the migration already ran. */
  applied: boolean;
  migrated: Array<{ fromSlug: string; toSlug: string }>;
  skipped: Array<{ slug: string; reason: string }>;
}

/**
 * Body after the closing `---` fence, or the whole content if no frontmatter.
 * Exported for direct unit tests — callers only ever pass parse-validated
 * content, so the defensive branches are unreachable through the public path.
 */
export function stripLegacyFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
  const afterOpen = content.startsWith("---\r\n") ? 5 : 4;
  const endIdx = content.indexOf("\n---", afterOpen - 1);
  if (endIdx < 0) return content;
  const afterFence = content.indexOf("\n", endIdx + 1);
  return afterFence < 0 ? "" : content.slice(afterFence + 1);
}

/**
 * Mark a migrated source file inert: `enabled: false` + a
 * `migrated_to_agent:` marker appended inside the frontmatter block.
 * Exported for direct unit tests (see stripLegacyFrontmatter note).
 */
export function markSourceMigrated(content: string, toSlug: string): string {
  let out = content.replace(/^enabled\s*:.*$/m, "enabled: false");
  if (!/^migrated_to_agent\s*:/m.test(out)) {
    // Insert before the closing fence of the first frontmatter block.
    const afterOpen = out.startsWith("---\r\n") ? 5 : 4;
    const endIdx = out.indexOf("\n---", afterOpen - 1);
    if (endIdx >= 0) {
      out = `${out.slice(0, endIdx)}\nmigrated_to_agent: ${toSlug}${out.slice(endIdx)}`;
    }
  }
  return out;
}

function titleize(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function resolveTargetSlug(
  db: Database.Database,
  userDir: string,
  slug: string,
): string | null {
  const candidates = [slug, `custom-${slug}`];
  for (const candidate of candidates) {
    if (isBuiltinAgentSlug(candidate)) continue;
    if (getAgent(db, candidate) !== null) continue;
    if (existsSync(join(userDir, candidate, "agent.md"))) continue;
    return candidate;
  }
  return null;
}

export function migrateCustomRoutinesToAgents(
  db: Database.Database,
  opts: CustomRoutineMigrationOptions,
): CustomRoutineMigrationResult {
  if (readRuntimeState<string>(db, CUSTOM_ROUTINES_MIGRATED_KEY) !== null) {
    return { applied: false, migrated: [], skipped: [] };
  }

  const now = opts.now ?? Date.now;
  const { specs, errors } = enumerateCustomRoutines(opts.contextDir);
  const migrated: Array<{ fromSlug: string; toSlug: string }> = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  for (const { slug, error } of errors) {
    skipped.push({ slug, reason: `parse_error:${error.kind}` });
    logger.warn({ slug, error }, "Custom routine not migrated (parse error) — left as-is");
  }

  for (const spec of specs) {
    try {
      const result = migrateOne(db, opts, spec);
      if (result.ok) {
        migrated.push({ fromSlug: spec.slug, toSlug: result.toSlug });
      } else {
        skipped.push({ slug: spec.slug, reason: result.reason });
      }
    } catch (err) {
      skipped.push({ slug: spec.slug, reason: "write_failed" });
      logger.error({ err, slug: spec.slug }, "Custom routine migration failed for slug");
    }
  }

  writeRuntimeState(db, CUSTOM_ROUTINES_MIGRATED_KEY, new Date(now()).toISOString());
  if (migrated.length > 0 || skipped.length > 0) {
    logger.info({ migrated, skipped }, "Custom routines migrated to user Agents");
  }
  return { applied: true, migrated, skipped };
}

function migrateOne(
  db: Database.Database,
  opts: CustomRoutineMigrationOptions,
  spec: CustomRoutineSpec,
): { ok: true; toSlug: string } | { ok: false; reason: string } {
  const toSlug = resolveTargetSlug(db, opts.userDir, spec.slug);
  if (toSlug === null) {
    logger.warn({ slug: spec.slug }, "Custom routine not migrated (slug collision)");
    return { ok: false, reason: "slug_collision" };
  }

  const sourcePath = join(
    opts.contextDir,
    CONTEXT_RELATIVE_PATHS.routines.customDir,
    `${spec.slug}.md`,
  );
  const sourceContent = readFileSync(sourcePath, "utf-8");
  const body = stripLegacyFrontmatter(sourceContent).trim();

  const def = agentDefinitionSchema.parse({
    slug: toSlug,
    name: titleize(spec.slug),
    description: `Migrated from custom routine "${spec.slug}".`,
    kind: "user",
    enabled: spec.enabled,
    schedule: { kind: "cron", expression: spec.cron, timezone: opts.timezone },
    backend: { process_key: "agent.task", tier: spec.backendTier },
    limits: { max_budget_usd: spec.maxBudgetUsd },
  });
  const markdown = renderAgentMarkdown(
    definitionToFrontmatter(def),
    body.length > 0 ? body : def.description,
  );

  const dir = join(opts.userDir, toSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), markdown, "utf-8");

  // Mark the source inert only AFTER the agent.md write succeeded.
  writeFileSync(sourcePath, markSourceMigrated(sourceContent, toSlug), "utf-8");

  logger.info({ from: spec.slug, to: toSlug }, "Custom routine migrated to user Agent");
  return { ok: true, toSlug };
}
