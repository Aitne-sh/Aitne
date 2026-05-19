import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Shared browser / HTTP-readiness helpers used by cli.mjs (`pa start`) and
 * start.mjs (`pa dev`). Keep this file minimal and free of project state.
 */

/**
 * Fetch `url` with a hard timeout. Returns true iff *any* HTTP response came
 * back — we treat a 404 or 500 as "the server is reachable, it just doesn't
 * like this request", which is good enough to know Next.js has stopped
 * rejecting connections. Network errors / abort / ECONNREFUSED → false.
 */
export async function fetchHttpOk(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll `url` until the server answers, a liveness check fails, or we time out.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Array<() => boolean>} [opts.liveness] Each predicate returns true
 *   while its watched process is still running. Any false short-circuits to
 *   `false` so we don't poll a dead server.
 * @param {number} [opts.timeoutMs] Overall budget (default 30s).
 * @param {number} [opts.pollMs] Sleep between attempts (default 300ms).
 * @returns {Promise<boolean>} true if ready, false on timeout / liveness fail.
 */
export async function waitForHttpReady(url, opts = {}) {
  const { liveness = [], timeoutMs = 30_000, pollMs = 300 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const check of liveness) {
      if (!check()) return false;
    }
    const attemptBudget = Math.max(200, Math.min(2_000, deadline - Date.now()));
    if (await fetchHttpOk(url, attemptBudget)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Open `url` in the user's default browser. Returns a promise that resolves
 * to true iff the helper binary spawned successfully *and* no error surfaced
 * within ~150ms — enough to catch ENOENT (e.g. `xdg-open` missing on headless
 * Linux). On darwin/win32 the helper itself always spawns, so this is
 * effectively "did we attempt" rather than "did a tab actually open".
 */
export function openBrowser(url) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    switch (process.platform) {
      case "darwin":
        cmd = "open";
        args = [url];
        break;
      case "win32":
        cmd = "cmd";
        args = ["/c", "start", "", url];
        break;
      default:
        cmd = "xdg-open";
        args = [url];
        break;
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", detached: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on("error", () => settle(false));
    child.on("spawn", () => {
      child.unref();
      // Give a late ENOENT a moment to be delivered as an 'error' event.
      setTimeout(() => settle(true), 150);
    });
  });
}
