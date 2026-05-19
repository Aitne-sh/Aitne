import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client";
import {
  composeOutputPath,
  extractError,
  isOverSoftWarning,
  modifySheetDirty,
  parseOutputPath,
} from "./managed-tasks-card.logic";
import type { ManagedTask } from "@aitne/shared";
import type { RecurrenceRule } from "@/lib/api-types";

const baseTask: ManagedTask = {
  id: "mt_1",
  intent: "fetch",
  app: "Zoom",
  app_normalized: "zoom",
  cadence: "daily 10:00",
  output_path: "work/meetings/",
  schedule_id: 11,
  last_run_at: null,
  last_result: null,
  consecutive_failures: 0,
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
};

const baseRule: RecurrenceRule = {
  frequency: "daily",
  time: "10:00",
  timezone: "Asia/Tokyo",
};

describe("parseOutputPath", () => {
  it("round-trips a valid `<domain>/<type-plural>/` path", () => {
    expect(parseOutputPath("work/meetings/")).toEqual({
      domain: "work",
      type: "meeting",
    });
    expect(parseOutputPath("finance/receipts/")).toEqual({
      domain: "finance",
      type: "receipt",
    });
  });

  it("returns the empty pair for null", () => {
    expect(parseOutputPath(null)).toEqual({ domain: "", type: "" });
  });

  it("rejects unknown domain", () => {
    expect(parseOutputPath("garbage/meetings/")).toEqual({
      domain: "",
      type: "",
    });
  });

  it("rejects unknown plural", () => {
    expect(parseOutputPath("work/notarealtype/")).toEqual({
      domain: "",
      type: "",
    });
  });

  it("rejects extra path segments", () => {
    expect(parseOutputPath("work/meetings/extra/")).toEqual({
      domain: "",
      type: "",
    });
  });
});

describe("composeOutputPath", () => {
  it("composes a §9.3 path when both selectors are filled", () => {
    expect(
      composeOutputPath({ domain: "work", type: "meeting" }),
    ).toBe("work/meetings/");
  });

  it("returns null for partial state — matches the nullable column", () => {
    expect(composeOutputPath({ domain: "", type: "meeting" })).toBeNull();
    expect(composeOutputPath({ domain: "work", type: "" })).toBeNull();
    expect(composeOutputPath({ domain: "", type: "" })).toBeNull();
  });
});

describe("isOverSoftWarning", () => {
  it("flags counts ≥ MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING (=30)", () => {
    expect(isOverSoftWarning(30)).toBe(true);
    expect(isOverSoftWarning(99)).toBe(true);
  });
  it("does not flag counts below the threshold", () => {
    expect(isOverSoftWarning(0)).toBe(false);
    expect(isOverSoftWarning(29)).toBe(false);
  });
});

describe("extractError", () => {
  it("preserves ApiError.message — derived from body.message", () => {
    // ApiError (status, body) extracts body.message into Error.message.
    expect(
      extractError(new ApiError(409, { message: "daemon refused" })),
    ).toBe("daemon refused");
  });
  it("falls back to body.error then to API-Error-<status>", () => {
    expect(extractError(new ApiError(500, { error: "internal" }))).toBe(
      "internal",
    );
    expect(extractError(new ApiError(404, null))).toBe("API Error 404");
  });
  it("preserves a regular Error.message", () => {
    expect(extractError(new Error("boom"))).toBe("boom");
  });
  it("falls back to a generic string for non-Error throws", () => {
    expect(extractError("string thrown")).toBe("operation failed");
    expect(extractError(undefined)).toBe("operation failed");
  });
});

describe("modifySheetDirty", () => {
  it("returns false for an unchanged draft", () => {
    expect(
      modifySheetDirty(
        {
          intent: baseTask.intent,
          cadence: baseTask.cadence,
          outputPath: baseTask.output_path,
          recurrenceRule: baseRule,
        },
        { task: baseTask, recurrenceRule: baseRule },
      ),
    ).toBe(false);
  });

  it("detects intent / cadence / output_path edits", () => {
    expect(
      modifySheetDirty(
        {
          intent: "different",
          cadence: baseTask.cadence,
          outputPath: baseTask.output_path,
          recurrenceRule: baseRule,
        },
        { task: baseTask, recurrenceRule: baseRule },
      ),
    ).toBe(true);
    expect(
      modifySheetDirty(
        {
          intent: baseTask.intent,
          cadence: "different",
          outputPath: baseTask.output_path,
          recurrenceRule: baseRule,
        },
        { task: baseTask, recurrenceRule: baseRule },
      ),
    ).toBe(true);
    expect(
      modifySheetDirty(
        {
          intent: baseTask.intent,
          cadence: baseTask.cadence,
          outputPath: "personal/notes/",
          recurrenceRule: baseRule,
        },
        { task: baseTask, recurrenceRule: baseRule },
      ),
    ).toBe(true);
  });

  it("detects recurrence-rule changes (time edit)", () => {
    expect(
      modifySheetDirty(
        {
          intent: baseTask.intent,
          cadence: baseTask.cadence,
          outputPath: baseTask.output_path,
          recurrenceRule: { ...baseRule, time: "11:00" },
        },
        { task: baseTask, recurrenceRule: baseRule },
      ),
    ).toBe(true);
  });

  it("ignores whitespace-only edits to intent / cadence", () => {
    expect(
      modifySheetDirty(
        {
          intent: `  ${baseTask.intent}  `,
          cadence: `  ${baseTask.cadence}  `,
          outputPath: baseTask.output_path,
          recurrenceRule: baseRule,
        },
        { task: baseTask, recurrenceRule: baseRule },
      ),
    ).toBe(false);
  });
});
