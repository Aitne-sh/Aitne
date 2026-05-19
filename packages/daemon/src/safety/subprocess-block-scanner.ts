/**
 * Per-event absolute-block observability for CLI backends.
 *
 * Claude has a PreToolUse hook that authoritatively rejects matching tool
 * calls (`claude-tool-collection.ts:makeAbsoluteBlockHook`). Codex (sandbox)
 * and Gemini (admin TOML) enforce their own rejection layers, but those
 * happen inside the subprocess where the daemon can't observe directly.
 *
 * This module gives the daemon a stream-side observability hook: when a
 * `tool_use`-shaped event surfaces from the subprocess, we run
 * `classifyAbsoluteBlock` against the input. On a hit we record an
 * `agent_actions.blocked_absolute` row with `result='partial'` to
 * indicate "attempt detected; underlying enforcement happened out-of-band".
 *
 * Audit row semantics:
 *   - Claude PreToolUse path → `result='failed'` (SDK rejected).
 *   - CLI stream path (this module) → `result='partial'` (attempt observed,
 *     enforcement decided by sandbox/policy and not always echoed back to
 *     the daemon).
 *
 * Pure module — `extract*` helpers return classification candidates so the
 * scanner stays unit-testable without a DB.
 */

import type Database from "better-sqlite3";
import type { BackendId, ExecutionPermissionMode } from "@aitne/shared";
import {
  classifyAbsoluteBlock,
  type AbsoluteBlockMatch,
} from "./always-disallowed.js";
import { recordAbsoluteBlockAudit } from "./absolute-block-audit.js";

/**
 * Best-effort extraction of the (toolName, arg) pair to classify from a
 * Codex stream `item`. Codex reports shell calls under several historical
 * shapes — `item.command` as a joined string, `item.action.command` as
 * an argv array, or a generic `item.input.command` field. We probe each
 * defensively.
 *
 * Returns the synthetic Bash-style toolName and the joined command string
 * so the caller can route through `classifyAbsoluteBlock("Bash", ...)`.
 * Returns null when the event isn't a shell call we can recognise — the
 * caller treats null as "nothing to audit", not as an error.
 */
export function extractCodexShellCall(
  item: unknown,
): { toolName: "Bash"; arg: string } | null {
  if (!item || typeof item !== "object") return null;
  const bag = item as Record<string, unknown>;

  // Shape 1: `item.command` is the command string (older codex builds).
  if (typeof bag.command === "string" && bag.command.length > 0) {
    return { toolName: "Bash", arg: bag.command };
  }

  // Shape 2: `item.action.command` is the argv array (current codex). The
  // first element is typically the executable, so we joined-stringify the
  // tail to feed it back through the Bash classifier.
  const action = bag.action;
  if (action && typeof action === "object") {
    const cmd = (action as Record<string, unknown>).command;
    if (Array.isArray(cmd) && cmd.length > 0) {
      const stringified = cmd.filter((p) => typeof p === "string").join(" ");
      if (stringified.length > 0) {
        return { toolName: "Bash", arg: stringified };
      }
    }
    if (typeof cmd === "string" && cmd.length > 0) {
      return { toolName: "Bash", arg: cmd };
    }
  }

  // Shape 3: `item.input.command` (response-API normalised form).
  const input = bag.input;
  if (input && typeof input === "object") {
    const cmd = (input as Record<string, unknown>).command;
    if (typeof cmd === "string" && cmd.length > 0) {
      return { toolName: "Bash", arg: cmd };
    }
  }

  return null;
}

/**
 * Best-effort extraction from a Gemini `tool_use` stream event. Gemini's
 * built-in shell tool is `run_shell_command` (gemini-cli ≥ 0.30); file
 * I/O surfaces as `read_file` / `write_file` / `replace`. The classifier
 * is symmetric to Claude's PreToolUse hook — Bash for shells, Read for
 * read-file, Write/Edit for write-file/replace.
 */
