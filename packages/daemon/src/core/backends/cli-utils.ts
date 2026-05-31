import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, unlinkSync } from "node:fs";
import { delimiter, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

export interface CommandRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutLines: string[];
  stderrLines: string[];
  timedOut: boolean;
}

export interface CommandRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /**
   * External cancellation signal. When aborted, kills the subprocess tree
   * the same way the internal `timeoutMs` does. Used by the delegated-proxy
   * invoker so the wall-clock 30s and the user-side AbortSignal share one
   * kill path. The result's `timedOut` flag reflects the internal timer
   * only; an external abort is reported via the rejection / non-zero exit
   * — callers that need to distinguish should track the signal themselves.
   */
  abortSignal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

/**
 * Belt-and-suspenders cap on how long a kill can take to translate into
 * a resolved Promise after `timeoutMs` (or `abortSignal`) has fired.
 * killTree's SIGKILL + stdio destroy should fire `child.once("close")`
 * within a few seconds; this margin gives even a pathologically uncooperative
 * grandchild ample time before we abandon the Promise. If this fires it's a
 * loud signal of a kill-path regression — the warning we log on this branch
 * is intentionally noisy.
 */
const HARD_CEILING_AFTER_KILL_MS = 30_000;

export async function runLineCommand(
  options: CommandRunOptions,
): Promise<CommandRunResult> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  return await new Promise<CommandRunResult>((resolve, reject) => {
    // Windows: resolve bare names via PATHEXT and route `.cmd`/`.bat` batch
    // shims through an explicit, hand-escaped `cmd.exe` wrapper. POSIX is left
    // exactly as-is. `win` is null when no rewrite is needed (POSIX always, or
    // an unresolvable bare name that should ENOENT naturally). See
    // {@link resolveWin32Invocation}.
    const win =
      process.platform === "win32"
        ? resolveWin32Invocation(options.command, options.args)
        : null;
    const child = spawn(win?.command ?? options.command, win?.args ?? options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: detached=true makes the child a process-group leader so
      // the timeout handler below can take down the whole subprocess
      // tree (Claude/Codex/Gemini CLIs all spawn npm/node grandchildren
      // that must be reaped on timeout to avoid resource leaks). All
      // current callers are non-interactive batch invocations
      // (`auth-recovery` device-auth/login flows go through bespoke
      // spawn calls, not this helper), so the new process-group identity
      // is invisible to them. Windows has no process groups; we rely on
      // taskkill /T below to walk the parent-pid chain instead (the chain
      // includes the cmd.exe wrapper above), and hide the helper console
      // window so background CLI calls don't flash one on screen.
      detached: process.platform !== "win32",
      windowsHide: true,
      // The cmd.exe wrapper's args are already escaped for cmd.exe; tell Node
      // not to re-quote them. Inert/false on POSIX and the direct-.exe path.
      windowsVerbatimArguments: win?.windowsVerbatimArguments ?? false,
    });

    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let hardCeilingTimer: ReturnType<typeof setTimeout> | undefined;

    const handleStdout = createInterface({ input: child.stdout });
    const handleStderr = createInterface({ input: child.stderr });

    handleStdout.on("line", (line) => {
      stdoutLines.push(line);
      options.onStdoutLine?.(line);
    });
    handleStderr.on("line", (line) => {
      stderrLines.push(line);
      options.onStderrLine?.(line);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal,
        stdoutLines,
        stderrLines,
        timedOut,
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }

    /**
     * Schedule the hard-ceiling watchdog. Idempotent — reset whenever a
     * fresh kill is initiated (timeout fires, abortSignal fires, or
     * SIGTERM-ignoring escalation in `killTree`). If this fires the
     * subprocess kill chain has demonstrably failed; we resolve the
     * Promise with a synthetic `timedOut` result so the caller is not
     * stranded for the lifetime of the parent process.
     */
    function armHardCeiling(): void {
      if (hardCeilingTimer) clearTimeout(hardCeilingTimer);
      hardCeilingTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // One more SIGKILL+destroy in case the previous kill quietly
        // failed (signal lost, EPERM, etc.). Ignored on success.
        try {
          if (process.platform === "win32" && child.pid != null) {
            try {
              execFileSync(
                "taskkill",
                ["/T", "/F", "/PID", String(child.pid)],
                { stdio: "pipe", windowsHide: true },
              );
            } catch {
              child.kill("SIGKILL");
            }
          } else if (child.pid != null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        } catch {
          /* noop */
        }
        try {
          child.stdout?.destroy();
        } catch {
          /* noop */
        }
        try {
          child.stderr?.destroy();
        } catch {
          /* noop */
        }
        cleanup();
        resolve({
          exitCode: null,
          signal: "SIGKILL",
          stdoutLines,
          stderrLines,
          timedOut: true,
        });
      }, HARD_CEILING_AFTER_KILL_MS);
      hardCeilingTimer.unref?.();
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killTree(child);
        armHardCeiling();
      }, options.timeoutMs);
      timeout.unref?.();
    }

    let abortListener: (() => void) | undefined;
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        killTree(child);
        armHardCeiling();
      } else {
        abortListener = () => {
          killTree(child);
          armHardCeiling();
        };
        options.abortSignal.addEventListener("abort", abortListener, {
          once: true,
        });
      }
    }

    function cleanup(): void {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (hardCeilingTimer) {
        clearTimeout(hardCeilingTimer);
        hardCeilingTimer = undefined;
      }
      if (abortListener && options.abortSignal) {
        options.abortSignal.removeEventListener("abort", abortListener);
      }
      handleStdout.close();
      handleStderr.close();
    }
  });
}

