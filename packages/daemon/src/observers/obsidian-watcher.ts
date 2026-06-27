import * as chokidar from "chokidar";
import { extname, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import { recordObservation } from "../db/observations.js";
import type { Observer } from "./manager.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { createLogger } from "../logging.js";

const logger = createLogger("obsidian-watcher");

/** Truncate diff previews to this many characters before storage. */
const DIFF_PREVIEW_CAP = 2000;

/** Valid `source` values for observations emitted by an Obsidian-style vault watcher. */
export type ObsidianObservationSource = "obsidian:primary" | "obsidian:external";

export interface ObsidianWatcherOptions {
  /** Observer registry name. Must be unique per ObserverManager. */
  name?: string;
  /**
   * `source` tag for recorded observations. The primary vault (managed
   * by the agent via `/api/context/*`) and a user's external Obsidian
   * vault share the "obsidian-style file watcher" plumbing but must be
   * distinguishable downstream — e.g. the UPSERT's `(source, ref)`
   * conflict key would otherwise cause a primary-vault `today.md` edit
   * to overwrite an unrelated external-vault `today.md` pending row.
   * Defaults to `"obsidian:external"` for backward compatibility with
   * the single-watcher world.
   */
  source?: ObsidianObservationSource;
}

/**
 * Pure helper that records a single debounced file-change event as an
 * observation row. Extracted from `ObsidianWatcher` so the watcher's
 * wiring can be unit-tested without spinning up a real chokidar / FSEvents
 * subscription — tests drive this function directly with a synthetic
 * path, bypassing the watch loop entirely.
 *
 * Returns `"recorded"` when a row is written, `"skipped:agent"` when the
 * change was pre-marked as an agent-originated write (no row — see
 * `recordFileChange`'s contract note below), `"skipped:ext"` when the
 * file extension falls outside `WATCH_EXTENSIONS`.
 *
 * **Agent-write suppression**: `AgentWriteTracker` pre-marks files the
 * agent writes via `/api/context/*`. When a watcher fires for one of
 * those, we silently drop the observation instead of recording it with
 * `actor='agent'`. Downstream consumers (activity-scan skill) already
 * filter by `actor='user'`, so an agent row has no consumer; leaving it
 * out of the table entirely prevents unbounded growth from the agent's
 * own write traffic.
 */
export async function recordFileChange(params: {
  vaultPath: string;
  filePath: string;
  changeType: "created" | "modified" | "deleted";
  source: ObsidianObservationSource;
  db: Database.Database;
  writeTracker?: AgentWriteTracker;
}): Promise<"recorded" | "skipped:agent" | "skipped:ext"> {
  if (!ObsidianWatcher.WATCH_EXTENSIONS.has(extname(params.filePath))) {
    return "skipped:ext";
  }

  const relativePath = relative(params.vaultPath, params.filePath);
  const absolutePath = resolve(params.filePath);

  let content: string | null = null;
  let diffContent = "";
  if (params.changeType !== "deleted") {
    try {
      content = await readFile(params.filePath, "utf-8");
      diffContent = content.length <= DIFF_PREVIEW_CAP
        ? content
        : content.slice(0, DIFF_PREVIEW_CAP) + `\n\n--- (truncated, ${content.length} chars total) ---`;
    } catch {
      diffContent = "(file read failed)";
    }
  }

  if (params.writeTracker?.isMarked(absolutePath, content)) {
    logger.debug(
      { file: relativePath, changeType: params.changeType, source: params.source },
      "dropping agent-originated file event",
    );
    return "skipped:agent";
  }

  recordObservation(params.db, {
    source: params.source,
    ref: relativePath,
    changeType: params.changeType,
    actor: "user",
    payload: {
      filePath: relativePath,
      diffPreview: diffContent,
    },
  });
  logger.debug(
    { file: relativePath, changeType: params.changeType, source: params.source },
    "file change observation recorded",
  );
  return "recorded";
}

/**
 * ObsidianWatcher — monitors an Obsidian-style vault for Markdown file
 * changes.
 *
 * Uses chokidar (FSEvents on macOS) for native filesystem events.
 * Debounces rapid edits to avoid flooding the observations table during
 * active editing.
 *
 * Two registered instances coexist at runtime:
 *   - `obsidian:external` — the user's separate note vault,
 *     `externalObsidianVaultPath`.
 *   - `obsidian:primary`  — the agent's own primary management vault
 *     when `vaultMode === "obsidian"` (see `PrimaryVaultWatcher`).
 *
 * Both tag their observations with a distinct `source` so the
 * `(source, ref)` upsert constraint can never merge unrelated changes.
 */
export class ObsidianWatcher implements Observer {
  readonly name: string;
  readonly source: ObsidianObservationSource;

  /** Directories to ignore inside the vault */
  static readonly IGNORE_PATTERNS = [
    "**/.obsidian/**",
    "**/.trash/**",
    "**/.git/**",
    "**/node_modules/**",
  ];

  /** Only watch these file extensions */
  static readonly WATCH_EXTENSIONS = new Set([".md"]);

  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly vaultPath: string,
    private readonly db: Database.Database,
    private readonly debounceSeconds: number = 5,
    private readonly writeTracker?: AgentWriteTracker,
    options: ObsidianWatcherOptions = {},
  ) {
    this.source = options.source ?? "obsidian:external";
    this.name = options.name ?? this.source;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.vaultPath, {
      ignored: ObsidianWatcher.IGNORE_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher
      .on("add", (path) => this.handleChange(path, "created"))
      .on("change", (path) => this.handleChange(path, "modified"))
      .on("unlink", (path) => this.handleChange(path, "deleted"))
      .on("error", (error) => {
        logger.error({ error }, "Watcher error");
      });

    logger.info(
      { vaultPath: this.vaultPath, source: this.source, name: this.name },
      "Obsidian watcher started",
    );
  }

  async stop(): Promise<void> {
    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    logger.info({ name: this.name }, "Obsidian watcher stopped");
  }

  /**
   * Debounced chokidar event handler. Public only so observer-level
   * tests can drive the full wiring (debounce → recordFileChange)
   * without bringing up chokidar; production code never calls this
   * directly.
   */
  handleChange(
    filePath: string,
    changeType: "created" | "modified" | "deleted",
  ): void {
    // Filter by extension before arming the timer.
    if (!ObsidianWatcher.WATCH_EXTENSIONS.has(extname(filePath))) return;

    // Debounce: reset timer for this file path
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        void recordFileChange({
          vaultPath: this.vaultPath,
          filePath,
          changeType,
          source: this.source,
          db: this.db,
          writeTracker: this.writeTracker,
        });
      }, this.debounceSeconds * 1000),
    );
  }
}
