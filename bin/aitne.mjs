#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureBuild } from "../scripts/run-node.mjs";
import { fetchHttpOk, openBrowser } from "../scripts/browser.mjs";
// Port defaults live in this plain-ESM module (NOT @aitne/shared, per the
// pre-build constraint noted below). scripts/lib/ ships in the published
// `files` list, so this import works in global installs too.
import {
  DEFAULT_API_PORT,
  DEFAULT_DASHBOARD_PORT,
  resolveApiPort,
  resolveDashboardPort,
} from "../scripts/lib/ports.mjs";

const IS_WINDOWS = process.platform === "win32";

/**
 * aitne — CLI for managing the Aitne local-first personal agent.
 *
 * Lifecycle:
 *   aitne start [--no-open]               Build & launch daemon + dashboard
 *   aitne stop                            Graceful shutdown
 *   aitne restart [--clean-context]       Stop then start
 *   aitne status                          PIDs, uptime, integrations, today spend
 *   aitne logs [-f] [-n N] [-d]           View daemon (or dashboard) logs
 *   aitne dev                             Foreground mode (development)
 *   aitne build                           Explicit build
 *
 * Operations:
 *   aitne setup                           Open dashboard /setup wizard
 *   aitne open                            Open dashboard root
 *   aitne doctor                          Diagnose install issues
 *   aitne audit [--since 24h] [--type X]  Show agent action log
 *   aitne version                         Print version + environment
 *   aitne update                          Print npm upgrade command
 *   aitne uninstall                       Stop, then offer to wipe data dir
 *   aitne help [cmd]                      Show help (or per-command help)
 *
 * APP_NAME is hardcoded inline here, not imported from packages/shared, because
 * this bin runs *before* `pnpm build` completes (the whole point of `aitne
 * start` is to trigger that build), so importing from `shared/dist/` would fail
 * on a fresh checkout. Keep this in sync with packages/shared/src/branding.ts.
 */
const APP_NAME = "Aitne";
// MUST stay in sync with packages/shared/src/branding.ts:APP_NAME

// ── Resolve project root (works from bin symlink, direct invocation, or
//    node_modules/aitne/bin/ once published — `..` resolves to package root in
//    every case). ──
const BIN_FILE = fileURLToPath(import.meta.url);
const __dirname = path.dirname(BIN_FILE);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const requireFromBin = createRequire(import.meta.url);

const DATA_DIR = process.env.PA_DATA_DIR || path.join(os.homedir(), ".personal-agent");
const PIDS_DIR = path.join(DATA_DIR, "run");
const DAEMON_PID_FILE = path.join(PIDS_DIR, "daemon.pid");
const DASHBOARD_PID_FILE = path.join(PIDS_DIR, "dashboard.pid");
const DAEMON_LOG_FILE = path.join(DATA_DIR, "logs", "daemon.log");
const DASHBOARD_LOG_FILE = path.join(DATA_DIR, "logs", "dashboard.log");
const DAEMON_PORT = resolveApiPort();
const DASHBOARD_PORT = resolveDashboardPort();

const VERSION = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
).version || "0.1.0";

// ── PID helpers ──

const parsedLogMaxBytes = parseInt(process.env.PA_LOG_MAX_BYTES || "", 10);
const LOG_MAX_BYTES =
  Number.isFinite(parsedLogMaxBytes) && parsedLogMaxBytes > 0
    ? parsedLogMaxBytes
    : 10 * 1024 * 1024;

function ensureDirs() {
  fs.mkdirSync(PIDS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DAEMON_LOG_FILE), { recursive: true });
}

/** Rotate log if over threshold. Keeps one .1 backup. */
function rotateLogIfNeeded(logFile, maxBytes = LOG_MAX_BYTES) {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > maxBytes) rotateLogFile(logFile);
  } catch { /* file doesn't exist yet — fine */ }
}

function rotateLogFile(logFile) {
  const rotated = logFile + ".1";
  try { fs.unlinkSync(rotated); } catch { /* ignore */ }
  try { fs.renameSync(logFile, rotated); } catch { /* ignore */ }
}