/**
 * Tree-kill a child spawned by {@link runLineCommand}.
 *
 * Symmetric implementation across POSIX and Windows so timeouts reap the
 * whole subprocess tree, not just the immediate child:
 *
 * - **POSIX** (with `detached: true` at spawn time): the child is its own
 *   process-group leader. `process.kill(-pid, "SIGTERM")` signals every
 *   member of that group, giving CLI grandchildren (npm/node spawned by
 *   Claude/Codex/Gemini) a chance to clean up before they're reaped.
 *   {@link SIGKILL_ESCALATION_MS} later, if the group is still alive, we
 *   escalate to SIGKILL — without this, a Gemini subprocess (or a
 *   grandchild) that catches SIGTERM and is mid-network-call leaves
 *   `runLineCommand` hanging on `child.once("close")` indefinitely.
 *   Observed: a long-running delegated_proxy.invoke that should have
 *   timed out at its abort deadline kept going because the gemini
 *   grandchild ignored SIGTERM until the upstream HTTP request
 *   unblocked.
 * - **Windows**: no process groups; `taskkill /T /F /PID <pid>` walks
 *   the parent-pid chain to terminate descendants. `/F` is forced
 *   because Windows console apps don't honor a graceful close — Node
 *   itself simulates SIGTERM as TerminateProcess in this scenario, so
 *   no SIGKILL escalation is needed.
 *
 * After SIGKILL we additionally **destroy the parent-side stdout/stderr
 * read ends** (POSIX path). Background: SIGKILL on the process group
 * reaps the immediate child, but a grandchild that called `setsid()`
 * (escaping the group) survives and can keep our pipe write-ends open.
 * Node fires `child.once("close")` only after BOTH the process exits AND
 * stdio EOF arrives — so a surviving grandchild leaves runLineCommand's
 * Promise stuck indefinitely. Forcibly destroying our read ends EOFs the
 * readline interfaces locally so close fires as soon as the kernel reaps
 * the (already-SIGKILLed) parent. Observed: long-running
 * delegated_proxy.invoke rows despite the wall-clock — Gemini's
 * google-workspace extension grandchild outlives the parent.
 *
 * The fall-through to `child.kill("SIGTERM")` covers two narrow races:
 * (1) the process already exited between our pid check and the syscall,
 * (2) on Windows, `taskkill` is unexpectedly missing from PATH (very
 * rare — it ships with every Windows since XP).
 */
