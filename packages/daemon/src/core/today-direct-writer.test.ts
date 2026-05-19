import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

describe("appendAgentLogLine", () => {
  let tempRoot: string;
  let contextDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "today-direct-writer-"));
    contextDir = join(tempRoot, "context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "today.md"), sampleToday);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("appends a bullet to today.md Agent Log atomically", () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = appendAgentLogLine({
      contextDir,
      message: "[hourly_check] Quiet — 0 obs",
      todayWriteLock: lock,
      now: new Date(2026, 4, 6, 12, 0, 0),
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "today.md"), "utf-8");
    expect(updated).toMatch(/- 12:00 \[hourly_check\] Quiet — 0 obs\n/);
    expect(lock.getHolder()).toBeNull();
  });

  it("rejects when today-write-lock is already held", () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const acquired = lock.acquire();
    expect(acquired.ok).toBe(true);
    const result = appendAgentLogLine({
      contextDir,
      message: "should be skipped",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("lock_unavailable");
  });

  it("returns today_missing when today.md does not exist", () => {
    rmSync(join(contextDir, "today.md"));
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = appendAgentLogLine({
      contextDir,
      message: "noop",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("today_missing");
  });

  it("returns agent_log_section_missing when section absent", () => {
    writeFileSync(
      join(contextDir, "today.md"),
      sampleToday.replace("## Agent Log\n- 09:00 routine ran\n", ""),
    );
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = appendAgentLogLine({
      contextDir,
      message: "noop",
      todayWriteLock: lock,
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toBe("agent_log_section_missing");
  });

  it("preserves an explicit HH:MM prefix instead of stamping a new one", () => {
    const lock = new InMemoryTodayWriteLockManager(60_000);
    const result = appendAgentLogLine({
      contextDir,
      message: "13:30 [hourly_check] custom timestamp",
      todayWriteLock: lock,
      now: new Date(2026, 4, 6, 12, 0, 0),
    });
    expect(result.appended).toBe(true);
    const updated = readFileSync(join(contextDir, "today.md"), "utf-8");
    expect(updated).toMatch(/- 13:30 \[hourly_check\] custom timestamp\n/);
  });
});
