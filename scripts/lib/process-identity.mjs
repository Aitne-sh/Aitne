/**
 * Process start-identity helpers for the Aitne launcher (`bin/aitne.mjs`).
 *
 * WHY THIS EXISTS — process-lifecycle-2 (CROSS_PLATFORM_REAUDIT_2026-06.md).
 * The launcher trusts a bare PID: `process.kill(pid, 0)` is true for *any* live
 * process owning that PID. After an unclean shutdown the stale `daemon.pid` /
 * `dashboard.pid` can point at a PID the OS has recycled to an unrelated
 * process, so `aitne start` false-positives "Already running" and `aitne stop`
 * can `taskkill /T /F` (Windows) or group-kill (POSIX) the wrong process tree.
 *
 * FIX — pair the PID with the OS-reported process **start time**, captured at
 * write time and re-read at check time. A recycled PID has a different start
 * time, so an exact-string mismatch flags it stale. We compare the *same* OS
 * field to *itself* on the *same* machine, so no absolute-time conversion,
 * clock-skew tolerance, or locale handling is needed.
 *
 * WHERE THIS LIVES — `scripts/lib/` (plain ESM), because `bin/aitne.mjs` runs
 * *before* the TypeScript build that produces `@aitne/shared` (running `aitne
 * start` is what triggers that build) and the published package ships only
 * `bin` + `scripts` + `agent-assets`. The pure functions here are pinned by a
 * peer `.test.ts` under the daemon/shared `src` tree (the `ports.mjs`
 * precedent), so they run under the standard vitest suite. The win32 read branch
 * carries the usual "no Windows runtime validation" caveat; by construction it
 * can only *degrade* to the legacy bare-PID behavior, never make things worse.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

/**
 * Serialize PID metadata to the pidfile.
 *
 * Line 1 is the bare PID so an *older* aitne (which parses only line 1) still
 * reads files written by this version — downgrade-safe. The identity token is
 * written as a trailing `key=value` line (not positional) so a future field can
 * be added without breaking parse order; {@link parsePidMeta} already ignores
 * unknown keys. An absent token is omitted.
 */
export function serializePidMeta({ pid, startToken = null }) {
  let out = `${pid}\n`;
  if (startToken != null) {
    const token = String(startToken).replace(/[\r\n]+/g, " ").trim();
    if (token.length > 0) out += `start=${token}\n`;
  }
  return out;
}

/**
 * Parse a pidfile written by {@link serializePidMeta} OR a legacy single-line
 * (`<pid>\n`) file. Returns `null` if line 1 is not a finite integer. Unknown
 * trailer keys are ignored, so the format stays forward-compatible.
 */
export function parsePidMeta(content) {
  if (typeof content !== "string") return null;
  const lines = content.split(/\r?\n/);
  const pid = Number.parseInt((lines[0] ?? "").trim(), 10);
  if (!Number.isFinite(pid)) return null;
  let startToken = null;
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === "start") startToken = val.length > 0 ? val : null;
  }
  return { pid, startToken };
}

/**
 * Extract field 22 (`starttime`, clock-ticks since boot) from `/proc/<pid>/stat`.
 *
 * The `comm` field (field 2) is wrapped in parens and may itself contain spaces
 * and `)`, so the only safe split point is the LAST `)` — everything after it
 * is space-separated starting at field 3 (state). field 22 is therefore index
 * `22 - 3 = 19` in that tail. Boot-relative, so immune to wall-clock changes;
 * across a reboot the recorded value's epoch is gone, which correctly reads as
 * a mismatch (stale).
 */
export function parseLinuxStat(statContent) {
  if (typeof statContent !== "string") return null;
  const close = statContent.lastIndexOf(")");
  if (close < 0) return null;
  const fields = statContent.slice(close + 1).trim().split(/\s+/);
  const starttime = fields[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}

/**
 * Resolve the PowerShell executable on Windows. Prefer Windows PowerShell 5.1
 * (`powershell.exe`), fall back to PowerShell 7+ (`pwsh.exe`) for minimal /
 * Server-Core / pwsh-7-only hosts, else keep the default so a missing host
 * surfaces a clear ENOENT. Mirrors `browser-history/lifecycle/platform.ts`.
 */
/* c8 ignore start -- win32-only path resolution; the POSIX test runner never enters this */
function resolveWindowsPowerShell() {
  const pathValue = process.env.PATH ?? "";
  const exts = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE"];
  const probe = (name) => {
    const hasExt = /\.[A-Za-z0-9]+$/.test(name);
    for (const dir of pathValue.split(delimiter)) {
      if (!dir) continue;
      const candidates = hasExt ? [name] : exts.map((e) => `${name}${e}`);
      for (const c of candidates) {
        try {
          accessSync(join(dir, c), constants.X_OK);
          return true;
        } catch {
          // keep scanning
        }
      }
    }
    return false;
  };
  return probe("powershell.exe") ? "powershell.exe" : probe("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
}
/* c8 ignore stop */

/**
 * Read an opaque, OS-native start-time token for `pid`, or `null` if the PID is
 * gone / the read fails. The token is compared *only* for exact-string equality
 * against a token captured earlier for the same PID on the same machine, so its
 * format is irrelevant as long as it is stable for a given process incarnation.
 *
 * `deps` is for testing — inject `platform` / `execFileSync` / `readFileSync`
 * to exercise a branch off its native OS without touching the real system.
 * Reads use `execFileSync` (never a shell) with a timeout; the PID is numeric,
 * so there is no injection surface, but args stay arrayed on principle.
 */
export function readProcessStartToken(pid, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const exec = deps.execFileSync ?? execFileSync;
  const readFile = deps.readFileSync ?? readFileSync;
  if (pid == null || !Number.isFinite(Number(pid))) return null;
  try {
    if (platform === "linux") {
      return parseLinuxStat(readFile(`/proc/${pid}/stat`, "utf8"));
    }
    if (platform === "darwin") {
      const out = exec("ps", ["-o", "lstart=", "-p", String(pid)], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        windowsHide: true,
      });
      const token = String(out).replace(/[\r\n]+/g, " ").trim();
      return token.length > 0 ? token : null;
    }
    /* c8 ignore start -- win32-only; not reachable from the POSIX test runner */
    if (platform === "win32") {
      const ps = resolveWindowsPowerShell();
      const out = exec(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToString('o')`,
        ],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true },
      );
      const token = String(out).replace(/[\r\n]+/g, " ").trim();
      return token.length > 0 ? token : null;
    }
    /* c8 ignore stop */
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify a pidfile's recorded process against the live system.
 *
 * - `stale`              — dead, or alive but the start-time token *differs*
 *                          (PID recycled). Caller should remove the pidfile.
 * - `running-ours`       — alive and the start-time token matches.
 * - `running-unverified` — alive but identity can't be confirmed: a legacy file
 *                          with no token, or the OS start-time read failed.
 *                          Caller treats this as running (the pre-fix bare-PID
 *                          behavior), so the change can never regress; a legacy
 *                          file self-heals on the next `writePid`.
 *
 * `isAlive` / `readToken` are injected so the decision is pure and fully
 * unit-testable without touching real processes.
 */
export function classifyPid(meta, { readToken, isAlive }) {
  if (meta == null || meta.pid == null) return "stale";
  if (!isAlive(meta.pid)) return "stale";
  if (meta.startToken == null) return "running-unverified";
  const live = readToken(meta.pid);
  if (live == null) return "running-unverified";
  return live === meta.startToken ? "running-ours" : "stale";
}
