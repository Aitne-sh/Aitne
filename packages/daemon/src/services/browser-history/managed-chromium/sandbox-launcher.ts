/**
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.4 / §7.4 — OS-specific
 * sandbox primitive wrappers.
 *
 * `launchUnderSandbox` is the single chokepoint every managed-chromium
 * spawn goes through (Instance S supervisor cycles, bootstrap UI
 * window, Instance A workflows in B-2). Argv shaping per primitive is
 * data-driven so each branch stays small and individually testable.
 *
 * Defence layering:
 *   1. The OS-level sandbox (sandbox-exec / bwrap / systemd-run /
 *      AppContainer) is the outer ring — Chromium itself cannot reach
 *      arbitrary network destinations or filesystem paths even if a
 *      page tries to escape.
 *   2. Inside the sandbox, Chromium's own renderer sandbox is a second
 *      ring.
 *   3. Per-workflow CDP `Network.setRequestInterception` (B-2) is the
 *      innermost ring.
 */

import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";

import type { SandboxPrimitive } from "../types.js";

export interface SandboxLaunchOptions {
  binary: string;
  args: readonly string[];
  /** Bind-mounts / allowlisted dirs for the bwrap branch. */
  readableBindings?: readonly string[];
  /** Read-write bind-mounts. Currently only the per-profile user data
   *  dir. */
  writableBindings?: readonly string[];
  /** Spawn options forwarded to `child_process.spawn`. */
  spawnOptions?: SpawnOptions;
  /** Whether the spawned child is a detached background process the
   *  daemon does not own (sets `detached: true`, `stdio: "ignore"`,
   *  `unref()`). Bootstrap UI windows set this to `false` so the
   *  daemon can SIGTERM them at the end of sign-in. */
  detached?: boolean;
}

export interface SandboxLaunchResult {
  child: ChildProcess;
  /** The argv0 the OS will see — useful for telemetry / ps inspection. */
  spawnedAs: string;
  /** Full argv. */
  spawnedArgs: readonly string[];
}

/**
 * Dispatch on `sandbox.kind` and spawn the Chromium binary under the
 * matching primitive. Throws (or returns a non-pid-bearing child) if
 * the primitive's wrapper binary is missing — callers must handle the
 * `child.on("error")` path.
 */
export function launchUnderSandbox(
  sandbox: SandboxPrimitive,
  options: SandboxLaunchOptions,
): SandboxLaunchResult {
  const baseSpawnOptions: SpawnOptions = {
    ...(options.spawnOptions ?? {}),
    detached: options.detached ?? false,
    stdio: options.detached ? "ignore" : (options.spawnOptions?.stdio ?? "ignore"),
    windowsHide: true,
  };

  switch (sandbox.kind) {
    case "sandbox-exec": {
      const argv = buildSandboxExecArgs(sandbox.profilePath, options);
      return finalise(spawn("/usr/bin/sandbox-exec", argv, baseSpawnOptions), "/usr/bin/sandbox-exec", argv, options.detached);
    }
    case "bubblewrap": {
      const argv = buildBwrapArgs(options);
      return finalise(spawn("bwrap", argv, baseSpawnOptions), "bwrap", argv, options.detached);
    }
    case "systemd-run": {
      const argv = buildSystemdRunArgs(options);
      return finalise(spawn("systemd-run", argv, baseSpawnOptions), "systemd-run", argv, options.detached);
    }
    case "appcontainer-jobobject": {
      // The Windows native helper exposes a JS-callable spawn function
      // that internally calls CreateProcessAsUser + AssignProcessToJob
      // Object. Loaded lazily so non-Windows builds do not require the
      // native binding (which only compiles on win32 + msvc).
      const native = loadWindowsHelper();
      const child = native.spawnInAppContainer({
        profileName: sandbox.profileName,
        binary: options.binary,
        args: options.args,
        detached: options.detached === true,
        readableBindings: options.readableBindings ?? [],
        writableBindings: options.writableBindings ?? [],
      });
      return { child, spawnedAs: options.binary, spawnedArgs: [...options.args] };
    }
    case "none": {
      // Unsandboxed — operator must have explicitly opted in. The
      // bootstrap module is the gate; this launcher trusts that gate
      // was passed.
      return finalise(spawn(options.binary, [...options.args], baseSpawnOptions), options.binary, [...options.args], options.detached);
    }
  }
}

function finalise(
  child: ChildProcess,
  spawnedAs: string,
  argv: readonly string[],
  detached: boolean | undefined,
): SandboxLaunchResult {
  if (detached) {
    try {
      child.unref();
    } catch {
      // unref is best-effort — if the spawn already errored, there is
      // nothing to unref.
    }
  }
  return { child, spawnedAs, spawnedArgs: argv };
}

/**
 * macOS `sandbox-exec` argv: `["-f", profile, binary, ...args]`. The
 * profile path is resolved by `sandbox-install.ts` (copies the bundled
 * `agent-assets/sandbox/macos/aitne-chromium.sb` into PA_DATA_DIR so
 * Apple's signature-validating wrapper can read it from a
 * non-quarantined location).
 */
