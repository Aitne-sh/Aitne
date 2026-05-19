#!/usr/bin/env node

import module from "node:module";

// Enable Node.js module compile cache for faster startup
// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

// Distinguish "@aitne/daemon itself is missing" from "@aitne/daemon loaded but
// one of its transitive imports is missing" — only the former should trigger
// the workspace fallback. The latter must surface as-is so the operator sees
// the real missing-package name.
const isMissingDaemonItself = (err) =>
  isModuleNotFoundError(err) && /['"]@aitne\/daemon['"]/.test(String(err.message ?? ""));

// Resolves to packages/daemon/dist/index.js in workspace dev (pnpm symlinks
// node_modules/@aitne/daemon → packages/daemon) and to the installed package
// in a published global install. Falls back to the workspace path when the
// dependency cannot be resolved (helps in fresh checkouts pre-`pnpm install`).
try {
  await import("@aitne/daemon");
} catch (err) {
  if (isMissingDaemonItself(err)) {
    try {
      await import("./packages/daemon/dist/index.js");
    } catch (innerErr) {
      if (isMissingDaemonItself(innerErr)) {
        throw new Error(
          "personal-agent: cannot find @aitne/daemon — run `pnpm install` and `pnpm build` first.",
        );
      }
      throw innerErr;
    }
  } else {
    throw err;
  }
}
