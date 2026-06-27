import { spawn } from "node:child_process";
import { createLogger } from "../logging.js";

const logger = createLogger("sleep-inhibitor");

/**
 * Keep-awake posture while the daemon runs (`preventSleepMode` setting):
 *
 * - `"off"`    — never inhibit sleep.
 * - `"ac"`     — inhibit system sleep only while on AC power
 *                (macOS `caffeinate -s`; battery drain stays impossible).
 * - `"always"` — additionally inhibit idle sleep on battery
 *                (macOS `caffeinate -i -s`).
 *
 * Why this exists: every timer in the daemon (node-cron, WakeDetector,
 * in-flight agent sessions) freezes while the host sleeps. A sleeping
 * laptop turns the 04:00 day-boundary flow into hours of wake-catchup
 * replays riding macOS maintenance DarkWakes — each replay re-fires
 * day-boundary work in a 1–2 minute window before the machine re-sleeps,
 * and cold prompt caches make those runs 10× the normal cost. Keeping
 * the machine awake while plugged in removes that failure mode at the
 * source; server installs (which never sleep) are unaffected.
 *
 * macOS only. `caffeinate` cannot override lid-close (clamshell) sleep —
 * that needs root (`pmset disablesleep 1`), which the daemon must not
 * touch. Windows/Linux hosts running this daemon are assumed to be
 * servers or desktops with OS-level power management; the inhibitor is a
 * no-op there and logs once at debug level.
 */
export const PREVENT_SLEEP_MODES = ["off", "ac", "always"] as const;
export type PreventSleepMode = (typeof PREVENT_SLEEP_MODES)[number];

/** Respawns allowed after an unexpected `caffeinate` exit before giving up. */
export const SLEEP_INHIBITOR_MAX_RESPAWNS = 3;

/** Pause before a respawn so a persistently-dying binary cannot tight-loop. */
export const SLEEP_INHIBITOR_RESPAWN_DELAY_MS = 5_000;

export interface SleepInhibitCommand {
  command: string;
  args: string[];
}

/**
 * Pure command resolver — `null` means "do not inhibit" (mode off or
 * unsupported platform). `-w <pid>` ties the power assertion to the
 * daemon process itself, so the assertion is released even if the daemon
 * is SIGKILLed and `stop()` never runs.
 */
export function resolveSleepInhibitCommand(
  platform: NodeJS.Platform,
  mode: PreventSleepMode,
  pid: number,
): SleepInhibitCommand | null {
  if (mode === "off") return null;
  if (platform !== "darwin") return null;
  const flags = mode === "always" ? ["-i", "-s"] : ["-s"];
  return { command: "caffeinate", args: [...flags, "-w", String(pid)] };
}

export interface SleepInhibitorChild {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  pid?: number;
}

export type SleepInhibitorSpawn = (
  command: string,
  args: readonly string[],
) => SleepInhibitorChild;

const defaultSpawn: SleepInhibitorSpawn = (command, args) =>
  spawn(command, args as string[], { stdio: "ignore" });

export interface SleepInhibitorOptions {
  mode: PreventSleepMode;
  /** Injectable for tests; defaults to the host platform. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to the daemon's own pid. */
  pid?: number;
  spawnFn?: SleepInhibitorSpawn;
  respawnDelayMs?: number;
}

/**
 * Holds a `caffeinate` child for the daemon's lifetime. Crash-safe by
 * construction (`-w pid` above); `stop()` exists for symmetric shutdown
 * and to suppress the respawn path during graceful exit.
 */
export class SleepInhibitor {
  private readonly mode: PreventSleepMode;
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly spawnFn: SleepInhibitorSpawn;
  private readonly respawnDelayMs: number;
  private child: SleepInhibitorChild | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawns = 0;
  private started = false;
  private stopped = false;

  constructor(options: SleepInhibitorOptions) {
    this.mode = options.mode;
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.respawnDelayMs =
      options.respawnDelayMs ?? SLEEP_INHIBITOR_RESPAWN_DELAY_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const cmd = resolveSleepInhibitCommand(this.platform, this.mode, this.pid);
    if (!cmd) {
      logger.debug(
        { mode: this.mode, platform: this.platform },
        "Sleep inhibitor inactive (mode off or unsupported platform)",
      );
      return;
    }
    this.spawnChild(cmd);
  }

  stop(): void {
    this.stopped = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    // Kill but leave `this.child` set — the exit handler clears it and the
    // `stopped` flag suppresses the respawn path.
    this.child?.kill("SIGTERM");
  }

  private spawnChild(cmd: SleepInhibitCommand): void {
    let child: SleepInhibitorChild;
    try {
      child = this.spawnFn(cmd.command, cmd.args);
    } catch (err) {
      logger.warn(
        { err, command: cmd.command },
        "Sleep inhibitor spawn failed — system sleep stays OS-managed",
      );
      return;
    }
    this.child = child;
    // The inhibitor must never keep the event loop alive on its own.
    child.unref();
    child.on("error", (err) => {
      // ENOENT and friends — the binary is missing or unrunnable, which a
      // respawn cannot fix. Warn once and fall back to OS-managed sleep.
      this.child = null;
      logger.warn(
        { err, command: cmd.command },
        "Sleep inhibitor process errored — system sleep stays OS-managed",
      );
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // killed by stop() or replaced
      this.child = null;
      if (this.stopped) return;
      if (this.respawns >= SLEEP_INHIBITOR_MAX_RESPAWNS) {
        logger.error(
          { code, signal, respawns: this.respawns },
          "Sleep inhibitor exited repeatedly — giving up; system sleep stays OS-managed",
        );
        return;
      }
      this.respawns += 1;
      logger.warn(
        { code, signal, attempt: this.respawns },
        "Sleep inhibitor exited unexpectedly — respawning",
      );
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        if (!this.stopped) this.spawnChild(cmd);
      }, this.respawnDelayMs);
      this.respawnTimer.unref?.();
    });
    logger.info(
      { command: cmd.command, args: cmd.args, mode: this.mode },
      "Sleep inhibitor active",
    );
  }
}
