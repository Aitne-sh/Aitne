#!/usr/bin/env node
// Build-time helper: strip the build machine's absolute project root out of
// Next.js' `required-server-files.{json,js}` before publishing.
//
// Next records the monorepo root it auto-detected at build time into
// `config.outputFileTracingRoot`, `config.turbopack.root`, and `appDir`
// (e.g. `/Users/<name>/Projects/personal_agent`). Those absolute paths are
// build-machine tracing hints — `next start` re-resolves the real directory
// from its cwd at runtime, so the baked value never matches (and is ignored on)
// an end user's install. Left in place they leak the maintainer's OS username
// and directory layout into the published @aitne/dashboard tarball.
//
// We rewrite that literal root to a neutral placeholder. This is post-build
// cleanup of a published artifact, exactly like strip-maps.mjs, and is safe:
// the value was already non-existent on every user's machine.
//
// Usage: node scripts/sanitize-build-paths.mjs <.next dir> [<.next dir> ...]

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PLACEHOLDER = "/aitne";

const dirs = process.argv.slice(2);
const targets = dirs.length > 0 ? dirs : [".next"];

let rewritten = 0;

for (const target of targets) {
  const nextDir = resolve(target);
  const jsonPath = join(nextDir, "required-server-files.json");

  let manifest;
  try {
    manifest = JSON.parse(await readFile(jsonPath, "utf8"));
  } catch {
    // No manifest (fresh tree / non-Next dir) → nothing to sanitize. Idempotent.
    continue;
  }

  // The build root Next baked in. Prefer the explicit tracing root; fall back
  // to deriving it from appDir by removing the portable relativeAppDir suffix.
  let buildRoot = manifest?.config?.outputFileTracingRoot;
  if (!buildRoot && manifest?.appDir && manifest?.relativeAppDir) {
    const suffix = `/${manifest.relativeAppDir}`;
    if (manifest.appDir.endsWith(suffix)) {
      buildRoot = manifest.appDir.slice(0, -suffix.length);
    }
  }
  if (!buildRoot || buildRoot === PLACEHOLDER) {
    continue; // nothing to strip, or already sanitized
  }

  // Literal (non-regex) global replace across both sibling files.
  for (const name of ["required-server-files.json", "required-server-files.js"]) {
    const p = join(nextDir, name);
    let text;
    try {
      text = await readFile(p, "utf8");
    } catch {
      continue; // .js sibling is optional
    }
    if (!text.includes(buildRoot)) continue;
    await writeFile(p, text.split(buildRoot).join(PLACEHOLDER));
    rewritten += 1;
  }

  console.log(`sanitize-build-paths: rewrote build root ${buildRoot} -> ${PLACEHOLDER} in ${target}`);
}

if (rewritten === 0) {
  console.log("sanitize-build-paths: no build-root paths to strip");
}
