import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  RUNTIME_AVAILABLE_BACKEND_IDS,
  isBackendId,
  isRuntimeAvailableBackendId,
} from "@aitne/shared";
import type { BackendId } from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import {
  createDefaultBangCommandRegistry,
  createUserBangCommand,
  DEFAULT_USER_BANG_COMMAND_SKILLS,
  deleteUserBangCommand,
  getBangCommandName,
  getUserBangCommandByCommand,
  getUserBangCommandById,
  listUserBangCommands,
  normalizeBangCommandName,
  updateUserBangCommand,
  USER_BANG_COMMAND_NAME_PATTERN,
  type UserBangCommandInput,
} from "../../core/bang-commands/index.js";
import { getModelsForBackend } from "../../core/backends/model-registry.js";

const SKILL_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_INSTRUCTION_MD_LENGTH = 32_000;

const userCommandSchema = z.object({
  name: z.string().min(1).max(33),
  description: z.string().max(160).optional().default(""),
  prompt: z.string().trim().min(1).max(8000),
  backendId: z.string().refine(isBackendId),
  modelId: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional().default(true),
  // Per-command skill selection. `null` keeps the legacy default (notify).
  // An empty array means "no skills" — the agent runs with safety + character
  // + custom instructions only. Undefined is treated the same as null for
  // backward-compatible PUT requests from older clients.
  enabledSkills: z
    .array(z.string().regex(SKILL_SLUG_PATTERN))
    .nullable()
    .optional(),
  // Custom CLAUDE.md / AGENTS.md / GEMINI.md profile body. Empty/whitespace
  // is normalised to null at the storage layer.
  instructionMd: z
    .string()
    .max(MAX_INSTRUCTION_MD_LENGTH)
    .nullable()
    .optional(),
});

/**
 * Enumerate the daemon's built-in skill slugs from disk. A directory only
 * counts when it both:
 *  - matches the strict-kebab slug pattern (defends against accidental
 *    dotfiles, scratch dirs, or path-traversal-shaped names), AND
 *  - contains a `SKILL.md` (the file the SDK actually loads).
 *
 * The materializer skips dirs without `SKILL.md` silently, so without
 * this filter a half-authored skill would show up in the dashboard's
 * checkbox grid and the user could "enable" something that has no
 * effect at runtime.
 */
function listAvailableBuiltinSkillSlugs(workspaceDir: string): Set<string> {
  const root = resolve(workspaceDir, "agent-assets", "skills");
  if (!existsSync(root)) return new Set();
  const slugs = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!SKILL_SLUG_PATTERN.test(entry.name)) continue;
    if (!existsSync(join(root, entry.name, "SKILL.md"))) continue;
    slugs.add(entry.name);
  }
  return slugs;
}

