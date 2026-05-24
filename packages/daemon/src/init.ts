import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import {
  getLogsDir,
  getTmpDir,
} from "./config.js";
import { CONTEXT_DIR_NAMES } from "./core/context-paths.js";

/**
 * B-007 §5.1 — context/ subdirectories created on first boot.
 * Mirrors `CONTEXT_DIR_NAMES`; `""` is the root itself.
 */
const CONTEXT_SUBDIRS = ["", ...CONTEXT_DIR_NAMES];

/**
 * Ensure all required directories exist under dataDir.
 * Called during daemon startup.
 */
export function initDirectories(config: AgentConfig): void {
  const fallbackContextDir = resolve(config.dataDir, "context");
  const dataDbDir = resolve(config.dataDir, "data");
  const logsDir = getLogsDir(config);
  const tmpDir = getTmpDir(config);

  // Always materialize the fallback context tree under dataDir. Do NOT
  // touch primaryVaultPath here: startup validation must decide whether an
  // obsidian-mode primary path is reachable, and pre-creating it would mask
  // parent-missing / wrong-path misconfigurations.
  for (const sub of CONTEXT_SUBDIRS) {
    mkdirSync(resolve(fallbackContextDir, sub), { recursive: true });
  }

  mkdirSync(dataDbDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(resolve(config.dataDir, "secrets"), { recursive: true });
}
