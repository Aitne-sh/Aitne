import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryTodayWriteLockManager,
} from "./today-write-lock.js";
import {
  appendAgentLogLine,
  appendBulletToAgentLog,
} from "./today-direct-writer.js";

const sampleToday = [
  "# 2026-05-06 (Wednesday)",
  "> Day type: Weekday | Work focus: on | Study focus: off | Personal focus: on",
  "",
  "## User Schedule",
  "- 09:00 stand-up",
  "",
  "## Agent Plan",
  "- 09:30 ship the patch",
  "",
  "## Agent Log",
  "- 09:00 routine ran",
  "",
  "## User Notes",
  "- random note",
  "",
].join("\n");

describe("appendBulletToAgentLog", () => {
  it("inserts a bullet as the last entry in the Agent Log section", () => {
    const updated = appendBulletToAgentLog(
      sampleToday,
      "- 12:00 [hourly_check] Quiet — 0 obs",
    );
    expect(updated).not.toBeNull();
    const lines = updated!.split("\n");
    const headerIdx = lines.findIndex((l) => l === "## Agent Log");
    const nextHeader = lines.findIndex(
      (l, i) => i > headerIdx && l.startsWith("## "),
    );
    const sectionLines = lines.slice(headerIdx + 1, nextHeader);
    expect(sectionLines.filter((l) => l.startsWith("- "))).toEqual([
      "- 09:00 routine ran",
      "- 12:00 [hourly_check] Quiet — 0 obs",
    ]);
    // The User Notes section is preserved verbatim afterwards.
    expect(updated).toContain("\n## User Notes\n- random note\n");
  });

  it("returns null when the Agent Log section is missing", () => {
    const stripped = sampleToday.replace("## Agent Log\n- 09:00 routine ran\n", "");
    const updated = appendBulletToAgentLog(stripped, "- 12:00 noop");
    expect(updated).toBeNull();
  });

  it("works when Agent Log is the final section (no trailing heading)", () => {
    const ending = sampleToday.split("\n## User Notes\n")[0] + "\n";
    const updated = appendBulletToAgentLog(ending, "- 12:00 added");
    expect(updated).not.toBeNull();
    expect(updated).toMatch(/- 09:00 routine ran\n- 12:00 added\n/);
  });

  it("handles `## Agent Log` at the very start of the file (no leading newline)", () => {
    const content = [
      "## Agent Log",
      "- 09:00 first",
      "",
      "## After",
      "- after",
      "",
    ].join("\n");
    const updated = appendBulletToAgentLog(content, "- 12:00 added");
    expect(updated).not.toBeNull();
    expect(updated).toMatch(/^## Agent Log\n- 09:00 first\n- 12:00 added\n/);
    expect(updated).toContain("\n## After\n- after\n");
  });
});

describe("appendAgentLogLine", () => {
  let tempRoot: string;
  let contextDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "today-direct-writer-"));
    contextDir = join(tempRoot, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "state", "today.md"), sampleToday);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("appends a bullet to today.md Agent Log atomically", async () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "[hourly_check] Quiet — 0 obs",
      todayWriteLock: lock,
      now: new Date(2026, 4, 6, 12, 0, 0),
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
    expect(updated).toMatch(/- 12:00 \[hourly_check\] Quiet — 0 obs\n/);
    expect(lock.getHolder()).toBeNull();
  });

  it("rejects when today-write-lock is already held", async () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const acquired = lock.acquire();
    expect(acquired.ok).toBe(true);
    const result = await appendAgentLogLine({
      contextDir,
      message: "should be skipped",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("lock_unavailable");
  });

  it("returns today_missing when today.md does not exist", async () => {
    rmSync(join(contextDir, "state", "today.md"));
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "noop",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("today_missing");
  });

  it("returns agent_log_section_missing when section absent", async () => {
    writeFileSync(
      join(contextDir, "state", "today.md"),
      sampleToday.replace("## Agent Log\n- 09:00 routine ran\n", ""),
    );
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "noop",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("agent_log_section_missing");
  });

  it("preserves an explicit HH:MM prefix instead of stamping a new one", async () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "13:30 [hourly_check] custom timestamp",
      todayWriteLock: lock,
      now: new Date(2026, 4, 6, 12, 0, 0),
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
    expect(updated).toMatch(/- 13:30 \[hourly_check\] custom timestamp\n/);
  });

  it("preserves a message that is already formatted as a bullet (- prefix)", async () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "- already a bullet",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
    expect(updated).toContain("- already a bullet\n");
  });

  it("respects a custom timezone option when formatting the HH:MM stamp", async () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "[hourly_check] tz check",
      todayWriteLock: lock,
      // 2026-05-06T03:00:00Z — at UTC the local time is 03:00, but Tokyo
      // is +09:00 so the formatted bullet should show 12:00.
      now: new Date(Date.UTC(2026, 4, 6, 3, 0, 0)),
      timezone: "Asia/Tokyo",
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
    expect(updated).toMatch(/- 12:00 \[hourly_check\] tz check\n/);
  });

  it("falls back to a system-clock HH:MM when Intl.DateTimeFormat throws on an invalid timezone", async () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "[hourly_check] tz fallback",
      todayWriteLock: lock,
      now: new Date(2026, 4, 6, 7, 5, 0),
      // Bogus IANA zone — Intl.DateTimeFormat throws a RangeError on
      // construction. The writer should drop into the pad2 fallback
      // branch and still produce a HH:MM stamp.
      timezone: "Mars/Phobos",
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
    expect(updated).toMatch(/- 07:05 \[hourly_check\] tz fallback\n/);
  });

  it("returns io_error when today.md cannot be read (path is a directory)", async () => {
    // Replace today.md with a directory of the same name — readFileSync
    // will throw EISDIR while existsSync still reports the path as present.
    rmSync(join(contextDir, "state", "today.md"));
    mkdirSync(join(contextDir, "state", "today.md"));
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = await appendAgentLogLine({
      contextDir,
      message: "should fail",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("io_error");
    // Lock must be released even on the error path.
    expect(lock.getHolder()).toBeNull();
  });

  it("returns io_error when today.md write fails (parent is read-only)", async () => {
    // On macOS/Linux, chmod 0500 (read+execute, no write) on the parent
    // dir makes writeFileAtomically's rename / open-for-write fail.
    if (process.platform === "win32") return;
    const stateDir = join(contextDir, "state");
    chmodSync(stateDir, 0o500);
    try {
      const lock = new InMemoryTodayWriteLockManager(60_000);
      const result = await appendAgentLogLine({
        contextDir,
        message: "should fail on write",
        todayWriteLock: lock,
      });
      expect(result.appended).toBe(false);
      expect(result.reason).toBe("io_error");
    } finally {
      // Restore so afterEach's rmSync can clean up.
      chmodSync(stateDir, 0o700);
    }
  });

  it("serializes against a concurrent direct write to the same today.md", async () => {
    // The bug this fix addresses: without serializeContextFileWrite,
    // two concurrent appendAgentLogLine calls could read the same
    // pre-state and the second rename would clobber the first bullet.
    // With the serializer, both bullets land in order.
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const lock2 = new InMemoryTodayWriteLockManager(60_000);
    const [first, second] = await Promise.all([
      appendAgentLogLine({
        contextDir,
        message: "[bullet-A] first",
        todayWriteLock: lock,
        now: new Date(2026, 4, 6, 12, 0, 0),
      }),
      appendAgentLogLine({
        contextDir,
        message: "[bullet-B] second",
        todayWriteLock: lock2,
        now: new Date(2026, 4, 6, 12, 1, 0),
      }),
    ]);
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
    expect(updated).toContain("- 12:00 [bullet-A] first\n");
    expect(updated).toContain("- 12:01 [bullet-B] second\n");
  });
});