function readPid(pidFile) {
  try {
    const content = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pidFile, pid) {
  fs.writeFileSync(pidFile, String(pid) + "\n");
}

function removePid(pidFile) {
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Resolve the dashboard package directory.
 *
 * Workspace dev:    pnpm symlinks node_modules/@aitne/dashboard → packages/dashboard
 * Published install: @aitne/dashboard is installed as a sibling node_modules entry
 *
 * Falls back to PROJECT_ROOT/packages/dashboard for fresh checkouts before
 * `pnpm install` has created the symlink.
 */
function resolveDashboardDir() {
  try {
    return path.dirname(requireFromBin.resolve("@aitne/dashboard/package.json"));
  } catch {
    return path.join(PROJECT_ROOT, "packages/dashboard");
  }
}

/**
 * Resolve the dashboard `next` binary for the current OS.
 *
 * Prefer Node's package resolution for Next's real CLI entrypoint. This works
 * in the pnpm workspace, in npm global installs, and in local npm installs
 * where dependencies are hoisted to the parent app's node_modules instead of
 * living under node_modules/aitne/node_modules.
 *
 * The fallback .bin lookup is kept for unusual layouts and older installs.
 * Batch shims need `cmd.exe` on Windows, so the resolved Node entrypoint is
 * preferred there too.
 */
function resolveNextBin(dashboardDir) {
  try {
    requireFromBin.resolve("next/dist/bin/next");
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

/**
 * Build the spawn args for the dashboard. When resolveNextBin returns the
 * current Node executable, inject Next's CLI entrypoint before the user's args.
 * Mirrors the candidate-dirs fallback lookup in resolveNextBin.
 */
function nextSpawnArgs(dashboardDir, nextBin, userArgs) {
  if (nextBin === process.execPath) {
    try {
      return [requireFromBin.resolve("next/dist/bin/next"), ...userArgs];
    } catch {
      // Fall through to direct-path probing.
    }
    for (const dir of [dashboardDir, PROJECT_ROOT]) {
      const direct = path.join(dir, "node_modules", "next", "dist", "bin", "next");
      if (fs.existsSync(direct)) return [direct, ...userArgs];
    }
  }
  return userArgs;
}

function getRunningPid(pidFile) {
  const pid = readPid(pidFile);
  if (pid == null) return null;
  if (!isAlive(pid)) { removePid(pidFile); return null; }
  return pid;
}

/**
 * Kill `pid` (and its descendants where supported) and wait for it to exit.
 *
 * - POSIX: signal the process *group* via `process.kill(-pid, ...)` so any
 *   child processes the daemon spawned (Claude/Codex/Gemini CLIs, the
 *   bundled Next dashboard) also receive the signal. Falls back to a
 *   single-process kill if the group call fails.
 * - Windows: no process groups; use `taskkill /T /F /PID <pid>` to walk the
 *   parent-pid chain and terminate descendants. `/F` is required because
 *   Windows console apps don't honor a graceful close — Node simulates
 *   SIGTERM as TerminateProcess in this scenario, so a graceful first pass
 *   would no-op.
 */
function killTree(pid, signal) {
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "pipe",
        windowsHide: true,
      });
      return true;
    } catch {
      // Fall through to per-process kill below.
    }
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
  try { process.kill(-pid, signal); return true; } catch {
    try { process.kill(pid, signal); return true; } catch { return false; }
  }
}

async function killAndWait(pid, pidFile, label, timeoutMs = 10_000) {
  killTree(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) { removePid(pidFile); return true; }
    await new Promise((r) => setTimeout(r, 150));
  }
  // Force kill if still alive. On Windows the first taskkill /F already
  // hard-kills, so this branch is mostly a POSIX escalation.
  killTree(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  if (!isAlive(pid)) { removePid(pidFile); return true; }
  return false;
}

/**
 * Print the last N lines of a log file to stderr, framed so it's visible.
 * Used on startup failure so the user gets immediate signal instead of
 * having to chase `pa logs`. Falls back silently if the file is missing.
 */
function printLogTail(logFile, n) {
  try {
    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(-n);
    if (tail.length === 0) return;
    console.log("");
    console.log(`  --- last ${tail.length} log line(s) ---`);
    for (const line of tail) console.log(`  ${line}`);
    console.log(`  --- end of log ---`);
  } catch {
    /* log not present — caller already told the user where to look */
  }
}

function encodeLogRunnerSpec(spec) {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

function decodeLogRunnerSpec(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function spawnLoggedService({ command, args, cwd, logFile, env, shell = false }) {
  return spawn(
    process.execPath,
    [BIN_FILE, "_log-runner", encodeLogRunnerSpec({ command, args, cwd, logFile, shell })],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: true,
    },
  );
}

async function cmdLogRunner(args) {
  const spec = decodeLogRunnerSpec(args[0] || "");
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  rotateLogIfNeeded(spec.logFile);

  let fd = fs.openSync(spec.logFile, "a");
  let size = 0;
  try {
    size = fs.fstatSync(fd).size;
  } catch {
    size = 0;
  }

  const reopen = () => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    rotateLogFile(spec.logFile);
    fd = fs.openSync(spec.logFile, "a");
    size = 0;
  };

  const writeChunk = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let offset = 0;
    while (offset < buf.length) {
      if (size >= LOG_MAX_BYTES) reopen();
      const room = Math.max(1, LOG_MAX_BYTES - size);
      const length = Math.min(room, buf.length - offset);
      fs.writeSync(fd, buf, offset, length);
      offset += length;
      size += length;
    }
  };

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: spec.shell === true,
  });

  child.stdout.on("data", writeChunk);
  child.stderr.on("data", writeChunk);
  child.on("error", (err) => {
    writeChunk(`[log-runner] failed to start child: ${err.message}\n`);
    try { fs.closeSync(fd); } catch { /* ignore */ }
    process.exit(1);
  });

  const stopChild = (signal) => {
    try { child.kill(signal); } catch { /* ignore */ }
  };
  process.on("SIGTERM", () => stopChild("SIGTERM"));
  process.on("SIGINT", () => stopChild("SIGINT"));

  child.on("exit", (code, signal) => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    if (signal) process.exit(128);
    process.exit(code ?? 0);
  });
}

