import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  EventPriority,
  isBackendId,
  type BackendId,
  type MessageEvent,
} from "@aitne/shared";

export const CUSTOM_BANG_COMMAND_SOURCE = "bang-command";
export const USER_BANG_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Default skill set for legacy commands (no enabled_skills_json column set).
 * Single-skill default: only `notify` is needed for the agent to send a
 * well-formed DM reply (awareness gate, no-ceremony rule, no-readback). Any
 * additional capability — context reads, schedule, mail, etc. — is opt-in
 * per command via the dashboard.
 */
export const DEFAULT_USER_BANG_COMMAND_SKILLS: readonly string[] = ["notify"];

export interface UserBangCommand {
  id: number;
  command: string;
  name: string;
  description: string;
  prompt: string;
  backendId: BackendId;
  modelId: string;
  enabled: boolean;
  /**
   * Skill slugs to materialize into the per-turn workdir. `null` means the
   * row was created before the feature shipped — runtime treats it as
   * `DEFAULT_USER_BANG_COMMAND_SKILLS` for backward compatibility. An empty
   * array means "no skills" (the agent gets only safety + character + custom
   * instructions).
   */
  enabledSkills: string[] | null;
  /**
   * Custom CLAUDE.md / AGENTS.md / GEMINI.md profile body. `null` keeps the
   * default conversational profile; non-null replaces the profile body
   * while safety preamble + character block + skills section are still
   * rendered around it.
   */
  instructionMd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserBangCommandInput {
  name: string;
  description?: string;
  prompt: string;
  backendId: BackendId;
  modelId: string;
  enabled?: boolean;
  enabledSkills?: string[] | null;
  instructionMd?: string | null;
}

interface UserBangCommandRow {
  id: number;
  command: string;
  description: string;
  prompt: string;
  backend_id: string;
  model_id: string;
  enabled: number;
  enabled_skills_json: string | null;
  instruction_md: string | null;
  created_at: string;
  updated_at: string;
}

export type NormalizeBangCommandNameResult =
  | { ok: true; name: string; command: string }
  | { ok: false; reason: "empty" | "invalid" };

export function normalizeBangCommandName(
  raw: string,
): NormalizeBangCommandNameResult {
  const trimmed = raw.trim().toLowerCase();
  const withoutBang = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
  if (withoutBang.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (!USER_BANG_COMMAND_NAME_PATTERN.test(withoutBang)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, name: withoutBang, command: `!${withoutBang}` };
}

const SELECT_COLUMNS = `id, command, description, prompt, backend_id, model_id,
              enabled, enabled_skills_json, instruction_md,
              created_at, updated_at`;

export function listUserBangCommands(
  db: Database.Database,
): UserBangCommand[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM user_bang_commands
        ORDER BY command ASC`,
    )
    .all() as UserBangCommandRow[];
  return rows.map(rowToUserBangCommand).filter(Boolean) as UserBangCommand[];
}

export function getEnabledUserBangCommandByCommand(
  db: Database.Database,
  command: string,
): UserBangCommand | null {
  const normalized = command.trim().toLowerCase();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM user_bang_commands
        WHERE command = ?
          AND enabled = 1
        LIMIT 1`,
    )
    .get(normalized) as UserBangCommandRow | undefined;
  return row ? rowToUserBangCommand(row) : null;
}

export function getUserBangCommandByCommand(
  db: Database.Database,
  command: string,
): UserBangCommand | null {
  const normalized = command.trim().toLowerCase();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM user_bang_commands
        WHERE command = ?
        LIMIT 1`,
    )
    .get(normalized) as UserBangCommandRow | undefined;
  return row ? rowToUserBangCommand(row) : null;
}

export function getUserBangCommandById(
  db: Database.Database,
  id: number,
): UserBangCommand | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM user_bang_commands
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id) as UserBangCommandRow | undefined;
  return row ? rowToUserBangCommand(row) : null;
}

export function createUserBangCommand(
  db: Database.Database,
  input: UserBangCommandInput,
): UserBangCommand {
  const normalized = normalizeBangCommandName(input.name);
  if (!normalized.ok) {
    throw new Error(`Invalid command name: ${normalized.reason}`);
  }
  const result = db
    .prepare(
      `INSERT INTO user_bang_commands (
         command, description, prompt, backend_id, model_id, enabled,
         enabled_skills_json, instruction_md,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(
      normalized.command,
      normalizeDescription(input.description),
      input.prompt.trim(),
      input.backendId,
      input.modelId.trim(),
      input.enabled === false ? 0 : 1,
      serializeEnabledSkills(input.enabledSkills),
      normalizeInstructionMd(input.instructionMd),
    );
  return getUserBangCommandById(db, Number(result.lastInsertRowid))!;
}

export function updateUserBangCommand(
  db: Database.Database,
  id: number,
  input: UserBangCommandInput,
): UserBangCommand | null {
  const normalized = normalizeBangCommandName(input.name);
  if (!normalized.ok) {
    throw new Error(`Invalid command name: ${normalized.reason}`);
  }
  const result = db
    .prepare(
      `UPDATE user_bang_commands
          SET command = ?,
              description = ?,
              prompt = ?,
              backend_id = ?,
              model_id = ?,
              enabled = ?,
              enabled_skills_json = ?,
              instruction_md = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
    .run(
      normalized.command,
      normalizeDescription(input.description),
      input.prompt.trim(),
      input.backendId,
      input.modelId.trim(),
      input.enabled === false ? 0 : 1,
      serializeEnabledSkills(input.enabledSkills),
      normalizeInstructionMd(input.instructionMd),
      id,
    );
  if (result.changes === 0) return null;
  return getUserBangCommandById(db, id);
}

export function deleteUserBangCommand(
  db: Database.Database,
  id: number,
): boolean {
  const result = db
    .prepare("DELETE FROM user_bang_commands WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function buildUserBangCommandPrompt(
  command: UserBangCommand,
  event: MessageEvent,
): string {
  const lines = [
    `The owner invoked custom messaging command ${command.command}.`,
    "",
    "Run this instruction exactly as the command definition:",
    "",
    command.prompt.trim(),
    "",
    "Invocation context:",
    `- Platform: ${event.platform}`,
    `- Command: ${command.command}`,
  ];
  if (command.description) {
    lines.push(`- Description: ${command.description}`);
  }
  return lines.join("\n");
}

export function createUserBangCommandEvent(
  event: MessageEvent,
  command: UserBangCommand,
): MessageEvent {
  return {
    ...event,
    type: "message.received",
    source: CUSTOM_BANG_COMMAND_SOURCE,
    priority: EventPriority.HIGH,
    timestamp: new Date(),
    data: {
      ...event.data,
      customBangCommand: {
        id: command.id,
        command: command.command,
      },
    },
    correlationId: randomUUID(),
    content: buildUserBangCommandPrompt(command, event),
    requestedBackendId: command.backendId,
    requestedModelId: command.modelId,
  };
}

/**
 * Resolve the effective skill slug list for a command at materialize time.
 * Legacy NULL → `DEFAULT_USER_BANG_COMMAND_SKILLS` (just `notify`); empty
 * array → no skills; non-empty → caller-specified set.
 */
export function resolveCommandSkillSlugs(
  command: Pick<UserBangCommand, "enabledSkills">,
): readonly string[] {
  return command.enabledSkills ?? DEFAULT_USER_BANG_COMMAND_SKILLS;
}

function rowToUserBangCommand(
  row: UserBangCommandRow,
): UserBangCommand | null {
  if (!isBackendId(row.backend_id)) {
    return null;
  }
  return {
    id: row.id,
    command: row.command,
    name: row.command.startsWith("!") ? row.command.slice(1) : row.command,
    description: row.description,
    prompt: row.prompt,
    backendId: row.backend_id,
    modelId: row.model_id,
    enabled: row.enabled === 1,
    enabledSkills: parseEnabledSkills(row.enabled_skills_json),
    instructionMd: row.instruction_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeDescription(description: string | undefined): string {
  return (description ?? "").trim();
}

/**
 * Round-trip the enabled skills array as compact JSON. `null` (or an
 * undefined input) maps to a literal SQL NULL so legacy rows are
 * indistinguishable from new rows the user has not customised.
 */
export function serializeEnabledSkills(
  skills: readonly string[] | null | undefined,
): string | null {
  if (skills === null || skills === undefined) return null;
  const cleaned = skills
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
  return JSON.stringify(cleaned);
}

/**
 * Inverse of `serializeEnabledSkills` — null DB → null model. Malformed JSON
 * is treated as null so a legacy/corrupt row doesn't crash the materializer
 * (it falls back to the default skill set).
 */
export function parseEnabledSkills(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

function normalizeInstructionMd(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
