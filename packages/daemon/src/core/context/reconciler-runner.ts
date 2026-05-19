import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  type Dirent,
} from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { localDateStr } from "@aitne/shared";
import {
  CONTEXT_RELATIVE_PATHS,
  CONTEXT_FILE_EXTENSIONS,
} from "../context-paths.js";
import {
  parseContextIndexRows,
  type ContextIndexRow,
} from "../review-context.js";
import { validateContextFileFrontmatter } from "../context-frontmatter.js";
import { POLICY_FILE_MAX_BYTES } from "../policy-files.js";
import {
  writeRuntimeState,
  getDegradedMode,
} from "../../db/runtime-state.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger } from "../../logging.js";
import type { PromptContextChangedCallback } from "../context-staleness.js";
import {
  applyRollingRetention,
  reconcileContextIndex,
  renderContextIndex,
  shouldIndexPath,
  type FilesystemSnapshotEntry,
} from "./index-reconciler.js";

const logger = createLogger("context-index-reconciler");

/** Runtime-state key for the minimum-viable run record — §5.6. */
export const RECONCILER_LAST_RUN_KEY = "reconciler.context_index.last_run";

/** First N lines of a file are scanned for an H1 title. */
const H1_SCAN_LINE_LIMIT = 20;

/**
 * Per-process mutex. The design doc (§4.5) originally proposed sharing
 * `withWriteLock` from `context.ts`, but that helper is closure-local to
 * `createContextRoutes` and extracting it would ripple through the route
 * file. No agent task flow writes to `context-index.md` via the API
 * today — the file is reconciler-owned — so a process-scoped mutex is
 * sufficient. If a future flow starts writing to the index via
 * `PUT /api/context/context-index`, promote this to a shared mutex.
 */
let runnerMutex: Promise<void> = Promise.resolve();

export type ReconcilerRunResultState = "applied" | "noop" | "error";
export type ReconcilerTrigger = "startup" | "cron" | "fs_event" | "manual";

export interface ReconcilerRunRecord {
  at: string;
  trigger: ReconcilerTrigger;
  result: ReconcilerRunResultState;
  added: number;
  removed: number;
  refreshedMtime: number;
  error: string | null;
}

export interface RunReconcilerOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onPromptContextChanged?: PromptContextChangedCallback;
  timezone?: string;
  trigger: ReconcilerTrigger;
  /**
   * Injectable clock — production uses `Date.now()`. Tests thread a
   * deterministic clock so the `at` field in the run record is stable.
   */
  now?: () => Date;
}

/**
 * Drive one reconciler pass end-to-end:
 *  1. Early-exit when degraded mode is active (vault unreachable).
 *  2. Walk `contextDir`, build the snapshot with retention caps applied.
 *  3. Read the current `context-index.md`, parse rows. If the file is
 *     missing, start from an empty row list (§4.5 missing-file recovery).
 *  4. Compute the diff and short-circuit on no-op.
 *  5. Render + self-validate via `validateContextFileFrontmatter`.
 *  6. Write under the per-process mutex, update the write tracker,
 *     snapshot the previous contents, and notify prompt listeners.
 *  7. Persist a single `runtime_state` row regardless of outcome so the
 *     Phase 2b gate (§2.2) can query the last run deterministically.
 */
export async function runReconciler(
  opts: RunReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const prev = runnerMutex;
  let releaseMutex!: () => void;
  runnerMutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  try {
    await prev;
    return await runOnce(opts);
  } finally {
    releaseMutex();
  }
}

async function runOnce(
  opts: RunReconcilerOptions,
): Promise<ReconcilerRunRecord> {
  const now = opts.now ? opts.now() : new Date();
  const today = localDateStr(now, opts.timezone || undefined);
  const recordBase = {
    at: now.toISOString(),
    trigger: opts.trigger,
    added: 0,
    removed: 0,
    refreshedMtime: 0,
  };

  const degraded = getDegradedMode(opts.db);
  if (degraded) {
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "noop",
      error: `degraded_mode:${degraded.reason}`,
    };
    persistRunRecord(opts.db, record);
    return record;
  }

  try {
    const snapshot = applyRollingRetention(
      buildSnapshot(opts.contextDir, opts.timezone),
    );
    const currentRows = readCurrentRows(opts.contextDir);
    const diff = reconcileContextIndex(snapshot, currentRows);

    if (diff.noOp) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "noop",
        error: null,
      };
      persistRunRecord(opts.db, record);
      return record;
    }

    const output = renderContextIndex(diff.rows, today);
    const validationError = validateContextFileFrontmatter(
      output,
      CONTEXT_RELATIVE_PATHS.contextIndex,
    );
    if (validationError) {
      const record: ReconcilerRunRecord = {
        ...recordBase,
        result: "error",
        error: `self_validation_failed:${validationError.code}`,
        added: diff.added.length,
        removed: diff.removed.length,
        refreshedMtime: diff.refreshedMtime.length,
      };
      persistRunRecord(opts.db, record);
      logger.error(
        {
          added: diff.added.length,
          removed: diff.removed.length,
          refreshedMtime: diff.refreshedMtime.length,
          validation: validationError,
        },
        "Reconciler output failed frontmatter validation — leaving file untouched",
      );
      return record;
    }

    writeIndex(opts, output);

    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "applied",
      error: null,
      added: diff.added.length,
      removed: diff.removed.length,
      refreshedMtime: diff.refreshedMtime.length,
    };
    persistRunRecord(opts.db, record);
    logger.info(
      {
        trigger: opts.trigger,
        added: diff.added.length,
        removed: diff.removed.length,
        refreshedMtime: diff.refreshedMtime.length,
      },
      "Reconciler applied",
    );
    return record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record: ReconcilerRunRecord = {
      ...recordBase,
      result: "error",
      error: message.slice(0, 200),
    };
    persistRunRecord(opts.db, record);
    logger.error({ err, trigger: opts.trigger }, "Reconciler run failed");
    return record;
  }
}

