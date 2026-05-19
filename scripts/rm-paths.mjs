#!/usr/bin/env node
import { rm } from "node:fs/promises";
import path from "node:path";

/**
 * Cross-platform rm -rf for build artifacts. Each path is resolved
 * relative to the caller's CWD so per-package `clean` scripts can call
 * `node ../../scripts/rm-paths.mjs dist` without juggling absolute paths.
 *
 * `recursive: true, force: true` matches the `rm -rf` semantics:
 * non-existent paths are ignored, directories are removed recursively.
 */

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: rm-paths.mjs <path>...");
  process.exit(1);
}

for (const target of targets) {
  await rm(path.resolve(target), { recursive: true, force: true });
}
