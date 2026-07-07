/**
 * Development-mode knowledge publisher — mirrors the private
 * `writeManagedContextFile` (repository-management-docs.ts) so a finished dev
 * session's artifacts land in the owner's context vault under
 * `knowledge/repos/<slug>/dev-sessions/<id>/`, indexed + wikilink-reachable
 * like every other managed context file.
 *
 * The sequence is byte-for-byte the managed-write contract: snapshot the prior
 * content into `md_file_snapshots` (reversible), `markWriting` BEFORE the
 * atomic rename so the FS-watch consumer attributes the write to the agent
 * (unmark on failure), then notify the context-index reconciler.
 *
 * I/O-shaped; excluded from the coverage gate.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { writeFileAtomically } from "../../core/atomic-write.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger } from "../../logging.js";
import { DEV_DIR_NAME, DEV_DOCS, DEV_TASK_ARCHIVE_DIR, readDevDoc } from "./dev-loop-docs.js";

const logger = createLogger("dev-mode-publisher");

export interface DevModePublisherDeps {
  db: Database.Database;
  /** The context-vault ROOT (`getContextDir(config, db)`). */
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onIndexableContextChange?: (relativePath: string) => void;
}

export interface DevModePublisher {
  /** Copy a terminal session's `.aitne-dev` artifacts into the knowledge vault.
   *  Best-effort per file — a single write failure is logged, never thrown. */
  publishSession(input: { sessionId: string; slug: string; repoPath: string }): void;
}

export function createDevModePublisher(deps: DevModePublisherDeps): DevModePublisher {
  function writeManaged(relativePath: string, content: string, trigger: string): void {
    const absolutePath = join(deps.contextDir, relativePath);
    const previous = existsSync(absolutePath) ? readFileSync(absolutePath, "utf-8") : null;
    if (previous !== null) {
      deps.db
        .prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
        )
        .run(relativePath, previous, trigger, null);
    }
    deps.writeTracker?.markWriting(absolutePath, content);
    try {
      writeFileAtomically(absolutePath, content);
    } catch (err) {
      deps.writeTracker?.unmark(absolutePath);
      throw err;
    }
    deps.onIndexableContextChange?.(relativePath);
  }

  return {
    publishSession({ sessionId, slug, repoPath }) {
      const base = `knowledge/repos/${slug}/dev-sessions/${sessionId}`;
      const trigger = `dev-session:${sessionId}`;
      const publishOne = (docKey: string, outName: string): void => {
        const content = readDevDoc(repoPath, docKey);
        if (content === null || content.trim().length === 0) return;
        try {
          writeManaged(`${base}/${outName}`, content, trigger);
        } catch (err) {
          logger.warn({ err, sessionId, outName }, "dev publish: write failed (continuing)");
        }
      };
      publishOne(DEV_DOCS.contract, "contract.md");
      publishOne(DEV_DOCS.ledger, "requirements-ledger.md");
      publishOne(DEV_DOCS.evidence, "evidence-report.md");
      publishOne(DEV_DOCS.progress, "journal.md");
      // Fleet runs — the task plan + each merged task's archived instruction +
      // evidence (phase-context source), so the whole decomposition is browsable.
      publishOne(DEV_DOCS.taskPlan, "task-plan.md");
      const archiveDir = join(repoPath, DEV_DIR_NAME, DEV_TASK_ARCHIVE_DIR);
      if (existsSync(archiveDir)) {
        let taskKeys: string[] = [];
        try {
          taskKeys = readdirSync(archiveDir);
        } catch {
          taskKeys = [];
        }
        for (const taskKey of taskKeys) {
          const rel = (name: string): string => `${DEV_TASK_ARCHIVE_DIR}/${taskKey}/${name}`;
          for (const [name, out] of [
            ["task-instruction.md", "task.md"],
            ["evidence-report.md", "evidence-report.md"],
          ] as const) {
            const content = readDevDoc(repoPath, rel(name));
            if (content === null || content.trim().length === 0) continue;
            try {
              writeManaged(`${base}/tasks/${taskKey}/${out}`, content, trigger);
            } catch (err) {
              logger.warn({ err, sessionId, taskKey, out }, "dev publish: task artifact write failed (continuing)");
            }
          }
        }
      }
      logger.info({ sessionId, slug }, "dev session artifacts published to the knowledge vault");
    },
  };
}
