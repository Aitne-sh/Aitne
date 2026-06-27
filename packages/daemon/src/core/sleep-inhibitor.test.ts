import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  SleepInhibitor,
  resolveSleepInhibitCommand,
  SLEEP_INHIBITOR_MAX_RESPAWNS,
  type SleepInhibitorChild,
  type SleepInhibitorSpawn,
} from "./sleep-inhibitor.js";

class FakeChild implements SleepInhibitorChild {
  pid = 4242;
  killed: NodeJS.Signals | undefined;
  unrefCount = 0;
  private listeners = new Map<string, ((...args: never[]) => void)[]>();

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? "SIGTERM";
    return true;
  }

  unref(): void {
    this.unrefCount += 1;
  }

  emit(event: "error", err: Error): void;
  emit(event: "exit", code: number | null, signal: NodeJS.Signals | null): void;
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

describe("resolveSleepInhibitCommand", () => {
  it("returns null when mode is off", () => {
    expect(resolveSleepInhibitCommand("darwin", "off", 123)).toBeNull();
  });

  it("returns null on non-darwin platforms", () => {
    expect(resolveSleepInhibitCommand("linux", "ac", 123)).toBeNull();
    expect(resolveSleepInhibitCommand("win32", "always", 123)).toBeNull();
  });

  it("builds AC-only caffeinate args tied to the daemon pid", () => {
    expect(resolveSleepInhibitCommand("darwin", "ac", 123)).toEqual({
      command: "caffeinate",
      args: ["-s", "-w", "123"],
    });
  });

  it("adds the idle-sleep assertion in always mode", () => {
    expect(resolveSleepInhibitCommand("darwin", "always", 9)).toEqual({
      command: "caffeinate",
      args: ["-i", "-s", "-w", "9"],
    });
  });
});

describe("SleepInhibitor", () => {
  let children: FakeChild[];
  let spawnCalls: { command: string; args: readonly string[] }[];
  let spawnFn: SleepInhibitorSpawn;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    spawnCalls = [];
    spawnFn = (command, args) => {
      spawnCalls.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeInhibitor(
    overrides: Partial<ConstructorParameters<typeof SleepInhibitor>[0]> = {},
  ): SleepInhibitor {
    return new SleepInhibitor({
      mode: "ac",
      platform: "darwin",
      pid: 777,
      spawnFn,
      respawnDelayMs: 50,
      ...overrides,
    });
  }

  it("spawns caffeinate and unrefs the child", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    expect(spawnCalls).toEqual([
      { command: "caffeinate", args: ["-s", "-w", "777"] },
    ]);
    expect(children[0].unrefCount).toBe(1);
  });

  it("start is idempotent", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    inhibitor.start();
    expect(spawnCalls).toHaveLength(1);
  });

  it("does nothing when the resolved command is null", () => {
    const inhibitor = makeInhibitor({ platform: "linux" });
    inhibitor.start();
    expect(spawnCalls).toHaveLength(0);
    inhibitor.stop(); // no child — must not throw
  });

  it("defaults platform/pid/spawn from the process (no-op on non-darwin CI)", () => {
    // Exercises the option-default branches; mode "off" guarantees no spawn
    // regardless of host platform.
    const inhibitor = new SleepInhibitor({ mode: "off" });
    inhibitor.start();
    inhibitor.stop();
  });

  it("stop kills the child with SIGTERM and suppresses respawn", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    inhibitor.stop();
    expect(children[0].killed).toBe("SIGTERM");
    // A late exit event from the killed child must not respawn.
    children[0].emit("exit", null, "SIGTERM");
    vi.runAllTimers();
    expect(spawnCalls).toHaveLength(1);
  });

  it("respawns after an unexpected exit, with delay", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    children[0].emit("exit", 1, null);
    expect(spawnCalls).toHaveLength(1); // not yet — delay pending
    vi.advanceTimersByTime(50);
    expect(spawnCalls).toHaveLength(2);
  });

  it("does not respawn when stop() lands during the respawn delay", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    children[0].emit("exit", 1, null);
    inhibitor.stop();
    vi.runAllTimers();
    expect(spawnCalls).toHaveLength(1);
  });

  it("gives up after the respawn cap", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    for (let i = 0; i < SLEEP_INHIBITOR_MAX_RESPAWNS; i++) {
      children[children.length - 1].emit("exit", 1, null);
      vi.advanceTimersByTime(50);
    }
    expect(spawnCalls).toHaveLength(1 + SLEEP_INHIBITOR_MAX_RESPAWNS);
    children[children.length - 1].emit("exit", 1, null);
    vi.runAllTimers();
    expect(spawnCalls).toHaveLength(1 + SLEEP_INHIBITOR_MAX_RESPAWNS);
  });

  it("treats a process error as terminal (no respawn)", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    children[0].emit("error", new Error("ENOENT"));
    // The exit that follows an error must be ignored (child already cleared).
    children[0].emit("exit", null, null);
    vi.runAllTimers();
    expect(spawnCalls).toHaveLength(1);
  });

  it("survives a spawn function that throws", () => {
    const inhibitor = makeInhibitor({
      spawnFn: () => {
        throw new Error("spawn failed");
      },
    });
    expect(() => inhibitor.start()).not.toThrow();
    inhibitor.stop();
  });

  it("default spawn delegates to node:child_process with stdio ignored", () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const inhibitor = new SleepInhibitor({
      mode: "ac",
      platform: "darwin",
      pid: 1,
    });
    inhibitor.start();
    expect(spawnMock).toHaveBeenCalledWith("caffeinate", ["-s", "-w", "1"], {
      stdio: "ignore",
    });
    inhibitor.stop();
    expect(child.killed).toBe("SIGTERM");
  });

  it("ignores exit events from a replaced child", () => {
    const inhibitor = makeInhibitor();
    inhibitor.start();
    const first = children[0];
    first.emit("exit", 1, null);
    vi.advanceTimersByTime(50);
    expect(spawnCalls).toHaveLength(2);
    // The stale child fires exit again — must not trigger another respawn.
    first.emit("exit", 1, null);
    vi.runAllTimers();
    expect(spawnCalls).toHaveLength(2);
  });
});