async function fetchHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) return await res.json();
  } catch { /* not responding */ }
  return null;
}

function formatUptime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ── Commands ──

async function cmdStart(args = []) {
  const noOpen = args.includes("--no-open");
  const daemonPid = getRunningPid(DAEMON_PID_FILE);
  const dashPid = getRunningPid(DASHBOARD_PID_FILE);
  if (daemonPid && dashPid) {
    console.log(`Already running (daemon: ${daemonPid}, dashboard: ${dashPid}).`);
    if (!noOpen) {
      const url = `http://localhost:${DASHBOARD_PORT}`;
      if (await openBrowser(url)) console.log(`  Opened ${url} in browser.`);
    }
    // `pa start` on an already-running instance is idempotent, not an error.
    process.exit(0);
  }
  if (daemonPid || dashPid) {
    // Partial state — stop first
    console.log("Partial state detected, cleaning up...");
    await cmdStop();
    await new Promise((r) => setTimeout(r, 500));
  }

  // Build if needed (quiet — only show output on failure)
  const { shouldBuild } = await import("../scripts/run-node.mjs");
  if (shouldBuild(PROJECT_ROOT)) {
    process.stdout.write("Building...");
    const buildCode = await ensureBuild(PROJECT_ROOT, { quiet: true });
    if (buildCode !== 0) {
      console.log(" failed.");
      process.exit(buildCode);
    }
    console.log(" done.");
  }

  ensureDirs();
  rotateLogIfNeeded(DAEMON_LOG_FILE);
  rotateLogIfNeeded(DASHBOARD_LOG_FILE);

  // Start daemon under a tiny log runner. The runner owns the file handle and
  // rotates while the service is running; direct child fd redirection can only
  // rotate on the next `aitne start`.
  const daemon = spawnLoggedService({
    command: process.execPath,
    args: ["personal-agent.mjs"],
    cwd: PROJECT_ROOT,
    logFile: DAEMON_LOG_FILE,
    env: { ...process.env, PA_DAEMONIZED: "1" },
  });
  writePid(DAEMON_PID_FILE, daemon.pid);
  daemon.unref();

  // Start dashboard (next start — production mode).
  // Resolve via package.json so we work in both workspace dev (pnpm symlinks
  // node_modules/@aitne/dashboard → packages/dashboard) and global installs
  // (where @aitne/dashboard is a sibling node_modules entry).
  const dashboardDir = resolveDashboardDir();
  // Prefer Next's direct Node entrypoint on Windows; `.cmd` shims require
  // cmd.exe and are kept only as a last fallback.
  const nextBin = resolveNextBin(dashboardDir);
  const dashArgs = nextSpawnArgs(dashboardDir, nextBin, [
    "start", "--port", String(DASHBOARD_PORT),
  ]);
  const dashboard = spawnLoggedService({
    command: nextBin,
    args: dashArgs,
    cwd: dashboardDir,
    logFile: DASHBOARD_LOG_FILE,
    env: { ...process.env, PA_DAEMONIZED: "1" },
    shell: IS_WINDOWS && nextBin.toLowerCase().endsWith(".cmd"),
  });
  writePid(DASHBOARD_PID_FILE, dashboard.pid);
  dashboard.unref();

  // Verify startup — wait for daemon health AND dashboard HTTP in one phase,
  // so the "ok." line is only printed once everything is actually ready.
  process.stdout.write("Starting...");
  const status = await verifyStartup(daemon.pid, dashboard.pid);
  if (!status.daemon) {
    console.log(" failed.");
    const daemonAlive = isAlive(daemon.pid);
    if (daemonAlive) {
      console.log(`  Daemon process ${daemon.pid} is alive but /api/health did not respond — likely hung during startup.`);
    } else {
      console.log(`  Daemon process ${daemon.pid} exited before becoming ready.`);
    }
    console.log(`  Check logs: ${DAEMON_LOG_FILE}`);
    printLogTail(DAEMON_LOG_FILE, 30);
    // Leave the hung daemon cleaned up so the next `pa start` is not
    // short-circuited by the "already running" check — otherwise the user
    // would have to `pa stop` first.
    if (daemonAlive) {
      await killAndWait(daemon.pid, DAEMON_PID_FILE, "daemon", 5_000);
    } else {
      removePid(DAEMON_PID_FILE);
    }
    if (isAlive(dashboard.pid)) {
      await killAndWait(dashboard.pid, DASHBOARD_PID_FILE, "dashboard", 5_000);
    } else {
      removePid(DASHBOARD_PID_FILE);
    }
    process.exit(1);
  }
  console.log(" ok.");

  let dashSuffix = "";
  if (!status.dashboard) {
    dashSuffix = "  (not yet responding — open manually)";
  } else if (!noOpen) {
    const url = `http://localhost:${DASHBOARD_PORT}`;
    if (await openBrowser(url)) dashSuffix = "  (opened in browser)";
  }

  console.log(`  Daemon:    PID ${daemon.pid}  → http://127.0.0.1:${DAEMON_PORT}`);
  console.log(`  Dashboard: PID ${dashboard.pid}  → http://localhost:${DASHBOARD_PORT}${dashSuffix}`);

  // Post-startup summary — best-effort. /api/health is the daemon's own
  // synthesis of ready integrations + auth state, so we lean on it instead
  // of re-querying multiple endpoints. Skip silently if anything is shaped
  // unexpectedly — a successful daemon start is the signal here, not this
  // line.
  try {
    const finalHealth = await fetchHealth();
    if (finalHealth) {
      const platforms = Array.isArray(finalHealth.connectedPlatforms)
        ? finalHealth.connectedPlatforms.length
        : 0;
      const backends = Array.isArray(finalHealth.backends)
        ? finalHealth.backends.filter((b) => b.authOk !== false).length
        : 0;
      const totalBackends = Array.isArray(finalHealth.backends) ? finalHealth.backends.length : 0;
      const integrations = finalHealth.integrationModes
        ? Object.values(finalHealth.integrationModes).filter((m) => m && m !== "off").length
        : 0;
      console.log("");
      console.log(`  ${platforms} platform(s) · ${backends}/${totalBackends} backend(s) ready · ${integrations} integration(s) active`);
    }
  } catch { /* health query racy at boot — ignore */ }
}