function buildSnapshot(
  contextDir: string,
  timezone: string | undefined,
): FilesystemSnapshotEntry[] {
  if (!existsSync(contextDir)) return [];
  const out: FilesystemSnapshotEntry[] = [];
  walkDirectory(contextDir, "", (relativePath) => {
    if (!shouldIndexPath(relativePath)) return;
    const absolute = join(contextDir, relativePath);
    try {
      const stat = statSync(absolute);
      const mtimeDate = localDateStr(stat.mtime, timezone || undefined);
      const h1Title = extractH1(absolute);
      out.push({ path: relativePath, mtimeDate, h1Title });
    } catch (err) {
      logger.debug(
        { err, path: relativePath },
        "Skipping unreadable file in reconciler snapshot",
      );
    }
  });
  return out;
}

function walkDirectory(
  root: string,
  relativePrefix: string,
  visit: (relativePath: string) => void,
): void {
  const absolute = join(root, relativePrefix);
  let entries: Dirent[];
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === ".obsidian" ||
      entry.name === ".DS_Store"
    ) {
      continue;
    }
    const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkDirectory(root, rel, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    const hasTrackedExtension = CONTEXT_FILE_EXTENSIONS.some((ext) =>
      entry.name.endsWith(ext),
    );
    if (!hasTrackedExtension) continue;
    visit(rel);
  }
}

function extractH1(absolute: string): string | null {
  // Bounded read (§4.4): scan at most `POLICY_FILE_MAX_BYTES` from the
  // start of the file. The H1 we care about lives in the first ~20 lines,
  // which fits comfortably within 32 KB for any reasonable file; larger
  // reads would make the reconciler O(vault bytes) instead of O(files).
  let fd: number;
  try {
    fd = openSync(absolute, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(POLICY_FILE_MAX_BYTES);
    const bytes = readSync(fd, buf, 0, POLICY_FILE_MAX_BYTES, 0);
    const content = buf.slice(0, bytes).toString("utf-8");
    const lines = content.split(/\r?\n/).slice(0, H1_SCAN_LINE_LIMIT);
    let inFrontmatter = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!inFrontmatter && line === "---") {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (line === "---") {
          inFrontmatter = false;
        }
        continue;
      }
      const match = /^#\s+(.+?)\s*$/.exec(line);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort close
    }
  }
}

function readCurrentRows(contextDir: string): ContextIndexRow[] {
  const absolute = join(contextDir, CONTEXT_RELATIVE_PATHS.contextIndex);
  if (!existsSync(absolute)) return [];
  try {
    const content = readFileSync(absolute, "utf-8");
    return parseContextIndexRows(content);
  } catch (err) {
    logger.warn(
      { err },
      "Reconciler could not read existing context-index.md — treating as empty",
    );
    return [];
  }
}

function writeIndex(opts: RunReconcilerOptions, content: string): void {
  const absolute = join(opts.contextDir, CONTEXT_RELATIVE_PATHS.contextIndex);
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true });

  if (existsSync(absolute)) {
    try {
      const previous = readFileSync(absolute, "utf-8");
      saveSnapshot(opts.db, CONTEXT_RELATIVE_PATHS.contextIndex, previous);
    } catch (err) {
      logger.warn(
        { err },
        "Reconciler failed to snapshot previous context-index.md",
      );
    }
  }

  // Mark before the visible-write boundary so FS-watch consumers attribute
  // the resulting event to the agent. Roll back on failure (C2).
  opts.writeTracker?.markWriting(absolute, content);
  try {
    writeFileSync(absolute, content, "utf-8");
  } catch (writeErr) {
    opts.writeTracker?.unmark(absolute);
    throw writeErr;
  }
  opts.onPromptContextChanged?.(
    CONTEXT_RELATIVE_PATHS.contextIndex,
    "reconciler",
    "quiet",
    { tierReason: "derived_context_index" },
  );
}

function saveSnapshot(
  db: Database.Database,
  filePath: string,
  content: string,
): void {
  db.prepare(
    "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
  ).run(filePath, content, "reconciler_write", null);
}

function persistRunRecord(
  db: Database.Database,
  record: ReconcilerRunRecord,
): void {
  try {
    writeRuntimeState(db, RECONCILER_LAST_RUN_KEY, record);
  } catch (err) {
    logger.warn(
      { err, record },
      "Reconciler run record persistence failed",
    );
  }
}
