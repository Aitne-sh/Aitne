/**
 * Native helper loader. Returns the AppContainer launcher when running
 * on Windows with the addon present; throws a descriptive error
 * otherwise so callers (`sandbox-launcher.ts:loadWindowsHelper`) can
 * surface the situation cleanly to the dashboard.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

function loadHelper() {
  if (process.platform !== "win32") {
    throw new Error(
      "win-appcontainer is Windows-only; the daemon should not have selected the appcontainer-jobobject sandbox primitive on this host",
    );
  }
  const candidate = path.join(__dirname, "build", "Release", "win_appcontainer.node");
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `win_appcontainer.node missing at ${candidate}; run 'npm rebuild' inside packages/daemon to compile the native addon`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports, node/no-missing-require
  return require(candidate);
}

module.exports = { loadHelper };
