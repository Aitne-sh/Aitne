import { describe, expect, it } from "vitest";
import {
  emptyRow,
  nullableTrim,
  rowsEqual,
  rowsValid,
  WRITER_OPTIONS,
} from "./sot-bindings-card.logic";

describe("emptyRow", () => {
  it("seeds an empty draft row with `shared` writer default", () => {
    expect(emptyRow()).toEqual({
      category: "",
      sotApp: "",
      mirrorPath: null,
      policy: null,
      writer: "shared",
    });
  });
});

describe("WRITER_OPTIONS", () => {
  it("matches the daemon's `writer` enum (agent/shared/user)", () => {
    expect(WRITER_OPTIONS.map((o) => o.value)).toEqual([
      "agent",
      "shared",
      "user",
    ]);
  });
});

describe("nullableTrim", () => {
  it("returns null for empty / whitespace-only strings", () => {
    expect(nullableTrim("")).toBeNull();
    expect(nullableTrim("   ")).toBeNull();
    expect(nullableTrim("\t\n")).toBeNull();
  });
  it("trims and preserves non-empty values", () => {
    expect(nullableTrim("  context/work/tasks-index.md  ")).toBe(
      "context/work/tasks-index.md",
    );
  });
});

describe("rowsEqual", () => {
  const row = {
    category: "tasks",
    sotApp: "notion",
    mirrorPath: "context/work/tasks.md",
    policy: null,
    writer: "agent" as const,
  };

  it("returns true for byte-equal arrays", () => {
    expect(rowsEqual([row], [{ ...row }])).toBe(true);
  });

  it("returns false on length mismatch", () => {
    expect(rowsEqual([row], [row, row])).toBe(false);
  });

  it("detects per-column drift", () => {
    expect(rowsEqual([row], [{ ...row, category: "events" }])).toBe(false);
    expect(rowsEqual([row], [{ ...row, sotApp: "obsidian" }])).toBe(false);
    expect(rowsEqual([row], [{ ...row, writer: "shared" }])).toBe(false);
    expect(rowsEqual([row], [{ ...row, mirrorPath: null }])).toBe(false);
    expect(
      rowsEqual([row], [{ ...row, policy: "agent-writes-once-daily" }]),
    ).toBe(false);
  });

  it("returns true for two empty arrays (initial baseline)", () => {
    expect(rowsEqual([], [])).toBe(true);
  });
});

describe("rowsValid", () => {
  const row = {
    category: "tasks",
    sotApp: "notion",
    mirrorPath: null,
    policy: null,
    writer: "agent" as const,
  };

  it("accepts a single well-formed row", () => {
    expect(rowsValid([row])).toEqual({ ok: true });
  });

  it("rejects a row with empty category", () => {
    const result = rowsValid([{ ...row, category: "   " }]);
    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toMatch(/Category is required/);
  });

  it("rejects a row with empty sotApp", () => {
    const result = rowsValid([{ ...row, sotApp: "" }]);
    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toMatch(/SoT app is required/);
  });

  it("flags a duplicate category case-insensitively", () => {
    const result = rowsValid([
      row,
      { ...row, category: "Tasks", sotApp: "obsidian" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toMatch(/Duplicate category/);
  });

  it("treats categories as distinct after trim normalization", () => {
    const result = rowsValid([
      row,
      { ...row, category: "events", sotApp: "calendar" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty list (the user has no bindings yet)", () => {
    expect(rowsValid([])).toEqual({ ok: true });
  });
});