export function extractGeminiToolUseTarget(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
): { toolName: "Bash" | "Read" | "Write" | "Edit"; arg: string } | null {
  if (!toolName || !args) return null;

  if (toolName === "run_shell_command" || toolName === "shell") {
    const cmd = args.command;
    if (typeof cmd === "string" && cmd.length > 0) {
      return { toolName: "Bash", arg: cmd };
    }
  }

  if (toolName === "read_file") {
    const path = args.absolute_path ?? args.file_path ?? args.path;
    if (typeof path === "string" && path.length > 0) {
      return { toolName: "Read", arg: path };
    }
  }

  if (toolName === "write_file") {
    const path = args.file_path ?? args.absolute_path ?? args.path;
    if (typeof path === "string" && path.length > 0) {
      return { toolName: "Write", arg: path };
    }
  }

  if (toolName === "replace") {
    const path = args.file_path ?? args.absolute_path ?? args.path;
    if (typeof path === "string" && path.length > 0) {
      return { toolName: "Edit", arg: path };
    }
  }

  return null;
}

/**
 * Best-effort extraction from an opencode `tool_use` part (pulled from
 * the final `session.prompt` response, see §5.3 — opencode 1.14.50 does
 * NOT stream `message.part.updated` events). The tool names are
 * opencode's built-in surface — `bash` (shell), `read` (file read),
 * `write` (file write), `edit` (str_replace edit), `apply_patch` (multi-
 * file patch). The classifier is symmetric to Claude's PreToolUse hook:
 * Bash for shells, Read for reads, Write/Edit for writes.
 *
 * Apply-patch (multi-file patch) is collapsed to a single Write entry
 * keyed on the first file path the input declares — finer-grained
 * coverage would require parsing the patch body, which is documented
 * gap.
 */
export function extractOpencodeToolUseTarget(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): { toolName: "Bash" | "Read" | "Write" | "Edit"; arg: string } | null {
  if (!toolName || !input) return null;

  if (toolName === "bash") {
    const cmd = input.command;
    if (typeof cmd === "string" && cmd.length > 0) {
      return { toolName: "Bash", arg: cmd };
    }
    return null;
  }

  if (toolName === "read") {
    const path = input.filePath ?? input.path ?? input.file;
    if (typeof path === "string" && path.length > 0) {
      return { toolName: "Read", arg: path };
    }
    return null;
  }

  if (toolName === "write" || toolName === "apply_patch") {
    const path = input.filePath ?? input.path ?? input.file;
    if (typeof path === "string" && path.length > 0) {
      return { toolName: "Write", arg: path };
    }
    return null;
  }

  if (toolName === "edit") {
    const path = input.filePath ?? input.path ?? input.file;
    if (typeof path === "string" && path.length > 0) {
      return { toolName: "Edit", arg: path };
    }
    return null;
  }

  return null;
}

export interface StreamObservationDeps {
  db: Database.Database | undefined;
  backend: BackendId;
  mode: ExecutionPermissionMode;
  sessionId?: number | null;
}

/**
 * Run `classifyAbsoluteBlock` against the candidate and, on match, write
 * an `agent_actions.blocked_absolute` row with `result='partial'`. Returns
 * the match (or null) so the caller can opt to log/decorate stream output.
 *
 * Best-effort: any DB write failure is swallowed by the audit helper.
 */
export function auditStreamObservation(
  candidate: { toolName: string; arg: string },
  deps: StreamObservationDeps,
): AbsoluteBlockMatch | null {
  const match = classifyAbsoluteBlock(candidate.toolName, candidate.arg);
  if (!match) return null;
  recordAbsoluteBlockAudit({
    db: deps.db,
    backend: deps.backend,
    mode: deps.mode,
    match,
    toolName: candidate.toolName,
    sessionId: deps.sessionId ?? null,
    result: "partial",
  });
  return match;
}