const SIGKILL_ESCALATION_MS = 5_000;

function destroyChildPipes(child: ReturnType<typeof spawn>): void {
  // Best-effort. Streams may be in any state; destroy is idempotent.
  try {
    child.stdout?.destroy();
  } catch {
    /* noop */
  }
  try {
    child.stderr?.destroy();
  } catch {
    /* noop */
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid == null || child.killed) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Same grandchild-pipe-survival defense as the POSIX path. taskkill /T
    // walks the parent-pid chain, but a grandchild that detached from the
    // job object (CREATE_BREAKAWAY_FROM_JOB) escapes the walk.
    destroyChildPipes(child);
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const escalation = setTimeout(() => {
    // `child.killed` flips to true the moment we call `child.kill()` even
    // if the signal is ignored, so it is NOT a "is dead" predicate. Only
    // exitCode/signalCode prove the kernel reaped the process.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    // Always destroy parent-side pipes after the SIGKILL window. If the
    // process exited cleanly, this is a no-op (the streams are already
    // closed). If a detached grandchild is keeping the pipes alive, this
    // is the only path that lets `child.once("close")` fire.
    destroyChildPipes(child);
  }, SIGKILL_ESCALATION_MS);
  escalation.unref?.();
  child.once("close", () => clearTimeout(escalation));
}

/**
 * Single-target SIGTERM → SIGKILL escalation for a `ChildProcess` that was
 * spawned WITHOUT `detached: true` (so there is no process group to signal).
 *
 * Distinct from {@link killTree} which targets the whole process group via
 * `process.kill(-pid, ...)`. Use {@link killChildWithEscalation} for short
 * auth-flow CLIs (`codex login --device-auth`, `claude auth login`) where
 * grandchildren are unlikely and the politeness of SIGTERM is preferred —
 * but if the child catches and ignores SIGTERM, escalate to SIGKILL after
 * `gracePeriodMs` so the parent's `child.once("close")` listener actually
 * fires. Same hang motivation as {@link killTree}'s SIGKILL escalation
 *
 * Note on `subprocess.killed` semantics: Node sets `killed=true` as soon
 * as `child.kill()` *sends* a signal — even if the child ignores it. So
 * the only reliable "is the child actually gone" predicates are
 * `exitCode !== null` (normal exit) and `signalCode !== null` (signal
 * exit). The escalation timer must check those, NOT `killed`, or it
 * would never SIGKILL after a swallowed SIGTERM.
 */
export function killChildWithEscalation(
  child: ChildProcess,
  options: { gracePeriodMs?: number } = {},
): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
    return;
  }
  const grace = options.gracePeriodMs ?? 5_000;
  const escalation = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, grace);
  escalation.unref?.();
  child.once("close", () => clearTimeout(escalation));
}

export function findExecutable(command: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  const extensions = process.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(command)
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".exe", ".cmd", ".bat"])
    : [""];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep scanning PATH
      }
    }
  }

  return null;
}

