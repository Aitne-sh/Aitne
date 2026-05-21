import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "../atomic-write.js";
import {
  buildPreMorningDigest,
  digestDateForNow,
  preMorningDigestRelativePath,
  renderPreMorningDigestMarkdown,
  type DigestBoundary,
} from "../../services/browser-history/pipeline/pre-morning-digest.js";
import {
  preMorningDigestSchema,
  type PreMorningDigest,
} from "@aitne/shared";
import { createLogger } from "../../logging.js";

const logger = createLogger("browser-history-pre-morning-digest");

/**
 * Daemon-side wrapper around the pure digest builder. Three roles:
 *
 *  1. `runPreMorningDigestJob` — called by the scheduler at
 *     `dayBoundaryHour − 1` (BROWSER_HISTORY_INTEGRATION_PLAN §5.F2
 *     Stage 1). Builds the digest for the agent-day that's just about
 *     to end and writes `<contextDir>/browser/yesterday-<date>.md`
 *     plus a JSON sidecar (`yesterday-<date>.json`) so the API route
 *     can return the exact same payload the journal sees, without
 *     parsing markdown back into Zod-validated JSON.
 *
 *  2. `readPreMorningDigestJsonForDate` — used by the API route. Reads
 *     the JSON sidecar when present; returns null otherwise. The route
 *     then falls back to building fresh from the DB.
 *
 *  3. `digestDate` / `digestPaths` — small helpers exported for tests
 *     and the cron call site to share a single source of truth for the
 *     filename layout.
 *
 * The job is intentionally fire-and-forget: a build / write failure
 * logs loudly and never re-throws. The morning journal's task-flow
 * tolerates a missing digest by calling
 * `GET /api/browser-history/pre-morning-digest/{date}` as the
 * documented fallback (§5.F2 Stage 2). Either path satisfies the
 * journal's contract; the file path is the primary one because it
 * pre-warms the morning context window without a network hop.
 */

export interface PreMorningDigestPaths {
  /** Absolute path to the markdown file the journal reads. */
  markdownPath: string;
  /** Absolute path to the parallel JSON sidecar the API serves. */
  jsonPath: string;
  /**
   * The `<path>` portion of `PUT /api/context/<path>.md` — useful for
   * task-flow strings and log lines that need a stable agent-facing
   * reference, independent of the on-disk `contextDir`.
   */
  contextRelative: string;
}

export function digestPaths(
  contextDir: string,
  dateStr: string,
): PreMorningDigestPaths {
  const contextRelative = preMorningDigestRelativePath(dateStr);
  const markdownPath = resolve(contextDir, contextRelative);
  const jsonPath = markdownPath.replace(/\.md$/, ".json");
  return { markdownPath, jsonPath, contextRelative };
}

export interface RunPreMorningDigestJobArgs {
  readonly db: Database.Database;
  readonly contextDir: string;
  readonly boundary: DigestBoundary;
  /** Override `Date.now()` for tests and the API on-demand path. */
  readonly nowMs?: number;
}

export interface RunPreMorningDigestJobResult {
  readonly date: string;
  readonly paths: PreMorningDigestPaths;
  readonly digest: PreMorningDigest;
}

/**
 * Build + persist the digest for the agent-day "now" is inside of.
 * Returns the typed digest so callers (the API route's
 * rebuild-on-demand path, tests) can use the same code shape as the
 * cron call site.
 */
export function runPreMorningDigestJob(
  args: RunPreMorningDigestJobArgs,
): RunPreMorningDigestJobResult {
  const { db, contextDir, boundary } = args;
  const nowMs = args.nowMs ?? Date.now();
  const date = digestDateForNow(boundary, nowMs);
  const digest = buildPreMorningDigest({
    db,
    date,
    boundary,
    options: { nowMs },
  });
  const paths = digestPaths(contextDir, date);
  const markdown = renderPreMorningDigestMarkdown(digest);
  // JSON sidecar first — it is the API's source of truth. Writing the
  // markdown after means a partial-failure leaves the JSON missing if
  // the markdown write fails, but never the other way around (which
  // would let the journal read stale prose with no API parity).
  writeFileAtomically(paths.jsonPath, JSON.stringify(digest, null, 2) + "\n");
  writeFileAtomically(paths.markdownPath, markdown);
  return { date, paths, digest };
}

/**
 * Read the JSON sidecar for the given agent-day, Zod-validate it, and
 * return the typed digest. Returns null when the file is missing or
 * the bytes do not parse — the API caller can then rebuild fresh.
 *
 * Validation matters here: the journal Stage B task-flow trusts the
 * file's schema invariants (no raw URLs / titles). Returning unvetted
 * JSON would let a corrupt sidecar bypass that boundary.
 */
export function readPreMorningDigestJsonForDate(
  contextDir: string,
  dateStr: string,
): PreMorningDigest | null {
  const { jsonPath } = digestPaths(contextDir, dateStr);
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed = preMorningDigestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    // A read / parse error is recoverable — caller rebuilds. We log so
    // the operator can investigate, but do not throw upward into the
    // request handler.
    logger.warn(
      { err, jsonPath },
      "Failed to read pre-morning digest JSON sidecar; caller will rebuild",
    );
    return null;
  }
}

/**
 * Wrapper safe to register as a fire-and-forget cron callback. Catches
 * every error so a transient SQL failure or filesystem hiccup cannot
 * crash the scheduler's cron tick. Returns the result for callers that
 * want to inspect outcomes (tests / dashboards / future audit hooks).
 */
export function safeRunPreMorningDigestJob(
  args: RunPreMorningDigestJobArgs,
): RunPreMorningDigestJobResult | null {
  try {
    const result = runPreMorningDigestJob(args);
    logger.info(
      {
        date: result.date,
        clusters: result.digest.clusters.length,
        shopping: result.digest.shopping.length,
        reloads: result.digest.reloads.length,
        pendingOffers: result.digest.pendingOffers.length,
        newThresholds: result.digest.newThresholdsCount,
      },
      "Pre-morning digest written",
    );
    return result;
  } catch (err) {
    logger.error(
      { err },
      "Pre-morning digest job failed; the morning journal will fall back to the API endpoint",
    );
    return null;
  }
}