/**
 * Wait for both daemon (/api/health) and dashboard (HTTP root) to become
 * reachable. Exits early if either process dies. Returns a structured result
 * so the caller can differentiate "daemon crashed" (hard failure) from
 * "dashboard is just slow" (soft degradation).
 */
async function verifyStartup(daemonPid, dashPid, timeoutMs = 30_000) {
  const dashUrl = `http://127.0.0.1:${DASHBOARD_PORT}/`;
  const deadline = Date.now() + timeoutMs;
  let daemonHealthy = false;
  let dashboardReady = false;
  while (Date.now() < deadline) {
    if (!isAlive(daemonPid)) return { daemon: false, dashboard: false };
    if (!isAlive(dashPid)) return { daemon: daemonHealthy, dashboard: false };
    if (!daemonHealthy) {
      if (await fetchHealth()) daemonHealthy = true;
    }
    if (!dashboardReady) {
      if (await fetchHttpOk(dashUrl, 1_500)) dashboardReady = true;
    }
    if (daemonHealthy && dashboardReady) return { daemon: true, dashboard: true };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { daemon: daemonHealthy, dashboard: dashboardReady };
}

async function cmdStop() {
  const daemonPid = getRunningPid(DAEMON_PID_FILE);
  const dashPid = getRunningPid(DASHBOARD_PID_FILE);

  if (!daemonPid && !dashPid) {
    console.log("Not running.");
    return;
  }

  // Kill both in parallel
  const kills = [];
  if (daemonPid) kills.push(killAndWait(daemonPid, DAEMON_PID_FILE, "daemon"));
  if (dashPid) kills.push(killAndWait(dashPid, DASHBOARD_PID_FILE, "dashboard"));
  const results = await Promise.all(kills);

  const labels = [];
  if (daemonPid) labels.push(results.shift() ? "daemon stopped" : `daemon (PID ${daemonPid}) did not exit`);
  if (dashPid) labels.push(results.shift() ? "dashboard stopped" : `dashboard (PID ${dashPid}) did not exit`);

  for (const l of labels) console.log(`  ${l}`);
  console.log("Stopped.");
}

async function cmdRestart(args = []) {
  const cleanContext = args.includes("--clean-context");
  await cmdStop();
  await new Promise((r) => setTimeout(r, 500));
  if (cleanContext) {
    await cleanContextDirectory();
  }
  await cmdStart(args.filter((a) => a !== "--clean-context"));
}

// B-007 §7 — wipe context/ and md_file_snapshots rows after stopping the
// daemon, with a tarball safety backup. Mirrors
// packages/daemon/src/core/reinstall.ts but runs from the CLI so the
// daemon does not have to serve API calls through its own deletion.
async function cleanContextDirectory() {
  const contextDir = path.join(DATA_DIR, "context");
  const backupDir = path.join(DATA_DIR, "backup");
  const dbPath = path.join(DATA_DIR, "data", "personal_agent.db");

  if (!fs.existsSync(contextDir) && !fs.existsSync(dbPath)) {
    console.log("Nothing to wipe — no context/ or personal_agent.db present.");
    return;
  }

  const plan = await enumerateContextPlan(contextDir, dbPath);
  const sizeMb = (plan.totalBytes / (1024 * 1024)).toFixed(2);
  console.log("");
  console.log("About to WIPE the following:");
  console.log(`  context/ (${plan.fileCount} files, ${sizeMb} MB)`);
  console.log(`  md_file_snapshots (${plan.snapshotRowCount} rows)`);
  console.log("");
  console.log("Other SQLite tables, the OS keychain, and cache/ stay intact.");
  console.log("Type CLEAN to proceed, anything else to abort:");
  const confirm = await readLineFromStdin();
  if (confirm.trim() !== "CLEAN") {
    console.log("Aborted.");
    process.exit(1);
  }

  if (plan.fileCount > 0) {
    const backupPath = path.join(
      backupDir,
      `context-pre-reinstall-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const parent = path.dirname(contextDir);
    const leaf = path.basename(contextDir);
    // `tar` ships with macOS, every modern Linux, and Windows 10 1803+
    // (bsdtar in System32). The flags below (`-czf -C`) work on all three.
    // If `tar` is missing (older Windows), fall back to a Node tarball
    // implementation lazy-loaded only on that path.
    const tarOk = await runBackupTar(parent, leaf, backupPath);
    if (!tarOk) {
      console.error("Backup failed — aborting.");
      process.exit(1);
    }
    console.log(`  backup → ${backupPath}`);
  }

  if (fs.existsSync(contextDir)) {
    fs.rmSync(contextDir, { recursive: true, force: true });
    console.log(`  wiped   → ${contextDir}`);
  }

  // B-007 §7.1 — ancillary caches: prompts/ (regenerable), agent-sessions/
  // (bound to the old layout). Missing dirs are skipped silently.
  for (const sub of ["prompts", "agent-sessions"]) {
    const full = path.join(DATA_DIR, sub);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  wiped   → ${full}`);
    }
  }

  if (plan.snapshotRowCount > 0 && fs.existsSync(dbPath)) {
    // The sqlite3 CLI isn't on Windows by default and isn't required on
    // POSIX either. Use the workspace's better-sqlite3 (already a daemon
    // dep and prebuilt for win32-x64 / linux-{x64,arm64} / darwin) so the
    // CLI cleanup path is identical across platforms.
    try {
      const { loadBetterSqlite3 } = await import("../scripts/lib/sqlite-loader.mjs");
      const Database = await loadBetterSqlite3(PROJECT_ROOT);
      const db = new Database(dbPath);
      try {
        db.exec("DELETE FROM md_file_snapshots;");
      } finally {
        db.close();
      }
      console.log(`  cleared → md_file_snapshots (${plan.snapshotRowCount} rows)`);
    } catch (err) {
      console.error(`Failed to clear md_file_snapshots: ${err?.message ?? err}`);
      process.exit(1);
    }
  }
  console.log("");
}

