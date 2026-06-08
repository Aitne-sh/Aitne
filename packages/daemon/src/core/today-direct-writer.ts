/**
 * Daemon-direct, lock-aware writes to today.md that run *before* (or
 * instead of) an agent session — bypassing `/api/context/*` because there
 * is no subprocess to issue the curl call from. Two operations live here:
 *
 *   1. {@link appendAgentLogLine} — append a single `## Agent Log` bullet.
 *      Used by the three-stage hourly_check gate (cost-reduction-structural
 *      §B) on the stage0_silent / stage2_log_only paths so a "no-op" cron
 *      tick still leaves an audit trail without paying for an LLM session.
 *   2. {@link ensureTodaySkeleton} — seed the canonical empty skeleton when
 *      today.md is **absent**, so a section-only refresh routine has a valid
 *      PATCH target instead of 404-ing and budget-burning on full-file PUTs.
 *
 * Why this lives in the daemon (not /api/context/* via curl):
 *   - These paths run *before* the agent is spawned. There is no
 *     subprocess to issue the curl call from.
 *   - The write must use the **'quiet'** staleness tier (see
 *     `context-staleness.ts`) — the same tier the PATCH route already
 *     classifies for `## Agent Log` appends. Bypassing the route is
 *     fine because we never touch the prompt-context-changed hook here.
 *   - The today-write-lock invariant is preserved: both functions acquire
 *     it before mutating the file, so morning_routine and direct writes
 *     never interleave.
 *
 * Synthesis boundary: `appendAgentLogLine` NEVER synthesizes structure —
 * a missing / malformed / heading-less file returns false and the gate
 * caller proceeds. `ensureTodaySkeleton` synthesizes ONLY the empty
 * skeleton, ONLY when the file is entirely absent, and never touches a
 * present file. Neither populates today.md — full creation and repair stay
 * the morning routine's job.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "./atomic-write.js";
import { serializeContextFileWrite } from "./context-file-serializer.js";
import { fullPath, CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { FALLBACK_PLACEHOLDERS } from "./skeleton.js";
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
 * Canonical empty `today.md` skeleton, reused byte-for-byte from the
 * boot-time seeder (`skeleton.ts`) so a refresh-path seed and a
 * fresh-install seed produce identical structure. `skeleton.test.ts`
 * asserts this placeholder matches `agent-assets/templates/state/today.md`
 * byte-for-byte, so the two definitions never drift. The non-null
 * assertion is safe: the key is a literal entry of `FALLBACK_PLACEHOLDERS`.
 */
const TODAY_SKELETON = FALLBACK_PLACEHOLDERS[CONTEXT_RELATIVE_PATHS.today]!;

export interface EnsureTodaySkeletonInput {
  contextDir: string;
  todayWriteLock: TodayWriteLockManager;
}

export interface EnsureTodaySkeletonResult {
  seeded: boolean;
  reason?: "already_present" | "lock_unavailable" | "io_error";
}

/**
 * Guarantee a `today.md` working surface exists before a section-only
 * refresh routine (`routine.today_refresh`) assumes it.
 *
 * `rotateDayFiles()` intentionally renames `today.md` → `yesterday.md` at
 * the day boundary and relies on the morning routine to recreate the
 * dated file. When the morning routine has not run yet — or failed (e.g.
 * a quota/budget death with no fallback backend) — `today.md` is absent
 * and the refresh task flow's `PATCH section=user_schedule` 404s. The
 * agent then improvises full-file `PUT`s, which the strict
 * `validateTodayContent` schema rejects line-by-line; on a single-backend
 * binding with a tight per-turn budget that loop tips into
 * `BackendQuotaError(max_budget_usd)` and the refresh dies without ever
 * writing the file — the "Refresh Today does nothing" symptom.
 *
 * This deterministic pre-step removes that whole failure mode: when the
 * file is **entirely absent** we seed the canonical empty skeleton so the
 * agent's section PATCH always has a valid target. A file that already
 * exists is left byte-untouched — a valid dated file OR the legacy
 * `# Today` bridge stub both accept the section PATCH (the route's
 * `allowLegacyToday` branch). We never repair a malformed-but-present
 * file and never overwrite user content; full creation/repair stays the
 * morning routine's job. The seeded skeleton is dateless (`# Today`), so
 * it does NOT satisfy `hasCurrentAgentDayTodayMd()` and the pending
 * morning-routine retry still fires and upgrades it.
 *
 * Lock-aware exactly like {@link appendAgentLogLine}: if the morning
 * routine holds the today-write-lock (mid-creation) we skip and let it
 * win — the refresh session then 409-defers on its own PATCH.
 */
export async function ensureTodaySkeleton(
  input: EnsureTodaySkeletonInput,
): Promise<EnsureTodaySkeletonResult> {
  const lock = input.todayWriteLock.acquire();
  if (!lock.ok) {
    logger.info(
      { holder: lock.holder },
      "Skipping today.md skeleton seed — today-write-lock held",
    );
    return { seeded: false, reason: "lock_unavailable" };
  }

  try {
    const path = fullPath(input.contextDir, CONTEXT_RELATIVE_PATHS.today);
    return await serializeContextFileWrite(path, () => {
      if (existsSync(path)) {
        return {
          seeded: false,
          reason: "already_present",
        } as EnsureTodaySkeletonResult;
      }
      try {
        writeFileAtomically(path, TODAY_SKELETON);
        logger.info(
          { path },
          "Seeded today.md skeleton for refresh — file was absent (morning routine not yet run for the agent-day)",
        );
        return { seeded: true } as EnsureTodaySkeletonResult;
      } catch (err) {
        logger.error({ err, path }, "Failed to seed today.md skeleton");
        return { seeded: false, reason: "io_error" } as EnsureTodaySkeletonResult;
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