export function buildSandboxExecArgs(
  profilePath: string,
  options: SandboxLaunchOptions,
): string[] {
  if (!profilePath) {
    throw new Error(
      "sandbox-exec profile path is empty; sandbox-install must run before launch",
    );
  }
  return ["-f", profilePath, options.binary, ...options.args];
}

/**
 * bwrap argv: deny-by-default with explicit `--ro-bind` / `--bind` for
 * each path the browser needs.
 *
 *   --die-with-parent       — child exits when daemon does
 *   --new-session           — own session so a runaway browser cannot
 *                              reach the daemon's tty
 *   --unshare-all           — start with everything unshared
 *   --share-net             — re-share network (Chromium needs it; the
 *                              CDP interception layer is the innermost
 *                              ring per the plan)
 *   --proc /proc            — minimal procfs
 *   --dev /dev              — minimal devfs (needed for /dev/null,
 *                              /dev/urandom, /dev/shm)
 *   --tmpfs /tmp            — private writable tmp
 *   --ro-bind <bin> <bin>   — read-only access to /usr, /bin, /lib*
 *                              for the Chromium binary's shared libs
 *   --bind <profile> <profile> — read-write access to the per-instance
 *                              user data dir only
 */
export function buildBwrapArgs(options: SandboxLaunchOptions): string[] {
  const argv: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--share-net",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/lib32", "/lib32",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/fonts", "/etc/fonts",
    "--ro-bind-try", "/usr/share/fonts", "/usr/share/fonts",
    "--ro-bind-try", "/var/lib/dbus", "/var/lib/dbus",
    "--setenv", "HOME", "/tmp",
    "--setenv", "XDG_RUNTIME_DIR", "/run",
    "--setenv", "DISPLAY", process.env.DISPLAY ?? "",
    "--setenv", "WAYLAND_DISPLAY", process.env.WAYLAND_DISPLAY ?? "",
  ];
  for (const path of options.readableBindings ?? []) {
    argv.push("--ro-bind-try", path, path);
  }
  for (const path of options.writableBindings ?? []) {
    argv.push("--bind-try", path, path);
  }
  argv.push("--", options.binary, ...options.args);
  return argv;
}

/**
 * systemd-run argv: transient user-scope unit with cgroup-level
 * resource ceilings + private filesystem hooks. Less hermetic than
 * bwrap (no namespace unshare) but available on hosts where bwrap is
 * not installed.
 *
 *   --user --scope               — run as a transient scope under the
 *                                   caller's user manager (no root)
 *   --quiet                      — no systemctl chatter on stdout
 *   --collect                    — discard scope unit on exit
 *   --property=MemoryMax=…       — cgroup memory ceiling
 *   --property=TasksMax=…        — cgroup process-count ceiling
 *   --property=PrivateTmp=true   — private /tmp
 *   --property=ProtectSystem=strict — read-only /usr, /boot, /etc
 *   --property=ProtectHome=read-only — read-only $HOME except writable
 *                                       binds added below
 *   --property=NoNewPrivileges=true — block setuid/setgid escalation
 */
export function buildSystemdRunArgs(options: SandboxLaunchOptions): string[] {
  const argv: string[] = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--property=MemoryMax=2G",
    "--property=TasksMax=2048",
    "--property=PrivateTmp=true",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=read-only",
    "--property=NoNewPrivileges=true",
    "--property=LockPersonality=true",
    "--property=RestrictNamespaces=true",
    "--property=RestrictRealtime=true",
    "--property=RestrictSUIDSGID=true",
  ];
  const writable = options.writableBindings ?? [];
  if (writable.length > 0) {
    argv.push(`--property=ReadWritePaths=${writable.join(" ")}`);
  }
  const readable = options.readableBindings ?? [];
  if (readable.length > 0) {
    argv.push(`--property=ReadOnlyPaths=${readable.join(" ")}`);
  }
  argv.push("--", options.binary, ...options.args);
  return argv;
}

interface WindowsHelper {
  spawnInAppContainer(opts: {
    profileName: string;
    binary: string;
    args: readonly string[];
    detached: boolean;
    readableBindings: readonly string[];
    writableBindings: readonly string[];
  }): ChildProcess;
}

/**
 * Lazy require of the native binding. On non-Windows hosts (dev / CI)
 * the binding is not built; the helper falls back to a no-op that
 * surfaces a clear runtime error so a test accidentally exercising the
 * appcontainer branch outside Windows fails loudly.
 */
function loadWindowsHelper(): WindowsHelper {
  if (process.platform !== "win32") {
    throw new Error(
      "appcontainer-jobobject sandbox primitive is only available on Windows",
    );
  }
  // The native binding is loaded via the package barrel `./loader.js`
  // which falls back gracefully when the .node addon is missing
  // (fresh source checkout before `npm rebuild`).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../../../native/win-appcontainer/loader.js") as {
    loadHelper: () => WindowsHelper;
  };
  return mod.loadHelper();
}

export const __testing = {
  buildSandboxExecArgs,
  buildBwrapArgs,
  buildSystemdRunArgs,
};