/**
 * Run `tar -czf <out> -C <cwd> <leaf>`. Returns true on success. Spawns
 * the system `tar` (bsdtar on macOS / Windows 10 1803+, GNU tar on Linux);
 * if the binary itself is missing (ENOENT) or the spawn fails, returns
 * false so the caller can decide what to do. We don't ship a Node-side
 * tarball implementation: the failure case (no tar binary) is a stale
 * Windows 7/8 install we don't claim to support.
 */
function runBackupTar(cwd, leaf, outPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("tar", ["-czf", outPath, "-C", cwd, leaf], {
        stdio: "inherit",
        windowsHide: true,
      });
    } catch (err) {
      console.error(`tar spawn failed: ${err?.message ?? err}`);
      resolve(false);
      return;
    }
    child.on("error", (err) => {
      // ENOENT — `tar` not on PATH (e.g. very old Windows).
      console.error(`tar not available: ${err?.message ?? err}`);
      resolve(false);
    });
    child.on("close", (code) => resolve(code === 0));
  });
}

async function enumerateContextPlan(contextDir, dbPath) {
  let fileCount = 0;
  let totalBytes = 0;
  if (fs.existsSync(contextDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          fileCount++;
          totalBytes += fs.statSync(full).size;
        }
      }
    };
    walk(contextDir);
  }
  let snapshotRowCount = 0;
  if (fs.existsSync(dbPath)) {
    // Use better-sqlite3 (workspace dep, prebuilds for all three OSes)
    // instead of the sqlite3 CLI. The CLI isn't on Windows by default and
    // its absence on POSIX would silently undercount snapshots in the
    // confirm prompt — better to fail loud.
    try {
      const { loadBetterSqlite3 } = await import("../scripts/lib/sqlite-loader.mjs");
      const Database = await loadBetterSqlite3(PROJECT_ROOT);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM md_file_snapshots")
          .get();
        snapshotRowCount = Number(row?.n ?? 0) || 0;
      } finally {
        db.close();
      }
    } catch {
      // Table missing on a half-migrated DB, etc. — leave at 0; the daemon
      // will finish cleanup on next boot.
    }
  }
  return { fileCount, totalBytes, snapshotRowCount };
}

