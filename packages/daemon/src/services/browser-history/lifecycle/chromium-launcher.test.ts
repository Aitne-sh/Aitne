import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { terminateLaunchedChromium } from "./chromium-launcher.js";
import type { BrowserProfileCandidate, HostProfile } from "../types.js";

function makeHost(overrides: Partial<HostProfile> = {}): HostProfile {
  return {
    os: "darwin",
    hasDisplay: true,
    sandboxPrimitive: { kind: "none" },
    browserBinaryFor: () => "/Applications/Chrome.app/Contents/MacOS/Chrome",
    profileRootFor: () => null,
    profileRootCandidatesFor: () => [],
    isProcessRunning: async () => false,
    terminate: async () => {},
    ...overrides,
  };
}

function makeProfile(userDataDir: string): BrowserProfileCandidate {
  return {
    browser: "chrome",
    profileName: "Default",
    userDataDir,
    historyPath: join(userDataDir, "Default", "History"),
    signedIn: false,
    canonical: true,
    lastHistoryMtimeMs: null,
  };
}

function writeSingletonLock(userDataDir: string, pid: number): void {
  symlinkSync(`${hostname()}-${pid}`, join(userDataDir, "SingletonLock"));
}

describe("terminateLaunchedChromium", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "pa-bh-launcher-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("returns already_gone when the spawned PID is not alive", async () => {
    // A PID this high is exceedingly unlikely to be assigned; treated
    // as not-alive so the terminate path short-circuits.
    const deadPid = 0x7fffffff;
    const terminateCalls: Array<{ pid: number; mode: string }> = [];
    const host = makeHost({
      terminate: async (pid, mode) => {
        terminateCalls.push({ pid, mode });
      },
    });

    const result = await terminateLaunchedChromium(host, makeProfile(userDataDir), deadPid);

    expect(result).toBe("already_gone");
    expect(terminateCalls).toEqual([]);
  });

  it("returns already_gone when the SingletonLock is missing", async () => {
    // spawnedPid is alive (we use the test process) but no symlink
    // exists — the spawned Chromium exited on its own between the
    // supervisor's snapshot and terminate, so there is nothing left
    // to kill.
    const terminateCalls: Array<{ pid: number; mode: string }> = [];
    const host = makeHost({
      terminate: async (pid, mode) => {
        terminateCalls.push({ pid, mode });
      },
    });

    const result = await terminateLaunchedChromium(host, makeProfile(userDataDir), process.pid);

    expect(result).toBe("already_gone");
    expect(terminateCalls).toEqual([]);
  });

  it("returns ownership_changed when SingletonLock owner differs from spawnedPid", async () => {
    // Two distinct PIDs that pass the parse: simulate a race where
    // the user opened Chrome via Dock during the flush sleep, so the
    // lock now points to a Chromium that is NOT the one we spawned.
    // The function must NOT kill `spawnedPid` in this case — that's
    // the precise scenario the race-safety guard exists for.
    writeSingletonLock(userDataDir, process.pid + 1);
    const terminateCalls: Array<{ pid: number; mode: string }> = [];
    const host = makeHost({
      terminate: async (pid, mode) => {
        terminateCalls.push({ pid, mode });
      },
    });

    const result = await terminateLaunchedChromium(host, makeProfile(userDataDir), process.pid);

    expect(result).toBe("ownership_changed");
    expect(terminateCalls).toEqual([]);
  });

  it("falls back to host.isProcessRunning when SingletonLock is a regular file (Chromium fork)", async () => {
    // Brave / some Chromium forks write SingletonLock as a regular
    // file instead of a symlink. readlink() fails, so we cannot
    // extract a PID — but the spawned Chromium is still alive and
    // must be terminated. Verify the host.isProcessRunning fallback
    // confirms ownership and proceeds.
    writeFileSync(join(userDataDir, "SingletonLock"), "");
    const terminateCalls: Array<{ pid: number; mode: string }> = [];
    const probeCalls: Array<{ binary: string; userDataDir: string }> = [];
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 60_000)",
    ], { stdio: "ignore" });
    try {
      const pid = child.pid!;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const host = makeHost({
        isProcessRunning: async (binary, dir) => {
          probeCalls.push({ binary, userDataDir: dir });
          return true;
        },
        terminate: async (signalPid, mode) => {
          terminateCalls.push({ pid: signalPid, mode });
          process.kill(signalPid, mode === "force" ? "SIGKILL" : "SIGTERM");
        },
      });

      const result = await terminateLaunchedChromium(
        host,
        makeProfile(userDataDir),
        pid,
        { gracefulTimeoutMs: 2000, pollIntervalMs: 50 },
      );

      expect(result).toBe("terminated");
      expect(probeCalls).toHaveLength(1);
      expect(probeCalls[0]?.userDataDir).toBe(userDataDir);
      expect(terminateCalls).toHaveLength(1);
      expect(terminateCalls[0]).toMatchObject({ pid, mode: "graceful" });
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  });

  it("returns already_gone when SingletonLock is a regular file but no Chromium is bound to the profile", async () => {
    // Lock is a stale regular file from a crashed fork. The host
    // probe reports no live owner — we must NOT terminate the
    // spawnedPid, because we cannot confirm it belongs to this
    // profile any more.
    writeFileSync(join(userDataDir, "SingletonLock"), "");
    const terminateCalls: Array<{ pid: number; mode: string }> = [];
    const host = makeHost({
      isProcessRunning: async () => false,
      terminate: async (signalPid, mode) => {
        terminateCalls.push({ pid: signalPid, mode });
      },
    });

    const result = await terminateLaunchedChromium(
      host,
      makeProfile(userDataDir),
      process.pid,
    );

    expect(result).toBe("already_gone");
    expect(terminateCalls).toEqual([]);
  });

  it("terminates the spawned process when SingletonLock confirms ownership", async () => {
    // Spawn a real child so process.kill(pid, 0) reflects actual
    // liveness. The child exits on default SIGTERM, which is exactly
    // what host.terminate(_, "graceful") sends in production.
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 60_000)",
    ], { stdio: "ignore" });
    try {
      const pid = child.pid!;
      // Wait for the child to be reapable by `process.kill(pid, 0)`.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      writeSingletonLock(userDataDir, pid);

      const terminateCalls: Array<{ pid: number; mode: string }> = [];
      const host = makeHost({
        terminate: async (signalPid, mode) => {
          terminateCalls.push({ pid: signalPid, mode });
          // Mirror platform.ts's terminate: SIGTERM for graceful,
          // SIGKILL for force. The child's default SIGTERM handler
          // exits the process, which makes the poll loop observe
          // the exit on its next tick.
          process.kill(signalPid, mode === "force" ? "SIGKILL" : "SIGTERM");
        },
      });

      const result = await terminateLaunchedChromium(
        host,
        makeProfile(userDataDir),
        pid,
        { gracefulTimeoutMs: 2000, pollIntervalMs: 50 },
      );

      expect(result).toBe("terminated");
      expect(terminateCalls).toHaveLength(1);
      expect(terminateCalls[0]).toMatchObject({ pid, mode: "graceful" });
    } finally {
      // Belt-and-suspenders: if the test failed before the child
      // exited, do not leak the process across the test suite.
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  });
});
