import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  formatZodPath,
  translateZodError,
  translateZodIssue,
} from "./agent-errors-zod.js";

// ── formatZodPath / translateZodIssue / translateZodError ────────────────────
//
// Peer tests for `agent-errors-zod.ts`. The zod translator is only called
// from two routes today (`agent-schedule.ts`, `recurring-schedules.ts`)
// plus this peer test, so isolating its tests here keeps the unrelated
// envelope tests from re-loading Zod every time you run them in watch
// mode. Tests import the module-under-test directly — not through the
// barrel — so source/test parity is 1:1.

describe("formatZodPath", () => {
  it("renders mixed string/number paths as field[N].subfield", () => {
    expect(formatZodPath(["rows", 2, "taskContext", "background"])).toBe(
      "rows[2].taskContext.background",
    );
  });

  it("renders root paths cleanly", () => {
    expect(formatZodPath([])).toBe("");
    expect(formatZodPath(["description"])).toBe("description");
  });

  it("handles paths starting with a number", () => {
    expect(formatZodPath([0, "scheduledFor"])).toBe("[0].scheduledFor");
  });

  it("handles symbol path segments by stringifying them", () => {
    // Defensive: Zod 4's path is PropertyKey[] which includes symbol.
    // No schema in this repo emits symbol keys, but the helper keeps
    // the wider type to match the public API surface — this exercise
    // pins the symbol branch.
    const sym = Symbol("rowIdSym");
    expect(formatZodPath([sym])).toBe("rowIdSym");
    expect(formatZodPath(["rows", sym])).toBe("rows.rowIdSym");
    const symNoDescription = Symbol();
    // Symbol() with no description: description is undefined; toString() is "Symbol()".
    expect(formatZodPath([symNoDescription])).toBe("Symbol()");
  });
});

describe("translateZodIssue / translateZodError", () => {
  it("translates a too_small issue on background into the field-keyed override code", () => {
    const schema = z.object({
      rows: z.array(
        z.object({
          taskContext: z.object({
            background: z.string().min(30),
          }),
        }),
      ),
    });
    const result = schema.safeParse({
      rows: [{ taskContext: { background: "short" } }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = translateZodError(result.error, {
      namespace: "schedule",
      fieldCodeMap: {
        "taskContext.background": "schedule.task_context_field_too_short",
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("schedule.task_context_field_too_short");
    expect(issues[0].field).toBe("rows[0].taskContext.background");
    expect(issues[0].rowIndex).toBe(0);
  });

  it("falls through to <namespace>.<fieldTail>_invalid when no override matches", () => {
    const schema = z.object({
      randomField: z.string().regex(/^abc/),
    });
    const result = schema.safeParse({ randomField: "xyz" });
    if (result.success) {
      throw new Error("expected parse failure");
    }
    const issue = translateZodIssue(result.error.issues[0], {
      namespace: "schedule",
    });
    expect(issue.code).toBe("schedule.randomField_invalid");
    // Placeholder hint surfaces because no registry entry exists.
    expect(issue.hint).toMatch(/unregistered code/);
  });

  it("maps invalid_type with received='undefined' onto <namespace>.<field>_missing", () => {
    const schema = z.object({
      rows: z.array(
        z.object({
          taskContext: z.object({
            background: z.string(),
          }),
        }),
      ),
    });
    const result = schema.safeParse({ rows: [{ taskContext: {} }] });
    if (result.success) {
      throw new Error("expected parse failure");
    }
    const issue = translateZodIssue(result.error.issues[0], {
      namespace: "schedule",
      fieldCodeMap: {
        "taskContext.background": "schedule.task_context_field_missing",
      },
    });
    expect(issue.code).toBe("schedule.task_context_field_missing");
  });

  it("extracts row index from rows[N].* paths", () => {
    const schema = z.array(z.object({ description: z.string().min(20) }));
    const result = schema.safeParse([
      { description: "a".repeat(30) },
      { description: "short" },
    ]);
    if (result.success) {
      throw new Error("expected parse failure");
    }
    const issue = translateZodIssue(result.error.issues[0], {
      namespace: "schedule",
    });
    // Root array — no "rows" key, so rowIndex stays null.
    expect(issue.rowIndex).toBeNull();
  });

  it("emits a generic `<namespace>._invalid` code when the Zod issue's path is empty", () => {
    // Root-level scalar parse failures carry an empty path. Exercises the
    // false branch of `path.length > 0 ? String(path[path.length - 1]) : ""`
    // — fieldTail becomes "" and the assembled code degrades to
    // `<namespace>._invalid`.
    const schema = z.string().min(5);
    const result = schema.safeParse("hi");
    if (result.success) {
      throw new Error("expected parse failure");
    }
    const issue = translateZodIssue(result.error.issues[0], {
      namespace: "schedule",
    });
    expect(issue.code).toBe("schedule._too_short");
    expect(issue.field).toBe("");
  });
});
