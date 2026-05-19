import type Database from "better-sqlite3";
import type { BackendId, ExecutionPermissionMode } from "@aitne/shared";
import { createLogger } from "../logging.js";
import type { AbsoluteBlockMatch } from "./always-disallowed.js";

const logger = createLogger("absolute-block-audit");

/**
 * Record an `agent_actions` row with `action_type = 'blocked_absolute'` so
 * the dashboard can surface that the absolute-block layer is doing useful
 * work (EXECUTION-MODE-DESIGN.md §6.3).
 *
 * Best-effort: failures do not throw. The authoritative enforcement is
 * the SDK-level `disallowedTools` / TOML deny-rule rejection; this row
 * is observability only. If the DB is transiently unavailable, a warning
 * logs and the hook still returns the block decision to the caller.
 *
 * Two semantic call sites, discriminated via the `result` parameter:
 *
 *   - `result: 'failed'` (default) — the Claude SDK PreToolUse hook
 *     authoritatively rejected the call. The audit row truthfully reports
 *     a denied invocation. `trigger='absolute_block_layer'`.
 *
 *   - `result: 'partial'` — a CLI backend (Codex, Gemini) observed a
 *     `tool_use`-shaped stream event whose input matches an absolute-block
 *     pattern. The actual rejection (or not) happens inside the subprocess
 *     sandbox / admin policy, where the daemon cannot directly observe
 *     the outcome. `trigger='absolute_block_stream_observation'` so an
 *     audit-log filter can keep the two streams cleanly separated.
 *     `detail.observation: 'stream'` mirrors the trigger discrimination
 *     for consumers that prefer the JSON detail field.
 */
export function recordAbsoluteBlockAudit(params: {
  db: Database.Database | undefined;
  backend: BackendId;
  mode: ExecutionPermissionMode;
  match: AbsoluteBlockMatch;
  toolName: string;
  sessionId?: number | null;
  /** Audit row outcome — see the function docstring. */
  result?: "failed" | "partial";
}): void {
  const { db, backend, mode, match, toolName, sessionId, result } = params;
  if (!db) return;
  const effectiveResult = result ?? "failed";
  // Trigger is derived from `result` so the (action_type, trigger, result)
  // triple is internally consistent: a reader that filters on any one of
  // those three columns sees the same partition between authoritative
  // PreToolUse rejections and CLI stream observations.
  const trigger = effectiveResult === "partial"
    ? "absolute_block_stream_observation"
    : "absolute_block_layer";
  try {
    const detail = JSON.stringify({
      category: match.category,
      toolName,
      redacted: match.redacted,
      mode,
      sessionId: sessionId ?? null,
      ...(effectiveResult === "partial"
        ? { observation: "stream" as const }
        : {}),
    });
    db.prepare(
      `INSERT INTO agent_actions (action_type, trigger, result, detail, backend)
         VALUES (?, ?, ?, ?, ?)`,
    ).run("blocked_absolute", trigger, effectiveResult, detail, backend);
  } catch (err) {
    logger.warn(
      { err, backend, category: match.category },
      "failed to record blocked_absolute audit row",
    );
  }
}