export function createCommandsRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db, config } = deps;
  const builtInRegistry = createDefaultBangCommandRegistry();
  const reservedCommands = new Set(
    builtInRegistry.list().map((cmd) => getBangCommandName(cmd)),
  );
  const workspaceDir = config.workspaceDir ?? process.cwd();
  // Capture the available skill slug list once at server boot — this set
  // ships with the daemon and never changes at runtime, so we don't need
  // a per-request stat. The validator below rejects unknown slugs so the
  // dashboard can surface "skill X doesn't exist" before saving.
  const availableSkillSlugs = listAvailableBuiltinSkillSlugs(workspaceDir);

  function serialize() {
    return {
      builtInCommands: builtInRegistry.list().map((cmd) => {
        const command = getBangCommandName(cmd);
        return {
          command,
          name: command.startsWith("!") ? command.slice(1) : command,
          title: cmd.title ?? command,
          description: cmd.describe,
          details: cmd.details ?? [],
          kind: "built_in" as const,
          enabled: true,
          runsBackend: false,
          availableWhilePaused: "name" in cmd,
        };
      }),
      userCommands: listUserBangCommands(db),
      constraints: {
        namePattern: USER_BANG_COMMAND_NAME_PATTERN.source,
        maxPromptLength: 8000,
        maxInstructionMdLength: MAX_INSTRUCTION_MD_LENGTH,
        reservedCommands: [...reservedCommands],
        availableSkills: [...availableSkillSlugs].sort(),
        defaultSkills: [...DEFAULT_USER_BANG_COMMAND_SKILLS],
      },
    };
  }

  function parseId(raw: string): number | null {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function validateInput(
    body: unknown,
    options: { existingId?: number } = {},
  ):
    | { ok: true; input: UserBangCommandInput }
    | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> } {
    const parsed = userCommandSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        body: { error: "validation_error", details: parsed.error.flatten() },
      };
    }

    const normalized = normalizeBangCommandName(parsed.data.name);
    if (!normalized.ok) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_command_name",
          message:
            "Command names may contain lowercase letters, numbers, hyphens, and underscores.",
        },
      };
    }

    if (reservedCommands.has(normalized.command)) {
      return {
        ok: false,
        status: 409,
        body: {
          error: "reserved_command",
          message: `${normalized.command} is a built-in command.`,
        },
      };
    }

    const existing = getUserBangCommandByCommand(db, normalized.command);
    if (existing && existing.id !== options.existingId) {
      return {
        ok: false,
        status: 409,
        body: {
          error: "duplicate_command",
          message: `${normalized.command} is already configured.`,
        },
      };
    }

    const backendId = parsed.data.backendId as BackendId;
    // Bang commands fire through the BackendRouter at run time. Reject any
    // backend that is type-system-registered but does not have an
    // `IAgentCore` wired into the router yet (Phase 1 = opencode). Without
    // this gate, a saved row would persist and dispatch later with
    // `BackendDecisiveFailure(model_unavailable)` from
    // `BackendRouter.requireCore` — much harder to debug than a clear
    // 400 at create time.
    if (!isRuntimeAvailableBackendId(backendId)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "backend_not_runtime_supported",
          message: `Backend "${backendId}" is registered but not yet supported at runtime in this build. Pick one of: ${RUNTIME_AVAILABLE_BACKEND_IDS.join(", ")}.`,
          backendId,
          runtimeAvailableBackends: [...RUNTIME_AVAILABLE_BACKEND_IDS],
        },
      };
    }
    const modelKnown = getModelsForBackend(backendId).some(
      (model) => model.modelId === parsed.data.modelId && model.available,
    );
    if (!modelKnown) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_model",
          message: `Model ${parsed.data.modelId} is not available for ${backendId}.`,
        },
      };
    }

    // Skill slugs are optional — undefined / null both leave the column at
    // SQL NULL (legacy default). When the array is provided, every slug must
    // resolve to a real skill on disk; otherwise the materializer would
    // silently drop it and the user would have no signal that their pick
    // didn't take effect.
    let normalizedSkills: string[] | null | undefined;
    if (parsed.data.enabledSkills === undefined) {
      normalizedSkills = undefined;
    } else if (parsed.data.enabledSkills === null) {
      normalizedSkills = null;
    } else {
      const cleaned = parsed.data.enabledSkills.map((slug) => slug.trim());
      const unknown = cleaned.filter((slug) => !availableSkillSlugs.has(slug));
      if (unknown.length > 0) {
        return {
          ok: false,
          status: 400,
          body: {
            error: "invalid_skill_slug",
            message: `Unknown skill slug(s): ${unknown.join(", ")}.`,
          },
        };
      }
      normalizedSkills = Array.from(new Set(cleaned));
    }

    return {
      ok: true,
      input: {
        name: normalized.name,
        description: parsed.data.description,
        prompt: parsed.data.prompt,
        backendId,
        modelId: parsed.data.modelId,
        enabled: parsed.data.enabled,
        enabledSkills: normalizedSkills,
        instructionMd: parsed.data.instructionMd ?? null,
      },
    };
  }

  app.get("/commands", (c) => c.json(serialize()));

  app.post("/commands", async (c) => {
    const body = await c.req.json().catch(() => null);
    const validated = validateInput(body);
    if (!validated.ok) {
      return c.json(validated.body, validated.status);
    }

    try {
      createUserBangCommand(db, validated.input);
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) {
        return c.json({ error: "duplicate_command" }, 409);
      }
      throw err;
    }
    return c.json(serialize(), 201);
  });

  app.put("/commands/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "invalid_id" }, 400);
    }
    if (!getUserBangCommandById(db, id)) {
      return c.json({ error: "not_found" }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const validated = validateInput(body, { existingId: id });
    if (!validated.ok) {
      return c.json(validated.body, validated.status);
    }

    try {
      const updated = updateUserBangCommand(db, id, validated.input);
      if (!updated) {
        return c.json({ error: "not_found" }, 404);
      }
    } catch (err) {
      if (err instanceof Error && /UNIQUE/.test(err.message)) {
        return c.json({ error: "duplicate_command" }, 409);
      }
      throw err;
    }
    return c.json(serialize());
  });

  app.delete("/commands/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "invalid_id" }, 400);
    }
    if (!deleteUserBangCommand(db, id)) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(serialize());
  });

  return app;
}
