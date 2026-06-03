import { basename } from "node:path";
import type Database from "better-sqlite3";
import * as chokidar from "chokidar";
import { createLogger } from "../../logging.js";
import {
  loadAgents,
  AgentEnabledCache,
  type AgentEventPort,
  type AgentLoadOptions,
  type LoadAgentsResult,
} from "./loader.js";

/**
 * Filesystem watcher for Agent definitions (AGENT_DEFINITIONS_DESIGN.md §6.2).
 *
 * Mirrors the `core/management-md.ts` chokidar pattern: debounced
 * (`awaitWriteFinish`), `ignoreInitial`, resilient to handler errors, and —
 * importantly — it watches the agent *directories* and filters events to
 * `agent.md` basenames rather than passing a glob to `chokidar.watch`
 * (chokidar v4 dropped glob support, so a `**​/agent.md` argument would be
 * treated as a literal path and never fire).
 *
 * On any add/change/unlink of an `agent.md` it re-runs {@link loadAgents} (the
 * full pass is cheap — the loader's hash/override efficiency-skip writes only
 * the rows that actually changed) and invalidates the enabled-cache so the
 * scheduler gate sees the new state on its next firing.
 *
 * The reload is injectable so the unit test can assert it fires without
 * standing up the whole pass; production defaults to `loadAgents`.
 */

const logger = createLogger("agents-watcher");

const AGENT_FILE_NAME = "agent.md";

export interface AgentsWatcherHandle {
  stop(): Promise<void>;
}

export interface AgentsWatcherOptions {
  /** Also watch the shipped built-in root (dev hot-reload). Off in production. */
  watchBuiltin?: boolean;
  /** Debounce window before a reload fires after the last filesystem event. */
  debounceMs?: number;
  /** Reload implementation (defaults to `loadAgents`); overridable for tests. */
  reload?: () => LoadAgentsResult;
  /** Optional enabled-cache to invalidate after each reload. */
  cache?: AgentEnabledCache;
  /** Optional SSE port; an `agent.updated` event fires after each reload. */
  events?: AgentEventPort;
}

/**
 * Start watching the user (and optionally built-in) agent roots. Returns a
 * handle whose `stop()` closes the chokidar watcher. Errors in the reload
 * handler are logged, never thrown — a bad edit must not take down the daemon.
 */
export function startAgentsWatcher(
  db: Database.Database,
  opts: AgentLoadOptions,
  watcherOpts: AgentsWatcherOptions = {},
): AgentsWatcherHandle {
  const roots = [opts.userDir];
  if (watcherOpts.watchBuiltin) {
    roots.push(opts.builtinDir);
  }
  const debounceMs = watcherOpts.debounceMs ?? 300;
  const reload = watcherOpts.reload ?? (() => loadAgents(db, opts));

  const watcher = chokidar.watch(roots, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  let timer: ReturnType<typeof setTimeout> | null = null;

  const runReload = (reason: string): void => {
    try {
      const result = reload();
      watcherOpts.cache?.invalidate();
      watcherOpts.events?.emit("agent.updated", { reason, upserted: result.upserted });
      logger.info(
        { reason, upserted: result.upserted.length, invalid: result.invalid.length },
        "agents reloaded after filesystem change",
      );
    } catch (err) {
      logger.error({ err, reason }, "agents reload failed");
    }
  };

  const schedule = (reason: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runReload(reason);
    }, debounceMs);
    timer.unref?.();
  };

  // Only `agent.md` files matter; ignore the surrounding directory churn.
  const onEvent = (reason: string) => (filePath: string): void => {
    if (basename(filePath) === AGENT_FILE_NAME) schedule(reason);
  };

  watcher.on("add", onEvent("add"));
  watcher.on("change", onEvent("change"));
  watcher.on("unlink", onEvent("unlink"));
  watcher.on("error", (err: unknown) => logger.error({ err }, "agents watcher error"));

  logger.info({ roots }, "agents watcher started");

  return {
    async stop() {
      if (timer) clearTimeout(timer);
      await watcher.close();
      logger.info("agents watcher stopped");
    },
  };
}