async function readLineFromStdin() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    const onData = (chunk) => {
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve(chunk);
    };
    process.stdin.on("data", onData);
  });
}

async function cmdStatus() {
  const daemonPid = getRunningPid(DAEMON_PID_FILE);
  const dashPid = getRunningPid(DASHBOARD_PID_FILE);

  if (!daemonPid && !dashPid) {
    console.log("Not running.");
    return;
  }

  const health = daemonPid ? await fetchHealth() : null;

  console.log(`${APP_NAME} status:`);
  console.log("");

  // Daemon
  if (daemonPid) {
    const uptime = health?.uptime != null ? formatUptime(health.uptime) : "—";
    console.log(`  Daemon:      running (PID ${daemonPid})`);
    console.log(`    Uptime:    ${uptime}`);
    console.log(`    API:       http://127.0.0.1:${DAEMON_PORT}`);
    if (health?.connectedPlatforms?.length > 0) {
      console.log(`    Platforms: ${health.connectedPlatforms.join(", ")}`);
    }
    if (Array.isArray(health?.backends) && health.backends.length > 0) {
      const summary = health.backends
        .map((b) => `${b.id}${b.authOk === false ? "(auth!)" : ""}`)
        .join(", ");
      console.log(`    Backends:  ${summary}`);
    }
  } else {
    console.log(`  Daemon:      not running`);
  }

  // Dashboard
  if (dashPid) {
    console.log(`  Dashboard:   running (PID ${dashPid})`);
    console.log(`    URL:       http://localhost:${DASHBOARD_PORT}`);
  } else {
    console.log(`  Dashboard:   not running`);
  }

  // Activity / cost summary — best-effort, read-only via SQLite. Skip silently
  // if the DB doesn't exist yet or the schema is unexpected.
  try {
    const summary = await readActivitySummary();
    if (summary) {
      console.log("");
      console.log(`  Last action: ${summary.lastActionAt ?? "—"}${summary.lastActionType ? `  (${summary.lastActionType})` : ""}`);
      console.log(`  Today:       ${summary.actionsToday} action(s)  ·  $${summary.costTodayUsd.toFixed(3)} spent`);
      if (summary.nextScheduled) {
        console.log(`  Next:        ${summary.nextScheduled.at}  ${summary.nextScheduled.label}`);
      }
    }
  } catch {
    /* DB missing or pre-init — silent. */
  }
}

/**
 * Read a tiny activity summary directly from SQLite for `aitne status`.
 *
 * Safe to do while the daemon runs because the daemon enables WAL
 * (`packages/daemon/src/db/client.ts`) — concurrent readers are fine.
 * Returns `null` if the DB file doesn't exist yet (fresh install before
 * the daemon's first boot) so the caller can skip the section gracefully.
 */
