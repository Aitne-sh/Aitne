import { describe, it, expect } from "vitest";
import {
  SNAPSHOT_DEBOUNCE_MS,
  clearEntriesBefore,
  parseEntryTimestamp,
  trimBulletEntries,
} from "./snapshot-debounce.js";

describe("SNAPSHOT_DEBOUNCE_MS", () => {
  it("is 5 minutes", () => {
    expect(SNAPSHOT_DEBOUNCE_MS).toBe(5 * 60 * 1000);
  });
});

describe("parseEntryTimestamp", () => {
  it("parses a valid timestamped bullet entry", () => {
    expect(parseEntryTimestamp("- [2026-04-10 02:32:59] [ignore] content")).toBe(
      "2026-04-10 02:32:59",
    );
  });

  it("returns null for a non-timestamped bullet", () => {
    expect(parseEntryTimestamp("- Some plain entry")).toBeNull();
  });

  it("returns null for a blank line", () => {
    expect(parseEntryTimestamp("")).toBeNull();
    expect(parseEntryTimestamp("  ")).toBeNull();
  });

  it("returns null for a heading", () => {
    expect(parseEntryTimestamp("## Raw Signals")).toBeNull();
  });
});

describe("clearEntriesBefore", () => {
  it("removes all entries when all are before cutoff", () => {
    const body = "- [2026-04-01 10:00:00] a\n- [2026-04-02 10:00:00] b\n";
    const result = clearEntriesBefore(body, "2026-04-03 00:00:00");
    expect(result.removedCount).toBe(2);
    expect(result.remaining).not.toContain("[2026-04-01");
    expect(result.remaining).not.toContain("[2026-04-02");
  });

  it("preserves all entries when none are before cutoff", () => {
    const body = "- [2026-04-05 10:00:00] a\n- [2026-04-06 10:00:00] b\n";
    const result = clearEntriesBefore(body, "2026-04-01 00:00:00");
    expect(result.removedCount).toBe(0);
    expect(result.remaining).toContain("[2026-04-05");
    expect(result.remaining).toContain("[2026-04-06");
  });

  it("returns empty-ish body for empty section", () => {
    const result = clearEntriesBefore("\n", "2026-04-10 00:00:00");
    expect(result.removedCount).toBe(0);
  });

  it("removes continuation lines of removed entries", () => {
    const body = [
      "- [2026-04-01 10:00:00] multi-line entry",
      "  continued here",
      "  and here",
      "- [2026-04-05 10:00:00] kept entry",
    ].join("\n");
    const result = clearEntriesBefore(body, "2026-04-02 00:00:00");
    expect(result.removedCount).toBe(1);
    expect(result.remaining).not.toContain("continued here");
    expect(result.remaining).toContain("kept entry");
  });

  it("preserves entries without timestamps", () => {
    const body =
      "- no timestamp entry\n- [2026-04-01 10:00:00] old\n- also no timestamp\n";
    const result = clearEntriesBefore(body, "2026-04-10 00:00:00");
    expect(result.removedCount).toBe(1);
    expect(result.remaining).toContain("no timestamp entry");
    expect(result.remaining).toContain("also no timestamp");
  });

  it("removes blank lines between removed entries", () => {
    const body = [
      "- [2026-04-01 10:00:00] old 1",
      "",
      "- [2026-04-02 10:00:00] old 2",
      "",
      "- [2026-04-05 10:00:00] kept",
    ].join("\n");
    const result = clearEntriesBefore(body, "2026-04-03 00:00:00");
    expect(result.removedCount).toBe(2);
    expect(result.remaining).not.toMatch(/^\n/);
    expect(result.remaining).toContain("kept");
  });
});

describe("trimBulletEntries", () => {
  it("does not trim when count <= maxEntries", () => {
    const body = "- a\n- b\n";
    expect(trimBulletEntries(body, 2).trimmed).toBe(0);
    expect(trimBulletEntries(body, 5).trimmed).toBe(0);
    expect(trimBulletEntries(body, 2).body).toBe(body);
  });

  it("trims oldest entries when over limit", () => {
    const body = "- a\n- b\n- c\n- d\n";
    const result = trimBulletEntries(body, 2);
    expect(result.trimmed).toBe(2);
    expect(result.body).not.toContain("- a");
    expect(result.body).not.toContain("- b");
    expect(result.body).toContain("- c");
    expect(result.body).toContain("- d");
  });

  it("handles empty body", () => {
    const result = trimBulletEntries("\n", 5);
    expect(result.trimmed).toBe(0);
    expect(result.body).toBe("\n");
  });

  it("preserves non-bullet lines", () => {
    const body = "Some header text\n- a\n- b\n- c\n";
    const result = trimBulletEntries(body, 2);
    expect(result.trimmed).toBe(1);
    expect(result.body).toContain("Some header text");
    expect(result.body).not.toContain("- a");
    expect(result.body).toContain("- b");
    expect(result.body).toContain("- c");
  });

  it("removes blank lines between trimmed entries", () => {
    const body = "- a\n\n- b\n\n- c\n";
    const result = trimBulletEntries(body, 2);
    expect(result.trimmed).toBe(1);
    expect(result.body).not.toMatch(/^\n/);
    expect(result.body).toContain("- b");
    expect(result.body).toContain("- c");
  });

  it("removes continuation lines of trimmed entries", () => {
    const body = "- a\n  cont a\n- b\n  cont b\n- c\n";
    const result = trimBulletEntries(body, 2);
    expect(result.trimmed).toBe(1);
    expect(result.body).not.toContain("- a");
    expect(result.body).not.toContain("cont a");
    expect(result.body).toContain("- b");
    expect(result.body).toContain("cont b");
  });

  it("clamps to zero entries — exercises the EOF-of-bullets branch", () => {
    // maxEntries=0 forces the loop's last iteration to fall through the
    // `i+1 < bulletIndices.length` branch into the `lines.length` fallback,
    // covering the final-bullet trim path.
    const body = "- a\n  cont a\n- b\n";
    const result = trimBulletEntries(body, 0);
    expect(result.trimmed).toBe(2);
    expect(result.body).not.toContain("- a");
    expect(result.body).not.toContain("- b");
    expect(result.body).not.toContain("cont a");
  });
});
