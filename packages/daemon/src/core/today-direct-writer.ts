/**
 * Daemon-direct writer that appends a single bullet to today.md
 * `## Agent Log` without going through the agent at all. Used by the
 * three-stage hourly_check gate (cost-reduction-structural §B) on the
 * stage0_silent / stage2_log_only paths so a "no-op" cron tick still
 * leaves an audit trail in today.md without paying for an LLM session.
 *
 * Why this lives in the daemon (not /api/context/* via curl):
 *   - These paths run *before* the agent is spawned. There is no
 *     subprocess to issue the curl call from.
 *   - The write must use the **'quiet'** staleness tier (see
 *     `context-staleness.ts`) — the same tier the PATCH route already
 *     classifies for `## Agent Log` appends. Bypassing the route is
 *     fine because we never touch the prompt-context-changed hook here.
 *   - The today-write-lock invariant is preserved: we acquire it before
 *     mutating the file, so morning_routine and direct writes never
 *     interleave.
 *
 * Failure mode: when today.md is missing, malformed, or lacks the
 * `## Agent Log` heading, the writer logs a warning and returns false
 * rather than synthesizing the structure — that is the morning routine's
 * job. The gate caller treats false as "log not appended; consume
 * observations regardless".
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "./atomic-write.js";
import { serializeContextFileWrite } from "./context-file-serializer.js";
import { fullPath, CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { createLogger } from "../logging.js";
import type { TodayWriteLockManager } from "./today-write-lock.js";

const logger = createLogger("today-direct-writer");

const AGENT_LOG_HEADER = "## Agent Log";

export interface AppendAgentLogLineInput {
  contextDir: string;
  /**
   * Bullet text to append, **without** the leading `- ` prefix and
   * without a trailing newline. The writer normalizes both.
   * Example: `"12:00 [hourly_check] Quiet — 0 obs"`.
   */
  message: string;
  todayWriteLock: TodayWriteLockManager;
  /** Wall-clock anchor — injectable for tests. */
  now?: Date;
  /**
   * Local timezone string passed to `toLocaleTimeString` so the HH:MM
   * timestamp respects the agent's configured timezone. When omitted,
   * uses the runtime default.
   */
  timezone?: string;
}

export interface AppendAgentLogLineResult {
  appended: boolean;
  reason?:
    | "lock_unavailable"
    | "today_missing"
    | "agent_log_section_missing"
    | "io_error";
}

/**
 * Append a single bullet line to today.md `## Agent Log`. Idempotent
 * shape — repeated calls each add a new bullet (the gate guarantees at
 * most one call per cron tick anyway).
 *
 * Async because the read-modify-write block runs inside the daemon-wide
 * {@link serializeContextFileWrite} so it cannot interleave with the HTTP
 * Context API's PUT/PATCH on the same today.md file. Without that fence
 * a concurrent HTTP PATCH could read the pre-bullet bytes, compute its
 * update, and rename over the file AFTER this writer's rename, silently
 * dropping the bullet. The cross-session `todayWriteLock` is still
 * acquired around the serialized block so the morning routine (which
 * holds the lock + passes X-Lock-Id) continues to fence other direct
 * writers cleanly.
 */
export async function appendAgentLogLine(
  input: AppendAgentLogLineInput,
): Promise<AppendAgentLogLineResult> {
  const lock = input.todayWriteLock.acquire();
  if (!lock.ok) {
    logger.info(
      { holder: lock.holder },
      "Skipping daemon-direct Agent Log append — today-write-lock held",
    );
    return { appended: false, reason: "lock_unavailable" };
  }

  try {
    const path = fullPath(input.contextDir, CONTEXT_RELATIVE_PATHS.today);
    return await serializeContextFileWrite(path, () => {
      if (!existsSync(path)) {
        logger.warn({ path }, "Daemon-direct Agent Log append skipped — today.md missing");
        return { appended: false, reason: "today_missing" } as AppendAgentLogLineResult;
      }

      let content: string;
      try {
        content = readFileSync(path, "utf-8");
      } catch (err) {
        logger.error({ err, path }, "Failed to read today.md for Agent Log append");
        return { appended: false, reason: "io_error" } as AppendAgentLogLineResult;
      }

      const updated = appendBulletToAgentLog(content, formatBullet(input));
      if (updated === null) {
        logger.warn(
          { path },
          "Daemon-direct Agent Log append skipped — `## Agent Log` heading missing",
        );
        return {
          appended: false,
          reason: "agent_log_section_missing",
        } as AppendAgentLogLineResult;
      }

      try {
        writeFileAtomically(path, updated);
        return { appended: true } as AppendAgentLogLineResult;
      } catch (err) {
        logger.error({ err, path }, "Failed to write today.md for Agent Log append");
        return { appended: false, reason: "io_error" } as AppendAgentLogLineResult;
      }
    });
  } finally {
    input.todayWriteLock.release(lock.lockId);
  }
}

/**
 * Splice a new bullet line into the `## Agent Log` section, immediately
 * before the next `## ` heading or end-of-file. Returns null when the
 * section is missing — caller decides how to handle that.
 *
 * Exported for unit tests; the writer above is the production entry.
 */
export function appendBulletToAgentLog(
  content: string,
  bullet: string,
): string | null {
  // Match "\n## Agent Log\n" or "## Agent Log\n" at file start. Use the
  // same anchored regex shape as truncateAgentLog in context-builder.ts
  // so the two stay aligned on what counts as "the heading".
  const headingIdx = findAgentLogHeading(content);
  if (headingIdx < 0) return null;

  const afterHeader = headingIdx + AGENT_LOG_HEADER.length;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSection >= 0 ? nextSection : content.length;

  const sectionBody = content.slice(afterHeader, sectionEnd);
  // Always insert as the LAST bullet of the section. Preserve any
  // trailing blank line that exists between the section and the next
  // heading by inserting before it.
  const trimmedTrailing = sectionBody.replace(/\s+$/, "");
  const trailingWhitespace = sectionBody.slice(trimmedTrailing.length);
  const newBody = `${trimmedTrailing}\n${bullet}\n${trailingWhitespace.replace(/^\n*/, "")}`;
  return content.slice(0, afterHeader) + newBody + content.slice(sectionEnd);
}

function findAgentLogHeading(content: string): number {
  if (content.startsWith(`${AGENT_LOG_HEADER}\n`)) return 0;
  const idx = content.indexOf(`\n${AGENT_LOG_HEADER}\n`);
  return idx < 0 ? -1 : idx + 1;
}

function formatBullet(input: AppendAgentLogLineInput): string {
  const sanitized = input.message.replace(/[\r\n]+/g, " ").trim();
  if (sanitized.startsWith("- ")) return sanitized;
  if (/^\d{1,2}:\d{2}\b/.test(sanitized)) return `- ${sanitized}`;
  const time = formatLocalHHMM(input.now ?? new Date(), input.timezone);
  return `- ${time} ${sanitized}`;
}

function formatLocalHHMM(now: Date, timezone: string | undefined): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timezone ? { timeZone: timezone } : {}),
    });
    return formatter.format(now);
  } catch {
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
