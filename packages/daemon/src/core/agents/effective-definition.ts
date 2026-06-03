import { agentDefinitionSchema, type AgentDefinition } from "@aitne/shared";
import type { z } from "zod";

import type { AgentDTO } from "../../db/agents-store.js";
import { AgentFrontmatterError, parseAgentFrontmatter } from "./agent-frontmatter.js";
import { getBuiltinRegistryEntry } from "./builtin-registry.js";
import { mergeAgentDefinition } from "./override-merge.js";
import { synthesizeRegistryDefinition } from "./loader.js";

/**
 * Effective-definition resolver for the `/api/agents/:slug` read path
 * (AGENT_DEFINITIONS_DESIGN.md §9.2). The stored `agents` row carries the
 * identity columns the list view needs, but the detail view returns the *full*
 * `AgentDefinition` body (`limits`, `tools`, `success_criteria`, …). That body
 * lives only in the `agent.md` file, so this module re-reads + re-composes it
 * exactly as the loader does at boot:
 *
 *     effective = parse(agent.md)  →  merge override_snapshot (built-ins)
 *
 * and falls back to the registry-synthesised definition when a built-in's file
 * is missing or unparseable (the same §6.1-step-3 fallback the loader applies),
 * so a broken file still renders a usable identity in the dashboard.
 *
 * Pure over an injected `readFile` (returns `null` when the file is absent or
 * unreadable) so it stays in the 100%-coverage set; the route supplies a thin
 * `fs` adapter.
 */

export interface EffectiveDefinitionDeps {
  /** Read a definition file; `null` when missing/unreadable (never throws). */
  readFile: (path: string) => string | null;
  /** Live day-boundary hour for `{dayBoundaryHour}` cron substitution (§4.2). */
  dayBoundaryHour: number;
}

export interface EffectiveDefinitionResult {
  /**
   * The composed effective definition, or `null` when it cannot be produced
   * (a user Agent whose file is missing/unparseable — built-ins always
   * synthesise from the registry).
   */
  definition: AgentDefinition | null;
  /** Raw `agent.md` bytes when a file exists, else `null` (synthesised). */
  yaml: string | null;
  /** True when the definition was synthesised from the registry fallback. */
  synthesized: boolean;
  /** Parse/validation error message when the on-disk file is invalid. */
  error: string | null;
}

/** Built-in override snapshot for the merge; `{}` when none / not a built-in. */
function overrideSnapshotFor(dto: AgentDTO): Record<string, unknown> {
  if (dto.source !== "builtin") return {};
  const snapshot = dto.metadata.override_snapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : {};
}

/** Apply the built-in override snapshot on top of a base definition (§6.4.1). */
function applyOverride(base: AgentDefinition, dto: AgentDTO): AgentDefinition {
  const snapshot = overrideSnapshotFor(dto);
  if (Object.keys(snapshot).length === 0) return base;
  return mergeAgentDefinition(base, base, snapshot);
}

/**
 * Synthesise a built-in's effective definition from `BUILTIN_AGENT_REGISTRY`
 * (used when the file is missing/invalid). Returns `null` for a slug with no
 * registry entry — impossible for a real built-in (the loader rejects unknown
 * built-in slugs), but guarded so a hand-corrupted `source='builtin'` row can't
 * throw.
 */
function synthesizeBuiltin(
  dto: AgentDTO,
  dayBoundaryHour: number,
): AgentDefinition | null {
  const entry = getBuiltinRegistryEntry(dto.slug);
  if (!entry) return null;
  return applyOverride(synthesizeRegistryDefinition(entry, dayBoundaryHour), dto);
}

/**
 * Compose the effective definition for one Agent row. The runtime `enabled`
 * authority is the `agents.enabled` column (§6.4 timestamp resolution), not the
 * YAML/snapshot value, so the composed `definition.enabled` is overwritten with
 * `dto.enabled` to keep the detail view truthful against the scheduler gate.
 */
export function loadEffectiveDefinition(
  dto: AgentDTO,
  deps: EffectiveDefinitionDeps,
): EffectiveDefinitionResult {
  const raw = deps.readFile(dto.definitionPath);

  if (raw !== null) {
    try {
      const { frontmatter } = parseAgentFrontmatter(raw);
      const parsed = agentDefinitionSchema.parse(frontmatter);
      const effective = applyOverride(parsed, dto);
      effective.enabled = dto.enabled;
      return { definition: effective, yaml: raw, synthesized: false, error: null };
    } catch (err) {
      const error = describeParseError(err);
      // A broken built-in file still renders from the registry fallback; a
      // broken user file has no fallback, so the body is null (the row's
      // last_error already explains why, surfaced via the list view).
      const fallback =
        dto.source === "builtin"
          ? synthesizeBuiltin(dto, deps.dayBoundaryHour)
          : null;
      if (fallback) fallback.enabled = dto.enabled;
      return {
        definition: fallback,
        yaml: raw,
        synthesized: fallback !== null,
        error,
      };
    }
  }

  // No file on disk — synthesise built-ins from the registry; user Agents
  // (which always own a file) report the missing definition.
  if (dto.source === "builtin") {
    const synth = synthesizeBuiltin(dto, deps.dayBoundaryHour);
    if (synth) synth.enabled = dto.enabled;
    return {
      definition: synth,
      yaml: null,
      synthesized: synth !== null,
      error: synth ? null : "no registry entry for built-in slug",
    };
  }
  return {
    definition: null,
    yaml: null,
    synthesized: false,
    error: "definition file not found",
  };
}

/**
 * Render a frontmatter / schema failure as a single-line message. The only two
 * throwers in the `try` above are `parseAgentFrontmatter` (→ `AgentFrontmatterError`)
 * and `agentDefinitionSchema.parse` (→ `ZodError`), so the two-branch form is
 * total — mirrors `loader.ts:processFile`'s identical catch.
 */
function describeParseError(err: unknown): string {
  if (err instanceof AgentFrontmatterError) return err.message;
  return `schema validation failed: ${(err as z.ZodError).issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ")}`;
}