// ── Windows `.cmd`/`.bat` shim launching ─────────────────────────────────
//
// On Windows with Node ≥ 22, spawning a resolved `.cmd`/`.bat` with the
// default `shell: false` throws EINVAL (the CVE-2024-27980 "BatBadBut"
// mitigation), and spawning a bare command name never consults PATHEXT (throws
// ENOENT). npm-installed CLIs ship exactly these batch shims (`codex.cmd`,
// `gemini.cmd`, `npm.cmd`, …), so every Codex/Gemini turn, auth-recovery probe,
// and in-dashboard CLI install/verify that flows through `runLineCommand`
// would crash on a Windows host.
//
// We therefore (win32-only) resolve a bare name to its absolute shim via
// `findExecutable()` and, when the target is a batch shim, launch it through an
// explicit `cmd.exe /d /s /c` wrapper. The naive `shell: true` shortcut is
// UNSAFE here: callers pass arbitrary LLM prompts as discrete argv elements,
// and under `shell: true` Node hands the joined line to cmd.exe whose metachar
// parsing (`%VAR%`, `&`, `|`, `<`, `>`, `^`, embedded `"`, newlines) is NOT
// neutralized by Node's quoting — turning a crash into prompt corruption and a
// command-injection surface. Instead we escape every element for cmd.exe
// ourselves and pass the pre-escaped line with `windowsVerbatimArguments: true`
// so Node does not re-quote on top.
//
// The escaping below is replicated faithfully from the battle-tested
// `cross-spawn` package (MIT, v7.0.6) and https://qntm.org/cmd: each argument
// is first made safe for the MS C runtime argv parser (backslash / double-
// quote rules, using cross-spawn's ReDoS-hardened regexes — our args are
// arbitrary LLM prompts), then cmd.exe metacharacters are caret-escaped. The
// caret-escaping is applied a *second* time only for `node_modules/.bin/*.cmd`
// shims, whose extra cmd.exe re-invocation layer consumes one level of escaping
// (a plain global shim like `npm.cmd` must NOT be double-escaped or its args
// would be corrupted).

/** cmd.exe metacharacters (space included) that require caret-escaping. */
const WIN_CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Matches a `node_modules/.bin/<name>.cmd` shim — the only case that needs
 * double-escaped metachars (mirrors cross-spawn's `isCmdShimRegExp`).
 */
const WIN_CMD_BIN_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function escapeCmdCommand(command: string): string {
  // Command path: caret-escape metachars (spaces included) but do NOT wrap in
  // quotes — matches cross-spawn, which relies on caret-escaped spaces here.
  return command.replace(WIN_CMD_META, "^$1");
}

function escapeCmdArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let s = `${arg}`;
  // 1. MS C runtime argv quoting (qntm.org/cmd, ReDoS-hardened): double up a
  //    backslash run that precedes a double quote and escape the quote; double
  //    up a trailing run (it ends up before the closing quote); wrap in quotes.
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  s = `"${s}"`;
  // 2. Caret-escape cmd.exe metachars; a second pass only for node_modules/.bin
  //    shims (their extra cmd layer consumes one level of ^-escaping).
  s = s.replace(WIN_CMD_META, "^$1");
  if (doubleEscapeMetaChars) {
    s = s.replace(WIN_CMD_META, "^$1");
  }
  return s;
}

/**
 * Build the `cmd.exe` argv that launches a `.cmd`/`.bat` shim with the given
 * arguments, fully escaped against cmd.exe re-parsing. Pure (no filesystem),
 * exported for unit testing of the escaping. Pair with
 * `windowsVerbatimArguments: true` so Node passes the line verbatim.
 */
