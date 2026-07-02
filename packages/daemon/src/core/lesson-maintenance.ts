import type Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { localDateStr } from "@aitne/shared";
import { writeFileAtomically } from "./atomic-write.js";
import { serializeContextFileWrite } from "./context-file-serializer.js";
import { agentLessonsPath, CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { buildRepromoteGuard } from "./feedback/lesson-contradiction.js";
import {
  normalizeLessonsFileContent,
  type LessonNormalizerStats,
} from "./feedback/lesson-normalizer.js";
import { isSafeAgentSlug } from "./feedback/scope-parser.js";
import { createLogger } from "../logging.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";

const logger = createLogger("lesson-maintenance");

/**
 * Agent-action `action_type` emitted once per cron tick. Keep stable —
 * the dashboard's audit log filters on this exact value.
 */
export const LESSON_MAINTENANCE_ACTION_TYPE = "lesson_mechanical_maintenance";

export interface LessonMaintenanceDeps {
  db: Database.Database;
  contextDir: string;
  config: {
    feedbackLearningEnabled: boolean;
    feedbackPromotionThreshold: number;
    feedbackLessonStaleDays: number;
    feedbackLessonConfidenceFloor: number;
    feedbackContradictionGuardCf: number;
    timezone?: string;
  };
  writeTracker?: AgentWriteTracker;
  /** Test seam — frozen-clock fixtures pass a fixed Date. */
  now?: Date;
  onIndexableContextChange?: (path: string) => void;
}

export interface LessonMaintenanceResult {
  status: "success" | "skipped" | "failed";
  /** Lesson stores examined this tick. */
  stores: number;
  /** Stores whose file was rewritten (cf stamped / verdicts enacted). */
  rewritten: number;
  /** Aggregated normalizer stats across all rewritten stores. */
  demoted: number;
  archived: number;
  repromoted: number;
  backfilled: number;
  errors: Array<{ store: string; message: string }>;
  /** Populated when `status === "skipped"`. */
  skipReason?: string;
}

/**
 * SELF_IMPROVEMENT_PHASE2 §2.1/§2.3 — the daily mechanical lessons sweep
 * (D2 backstop trigger). Runs the same deterministic normalizer the context
 * write pipeline applies, with `prev == current`, over every lesson store:
 *
 *   - the global `policies/agent-lessons.md`;
 *   - every safe-slug `policies/agents/<slug>/lessons.md`.
 *
 * This is what makes the graduated expiration fire on nights with **zero
 * feedback signals** (no worksheet → no evening Step 4 → no write-path
 * normalization) and what re-stamps files hand-edited through Obsidian,
 * bypassing the API chokepoint. Idempotent by construction — a store that
 * is already normalized produces `changed=false` and no write.
 *
 * Invariants (mirrors `roadmap-maintenance.ts`):
 *  - per-path `serializeContextFileWrite` fences each store's
 *    read-modify-write against the HTTP context routes;
 *  - a `md_file_snapshots` row is saved before every rewrite;
 *  - `writeTracker.markWriting` fires before the rename (agent-attributed
 *    fs events), rolled back via `unmark()` on write failure;
 *  - per-store failures are accumulated, never abort the sweep;
 *  - exactly one `agent_actions` audit row per fire.
 */
export async function runLessonMechanicalMaintenance(
  deps: LessonMaintenanceDeps,
): Promise<LessonMaintenanceResult> {
  const result: LessonMaintenanceResult = {
    status: "success",
    stores: 0,
    rewritten: 0,
    demoted: 0,
    archived: 0,
    repromoted: 0,
    backfilled: 0,
    errors: [],
  };

  try {
    if (deps.config.feedbackLearningEnabled === false) {
      result.status = "skipped";
      result.skipReason = "feedback_learning_disabled";
      return result;
    }

    const now = deps.now ?? new Date();
    const normalizerOpts = {
      nowIso: now.toISOString(),
      today: localDateStr(now, deps.config.timezone || undefined),
      promotionThreshold: deps.config.feedbackPromotionThreshold,
      enactExpiration: true,
      staleDays: deps.config.feedbackLessonStaleDays,
      confidenceFloor: deps.config.feedbackLessonConfidenceFloor,
      repromoteGuard: buildRepromoteGuard({
        guardCf: deps.config.feedbackContradictionGuardCf,
        threshold: deps.config.feedbackPromotionThreshold,
      }),
    };

    for (const rel of enumerateLessonStores(deps.contextDir)) {
      result.stores += 1;
      const full = join(deps.contextDir, rel);
      try {
        // Fenced read-modify-write per store: reading inside the serializer
        // means a concurrent HTTP write can't land between our read and
        // rename and get silently overwritten.
        await serializeContextFileWrite(full, () => {
          const original = readFileSync(full, "utf-8");
          const normalized = normalizeLessonsFileContent(
            original,
            original,
            normalizerOpts,
          );
          if (!normalized.changed) return;
          // Snapshot key convention matches the HTTP route: base path
          // without the .md extension.
          saveSnapshot(deps.db, rel.replace(/\.md$/, ""), original);
          deps.writeTracker?.markWriting(full, normalized.content);
          try {
            writeFileAtomically(full, normalized.content);
          } catch (writeErr) {
            deps.writeTracker?.unmark(full);
            throw writeErr;
          }
          deps.onIndexableContextChange?.(rel);
          result.rewritten += 1;
          accumulateStats(result, normalized.stats);
        });
      } catch (err) {
        logger.warn({ err, store: rel }, "Lesson store maintenance failed");
        result.errors.push({ store: rel, message: (err as Error).message });
      }
    }

    return result;
  } finally {
    if (result.errors.length > 0 && result.status === "success") {
      result.status = "failed";
    }
    emitAudit(deps.db, result);
    logger.info(
      {
        status: result.status,
        stores: result.stores,
        rewritten: result.rewritten,
        demoted: result.demoted,
        archived: result.archived,
        repromoted: result.repromoted,
        errorCount: result.errors.length,
      },
      "Lesson mechanical maintenance complete",
    );
  }
}

/**
 * Enumerate existing lesson-store files, relative to the context dir: the
 * global store plus every `policies/agents/<safe-slug>/lessons.md`. Unsafe
 * slugs are skipped with the same guard the scope parser applies; a missing
 * `policies/agents/` tree is the normal no-agents case.
 */
export function enumerateLessonStores(contextDir: string): string[] {
  const stores: string[] = [];
  const globalRel = CONTEXT_RELATIVE_PATHS.agentLessons;
  if (existsSync(join(contextDir, globalRel))) stores.push(globalRel);

  const agentsDir = join(contextDir, "policies", "agents");
  let entries: Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return stores;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeAgentSlug(entry.name)) continue;
    const rel = agentLessonsPath(entry.name);
    if (existsSync(join(contextDir, rel))) stores.push(rel);
  }
  return stores;
}

function accumulateStats(
  result: LessonMaintenanceResult,
  stats: LessonNormalizerStats,
): void {
  result.demoted += stats.demoted;
  result.archived += stats.archived;
  result.repromoted += stats.repromoted;
  result.backfilled += stats.backfilled;
}

function emitAudit(db: Database.Database, result: LessonMaintenanceResult): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, 'autonomous', ?, json(?), datetime('now'), datetime('now'))`,
    ).run(
      LESSON_MAINTENANCE_ACTION_TYPE,
      result.status === "success"
        ? "success"
        : result.status === "skipped"
          ? "skipped"
          : "failed",
      JSON.stringify({
        stores: result.stores,
        rewritten: result.rewritten,
        demoted: result.demoted,
        archived: result.archived,
        repromoted: result.repromoted,
        backfilled: result.backfilled,
        errors: result.errors,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
      }),
    );
  } catch (err) {
    logger.warn({ err }, "Failed to emit lesson_mechanical_maintenance audit row");
  }
}

function saveSnapshot(db: Database.Database, filePath: string, content: string): void {
  try {
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
    ).run(filePath, content, "lesson_maintenance", null);
  } catch (err) {
    logger.warn({ err, filePath }, "Failed to save md_file_snapshots row");
  }
}
