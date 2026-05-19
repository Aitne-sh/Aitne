#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Smart build-gate runner.
 *
 * 1. Checks whether TypeScript sources are newer than .buildstamp
 * 2. If stale, runs `turbo run build` (respects shared → daemon dep order)
 * 3. Spawns `node personal-agent.mjs` with the compiled output
 */

const SOURCE_DIRS = ["packages/shared/src", "packages/daemon/src", "packages/dashboard/src"];
const CONFIG_FILES = [
  "tsconfig.base.json",
  "packages/shared/tsconfig.json",
  "packages/shared/package.json",
  "packages/daemon/tsconfig.json",
  "packages/daemon/package.json",
  "packages/dashboard/package.json",
  "packages/dashboard/next.config.ts",
  "packages/dashboard/postcss.config.mjs",
  "package.json",
];
const DIST_ENTRY = "packages/daemon/dist/index.js";
const DASHBOARD_BUILD_ID = "packages/dashboard/.next/BUILD_ID";

const statMtime = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath) => {
  return (
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.tsx") ||
    filePath.endsWith("test-helpers.ts")
  );
};

const findLatestMtime = (dirPath) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedSource(fullPath)) continue;
      const mtime = statMtime(fullPath);
      if (mtime != null && (latest == null || mtime > latest)) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const readBuildStamp = (stampPath) => {
  const mtime = statMtime(stampPath);
  if (mtime == null) return { mtime: null };
  return { mtime };
};

function hasAnySourceTree(cwd) {
  return SOURCE_DIRS.some((relDir) => {
    try {
      return fs.statSync(path.join(cwd, relDir)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * True when running from a published `pnpm add -g aitne` install. The aitne
 * tarball excludes packages/ — sub-packages live as siblings under node_modules
 * (@aitne/daemon, @aitne/dashboard, @aitne/shared) and ship their own dist/.
 * In this layout there is nothing to build at the consumer's cwd, and the
 * build toolchain (turbo, tsc, next) is not installed.
 */
export function isPublishedInstall(cwd) {
  return !hasAnySourceTree(cwd);
}

export function hasPackagedBuild(cwd) {
  return (
    statMtime(path.join(cwd, DIST_ENTRY)) != null &&
    statMtime(path.join(cwd, DASHBOARD_BUILD_ID)) != null &&
    !hasAnySourceTree(cwd)
  );
}

/** Check if daemon TypeScript needs rebuilding. */
export function shouldBuild(cwd) {
  // Published install: nothing to build at cwd, build toolchain not installed.
  if (isPublishedInstall(cwd)) return false;
  // Legacy fallback: source-less tree with prebuilt artifacts at cwd.
  if (hasPackagedBuild(cwd)) return false;

  const stampPath = path.join(cwd, ".buildstamp");

  if (process.env.PA_FORCE_BUILD === "1") return true;

  const stamp = readBuildStamp(stampPath);
  if (stamp.mtime == null) return true;

  if (statMtime(path.join(cwd, DIST_ENTRY)) == null) return true;
  if (statMtime(path.join(cwd, DASHBOARD_BUILD_ID)) == null) return true;

  for (const relPath of CONFIG_FILES) {
    const mtime = statMtime(path.join(cwd, relPath));
    if (mtime != null && mtime > stamp.mtime) return true;
  }

  for (const relDir of SOURCE_DIRS) {
    const srcMtime = findLatestMtime(path.join(cwd, relDir));
    if (srcMtime != null && srcMtime > stamp.mtime) return true;
  }

  return false;
}

/** Write .buildstamp after a successful build. */
export function writeBuildStamp(cwd) {
  const stampPath = path.join(cwd, ".buildstamp");
  try {
    const stamp = { builtAt: Date.now() };
    fs.writeFileSync(stampPath, `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    log(`Failed to write build stamp: ${error?.message ?? "unknown error"}`);
  }
}

/** Run turbo build. Returns exit code. */
export async function runBuild(cwd, { quiet = false } = {}) {
  if (!quiet) log("Building TypeScript (dist is stale).");
  const stdio = quiet ? ["ignore", "pipe", "pipe"] : "inherit";
  // pnpm is installed as `pnpm.cmd` (and `.ps1`) on Windows. Batch shims
  // require a shell on Windows; POSIX keeps shell:false for predictable argv
  // handling.
  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const build = spawn(pnpmBin, ["run", "build"], {
    cwd,
    env: process.env,
    stdio,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  let output = "";
  if (quiet) {
    build.stdout?.on("data", (chunk) => { output += chunk; });
    build.stderr?.on("data", (chunk) => { output += chunk; });
  }
  const res = await new Promise((resolve) => {
    build.on("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });
  const code = res.exitSignal ? 1 : (res.exitCode ?? 0);
  if (quiet && code !== 0) {
    process.stderr.write(output);
  }
  return code;
}

/** Ensure build is fresh. Returns exit code (0 = ok). */
export async function ensureBuild(cwd, { quiet = false } = {}) {
  if (!shouldBuild(cwd)) return 0;
  const code = await runBuild(cwd, { quiet });
  if (code === 0) writeBuildStamp(cwd);
  return code;
}

export function log(message) {
  if (process.env.PA_RUNNER_LOG === "0") return;
  process.stderr.write(`[aiservant] ${message}\n`);
}

// ── Direct execution: build-if-needed → run daemon ──

async function runNodeMain() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);

  const buildCode = await ensureBuild(cwd);
  if (buildCode !== 0) return buildCode;

  const child = spawn(process.execPath, ["personal-agent.mjs", ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  const res = await new Promise((resolve) => {
    child.on("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });
  if (res.exitSignal) return 1;
  return res.exitCode ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