export function buildCmdShimArgs(shimPath: string, args: string[]): string[] {
  const doubleEscape = WIN_CMD_BIN_SHIM.test(shimPath);
  const line = [
    escapeCmdCommand(shimPath),
    ...args.map((a) => escapeCmdArgument(a, doubleEscape)),
  ].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

export interface Win32Invocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Windows-only spawn rewrite for {@link runLineCommand}. Returns the
 * substitute `{ command, args, windowsVerbatimArguments }`, or `null` when no
 * rewrite is needed (so the caller spawns the original command unchanged, and
 * an unresolvable bare name still ENOENTs naturally as before).
 *
 * - Bare name → resolved to its absolute path via PATHEXT (`findExecutable`).
 * - Resolved `.cmd`/`.bat` → launched through a hand-escaped
 *   `cmd.exe /d /s /c` wrapper (verbatim args).
 * - Resolved `.exe`/`.com`/extensionless → spawned directly (`shell:false` is
 *   safe for these); the only change vs. today is bare-name → absolute
 *   resolution, which also closes the bare-name PATHEXT ENOENT.
 */
export function resolveWin32Invocation(
  command: string,
  args: string[],
): Win32Invocation | null {
  const hasPathSeparator = /[\\/]/.test(command);
  // A pathed command is normalized (forward slashes → native, matching
  // cross-spawn, which otherwise ENOENTs on posix-style paths); a bare name is
  // resolved through PATH/PATHEXT.
  const resolved = hasPathSeparator ? normalize(command) : findExecutable(command);
  if (!resolved) {
    // Unresolvable bare name: leave it to spawn so the ENOENT surfaces as the
    // child "error" event exactly as it does today.
    return null;
  }
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: buildCmdShimArgs(resolved, args),
      windowsVerbatimArguments: true,
    };
  }
  if (resolved === command) {
    // Already an absolute/pathed non-batch target; nothing to rewrite.
    return null;
  }
  // Bare name resolved to an absolute .exe/.com (or extensionless): spawn it
  // directly. Node's standard argv quoting is correct for non-batch targets.
  return { command: resolved, args, windowsVerbatimArguments: false };
}

/**
 * Lazy CLI path resolver with TTL-based revalidation (roadmap §9.4).
 *
 * Eagerly resolves in the constructor (initial latency = one PATH scan),
 * then re-checks via `accessSync(X_OK)` every {@link ttlMs} (default 60 s).
 *
 * Handles three scenarios without daemon restart:
 *  - **CLI uninstall**: `accessSync` fails → re-resolve from PATH → returns null
 *  - **CLI re-install** (possibly different path): re-resolve finds new location
 *  - **Normal case**: returns cached value with zero filesystem access
 */
export class CliPathCache {
  private cached: string | null;
  private lastCheckedAt: number;

  constructor(
    private readonly command: string,
    private readonly ttlMs = 60_000,
    /** Overridable clock for deterministic testing. */
    private readonly getNow: () => number = Date.now,
  ) {
    this.cached = findExecutable(command);
    this.lastCheckedAt = this.getNow();
  }

  /** Return the resolved path, or null if the CLI is not installed. */
  get(): string | null {
    const now = this.getNow();
    if (now - this.lastCheckedAt < this.ttlMs) {
      return this.cached;
    }
    this.lastCheckedAt = now;

    if (this.cached === null) {
      // CLI wasn't found before — try again (install while daemon running)
      this.cached = findExecutable(this.command);
      return this.cached;
    }

    // CLI was found before — verify it still exists and is executable
    try {
      accessSync(this.cached, constants.X_OK);
      return this.cached;
    } catch {
      // File gone (uninstall / symlink broken) — re-resolve from PATH
      this.cached = findExecutable(this.command);
      return this.cached;
    }
  }
}

export function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

export function createOutputCapturePath(sessionDir: string, prefix: string): string {
  return join(sessionDir, `.${prefix}-${randomUUID()}.txt`);
}

export function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf-8");
}

export function removeFileIfExists(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  unlinkSync(path);
}

/**
 * Strict API-key format validators.
 *
 * These are format-only checks — they catch typos, truncation, and
 * pasted-into-wrong-field mistakes, but do NOT prove the key is
 * currently valid server-side. A real probe against the provider's
 * smallest endpoint (e.g. `GET /v1/models`) is the only authoritative
 * check; format validation is the cheap pre-flight.
 *
 * Any caller that returns `{ok: true, method: "api_key"}` based on
 * these helpers MUST include a `detail` noting the check is
 * format-only, so the dashboard doesn't misrepresent it as verified.
 */
export function isPlausibleAnthropicApiKey(raw: string | undefined): boolean {
  const key = raw?.trim();
  if (!key) return false;
  // Anthropic keys: `sk-ant-api03-<base64url>` (current) and related
  // prefixes. Minimum length ~60 chars in practice; be lenient on tail
  // charset but strict on the prefix to reject environmental garbage.
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
}
