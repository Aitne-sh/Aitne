import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import {
  AGENT_SLUG_PATTERN,
  agentDefinitionSchema,
  isProcessKey,
  type AgentDefinition,
} from "@aitne/shared";

import {
  BUILTIN_AGENT_REGISTRY,
  BUILTIN_AGENT_REGISTRY_BY_SLUG,
  getBuiltinRegistryEntry,
} from "./builtin-registry.js";
import { checkCronDrift, substituteCron, validateCronExpression } from "./cron-substitute.js";

/**
 * Phase 4 — shipped built-in `agent.md` definitions (×10).
 *
 * Asserts the on-disk `agent-assets/agents/<slug>/agent.md` files are the
 * faithful, schema-valid source for the 10 built-ins and stay in lock-step with
 * `BUILTIN_AGENT_REGISTRY` (the fallback identity + cron/stop-warning
 * authority). This is the test the Phase 3 `builtin-registry.test.ts` deferred
 * via `it.todo("... Phase 4")`.
 *
 * The frontmatter is parsed with `js-yaml` — the same nested-YAML parser the
 * Phase 5 loader uses. The repo's existing `extractContextFrontmatter` is a
 * flat line-scalar parser and cannot read the agent definition's nested
 * `schedule` / `backend` / `success_criteria` / `stop_warning` blocks (see the
 * Phase 4 design-drift note in AGENT_DEFINITIONS_IMPLEMENTATION_PLAN.md).
 */

// `core/agents/` is four levels below `packages/daemon/src`; repo root is five
// `..` up from this test file.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "agent-assets", "agents");

/** Default `dayBoundaryHour` the registry cron resolvers are checked against. */
const DEFAULT_DAY_BOUNDARY_HOUR = 4;

/**
 * Split a Markdown file into its YAML frontmatter object + body. Mirrors the
 * fence logic of `core/context-frontmatter-extract.ts:extractContextFrontmatter`
 * (open on a leading `---`, close on the next `---`) but parses the captured
 * block with `js-yaml` so nested mappings/sequences survive. Throws on a file
 * that does not open/close a frontmatter block — every `agent.md` must.
 */
function readAgentFrontmatter(content: string): { frontmatter: unknown; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error("agent.md must open with a `---` frontmatter fence");
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    throw new Error("agent.md frontmatter block is never closed with `---`");
  }
  // js-yaml v4 `load` IS the safe loader — the code-executing loader and the
  // `!!js/function` schema were removed in v4, so `DEFAULT_SCHEMA` constructs no
  // arbitrary types. Inputs here are repo-controlled shipped assets regardless.
  const frontmatter = yaml.load(lines.slice(1, end).join("\n"));
  return { frontmatter, body: lines.slice(end + 1).join("\n").trim() };
}

/** Directory names directly under `agent-assets/agents/`. */
function listAgentDirs(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => statSync(join(AGENTS_DIR, name)).isDirectory())
    .sort();
}

/** Parse `<dir>/agent.md` and return its validated definition + raw body. */
function loadAgentDefinition(dir: string): { definition: AgentDefinition; body: string } {
  const filePath = join(AGENTS_DIR, dir, "agent.md");
  const { frontmatter, body } = readAgentFrontmatter(readFileSync(filePath, "utf8"));
  // `.parse` throws (failing the test) with a precise Zod path on any drift.
  const definition = agentDefinitionSchema.parse(frontmatter);
  return { definition, body };
}

describe("built-in agent.md files — bijection with the registry", () => {
  it("every registry slug has exactly one agent.md directory, and no orphan dirs", () => {
    const dirs = listAgentDirs();
    const registrySlugs = BUILTIN_AGENT_REGISTRY.map((entry) => entry.slug).sort();
    expect(dirs).toEqual(registrySlugs);
  });

  it("ships exactly 11 built-in definitions", () => {
    expect(listAgentDirs()).toHaveLength(11);
    expect(BUILTIN_AGENT_REGISTRY).toHaveLength(11);
  });
});

