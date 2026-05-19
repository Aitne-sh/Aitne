#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { ensureBuild, log } from "./run-node.mjs";
import { openBrowser, waitForHttpReady } from "./browser.mjs";

const IS_WINDOWS = process.platform === "win32";
const requireFromScript = createRequire(import.meta.url);

/**
 * Resolve the `next` binary for the current OS — see bin/aitne.mjs
 * for the full rationale. Duplicated rather than shared to keep these
 * scripts dependency-free of one another at module-load time.
 */
function resolveNextBin(dashboardDir) {
  try {
    requireFromScript.resolve("next/dist/bin/next");
    return process.execPath;
  } catch {
    // Fall through to legacy .bin probing.
  }
  const binDir = path.join(dashboardDir, "node_modules", ".bin");
  if (IS_WINDOWS) {
    const direct = path.join(dashboardDir, "node_modules", "next", "dist", "bin", "next");
    if (fs.existsSync(direct)) return process.execPath;
    const cmd = path.join(binDir, "next.cmd");
    if (fs.existsSync(cmd)) return cmd;
  }
  return path.join(binDir, "next");
}

function nextSpawnArgs(dashboardDir, nextBin, userArgs) {
  if (nextBin === process.execPath) {
    try {
      return [requireFromScript.resolve("next/dist/bin/next"), ...userArgs];
    } catch {
      // Fall through to Windows legacy direct-path probing.
    }
    const direct = path.join(
      dashboardDir, "node_modules", "next", "dist", "bin", "next",
    );
    return [direct, ...userArgs];
  }
  return userArgs;
}

/**
 * Start daemon + dashboard together.
 *
 * 1. Build TypeScript if stale
 * 2. Spawn daemon (personal-agent.mjs)
 * 3. Spawn dashboard (next dev)
 * 4. Auto-open browser when dashboard is ready (unless --no-open)
 * 5. Ctrl+C stops both
 */

const DASHBOARD_PORT = parseInt(process.env.PA_DASHBOARD_PORT || "3000", 10);
const noOpen = process.argv.slice(2).includes("--no-open");
const children = [];
let shuttingDown = false;

// ── 1. Build ──

const cwd = process.cwd();
const buildCode = await ensureBuild(cwd);
if (buildCode !== 0) process.exit(buildCode);

// ── 2. Spawn daemon ──

log("Starting daemon...");
const daemon = spawn(process.execPath, ["personal-agent.mjs"], {
  cwd,
  env: process.env,
  stdio: "inherit",
});
children.push(daemon);

// ── 3. Spawn dashboard ──

log("Starting dashboard...");
// Resolve dashboard via package.json so this works in both workspace dev
// (pnpm symlinks node_modules/@aitne/dashboard → packages/dashboard) and
// global installs (where @aitne/dashboard is a sibling node_modules entry).
let dashboardDir;
try {
  dashboardDir = path.dirname(requireFromScript.resolve("@aitne/dashboard/package.json"));
} catch {
  dashboardDir = path.join(cwd, "packages/dashboard");
}
const nextBin = resolveNextBin(dashboardDir);
const dashArgs = nextSpawnArgs(dashboardDir, nextBin, [
  "dev", "--port", String(DASHBOARD_PORT),
]);
const dashboard = spawn(nextBin, dashArgs, {
  cwd: dashboardDir,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
  shell: IS_WINDOWS && nextBin.toLowerCase().endsWith(".cmd"),
});
children.push(dashboard);

// ── 4. Auto-open browser ──

if (!noOpen) {
  const url = `http://localhost:${DASHBOARD_PORT}`;
  waitForHttpReady(url, {
    // `next dev` can take ~30s on a cold boot; give it headroom.
    timeoutMs: 60_000,
    liveness: [
      () => !shuttingDown,
      () => !daemon.killed,
      () => !dashboard.killed,
    ],
  })
    .then(async (ready) => {
      if (!ready) {
        if (!shuttingDown) log("Dashboard did not become ready in time");
        return;
      }
      log(`Dashboard ready — opening ${url}`);
      await openBrowser(url);
    })
    .catch((err) => {
      if (!shuttingDown) log(`Browser-open error: ${err?.message ?? err}`);
    });
}

// ── 5. Graceful shutdown ──

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down...`);
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

// Exit when both children exit
let exited = 0;
const exitCodes = [];
for (const child of children) {
  child.on("exit", (code) => {
    exitCodes.push(code ?? 1);
    exited++;
    if (exited >= children.length) {
      process.exit(Math.max(...exitCodes));
    }
  });
}
