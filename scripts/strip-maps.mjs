#!/usr/bin/env node
// Build-time helper: delete *.map files under the given directories.
//
// Next.js emits server-side source maps under `.next/server/**` that carry no
// `sourcesContent` (and `sources: []`) — they map to nothing and are pure
// tarball weight in the published @aitne/dashboard package. There is no stable
// Next config flag to disable server source maps, so we strip them after the
// build. Source maps are never required for execution, so removal is safe.
//
// Usage: node scripts/strip-maps.mjs <dir> [<dir> ...]   (default: cwd)

import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ["."];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing dir → nothing to strip (idempotent / fresh-tree safe)
  }
  let removed = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      await rm(full);
      removed += 1;
    }
  }
  return removed;
}

let total = 0;
for (const target of targets) {
  total += await walk(resolve(target));
}
console.log(`strip-maps: removed ${total} .map file(s) from ${targets.join(", ")}`);
