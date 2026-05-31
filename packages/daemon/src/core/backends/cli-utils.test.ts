import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  CliPathCache,
  parseJsonLine,
  findExecutable,
  createOutputCapturePath,
  killChildWithEscalation,
  readFileIfExists,
  removeFileIfExists,
  runLineCommand,
  buildCmdShimArgs,
  resolveWin32Invocation,
} from "./cli-utils.js";

describe("parseJsonLine", () => {
  it("parses valid JSON", () => {
    const result = parseJsonLine<{ a: number }>('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonLine("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJsonLine("")).toBeNull();
  });

  it("parses JSON arrays", () => {
    expect(parseJsonLine<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });
});

describe("findExecutable", () => {
  it("finds an executable that exists on PATH (node)", () => {
    const result = findExecutable("node");
    expect(result).not.toBeNull();
    expect(result).toContain("node");
  });

  it("returns null for a nonexistent binary", () => {
    const result = findExecutable("nonexistent_binary_xyz_123456");
    expect(result).toBeNull();
  });

  it("returns null when PATH is empty", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      expect(findExecutable("node")).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("returns null when PATH is undefined", () => {
    const originalPath = process.env.PATH;
    try {
      delete process.env.PATH;
      expect(findExecutable("node")).toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("skips empty PATH segments", () => {
    const originalPath = process.env.PATH;
    try {
      // Include empty segments (double colons)
      process.env.PATH = `::${originalPath}`;
      const result = findExecutable("node");
      expect(result).not.toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("createOutputCapturePath", () => {
  it("returns a path under sessionDir with the prefix", () => {
    const result = createOutputCapturePath("/tmp/session", "output");
    expect(result).toMatch(/^\/tmp\/session\/\.output-.+\.txt$/);
  });

  it("produces unique paths on each call", () => {
    const a = createOutputCapturePath("/dir", "p");
    const b = createOutputCapturePath("/dir", "p");
    expect(a).not.toBe(b);
  });
});

describe("readFileIfExists", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads an existing file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-utils-test-"));
    const filePath = join(tmpDir, "test.txt");
    writeFileSync(filePath, "hello world");
    expect(readFileIfExists(filePath)).toBe("hello world");
  });

  it("returns null for a nonexistent file", () => {
    expect(readFileIfExists("/tmp/nonexistent_file_xyz_123456.txt")).toBeNull();
  });
});

describe("removeFileIfExists", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes an existing file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-utils-test-"));
    const filePath = join(tmpDir, "to-remove.txt");
    writeFileSync(filePath, "content");
    expect(existsSync(filePath)).toBe(true);

    removeFileIfExists(filePath);
    expect(existsSync(filePath)).toBe(false);
  });

  it("does nothing for a nonexistent file", () => {
    expect(() => removeFileIfExists("/tmp/nonexistent_file_xyz.txt")).not.toThrow();
  });
});

describe("runLineCommand", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures stdout lines from a simple command", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "echo",
      args: ["hello world"],
      cwd: tmpDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdoutLines).toContain("hello world");
  });

  it("captures stderr lines", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "node",
      args: ["-e", 'process.stderr.write("err line\\n")'],
      cwd: tmpDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderrLines).toContain("err line");
  });

  it("reports non-zero exit code", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "node",
      args: ["-e", "process.exit(42)"],
      cwd: tmpDir,
    });

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("invokes onStdoutLine and onStderrLine callbacks", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const stdoutCb: string[] = [];
    const stderrCb: string[] = [];

    const result = await runLineCommand({
      command: "node",
      args: ["-e", 'console.log("out"); console.error("err")'],
      cwd: tmpDir,
      onStdoutLine: (line) => stdoutCb.push(line),
      onStderrLine: (line) => stderrCb.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(stdoutCb).toContain("out");
    expect(stderrCb).toContain("err");
  });

  it("passes input to stdin", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "node",
      args: [
        "-e",
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>console.log(d.trim()))',
      ],
      cwd: tmpDir,
      input: "hello stdin",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toContain("hello stdin");
  });

  it("times out and kills a long-running process", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "node",
      args: ["-e", "setTimeout(()=>{},60000)"],
      cwd: tmpDir,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
  });

  it("tree-kills grandchildren on timeout (POSIX)", async () => {
    // POSIX-only: proves the `detached: true` + `process.kill(-pid, …)`
    // group-kill path actually reaps subprocess descendants. The previous
    // single-target SIGTERM would have left the grandchild running. The
    // Windows tree-kill path uses `taskkill /T` and is exercised through
    // visual review only on this dev box (no Windows CI here).
    if (process.platform === "win32") return;

    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-tree-"));
    const pidFile = join(tmpDir, "grandchild.pid");

    const childScript = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const gc = cp.spawn(process.execPath, [
        '-e',
        'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));' +
        'setInterval(()=>{}, 1000);'
      ], { stdio: 'ignore' });
      gc.unref();
      setInterval(()=>{}, 1000);
    `;

    const result = await runLineCommand({
      command: "node",
      args: ["-e", childScript],
      cwd: tmpDir,
      timeoutMs: 800,
    });

    expect(result.timedOut).toBe(true);

    // Give the kernel a beat to deliver SIGTERM to the group and let the
    // grandchild's exit propagate to the kernel's process table.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // The grandchild may or may not have written its pid before being
    // killed (race with our short timeout). Only assert when we actually
    // captured a pid — otherwise the test contributes no signal.
    if (!existsSync(pidFile)) return;
    const pid = parseInt(readFileSync(pidFile, "utf-8"), 10);
    expect(Number.isFinite(pid)).toBe(true);

    // signal 0 probes existence without delivering a signal: ESRCH means
    // the process is gone. With the old child.kill("SIGTERM") path this
    // probe would succeed (grandchild still alive) and the test would fail.
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("rejects when command cannot be found", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    await expect(
      runLineCommand({
        command: "nonexistent_binary_xyz_123456",
        args: [],
        cwd: tmpDir,
      }),
    ).rejects.toThrow();
  });

  it("escalates to SIGKILL when child ignores SIGTERM (POSIX)", async () => {
    // POSIX-only regression test for the 18m delegated_proxy.invoke hang
    // observed 2026-04-29: a Gemini grandchild ignored SIGTERM mid-call,
    // and `runLineCommand` waited forever on `child.once("close")`. The
    // killTree escalation (5s SIGTERM → SIGKILL) bounds the wait so the
    // proxy invoker's 240s safety net actually returns.
    if (process.platform === "win32") return;

    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-sigterm-ignore-"));

    // Child ignores SIGTERM and busy-loops. Without SIGKILL escalation
    // this would never close.
    const ignoreScript = `
      process.on('SIGTERM', () => { /* swallow */ });
      setInterval(() => {}, 1000);
    `;

    const startMs = Date.now();
    const result = await runLineCommand({
      command: "node",
      args: ["-e", ignoreScript],
      cwd: tmpDir,
      timeoutMs: 200,
    });
    const elapsedMs = Date.now() - startMs;

    expect(result.timedOut).toBe(true);
    // 200ms SIGTERM + 5s SIGKILL escalation + delivery slack. If the
    // escalation regresses, this blows past 30s and the test times out.
    expect(elapsedMs).toBeLessThan(15_000);
    expect(result.signal === "SIGKILL" || result.exitCode !== 0).toBe(true);
  }, 20_000);

  it("destroys parent stdio when a detached grandchild keeps the pipes open (POSIX)", async () => {
    // POSIX-only regression test for the 10–18m delegated_proxy.invoke
    // hangs observed 2026-05-01 (40+ rows in agent_actions). Root cause:
    // the gemini-cli grandchild process called setsid() and inherited
    // stdout/stderr. SIGKILL on the parent's process group reaped the
    // parent but the detached grandchild kept the pipe write-ends alive,
    // so Node's child.close (which requires both process exit AND stdio
    // EOF) never fired. The killTree fix destroys parent-side stdio after
    // SIGKILL, EOFing the readline interfaces locally so close fires.
    if (process.platform === "win32") return;

    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-detached-grandchild-"));
    const pidFile = join(tmpDir, "grandchild.pid");

    // Parent ignores SIGTERM. Spawns a detached grandchild (own process
    // group via setsid()) that inherits parent's stdout/stderr and writes
    // its pid for cleanup. Without our fix, the SIGKILL'd parent leaves
    // the grandchild holding the pipes and child.close never fires.
    const parentScript = `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const gc = cp.spawn(process.execPath, [
        '-e',
        'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));' +
        'setInterval(() => {}, 60000);'
      ], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      gc.unref();
      process.on('SIGTERM', () => { /* swallow */ });
      setInterval(() => {}, 60000);
    `;

    const startMs = Date.now();
    const result = await runLineCommand({
      command: "node",
      args: ["-e", parentScript],
      cwd: tmpDir,
      timeoutMs: 200,
    });
    const elapsedMs = Date.now() - startMs;

    // Cleanup: the grandchild detached itself from our group so SIGKILL
    // on the parent group missed it. Reap by pid before assertions so a
    // failure doesn't leave a 60s orphan eating CPU.
    if (existsSync(pidFile)) {
      const gcPid = parseInt(readFileSync(pidFile, "utf-8"), 10);
      if (Number.isFinite(gcPid)) {
        try { process.kill(gcPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }

    expect(result.timedOut).toBe(true);
    // Without the fix: hard ceiling fires at 30s → ~30.2s elapsed.
    // With the fix: 200ms timeout + ~5s SIGKILL + stdio destroy + slack.
    // Bound at 15s gives healthy headroom over the expected ~6s while
    // staying well under the 30s hard ceiling, so a regression to the
    // unfixed path would clearly miss this bound.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 35_000);

  it("hard-ceiling watchdog resolves the Promise even if killTree silently fails", async () => {
    // Belt-and-suspenders: monkey-patch process.kill so the SIGTERM,
    // SIGKILL, and group-SIGKILL syscalls all silently no-op. killTree
    // would normally rely on these to reap the subprocess; with them
    // disabled, child.close never fires and runLineCommand would wait
    // for the lifetime of the dev's terminal. The hard-ceiling watchdog
    // (HARD_CEILING_AFTER_KILL_MS, 30s) must resolve the Promise with
    // `timedOut: true` regardless.
    if (process.platform === "win32") return;

    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-hard-ceiling-"));

    const realKill = process.kill;
    const swallowedPids: number[] = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      // Track every non-probe kill (signal !== 0). killTree on POSIX only
      // calls `process.kill(-pid, ...)` (process-group kill, negative pid)
      // — never the positive single-target form — so filtering on `pid > 0`
      // would leave `swallowedPids` empty and the finally-block cleanup
      // would no-op, leaking the busy-looping subprocess. Record the
      // absolute pid for both forms so realKill can reap it below.
      if (typeof pid === "number" && pid !== 0 && signal !== 0) {
        swallowedPids.push(Math.abs(pid));
      }
      // No-op: pretend the kill landed.
      return true;
    }) as typeof process.kill;

    let result: Awaited<ReturnType<typeof runLineCommand>> | null = null;
    let elapsedMs = 0;
    try {
      const startMs = Date.now();
      result = await runLineCommand({
        command: "node",
        args: [
          "-e",
          // Ignore SIGTERM/SIGKILL (the latter is unblockable on Linux,
          // but our process.kill stub never delivers it anyway). Busy-loop
          // for 60s so without the watchdog we'd hang.
          "process.on('SIGTERM',()=>{}); setInterval(()=>{},60000);",
        ],
        cwd: tmpDir,
        timeoutMs: 200,
      });
      elapsedMs = Date.now() - startMs;
    } finally {
      process.kill = realKill;
      // The watchdog's last-ditch SIGKILL ran through our stub, so the
      // real subprocess is still alive. Reap it now via the real kill.
      for (const pid of swallowedPids) {
        try { realKill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }

    expect(result).not.toBeNull();
    expect(result!.timedOut).toBe(true);
    expect(result!.signal).toBe("SIGKILL");
    // 200ms timeout + 30s hard ceiling + slack. The watchdog is the
    // load-bearing assertion here; if it regresses the test hits its own
    // 45s vitest timeout instead.
    expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(elapsedMs).toBeLessThan(40_000);
  }, 45_000);

  it("passes custom env to the child process", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "node",
      args: ["-e", "console.log(process.env.MY_TEST_VAR)"],
      cwd: tmpDir,
      env: { ...process.env, MY_TEST_VAR: "custom_value" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toContain("custom_value");
  });

  it("handles zero timeoutMs as no timeout", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-run-"));
    const result = await runLineCommand({
      command: "echo",
      args: ["quick"],
      cwd: tmpDir,
      timeoutMs: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});

describe("killChildWithEscalation", () => {
  // POSIX-only: tests rely on `process.on("SIGTERM")` ignore semantics.
  // Windows simulates SIGTERM as TerminateProcess and ignore handlers
  // don't apply, so the escalation isn't observable there.
  it("escalates SIGTERM-ignoring single-target child to SIGKILL", async () => {
    if (process.platform === "win32") return;

    const child = spawn(
      "node",
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      { stdio: "ignore" },
    );

    // Wait for child to install the SIGTERM handler before sending the
    // signal. 200ms is generous on local hardware where Node startup is
    // 30-60ms and the script body is trivial.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    const startMs = Date.now();
    killChildWithEscalation(child, { gracePeriodMs: 300 });
    const closeResult = await Promise.race([
      closed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    const elapsedMs = Date.now() - startMs;

    expect(closeResult).not.toBeNull();
    expect(elapsedMs).toBeLessThan(2_000);
    expect(closeResult).not.toBeNull();
    expect((closeResult as { signal: NodeJS.Signals | null }).signal).toBe("SIGKILL");
  }, 10_000);

  it("does not SIGKILL a process that exited cleanly during the grace window", async () => {
    if (process.platform === "win32") return;

    // Child exits ~50ms after SIGTERM (default Node SIGTERM handler).
    const child = spawn(
      "node",
      ["-e", "setInterval(() => {}, 100);"],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const closed = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once("close", (_code, signal) => resolve(signal));
    });

    killChildWithEscalation(child, { gracePeriodMs: 1_000 });
    const signal = await closed;

    // Default SIGTERM handler kills with SIGTERM, not SIGKILL — proves the
    // escalation timer was cancelled by the close listener.
    expect(signal).toBe("SIGTERM");
  }, 5_000);

  it("is a no-op when the child has already exited", () => {
    if (process.platform === "win32") return;

    const child = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    return new Promise<void>((resolve) => {
      child.once("close", () => {
        // Should not throw; should return without scheduling anything.
        expect(() => killChildWithEscalation(child)).not.toThrow();
        resolve();
      });
    });
  });
});

describe("CliPathCache (§9.4)", () => {
  let tmpDir: string;
  let dirs: string[] = [];
  let originalPath: string | undefined;

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
      originalPath = undefined;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function makeFakeCli(dir: string, name: string): string {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  }

  it("resolves the path eagerly in the constructor", () => {
    const cache = new CliPathCache("node");
    expect(cache.get()).toBe(findExecutable("node"));
  });

  it("returns null when CLI is not on PATH", () => {
    const cache = new CliPathCache("nonexistent_binary_xyz_999");
    expect(cache.get()).toBeNull();
  });

  it("returns cached value within TTL without re-resolving", () => {
    let nowMs = 1000;
    const cache = new CliPathCache("node", 60_000, () => nowMs);
    const first = cache.get();
    nowMs += 30_000; // 30 s — within 60 s TTL
    expect(cache.get()).toBe(first);
  });

  it("re-resolves a null path after TTL expires (CLI install)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
    originalPath = process.env.PATH;
    process.env.PATH = tmpDir;

    let nowMs = 1000;
    const cache = new CliPathCache("pa-test-cli", 60_000, () => nowMs);
    expect(cache.get()).toBeNull();

    // "Install" the CLI
    const cliPath = makeFakeCli(tmpDir, "pa-test-cli");

    // Advance past TTL
    nowMs += 61_000;
    expect(cache.get()).toBe(cliPath);
  });

  it("detects CLI uninstall after TTL expires", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
    originalPath = process.env.PATH;
    const cliPath = makeFakeCli(tmpDir, "pa-test-cli2");
    process.env.PATH = tmpDir;

    let nowMs = 1000;
    const cache = new CliPathCache("pa-test-cli2", 60_000, () => nowMs);
    expect(cache.get()).toBe(cliPath);

    // "Uninstall" the CLI
    unlinkSync(cliPath);

    // Advance past TTL → accessSync fails → re-resolve → null
    nowMs += 61_000;
    expect(cache.get()).toBeNull();
  });

  it("detects CLI reinstall to a different directory after TTL", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
    const dir2 = mkdtempSync(join(tmpdir(), "cli-cache2-"));
    dirs.push(dir2);
    originalPath = process.env.PATH;

    const oldPath = makeFakeCli(tmpDir, "pa-test-cli3");
    process.env.PATH = `${tmpDir}:${dir2}`;

    let nowMs = 1000;
    const cache = new CliPathCache("pa-test-cli3", 60_000, () => nowMs);
    expect(cache.get()).toBe(oldPath);

    // "Uninstall" from old dir, "install" in new dir
    unlinkSync(oldPath);
    makeFakeCli(dir2, "pa-test-cli3");
    const newPath = join(dir2, "pa-test-cli3");

    // Advance past TTL → accessSync(oldPath) fails → re-resolve → new dir
    nowMs += 61_000;
    expect(cache.get()).toBe(newPath);
  });

  it("does not re-resolve before TTL expires (stale cache)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
    originalPath = process.env.PATH;
    const cliPath = makeFakeCli(tmpDir, "pa-test-cli4");
    process.env.PATH = tmpDir;

    let nowMs = 1000;
    const cache = new CliPathCache("pa-test-cli4", 60_000, () => nowMs);
    expect(cache.get()).toBe(cliPath);

    // "Uninstall" — but clock is still within TTL
    unlinkSync(cliPath);
    nowMs += 30_000; // only 30 s — within 60 s TTL
    expect(cache.get()).toBe(cliPath); // stale but within TTL
  });
});

describe("buildCmdShimArgs (Windows cmd.exe escaping — process-spawn-1)", () => {
  // These assert the exact escaped output, cross-checked byte-for-byte against
  // the `cross-spawn` package (v7.0.6). The escaping is the security boundary:
  // callers pass arbitrary LLM prompts as args, so cmd.exe metacharacters MUST
  // be neutralized rather than left to a `shell: true` re-parse.

  it("emits the cmd.exe /d /s /c wrapper shape", () => {
    const out = buildCmdShimArgs("C:\\npm\\npm.cmd", ["hello"]);
    expect(out.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(out).toHaveLength(4);
    expect(out[3].startsWith('"')).toBe(true);
    expect(out[3].endsWith('"')).toBe(true);
  });

  it("neutralizes spaces and the & command separator (single-escape shim)", () => {
    const out = buildCmdShimArgs("C:\\npm\\npm.cmd", ["a & b"]);
    expect(out[3]).toBe('"C:\\npm\\npm.cmd ^"a^ ^&^ b^""');
  });

  it("neutralizes %VAR% environment expansion", () => {
    const out = buildCmdShimArgs("C:\\npm\\npm.cmd", ["%PATH%"]);
    expect(out[3]).toBe('"C:\\npm\\npm.cmd ^"^%PATH^%^""');
  });

  it("neutralizes an injection attempt — `&` is always caret-escaped", () => {
    const out = buildCmdShimArgs("C:\\npm\\npm.cmd", ["x & calc.exe"]);
    // The raw `&` must never appear without a preceding caret.
    expect(/(^|[^^])&/.test(out[3])).toBe(false);
    expect(out[3]).toBe('"C:\\npm\\npm.cmd ^"x^ ^&^ calc.exe^""');
  });

  it("double-escapes metachars for node_modules/.bin shims only", () => {
    const binShim = buildCmdShimArgs(
      "C:\\p\\node_modules\\.bin\\codex.cmd",
      ["a & b"],
    );
    const globalShim = buildCmdShimArgs("C:\\npm\\codex.cmd", ["a & b"]);
    // node_modules/.bin/*.cmd re-parses its own line → one extra ^ layer.
    expect(binShim[3]).toContain("^^^&");
    expect(globalShim[3]).not.toContain("^^^&");
    expect(globalShim[3]).toContain("^&");
  });
});

describe("resolveWin32Invocation (process-spawn-1 / process-spawn-7)", () => {
  const comspec = process.env.ComSpec || "cmd.exe";

  it("wraps a .cmd batch shim through cmd.exe with verbatim args", () => {
    const r = resolveWin32Invocation("C:\\npm\\codex.cmd", ["turn"]);
    expect(r).not.toBeNull();
    expect(r?.command).toBe(comspec);
    expect(r?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(r?.windowsVerbatimArguments).toBe(true);
  });

  it("wraps a .bat batch shim through cmd.exe", () => {
    const r = resolveWin32Invocation("C:\\tools\\thing.bat", []);
    expect(r?.command).toBe(comspec);
    expect(r?.windowsVerbatimArguments).toBe(true);
  });

  it("leaves an absolute .exe path unchanged (spawned directly)", () => {
    // resolved === command → no rewrite; the OS argv quoting is safe for .exe.
    expect(resolveWin32Invocation("C:\\node\\node.exe", ["-v"])).toBeNull();
  });

  it("returns null for an unresolvable bare name (natural ENOENT)", () => {
    expect(
      resolveWin32Invocation("definitely_not_a_real_binary_zzz", []),
    ).toBeNull();
  });
});
