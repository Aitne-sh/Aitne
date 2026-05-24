import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import { createCommandsRoutes } from "./commands.js";
import type { ApiDependencies } from "../server.js";

// ── Module-level overrides for selective per-test mocking ──────────────────
// vi.hoisted + vi.mock are hoisted by vitest above imports, so this pattern
// allows per-test overrides without affecting the full test suite.
const bangOverrides = vi.hoisted(() => ({
  getUserBangCommandByCommand: undefined as ((...args: unknown[]) => unknown) | undefined,
  createUserBangCommand: undefined as ((...args: unknown[]) => unknown) | undefined,
  updateUserBangCommand: undefined as ((...args: unknown[]) => unknown) | undefined,
  createDefaultBangCommandRegistry: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock("../../core/bang-commands/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/bang-commands/index.js")>(
    "../../core/bang-commands/index.js",
  );
  return {
    ...actual,
    getUserBangCommandByCommand: (...args: unknown[]) =>
      bangOverrides.getUserBangCommandByCommand
        ? bangOverrides.getUserBangCommandByCommand(...args)
        : actual.getUserBangCommandByCommand(
            args[0] as Database.Database,
            args[1] as string,
          ),
    createUserBangCommand: (...args: unknown[]) =>
      bangOverrides.createUserBangCommand
        ? bangOverrides.createUserBangCommand(...args)
        : actual.createUserBangCommand(
            args[0] as Database.Database,
            args[1] as Parameters<typeof actual.createUserBangCommand>[1],
          ),
    updateUserBangCommand: (...args: unknown[]) =>
      bangOverrides.updateUserBangCommand
        ? bangOverrides.updateUserBangCommand(...args)
        : actual.updateUserBangCommand(
            args[0] as Database.Database,
            args[1] as number,
            args[2] as Parameters<typeof actual.updateUserBangCommand>[2],
          ),
    createDefaultBangCommandRegistry: (...args: unknown[]) =>
      bangOverrides.createDefaultBangCommandRegistry
        ? bangOverrides.createDefaultBangCommandRegistry(...args)
        : actual.createDefaultBangCommandRegistry(),
  };
});

function makeDeps(db: Database.Database, workspaceDir = "."): ApiDependencies {
  return {
    db,
    config: { dataDir: "/tmp/test", workspaceDir },
  } as unknown as ApiDependencies;
}

describe("Commands API routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    bangOverrides.getUserBangCommandByCommand = undefined;
    bangOverrides.createUserBangCommand = undefined;
    bangOverrides.updateUserBangCommand = undefined;
    bangOverrides.createDefaultBangCommandRegistry = undefined;
  });

  it("lists built-in commands separately from user commands", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands");

    expect(res.status).toBe(200);
    const body = await res.json() as {
      builtInCommands: Array<{ command: string }>;
      userCommands: unknown[];
    };
    expect(body.builtInCommands.map((cmd) => cmd.command)).toContain("!start");
    expect(body.builtInCommands.map((cmd) => cmd.command)).toContain("!stop");
    expect(body.builtInCommands.map((cmd) => cmd.command)).toContain("!report");
    expect(body.userCommands).toEqual([]);
  });

  it("creates a user command with normalized command name", async () => {
    const app = createCommandsRoutes(makeDeps(db));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "!Digest",
        description: "Daily digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        enabled: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      userCommands: Array<{ command: string; name: string; backendId: string }>;
    };
    expect(body.userCommands).toEqual([
      expect.objectContaining({
        command: "!digest",
        name: "digest",
        backendId: "claude",
      }),
    ]);
  });

  it("rejects built-in command collisions", async () => {
    const app = createCommandsRoutes(makeDeps(db));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "start",
        prompt: "Try to collide.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("reserved_command");
  });

  it("rejects duplicate user command names", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const body = {
      name: "digest",
      prompt: "Summarize today.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    };
    await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, prompt: "Different prompt." }),
    });

    expect(res.status).toBe(409);
    const result = await res.json() as { error: string };
    expect(result.error).toBe("duplicate_command");
  });

  it("rejects models outside the selected backend", async () => {
    const app = createCommandsRoutes(makeDeps(db));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "codex",
        modelId: "claude-sonnet-4-6",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_model");
  });

  // docs/design/appendices/opencode-backend.md Phase 2 — opencode is now wired into
  // BackendRouter, so it joined `RUNTIME_AVAILABLE_BACKEND_IDS` and the
  // user-bang-command create path accepts it. The runtime gate still
  // rejects backends that aren't yet runtime-available (none today).
  it("accepts backendId='opencode' once Phase 2 wires OpencodeCore", async () => {
    const app = createCommandsRoutes(makeDeps(db));

    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "opencode",
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      userCommands: Array<{ name: string; backendId?: string }>;
    };
    const created = body.userCommands.find((row) => row.name === "digest");
    expect(created?.backendId).toBe("opencode");
  });

  it("updates and deletes a user command", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const createRes = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    const created = await createRes.json() as {
      userCommands: Array<{ id: number }>;
    };
    const id = created.userCommands[0]!.id;

    const updateRes = await app.request(`/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "daily",
        prompt: "Summarize this day.",
        backendId: "codex",
        modelId: "gpt-5.4-mini",
        enabled: false,
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as {
      userCommands: Array<{ command: string; enabled: boolean }>;
    };
    expect(updated.userCommands[0]).toEqual(
      expect.objectContaining({ command: "!daily", enabled: false }),
    );

    const deleteRes = await app.request(`/commands/${id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleted = await deleteRes.json() as { userCommands: unknown[] };
    expect(deleted.userCommands).toEqual([]);
  });

  it("round-trips enabledSkills and instructionMd", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        enabledSkills: ["notify"],
        instructionMd: "You are a terse summariser.",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      userCommands: Array<{
        enabledSkills: string[] | null;
        instructionMd: string | null;
      }>;
    };
    expect(body.userCommands[0]?.enabledSkills).toEqual(["notify"]);
    expect(body.userCommands[0]?.instructionMd).toBe("You are a terse summariser.");
  });

  it("rejects unknown skill slugs in enabledSkills", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        enabledSkills: ["notify", "does-not-exist"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_skill_slug");
    expect(body.message).toContain("does-not-exist");
  });

  it("accepts an empty enabledSkills array (no skills)", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "minimal",
        prompt: "Just reply.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        enabledSkills: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      userCommands: Array<{ enabledSkills: string[] | null }>;
    };
    expect(body.userCommands[0]?.enabledSkills).toEqual([]);
  });

  it("exposes availableSkills + defaultSkills in constraints", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      constraints: {
        availableSkills: string[];
        defaultSkills: string[];
        maxInstructionMdLength: number;
      };
    };
    expect(body.constraints.defaultSkills).toEqual(["notify"]);
    expect(body.constraints.availableSkills).toContain("notify");
    expect(body.constraints.maxInstructionMdLength).toBeGreaterThan(0);
  });

  // ── validateInput: normalizeBangCommandName failure paths ────────────────

  it("POST returns 400 invalid_command_name when name is only '!' (empty after strip)", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "!",
        prompt: "Do something.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_command_name");
  });

  it("POST returns 400 invalid_command_name when name contains disallowed characters (spaces)", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my command",
        prompt: "Do something.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_command_name");
  });

  // ── POST: invalid JSON body + UNIQUE constraint catch ────────────────────

  it("POST returns 400 validation_error when body is not valid JSON", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json-at-all",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("POST returns 409 duplicate_command when createUserBangCommand throws UNIQUE constraint", async () => {
    // Bypass validateInput's pre-check by making getUserBangCommandByCommand
    // return null, then force createUserBangCommand to throw UNIQUE to exercise
    // the catch branch (lines 237-240 in commands.ts).
    bangOverrides.getUserBangCommandByCommand = () => null;
    bangOverrides.createUserBangCommand = () => {
      throw new Error("UNIQUE constraint failed: user_bang_commands.command");
    };
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("duplicate_command");
  });

  // ── PUT: ID validation + not-found + concurrent-delete + UNIQUE catch ───

  it("PUT returns 400 invalid_id for a non-numeric command ID", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands/abc", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("PUT returns 400 invalid_id for ID zero (not a positive integer)", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands/0", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("PUT returns 404 not_found when the command ID does not exist in DB", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands/99999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("PUT returns 404 not_found when updateUserBangCommand signals concurrent delete", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    // Create a command first so getUserBangCommandById passes the existence check.
    const createRes = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    const created = await createRes.json() as { userCommands: Array<{ id: number }> };
    const id = created.userCommands[0]!.id;

    // Simulate the record being concurrently deleted between the existence check
    // and the update call (the defensive guard at lines 262-265 in commands.ts).
    bangOverrides.updateUserBangCommand = () => null;
    const res = await app.request(`/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "renamed",
        prompt: "New prompt.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("PUT returns 409 duplicate_command when updateUserBangCommand throws UNIQUE constraint", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const createRes = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    const created = await createRes.json() as { userCommands: Array<{ id: number }> };
    const id = created.userCommands[0]!.id;

    // Bypass validateInput's duplicate check, then force updateUserBangCommand
    // to throw UNIQUE to cover the PUT catch branch (lines 266-269).
    bangOverrides.getUserBangCommandByCommand = () => null;
    bangOverrides.updateUserBangCommand = () => {
      throw new Error("UNIQUE constraint failed: user_bang_commands.command");
    };
    const res = await app.request(`/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "collision",
        prompt: "Prompt.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("duplicate_command");
  });

  // ── DELETE: ID validation + not-found ───────────────────────────────────

  it("DELETE returns 400 invalid_id for a non-numeric command ID", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands/abc", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("DELETE returns 404 not_found for a valid format ID that has no record", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands/99999", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  // ── listAvailableBuiltinSkillSlugs: filesystem edge cases ───────────────

  it("falls back to process.cwd() when config.workspaceDir is undefined", () => {
    // Exercises the `config.workspaceDir ?? process.cwd()` fallback at
    // server-construction time. We don't care about the list contents —
    // we only need to prove the constructor doesn't throw when the
    // dashboard config omits workspaceDir entirely.
    const deps = {
      db,
      config: { dataDir: "/tmp/test" },
    } as unknown as ApiDependencies;
    expect(() => createCommandsRoutes(deps)).not.toThrow();
  });

  it("listAvailableBuiltinSkillSlugs ignores non-directories, pattern-mismatched dirs, and dirs without SKILL.md", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "pa-cmd-skills-"));
    const skillsRoot = join(workspaceDir, "agent-assets", "skills");
    mkdirSync(skillsRoot, { recursive: true });

    // Valid skill: directory + SKILL.md → should appear
    mkdirSync(join(skillsRoot, "valid-skill"));
    writeFileSync(join(skillsRoot, "valid-skill", "SKILL.md"), "# Valid");

    // Regular file (not a directory) → skipped by !entry.isDirectory()
    writeFileSync(join(skillsRoot, "readme.txt"), "I am a file");

    // Directory with uppercase → fails SKILL_SLUG_PATTERN → skipped
    mkdirSync(join(skillsRoot, "UPPERCASE"));

    // Directory without SKILL.md → skipped by !existsSync(SKILL.md)
    mkdirSync(join(skillsRoot, "no-skill-md"));

    try {
      const app = createCommandsRoutes(makeDeps(db, workspaceDir));
      const res = await app.request("/commands");
      expect(res.status).toBe(200);
      const body = await res.json() as { constraints: { availableSkills: string[] } };
      expect(body.constraints.availableSkills).toEqual(["valid-skill"]);
      expect(body.constraints.availableSkills).not.toContain("UPPERCASE");
      expect(body.constraints.availableSkills).not.toContain("no-skill-md");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("listAvailableBuiltinSkillSlugs returns empty set when agent-assets/skills does not exist", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "pa-cmd-noskills-"));
    try {
      const app = createCommandsRoutes(makeDeps(db, workspaceDir));
      const res = await app.request("/commands");
      expect(res.status).toBe(200);
      const body = await res.json() as { constraints: { availableSkills: string[] } };
      expect(body.constraints.availableSkills).toEqual([]);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  // ── serialize: branch for command names without '!' prefix ──────────────

  it("serialize returns non-bang command names without slicing", async () => {
    // Inject a minimal registry stub with a command whose name does NOT start
    // with '!' to cover the else-branch of the ternary on the `name` field in
    // serialize() (line 93 in commands.ts).
    bangOverrides.createDefaultBangCommandRegistry = () => ({
      list: () => [
        {
          name: "no-bang-prefix",
          title: "No Bang",
          describe: "Command without ! prefix",
          details: [] as string[],
          handler: async () => {},
        },
      ],
      register: () => {},
    });
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      builtInCommands: Array<{ command: string; name: string }>;
    };
    const cmd = body.builtInCommands.find((c) => c.command === "no-bang-prefix");
    expect(cmd).toBeDefined();
    // Without '!', the ternary returns cmd.name unchanged (no slice).
    expect(cmd?.name).toBe("no-bang-prefix");
  });

  // ── enabledSkills deduplication via Set ─────────────────────────────────

  it("deduplicates enabledSkills slugs via Set before storing", async () => {
    const app = createCommandsRoutes(makeDeps(db));
    // Pass the same valid slug twice — expect it stored only once.
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dedup",
        prompt: "Deduplicate slugs.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        enabledSkills: ["notify", "notify"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      userCommands: Array<{ enabledSkills: string[] | null }>;
    };
    expect(body.userCommands[0]?.enabledSkills).toEqual(["notify"]);
  });

  // ── enabledSkills: null → normalizedSkills = null ────────────────────────

  it("POST stores SQL NULL when enabledSkills is explicitly passed as null", async () => {
    // The `else if (parsed.data.enabledSkills === null)` branch in validateInput
    // maps null to normalizedSkills = null (distinct from undefined which means
    // "use legacy default"). This covers branch 193 / statement 194.
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        enabledSkills: null,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      userCommands: Array<{ enabledSkills: string[] | null }>;
    };
    expect(body.userCommands[0]?.enabledSkills).toBeNull();
  });

  // ── serialize: ?? fallback branches for title and details ────────────────

  it("serialize falls back to cmd.name when title is undefined and to [] when details is undefined", async () => {
    // Covers the `cmd.title ?? cmd.name` (branch at line 94) and
    // `cmd.details ?? []` (branch at line 96) null-coalescing fallback paths.
    // Both are hit when a registry command omits those optional fields.
    bangOverrides.createDefaultBangCommandRegistry = () => ({
      list: () => [
        {
          name: "!no-optional-fields",
          describe: "Command that omits title and details",
          // title: intentionally absent → cmd.title ?? cmd.name uses cmd.name
          // details: intentionally absent → cmd.details ?? [] uses []
          handler: async () => {},
        },
      ],
      register: () => {},
    });
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      builtInCommands: Array<{ command: string; title: string; details: unknown[] }>;
    };
    const cmd = body.builtInCommands.find((c) => c.command === "!no-optional-fields");
    expect(cmd).toBeDefined();
    // title ?? cmd.name fallback: uses the command name because title is undefined
    expect(cmd?.title).toBe("!no-optional-fields");
    // details ?? [] fallback: produces an empty array because details is undefined
    expect(cmd?.details).toEqual([]);
  });

  // ── POST catch: re-throw of non-UNIQUE errors ────────────────────────────

  it("POST propagates non-UNIQUE errors from createUserBangCommand as 500", async () => {
    // When createUserBangCommand throws an error that is NOT a UNIQUE constraint
    // violation, the catch block's `throw err` branch is taken (line 241).
    // Hono's default error handler converts the unhandled throw to a 500 response.
    bangOverrides.getUserBangCommandByCommand = () => null;
    bangOverrides.createUserBangCommand = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    const app = createCommandsRoutes(makeDeps(db));
    const res = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    // Hono catches the re-thrown error and returns 500.
    expect(res.status).toBe(500);
  });

  // ── PUT: validation failure branch (if !validated.ok) ───────────────────

  it("PUT returns 400 validation_error when body fails Zod schema validation", async () => {
    // Covers the `if (!validated.ok)` branch in the PUT handler (branch 257,
    // statements 258–259). All previous PUT tests that reach validateInput pass
    // valid bodies; this one deliberately sends an invalid body.
    const app = createCommandsRoutes(makeDeps(db));
    const createRes = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    const created = await createRes.json() as { userCommands: Array<{ id: number }> };
    const id = created.userCommands[0]!.id;

    // Body is missing required fields (prompt, backendId, modelId) — Zod rejects it.
    const res = await app.request(`/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "valid-name" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation_error");
  });

  // ── PUT catch: re-throw of non-UNIQUE errors ─────────────────────────────

  it("PUT propagates non-UNIQUE errors from updateUserBangCommand as 500", async () => {
    // When updateUserBangCommand throws an error that is NOT a UNIQUE constraint
    // violation, the PUT catch block's `throw err` branch is taken (line 270).
    const app = createCommandsRoutes(makeDeps(db));
    const createRes = await app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "digest",
        prompt: "Summarize today.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    const created = await createRes.json() as { userCommands: Array<{ id: number }> };
    const id = created.userCommands[0]!.id;

    bangOverrides.getUserBangCommandByCommand = () => null;
    bangOverrides.updateUserBangCommand = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    const res = await app.request(`/commands/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "renamed",
        prompt: "New prompt.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    });
    // Hono catches the re-thrown error and returns 500.
    expect(res.status).toBe(500);
  });
});
