/**
 * Cross-context loader for better-sqlite3.
 *
 * The package ships as a daemon dependency. In two of our contexts it
 * resolves at the top level via standard ESM:
 *
 *   1. After `npm install -g aitne` — the prepack flatten makes daemon
 *      dependencies top-level for the published package, so `import`
 *      resolves cleanly.
 *   2. In the published package's tarball regardless of how it was
 *      installed locally.
 *
 * In the dev repo, however, pnpm 10 keeps daemon deps under
 * `packages/daemon/node_modules/`. `import("better-sqlite3")` from a
 * top-level CLI script (bin/aitne.mjs, scripts/commands/*.mjs) returns
 * ERR_MODULE_NOT_FOUND. This helper falls back to the daemon's own
 * resolver in that case so the dev-time CLI behaves identically to the
 * installed CLI.
 *
 * Returns the default-exported `Database` constructor.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadBetterSqlite3(projectRoot) {
  // Standard path first.
  try {
    const mod = await import("better-sqlite3");
    return mod.default ?? mod;
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  }

  // Dev fallback — resolve via the daemon's own require.
  const daemonPkgPath = path.join(projectRoot, "packages", "daemon", "package.json");
  if (!fs.existsSync(daemonPkgPath)) {
    const err = new Error(
      "better-sqlite3 is not installed. Run `pnpm install` from the repo root, "
      + "or reinstall the npm package.",
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  const req = createRequire(pathToFileURL(daemonPkgPath));
  // require() returns the constructor directly for better-sqlite3.
  return req("better-sqlite3");
}