async function readActivitySummary() {
  const dbPath = path.join(DATA_DIR, "data", "personal_agent.db");
  if (!fs.existsSync(dbPath)) return null;
  const { loadBetterSqlite3 } = await import("../scripts/lib/sqlite-loader.mjs");
  const Database = await loadBetterSqlite3(PROJECT_ROOT);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const lastRow = db
      .prepare("SELECT action_type, started_at FROM agent_actions ORDER BY started_at DESC LIMIT 1")
      .get();
    const todayRow = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost
                FROM agent_actions
                WHERE date(started_at) = date('now', 'localtime')`)
      .get();
    // Schema: agent_schedule(scheduled_for, task_type, status, …) — see
    // packages/daemon/src/db/schema.ts. Status enum: pending|running|completed|skipped|failed.
    let nextScheduled = null;
    try {
      const nextRow = db
        .prepare(`SELECT scheduled_for, task_type FROM agent_schedule
                  WHERE status = 'pending' AND scheduled_for >= datetime('now')
                  ORDER BY scheduled_for ASC LIMIT 1`)
        .get();
      if (nextRow) {
        nextScheduled = { at: nextRow.scheduled_for, label: nextRow.task_type ?? "" };
      }
    } catch { /* table absent on a much-older DB — skip silently */ }
    return {
      lastActionAt: lastRow?.started_at ?? null,
      lastActionType: lastRow?.action_type ?? null,
      actionsToday: Number(todayRow?.n ?? 0),
      costTodayUsd: Number(todayRow?.cost ?? 0),
      nextScheduled,
    };
  } finally {
    db.close();
  }
}

async function cmdLogs(args) {
  const follow = args.includes("-f") || args.includes("--follow");
  const isDash = args.includes("--dashboard") || args.includes("-d");
  const logFile = isDash ? DASHBOARD_LOG_FILE : DAEMON_LOG_FILE;
  const linesArg = (() => {
    const nIdx = args.indexOf("-n");
    if (nIdx !== -1 && args[nIdx + 1]) return parseInt(args[nIdx + 1], 10);
    return 50;
  })();
  const lineCount = Number.isFinite(linesArg) && linesArg > 0 ? linesArg : 50;

  if (!fs.existsSync(logFile)) {
    console.log(`No log file found at ${logFile}`);
    console.log("Has the service been started?");
    process.exit(1);
  }

  await tailFile(logFile, { follow, lines: lineCount });
}

/**
 * Pure-Node `tail` / `tail -f` so the CLI works on Windows (no `tail` binary)
 * as well as POSIX. Trade-offs:
 * - `lines` is honored by reading the whole file and slicing the last N lines.
 *   Daemon logs rotate at 10 MB (see `rotateLogIfNeeded` above), so reading
 *   them entirely is bounded.
 * - `follow` polls via `fs.watchFile` (1 s interval). `fs.watch` would be
 *   pushier but is unreliable across Windows network drives and various
 *   editor write patterns; polling is dull but trustworthy.
 * - On rotate or truncate the read offset is reset so we don't print stale
 *   bytes.
 */
function tailFile(logFile, { follow, lines }) {
  return new Promise((resolve) => {
    let position = 0;
    try {
      const initial = fs.readFileSync(logFile, "utf8");
      const tail = initial.split("\n");
      // Trailing empty element when file ends with newline — drop so we
      // don't print a blank line.
      if (tail.length > 0 && tail[tail.length - 1] === "") tail.pop();
      const slice = tail.slice(-lines);
      if (slice.length > 0) process.stdout.write(slice.join("\n") + "\n");
      position = Buffer.byteLength(initial, "utf8");
    } catch (err) {
      console.error(`Failed to read ${logFile}: ${err.message}`);
      resolve(1);
      return;
    }

    if (!follow) {
      resolve(0);
      return;
    }

    let watching = true;
    const onChange = (curr, prev) => {
      if (!watching) return;
      // File was truncated or rotated — reset to the start so we don't
      // emit garbage from a lost offset.
      if (curr.size < position) position = 0;
      if (curr.size === position) return;
      try {
        const fd = fs.openSync(logFile, "r");
        const length = curr.size - position;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, position);
        fs.closeSync(fd);
        position = curr.size;
        process.stdout.write(buf.toString("utf8"));
      } catch {
        // Log gone (rotation race) — fs.watchFile will fire again when it
        // reappears; resetting position handles the new file.
        position = 0;
      }
    };
    fs.watchFile(logFile, { interval: 1000 }, onChange);

    const stop = () => {
      if (!watching) return;
      watching = false;
      fs.unwatchFile(logFile, onChange);
      resolve(0);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (IS_WINDOWS) process.on("SIGBREAK", stop);
  });
}

async function cmdDev(args = []) {
  // Foreground mode: daemon + dashboard with full stdio
  const child = spawn(
    process.execPath,
    [path.join(PROJECT_ROOT, "scripts/start.mjs"), ...args],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function cmdBuild() {
  const { runBuild, writeBuildStamp } = await import("../scripts/run-node.mjs");
  const code = await runBuild(PROJECT_ROOT);
  if (code === 0) {
    writeBuildStamp(PROJECT_ROOT);
    console.log("Build complete.");
  } else {
    console.error("Build failed.");
    process.exit(code);
  }
}

/**
 * `aitne help` and `aitne help <command>`. Async so per-command help
 * dispatch into a dynamically-imported module is awaited — without await,
 * the runExternalCommand promise can race against process exit. In practice
 * Node's I/O wait usually keeps it alive long enough, but relying on that
 * is brittle.
 */
async function cmdHelp(args = []) {
  // Per-command help: `aitne help <cmd>` or `aitne <cmd> --help`. Defers to
  // each command module's run() with --help so the long-form usage lives
  // next to the command's logic, not duplicated in this dispatcher.
  const target = args[0];
  if (target && PER_COMMAND_HELP.has(target)) {
    await runExternalCommand(target, ["--help"]);
    return;
  }
  console.log(`${APP_NAME} v${VERSION} — local-first personal AI agent

Usage: aitne <command> [options]

Lifecycle:
  start [--no-open]                 Build (if stale) & launch daemon + dashboard
  stop                              Graceful shutdown (SIGTERM → SIGKILL after 10s)
  restart [--no-open] [--clean-context]
                                    Restart; --clean-context wipes context/ &
                                    md_file_snapshots after tarball backup (B-007)
  status                            PIDs, uptime, integrations, today's spend
  logs [-f] [-n N] [-d]             Tail daemon log (-d for dashboard log)
  dev [--no-open]                   Foreground mode (development, full stdio)
  build                             Build TypeScript explicitly

Operations:
  setup                             Open dashboard /setup wizard
  open                              Open dashboard root in browser
  doctor                            Diagnose install (Node, ports, keychain, CLIs, …)
  audit [--since <dur>] [--type X]  Show agent action log (filterable)
  run-now <job>                     Fire a daemon-internal maintenance job
                                    on demand (e.g. roadmap_maintenance)
  verify [target]                   Run post-launch verification for a
                                    shipped design surface (e.g.
                                    evening-review-slimdown)
  version                           Print version + Node + install path
  update                            Print npm command to upgrade
  uninstall                         Stop, then offer to wipe ${path.basename(DATA_DIR) || "data dir"}

Options:
  --version, -v                     Print version
  --help, -h                        Show this help (or per-command help)

Environment:
  PA_DATA_DIR                       Data directory (default: ~/.personal-agent)
  PA_API_PORT                       Daemon port (default: ${DEFAULT_API_PORT})
  PA_DASHBOARD_PORT                 Dashboard port (default: ${DEFAULT_DASHBOARD_PORT})

Examples:
  aitne start                       Launch in background
  aitne status                      Check what's running
  aitne audit --since 7d            Last week's agent actions
  aitne doctor                      Diagnose first-install issues
  aitne logs -f                     Follow daemon log

Run 'aitne help <command>' for detailed usage of a single command.`);
}

// Commands that own their own --help output (i.e. live in scripts/commands/).
// Used by `aitne help <cmd>` to dispatch into the module rather than duplicating
// usage strings in cmdHelp() above.
const PER_COMMAND_HELP = new Set([
  "doctor", "audit", "setup", "open", "version", "update", "uninstall", "run-now", "verify",
]);

/**
 * Dispatch into a command module under scripts/commands/. The dispatcher hands
 * the module a precomputed context (paths, ports, brand) so individual
 * commands don't re-derive shared state.
 */
async function runExternalCommand(name, args) {
  const mod = await import(`../scripts/commands/${name}.mjs`);
  const ctx = {
    APP_NAME,
    VERSION,
    DATA_DIR,
    DAEMON_PORT,
    DASHBOARD_PORT,
    PROJECT_ROOT,
    DAEMON_PID_FILE,
    DASHBOARD_PID_FILE,
    DAEMON_LOG_FILE,
    DASHBOARD_LOG_FILE,
    IS_WINDOWS,
    helpers: {
      getRunningPid,
      formatUptime,
      fetchHealth,
      openBrowser,
      cmdStart,
      cmdStop,
    },
  };
  return mod.run(args, ctx);
}

// ── Main ──

const subcommand = process.argv[2];
const subArgs = process.argv.slice(3);

switch (subcommand) {
  case "_log-runner": await cmdLogRunner(subArgs); break;
  case "start":     await cmdStart(subArgs); break;
  case "stop":      await cmdStop(); break;
  case "restart":   await cmdRestart(subArgs); break;
  case "status":    await cmdStatus(); break;
  case "logs":      await cmdLogs(subArgs); break;
  case "dev":       await cmdDev(subArgs); break;
  case "build":     await cmdBuild(); break;

  case "setup":     await runExternalCommand("setup", subArgs); break;
  case "open":      await runExternalCommand("open", subArgs); break;
  case "doctor":    await runExternalCommand("doctor", subArgs); break;
  case "audit":     await runExternalCommand("audit", subArgs); break;
  case "run-now":   await runExternalCommand("run-now", subArgs); break;
  case "verify":    await runExternalCommand("verify", subArgs); break;

  // version / -v / --version all dispatch identically — passing subArgs
  // through so `aitne --version --json` yields the same output as
  // `aitne version --json`. (Earlier code dropped subArgs in the
  // short-circuit path, producing inconsistent behavior.)
  case "version":
  case "--version":
  case "-v":
    await runExternalCommand("version", subArgs); break;

  case "update":    await runExternalCommand("update", subArgs); break;
  case "uninstall": await runExternalCommand("uninstall", subArgs); break;

  case "help":
  case "--help":
  case "-h":
    await cmdHelp(subArgs); break;
  default:
    if (subcommand) {
      console.error(`Unknown command: ${subcommand}`);
      console.error(`Run 'aitne help' for the list of commands.`);
      process.exit(1);
    }
    await cmdHelp();
}