describe("built-in agent.md files — per-slug contract", () => {
  for (const entry of BUILTIN_AGENT_REGISTRY) {
    describe(entry.slug, () => {
      it("parses under agentDefinitionSchema", () => {
        expect(() => loadAgentDefinition(entry.slug)).not.toThrow();
      });

      it("slug matches the directory name and the slug grammar", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        expect(definition.slug).toBe(entry.slug);
        expect(definition.slug).toMatch(AGENT_SLUG_PATTERN);
      });

      it("is kind:builtin with a stop_warning present", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        expect(definition.kind).toBe("builtin");
        expect(definition.stop_warning).toBeDefined();
      });

      it("stop_warning is byte-identical to the registry entry (§12.1)", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        expect(definition.stop_warning).toEqual(entry.stopWarning);
      });

      it("name and description are byte-identical to the registry entry (§12.1 fallback-identity sync)", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        // The registry is the §6.1 step-3 fallback identity synthesised when a
        // built-in's agent.md is missing. `name` and `description` are the two
        // registry-carried identity fields not already asserted above
        // (alongside stop_warning / process_key / cron / enabled). If the YAML
        // drifts from the registry on either, an operator sees a different
        // identity depending on whether the file loaded — so keep them in
        // lock-step, exactly as §12.1 requires for stop_warning.
        expect(definition.name).toBe(entry.name);
        expect(definition.description).toBe(entry.description);
      });

      it("backend.process_key matches the registry (and is a known key when non-null)", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        expect(definition.backend.process_key).toBe(entry.processKey);
        if (definition.backend.process_key !== null) {
          expect(isProcessKey(definition.backend.process_key)).toBe(true);
        }
      });

      it("cron resolves to the registry expression under the default dayBoundaryHour", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        expect(definition.schedule.kind).toBe("cron");
        const yamlExpr = definition.schedule.expression;
        expect(yamlExpr).toBeDefined();

        const resolved = substituteCron(yamlExpr!, {
          dayBoundaryHour: DEFAULT_DAY_BOUNDARY_HOUR,
        });
        // Resolution must leave no `{...}` placeholder and a well-formed shape.
        expect(validateCronExpression(resolved)).toBeNull();

        if (entry.cronExpression === null) {
          // Runtime-window builtin (activity-scan): the registry resolver is
          // null and the loader's drift check is a no-op (§5.5.1). The YAML
          // literal is self-documenting only and must not be scheduled from.
          expect(checkCronDrift(resolved, null)).toBeNull();
        } else {
          const registryExpr = entry.cronExpression({
            dayBoundaryHour: DEFAULT_DAY_BOUNDARY_HOUR,
          });
          expect(resolved).toBe(registryExpr);
          expect(checkCronDrift(resolved, registryExpr)).toBeNull();
        }
      });

      it("enabled reflects the registry's shipped default", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        expect(definition.enabled).toBe(entry.defaultEnabled);
      });

      it("description is non-empty and the body is a non-empty pointer (no inlined prompt body)", () => {
        const { definition, body } = loadAgentDefinition(entry.slug);
        expect(definition.description.length).toBeGreaterThan(0);
        // Q2 v1 pick: a short canonical pointer, not the inlined task-flow.
        expect(body.length).toBeGreaterThan(0);
      });

      it("success_criteria ids are unique (schema-enforced) and only use the {date} placeholder", () => {
        const { definition } = loadAgentDefinition(entry.slug);
        const ids = definition.success_criteria.map((criterion) => criterion.id);
        expect(new Set(ids).size).toBe(ids.length);
        // The v1 evaluator substitutes `{date}` only; a criterion target that
        // smuggles `{week}`/`{month}` would silently never match. Those
        // week/month-keyed outputs live in `outputs`, not `success_criteria`.
        for (const criterion of definition.success_criteria) {
          if ("target" in criterion) {
            expect(criterion.target).not.toMatch(/\{(?!date\})[^}]*\}/);
          }
        }
      });
    });
  }
});

describe("built-in agent.md files — registry lookup helpers agree with disk", () => {
  it("getBuiltinRegistryEntry resolves every shipped slug", () => {
    for (const dir of listAgentDirs()) {
      expect(getBuiltinRegistryEntry(dir)).toBeDefined();
      expect(BUILTIN_AGENT_REGISTRY_BY_SLUG.get(dir)?.slug).toBe(dir);
    }
  });
});
