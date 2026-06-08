import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { EventPriority, type MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import {
  CUSTOM_BANG_COMMAND_SOURCE,
  DEFAULT_USER_BANG_COMMAND_SKILLS,
  buildUserBangCommandPrompt,
  createUserBangCommand,
  createUserBangCommandEvent,
  deleteUserBangCommand,
  getEnabledUserBangCommandByCommand,
  getUserBangCommandByCommand,
  getUserBangCommandById,
  listUserBangCommands,
  normalizeBangCommandName,
  parseEnabledSkills,
  resolveCommandSkillSlugs,
  serializeEnabledSkills,
  updateUserBangCommand,
  type UserBangCommand,
} from "./user-commands.js";

/**
 * `serializeEnabledSkills` / `parseEnabledSkills` are the JSON boundary
 * between the `UserBangCommand` shape and the SQL TEXT column. They round
 * three distinct states — null (legacy default), empty array (explicit
 * "no skills"), and non-empty array — and tolerate corrupt rows without
 * crashing the materializer.
 */
describe("serializeEnabledSkills / parseEnabledSkills", () => {
  it("round-trips a non-empty slug list verbatim", () => {
    const serialized = serializeEnabledSkills(["notify", "context"]);
    expect(serialized).toBe('["notify","context"]');
    expect(parseEnabledSkills(serialized)).toEqual(["notify", "context"]);
  });

  it("round-trips an empty array as the explicit \"no skills\" state", () => {
    const serialized = serializeEnabledSkills([]);
    expect(serialized).toBe("[]");
    expect(parseEnabledSkills(serialized)).toEqual([]);
  });

  it("maps null and undefined inputs to a SQL NULL", () => {
    expect(serializeEnabledSkills(null)).toBeNull();
    expect(serializeEnabledSkills(undefined)).toBeNull();
  });

  it("maps a SQL NULL back to null at the model layer", () => {
    expect(parseEnabledSkills(null)).toBeNull();
  });

  it("strips whitespace and drops empty slugs at serialize time", () => {
    const serialized = serializeEnabledSkills([" notify ", "", "context"]);
    expect(parseEnabledSkills(serialized)).toEqual(["notify", "context"]);
  });

  it("treats malformed JSON as null (legacy default fallback)", () => {
    expect(parseEnabledSkills("{not valid json")).toBeNull();
  });

  it("filters out non-string entries from a structurally valid array", () => {
    // Defensive: a future migration mistake or hand-edited row could put
    // numbers/objects in there; the materializer must not crash on it.
    expect(parseEnabledSkills('["notify",1,null,"context"]')).toEqual([
      "notify",
      "context",
    ]);
  });

  it("treats a non-array JSON value as null", () => {
    expect(parseEnabledSkills('"notify"')).toBeNull();
    expect(parseEnabledSkills("42")).toBeNull();
    expect(parseEnabledSkills('{"notify":true}')).toBeNull();
  });
});

/**
 * `resolveCommandSkillSlugs` is the single source of truth for the
 * "legacy NULL → notify" contract. The dispatcher and any future caller
 * should go through this helper so the default lives in one place.
 */
describe("resolveCommandSkillSlugs", () => {
  it("returns the configured list when set", () => {
    expect(resolveCommandSkillSlugs({ enabledSkills: ["notify", "today"] })).toEqual([
      "notify",
      "today",
    ]);
  });

  it("returns an empty list when explicitly empty", () => {
    expect(resolveCommandSkillSlugs({ enabledSkills: [] })).toEqual([]);
  });

  it("falls back to the default skill set on legacy NULL", () => {
    expect(resolveCommandSkillSlugs({ enabledSkills: null })).toEqual(
      DEFAULT_USER_BANG_COMMAND_SKILLS,
    );
  });

  it("the default skill set is exactly `[\"notify\"]`", () => {
    // Pin the contract — any change here is a deliberate UX decision and
    // should be paired with a dashboard release note.
    expect(DEFAULT_USER_BANG_COMMAND_SKILLS).toEqual(["notify"]);
  });
});

// ── normalizeBangCommandName ──────────────────────────────────────────────────

describe("normalizeBangCommandName", () => {
  it("returns {ok:false, reason:'empty'} for an empty string", () => {
    expect(normalizeBangCommandName("")).toEqual({ ok: false, reason: "empty" });
  });

  it("returns {ok:false, reason:'empty'} for whitespace-only input", () => {
    expect(normalizeBangCommandName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("returns {ok:false, reason:'empty'} for a bare '!' with nothing after it", () => {
    expect(normalizeBangCommandName("!")).toEqual({ ok: false, reason: "empty" });
  });

  it("returns {ok:false, reason:'invalid'} for names with invalid characters", () => {
    expect(normalizeBangCommandName("hello world")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeBangCommandName("hello@world")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeBangCommandName("hello.world")).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns {ok:false, reason:'invalid'} for names starting with a non-alphanumeric character", () => {
    expect(normalizeBangCommandName("-bad")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeBangCommandName("_bad")).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns {ok:false, reason:'invalid'} for names exceeding 32 characters", () => {
    // 33 lowercase letters — exceeds the 0-31 range in the pattern
    expect(normalizeBangCommandName("a".repeat(33))).toEqual({ ok: false, reason: "invalid" });
  });

  it("accepts a plain lowercase alphanumeric name without '!' prefix", () => {
    expect(normalizeBangCommandName("standup")).toEqual({
      ok: true,
      name: "standup",
      command: "!standup",
    });
  });

  it("strips the '!' prefix and normalizes to lowercase", () => {
    expect(normalizeBangCommandName("!standup")).toEqual({
      ok: true,
      name: "standup",
      command: "!standup",
    });
  });

  it("converts uppercase to lowercase and trims surrounding whitespace", () => {
    expect(normalizeBangCommandName("  STANDUP  ")).toEqual({
      ok: true,
      name: "standup",
      command: "!standup",
    });
  });

  it("accepts names with hyphens and underscores", () => {
    expect(normalizeBangCommandName("daily-standup")).toEqual({
      ok: true,
      name: "daily-standup",
      command: "!daily-standup",
    });
    expect(normalizeBangCommandName("daily_standup")).toEqual({
      ok: true,
      name: "daily_standup",
      command: "!daily_standup",
    });
  });

  it("accepts exactly 32-character names (boundary)", () => {
    const name = "a" + "b".repeat(31); // 32 chars: 'a' + 31 'b's
    expect(normalizeBangCommandName(name)).toEqual({
      ok: true,
      name,
      command: `!${name}`,
    });
  });
});

// ── CRUD lifecycle (in-memory SQLite) ────────────────────────────────────────

describe("createUserBangCommand / getUserBangCommandById / listUserBangCommands", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a command and retrieves it by id with all fields correct", () => {
    const created = createUserBangCommand(db, {
      name: "standup",
      description: "Daily standup summary",
      prompt: "Summarize today's standup.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
      enabledSkills: ["notify", "context"],
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.command).toBe("!standup");
    expect(created.name).toBe("standup");
    expect(created.description).toBe("Daily standup summary");
    expect(created.prompt).toBe("Summarize today's standup.");
    expect(created.backendId).toBe("claude");
    expect(created.modelId).toBe("claude-sonnet-4-6");
    expect(created.enabled).toBe(true);
    expect(created.enabledSkills).toEqual(["notify", "context"]);
    expect(created.instructionMd).toBeNull();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
  });

  it("stores enabled=false correctly", () => {
    const cmd = createUserBangCommand(db, {
      name: "draft",
      prompt: "Draft a reply.",
      backendId: "codex",
      modelId: "gpt-4o",
      enabled: false,
    });

    expect(cmd.enabled).toBe(false);
  });

  it("defaults enabled to true when omitted", () => {
    const cmd = createUserBangCommand(db, {
      name: "check",
      prompt: "Check mail.",
      backendId: "gemini",
      modelId: "gemini-2.5-pro",
    });

    expect(cmd.enabled).toBe(true);
  });

  it("stores instructionMd when provided", () => {
    const md = "You are a concise assistant.";
    const cmd = createUserBangCommand(db, {
      name: "concise",
      prompt: "Be concise.",
      backendId: "claude",
      modelId: "claude-haiku-4-6",
      instructionMd: md,
    });

    expect(cmd.instructionMd).toBe(md);
  });

  it("coerces a whitespace-only instructionMd to null", () => {
    const cmd = createUserBangCommand(db, {
      name: "whitespace-md",
      prompt: "Whitespace profile.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      instructionMd: "   ",
    });

    expect(cmd.instructionMd).toBeNull();
  });

  it("stores null enabledSkills (legacy default) when omitted", () => {
    const cmd = createUserBangCommand(db, {
      name: "legacy",
      prompt: "Legacy command.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    expect(cmd.enabledSkills).toBeNull();
  });

  it("stores an empty enabledSkills array as the explicit 'no skills' state", () => {
    const cmd = createUserBangCommand(db, {
      name: "noskills",
      prompt: "No skills needed.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabledSkills: [],
    });

    expect(cmd.enabledSkills).toEqual([]);
  });

  it("throws on invalid command name during create", () => {
    expect(() =>
      createUserBangCommand(db, {
        name: "bad name!",
        prompt: "Should fail.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    ).toThrow("Invalid command name");
  });

  it("throws on empty command name during create", () => {
    expect(() =>
      createUserBangCommand(db, {
        name: "",
        prompt: "Should fail.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    ).toThrow("Invalid command name");
  });

  it("listUserBangCommands returns all rows ordered by command ASC", () => {
    createUserBangCommand(db, {
      name: "zzz",
      prompt: "Last alphabetically.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });
    createUserBangCommand(db, {
      name: "aaa",
      prompt: "First alphabetically.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });
    createUserBangCommand(db, {
      name: "mmm",
      prompt: "Middle alphabetically.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    const list = listUserBangCommands(db);
    expect(list.map((c) => c.command)).toEqual(["!aaa", "!mmm", "!zzz"]);
  });

  it("listUserBangCommands returns an empty array when the table is empty", () => {
    expect(listUserBangCommands(db)).toEqual([]);
  });

  it("getUserBangCommandById returns null for a non-existent id", () => {
    expect(getUserBangCommandById(db, 9999)).toBeNull();
  });
});

// ── getEnabledUserBangCommandByCommand / getUserBangCommandByCommand ──────────

describe("getEnabledUserBangCommandByCommand / getUserBangCommandByCommand", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("getEnabledUserBangCommandByCommand returns the command when enabled", () => {
    createUserBangCommand(db, {
      name: "report",
      prompt: "Generate a report.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });

    const found = getEnabledUserBangCommandByCommand(db, "!report");
    expect(found).not.toBeNull();
    expect(found!.command).toBe("!report");
    expect(found!.enabled).toBe(true);
  });

  it("getEnabledUserBangCommandByCommand returns null when the command is disabled", () => {
    createUserBangCommand(db, {
      name: "disabled",
      prompt: "This is disabled.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: false,
    });

    expect(getEnabledUserBangCommandByCommand(db, "!disabled")).toBeNull();
  });

  it("getEnabledUserBangCommandByCommand returns null for unknown command", () => {
    expect(getEnabledUserBangCommandByCommand(db, "!unknown")).toBeNull();
  });

  it("getEnabledUserBangCommandByCommand normalizes case and trims whitespace", () => {
    createUserBangCommand(db, {
      name: "ping",
      prompt: "Ping.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });

    const found = getEnabledUserBangCommandByCommand(db, "  !PING  ");
    expect(found).not.toBeNull();
    expect(found!.command).toBe("!ping");
  });

  it("getUserBangCommandByCommand returns disabled commands too", () => {
    createUserBangCommand(db, {
      name: "hidden",
      prompt: "Hidden command.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: false,
    });

    const found = getUserBangCommandByCommand(db, "!hidden");
    expect(found).not.toBeNull();
    expect(found!.enabled).toBe(false);
  });

  it("getUserBangCommandByCommand returns null for unknown command", () => {
    expect(getUserBangCommandByCommand(db, "!notexist")).toBeNull();
  });

  it("getUserBangCommandByCommand normalizes the lookup value", () => {
    createUserBangCommand(db, {
      name: "hello",
      prompt: "Say hello.",
      backendId: "gemini",
      modelId: "gemini-2.5-pro",
    });

    const found = getUserBangCommandByCommand(db, "!HELLO");
    expect(found).not.toBeNull();
    expect(found!.backendId).toBe("gemini");
  });
});

// ── updateUserBangCommand ─────────────────────────────────────────────────────

describe("updateUserBangCommand", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("updates all mutable fields and returns the new state", () => {
    const original = createUserBangCommand(db, {
      name: "update-me",
      description: "Original description",
      prompt: "Original prompt.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
      enabled: true,
    });

    const updated = updateUserBangCommand(db, original.id, {
      name: "update-me",
      description: "New description",
      prompt: "New prompt.",
      backendId: "codex",
      modelId: "gpt-4o",
      enabled: false,
      enabledSkills: ["notify"],
      instructionMd: "Custom profile.",
    });

    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("New description");
    expect(updated!.prompt).toBe("New prompt.");
    expect(updated!.backendId).toBe("codex");
    expect(updated!.modelId).toBe("gpt-4o");
    expect(updated!.enabled).toBe(false);
    expect(updated!.enabledSkills).toEqual(["notify"]);
    expect(updated!.instructionMd).toBe("Custom profile.");
  });

  it("can rename the command slug during an update", () => {
    const original = createUserBangCommand(db, {
      name: "old-name",
      prompt: "Old prompt.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    const updated = updateUserBangCommand(db, original.id, {
      name: "new-name",
      prompt: "Old prompt.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    expect(updated).not.toBeNull();
    expect(updated!.command).toBe("!new-name");
    expect(updated!.name).toBe("new-name");
  });

  it("returns null for a non-existent id", () => {
    expect(
      updateUserBangCommand(db, 9999, {
        name: "ghost",
        prompt: "Ghost prompt.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBeNull();
  });

  it("throws on an invalid name during update", () => {
    const cmd = createUserBangCommand(db, {
      name: "valid",
      prompt: "Valid.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    expect(() =>
      updateUserBangCommand(db, cmd.id, {
        name: "invalid name!",
        prompt: "Still valid prompt.",
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
      }),
    ).toThrow("Invalid command name");
  });
});

// ── deleteUserBangCommand ─────────────────────────────────────────────────────

describe("deleteUserBangCommand", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("deletes an existing command and returns true", () => {
    const cmd = createUserBangCommand(db, {
      name: "todelete",
      prompt: "Delete me.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    expect(deleteUserBangCommand(db, cmd.id)).toBe(true);
    expect(getUserBangCommandById(db, cmd.id)).toBeNull();
  });

  it("returns false for a non-existent id", () => {
    expect(deleteUserBangCommand(db, 9999)).toBe(false);
  });

  it("removes the command from listUserBangCommands after deletion", () => {
    const cmd = createUserBangCommand(db, {
      name: "ephemeral",
      prompt: "Ephemeral command.",
      backendId: "claude",
      modelId: "claude-sonnet-4-6",
    });

    deleteUserBangCommand(db, cmd.id);
    expect(listUserBangCommands(db)).toEqual([]);
  });
});

// ── rowToUserBangCommand null branch (invalid backend_id) ────────────────────

describe("listUserBangCommands — rowToUserBangCommand null branch", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Apply the schema but then remove the CHECK constraint by recreating the
    // table without it so we can insert a row with an invalid backend_id.
    applySchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_bang_commands_raw (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        enabled_skills_json TEXT,
        instruction_md TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("silently drops rows with an invalid backend_id from listUserBangCommands", () => {
    // Insert a corrupt row directly, bypassing the CHECK constraint by
    // using a shadow table and then copying into the real one via ATTACH trick.
    // Since SQLite enforces CHECK in the real table, we bypass by inserting
    // with a valid id via the raw table and then copying with INSERT OR IGNORE.
    // The simplest approach: drop and recreate the table without the CHECK.
    db.exec("DROP TABLE IF EXISTS user_bang_commands");
    db.exec(`
      CREATE TABLE user_bang_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        enabled_skills_json TEXT,
        instruction_md TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.prepare(
      `INSERT INTO user_bang_commands (command, description, prompt, backend_id, model_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("!badrow", "corrupt row", "Corrupt.", "invalid_backend", "some-model", 1);

    // The corrupt row should be silently filtered out
    const result = listUserBangCommands(db);
    expect(result).toEqual([]);
  });

  it("valid rows adjacent to corrupt rows are still returned", () => {
    db.exec("DROP TABLE IF EXISTS user_bang_commands");
    db.exec(`
      CREATE TABLE user_bang_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        enabled_skills_json TEXT,
        instruction_md TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert one corrupt row and one valid row
    db.prepare(
      `INSERT INTO user_bang_commands (command, description, prompt, backend_id, model_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("!badrow", "corrupt", "Corrupt.", "invalid_backend", "some-model", 1);

    db.prepare(
      `INSERT INTO user_bang_commands (command, description, prompt, backend_id, model_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("!goodrow", "valid", "Valid prompt.", "claude", "claude-sonnet-4-6", 1);

    const result = listUserBangCommands(db);
    expect(result).toHaveLength(1);
    expect(result[0].command).toBe("!goodrow");
    expect(result[0].backendId).toBe("claude");
  });

  it("rowToUserBangCommand derives name from command even when stored without ! prefix (legacy row)", () => {
    // The normal API always stores commands with a leading '!' via
    // normalizeBangCommandName. This test exercises the false branch of
    // `row.command.startsWith("!") ? row.command.slice(1) : row.command`
    // by inserting a legacy row directly.
    db.exec("DROP TABLE IF EXISTS user_bang_commands");
    db.exec(`
      CREATE TABLE user_bang_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        enabled_skills_json TEXT,
        instruction_md TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert a row whose command does NOT start with '!'
    db.prepare(
      `INSERT INTO user_bang_commands (command, description, prompt, backend_id, model_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("legacycmd", "no-bang legacy", "Do the thing.", "claude", "claude-sonnet-4-6", 1);

    const result = listUserBangCommands(db);
    expect(result).toHaveLength(1);
    // command stored as-is, name equals command (no slice)
    expect(result[0].command).toBe("legacycmd");
    expect(result[0].name).toBe("legacycmd");
  });
});

// ── buildUserBangCommandPrompt ────────────────────────────────────────────────

describe("buildUserBangCommandPrompt", () => {
  const baseEvent: MessageEvent = {
    type: "message.received",
    source: "telegram",
    platform: "telegram",
    priority: EventPriority.HIGH,
    timestamp: new Date(),
    data: { text: "!standup" },
    correlationId: "orig-id",
    content: "!standup",
    sender: "owner",
    channel: "dm",
    threadId: null,
    isDm: true,
    isMention: false,
  };

  const baseCommand: UserBangCommand = {
    id: 1,
    command: "!standup",
    name: "standup",
    description: "Daily standup summary",
    prompt: "Summarize today's standup for the team.",
    backendId: "claude",
    modelId: "claude-sonnet-4-6",
    enabled: true,
    enabledSkills: ["notify"],
    instructionMd: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("includes the command string in the output", () => {
    const prompt = buildUserBangCommandPrompt(baseCommand, baseEvent);
    expect(prompt).toContain("!standup");
  });

  it("includes the platform in the output", () => {
    const prompt = buildUserBangCommandPrompt(baseCommand, baseEvent);
    expect(prompt).toContain("telegram");
  });

  it("includes the description when non-empty", () => {
    const prompt = buildUserBangCommandPrompt(baseCommand, baseEvent);
    expect(prompt).toContain("Daily standup summary");
  });

  it("omits the description line when description is empty", () => {
    const cmdNoDesc = { ...baseCommand, description: "" };
    const prompt = buildUserBangCommandPrompt(cmdNoDesc, baseEvent);
    expect(prompt).not.toContain("Description:");
  });

  it("includes the prompt body verbatim (trimmed)", () => {
    const cmdWithSpaces = { ...baseCommand, prompt: "  Summarize today's standup.  " };
    const prompt = buildUserBangCommandPrompt(cmdWithSpaces, baseEvent);
    expect(prompt).toContain("Summarize today's standup.");
  });

  it("includes the invocation context header", () => {
    const prompt = buildUserBangCommandPrompt(baseCommand, baseEvent);
    expect(prompt).toContain("Invocation context:");
  });

  it("produces a multi-line string with the command on the first line", () => {
    const prompt = buildUserBangCommandPrompt(baseCommand, baseEvent);
    const firstLine = prompt.split("\n")[0];
    expect(firstLine).toContain("!standup");
  });

  it("works with a different platform (slack)", () => {
    const slackEvent: MessageEvent = { ...baseEvent, platform: "slack", source: "slack" };
    const prompt = buildUserBangCommandPrompt(baseCommand, slackEvent);
    expect(prompt).toContain("slack");
    expect(prompt).not.toContain("telegram");
  });
});

// ── createUserBangCommandEvent ────────────────────────────────────────────────

describe("createUserBangCommandEvent", () => {
  const baseEvent: MessageEvent = {
    type: "message.received",
    source: "telegram",
    platform: "telegram",
    priority: EventPriority.NORMAL,
    timestamp: new Date("2024-01-01T10:00:00Z"),
    data: { text: "!report", extra: "value" },
    correlationId: "orig-corr-id",
    content: "!report",
    sender: "owner",
    channel: "dm",
    threadId: null,
    isDm: true,
    isMention: false,
  };

  const command: UserBangCommand = {
    id: 42,
    command: "!report",
    name: "report",
    description: "Weekly report",
    prompt: "Generate the weekly report.",
    backendId: "claude",
    modelId: "claude-sonnet-4-6",
    enabled: true,
    enabledSkills: ["notify", "context"],
    instructionMd: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("returns an event with type 'message.received'", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.type).toBe("message.received");
  });

  it("sets source to CUSTOM_BANG_COMMAND_SOURCE", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.source).toBe(CUSTOM_BANG_COMMAND_SOURCE);
    expect(result.source).toBe("bang-command");
  });

  it("sets priority to EventPriority.HIGH", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.priority).toBe(EventPriority.HIGH);
  });

  it("generates a fresh correlationId distinct from the original", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.correlationId).toBeDefined();
    expect(result.correlationId).not.toBe("orig-corr-id");
    // UUID v4 pattern
    expect(result.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sets requestedBackendId from the command's backendId", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.requestedBackendId).toBe("claude");
  });

  it("sets requestedModelId from the command's modelId", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.requestedModelId).toBe("claude-sonnet-4-6");
  });

  it("content contains the command string (via buildUserBangCommandPrompt)", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.content).toContain("!report");
  });

  it("content contains the platform from the original event", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.content).toContain("telegram");
  });

  it("preserves the original event's platform and extra data fields", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.platform).toBe("telegram");
    expect((result.data as Record<string, unknown>)["extra"]).toBe("value");
  });

  it("embeds the customBangCommand id and command in data", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    const data = result.data as Record<string, unknown>;
    expect(data["customBangCommand"]).toEqual({ id: 42, command: "!report" });
  });

  it("timestamp is a fresh Date (not the original event's timestamp)", () => {
    const result = createUserBangCommandEvent(baseEvent, command);
    expect(result.timestamp).toBeInstanceOf(Date);
    // The new timestamp should be at or after the original
    expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(
      new Date("2024-01-01T10:00:00Z").getTime(),
    );
  });

  it("works with a gemini backend command", () => {
    const geminiCommand: UserBangCommand = {
      ...command,
      backendId: "gemini",
      modelId: "gemini-2.5-pro",
    };
    const result = createUserBangCommandEvent(baseEvent, geminiCommand);
    expect(result.requestedBackendId).toBe("gemini");
    expect(result.requestedModelId).toBe("gemini-2.5-pro");
  });
});
