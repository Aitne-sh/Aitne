import { describe, expect, it } from "vitest";
import { runtimeSettingsSchema } from "./runtime-settings.js";

describe("runtimeSettingsSchema — character field", () => {
  it("defaults to empty string", () => {
    const parsed = runtimeSettingsSchema.parse({});
    expect(parsed.character).toBe("");
  });

  it("accepts a 999-char value (below cap)", () => {
    const value = "x".repeat(999);
    const parsed = runtimeSettingsSchema.parse({ character: value });
    expect(parsed.character).toBe(value);
  });

  it("accepts a 1000-char value (at cap)", () => {
    const value = "x".repeat(1000);
    const parsed = runtimeSettingsSchema.parse({ character: value });
    expect(parsed.character).toBe(value);
  });

  it("rejects a 1001-char value (over cap)", () => {
    const value = "x".repeat(1001);
    const result = runtimeSettingsSchema.safeParse({ character: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "character")).toBe(true);
    }
  });

  it("rejects a value containing the block start marker", () => {
    const result = runtimeSettingsSchema.safeParse({
      character: "hello <!-- character:start --> there",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.message.includes("block marker substring"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a value containing the block end marker", () => {
    const result = runtimeSettingsSchema.safeParse({
      character: "hello <!-- character:end --> there",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.message.includes("block marker substring"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a whitespace-only value (non-empty but blank)", () => {
    const result = runtimeSettingsSchema.safeParse({ character: "   \n\t  " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.message.includes("non-blank or empty"),
        ),
      ).toBe(true);
    }
  });

  it("accepts a non-empty value that begins or ends with whitespace", () => {
    const parsed = runtimeSettingsSchema.parse({
      character: "  Speak casually.  ",
    });
    expect(parsed.character).toBe("  Speak casually.  ");
  });
});

// docs/design/appendices/pre-pass-fan-out.md §6 — `prePassBackoffMs.length >= maxAttempts - 1`.
// A too-short array would silently fall back to the last element via
// `RoutineFetchWindowRunner.backoffForAttempt`, surprising operators
// who set distinct values intentionally. Equality and overshoot pass.
describe("runtimeSettingsSchema — prePassBackoffMs length cross-field check (PRE_PASS_FAN_OUT_DESIGN §6)", () => {
  it("accepts the documented defaults (maxAttempts=3, backoffMs length 3)", () => {
    const parsed = runtimeSettingsSchema.parse({});
    expect(parsed.prePassMaxAttemptsPerIntegration).toBe(3);
    expect(parsed.prePassBackoffMs).toEqual([1000, 2000, 4000]);
  });

  it("accepts exact length match (maxAttempts=3, backoffMs length 2)", () => {
    const parsed = runtimeSettingsSchema.parse({
      prePassMaxAttemptsPerIntegration: 3,
      prePassBackoffMs: [500, 1000],
    });
    expect(parsed.prePassBackoffMs).toEqual([500, 1000]);
  });

  it("accepts overshoot (maxAttempts=2, backoffMs length 3)", () => {
    // Extra trailing entries are harmless — the loop never reads past
    // index `attempt - 1`. Rejecting overshoot would force operators to
    // keep two fields in lockstep across every PATCH.
    const parsed = runtimeSettingsSchema.parse({
      prePassMaxAttemptsPerIntegration: 2,
      prePassBackoffMs: [1000, 2000, 4000],
    });
    expect(parsed.prePassBackoffMs).toEqual([1000, 2000, 4000]);
  });

  it("rejects too-short backoffMs (maxAttempts=4, backoffMs length 2)", () => {
    // Required = maxAttempts - 1 = 3, supplied 2 → reject so the operator
    // sees the misconfiguration instead of silently inheriting the last
    // value for the third inter-attempt wait.
    const result = runtimeSettingsSchema.safeParse({
      prePassMaxAttemptsPerIntegration: 4,
      prePassBackoffMs: [500, 1000],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) =>
            i.path.includes("prePassBackoffMs")
            && i.message.includes("at least"),
        ),
        "expected the cross-field error to mention prePassBackoffMs and 'at least'",
      ).toBe(true);
    }
  });

  it("rejects empty backoffMs when maxAttempts >= 2", () => {
    const result = runtimeSettingsSchema.safeParse({
      prePassMaxAttemptsPerIntegration: 2,
      prePassBackoffMs: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty backoffMs when maxAttempts === 1 (no inter-attempt waits)", () => {
    // maxAttempts - 1 = 0, so the empty array is structurally valid.
    const parsed = runtimeSettingsSchema.parse({
      prePassMaxAttemptsPerIntegration: 1,
      prePassBackoffMs: [],
    });
    expect(parsed.prePassBackoffMs).toEqual([]);
  });
});

// BROWSER_TASK_REDESIGN_PLAN.md §5.1 / §12 Q#5 — additive runtime-
// settings keys for the open-ended browser sub-agent slot policy and
// quiet-hours respect. The three keys ship in Phase 1; their defaults
// match the design doc verbatim.
describe("runtimeSettingsSchema — browser-task knobs (Phase 1)", () => {
  it("defaults browserTaskMaxConcurrent to 3", () => {
    expect(runtimeSettingsSchema.parse({}).browserTaskMaxConcurrent).toBe(3);
  });

  it("accepts 1..5 for browserTaskMaxConcurrent", () => {
    for (const v of [1, 2, 3, 4, 5]) {
      expect(
        runtimeSettingsSchema.parse({ browserTaskMaxConcurrent: v })
          .browserTaskMaxConcurrent,
      ).toBe(v);
    }
  });

  it("rejects browserTaskMaxConcurrent outside [1, 5]", () => {
    expect(
      runtimeSettingsSchema.safeParse({ browserTaskMaxConcurrent: 0 }).success,
    ).toBe(false);
    expect(
      runtimeSettingsSchema.safeParse({ browserTaskMaxConcurrent: 6 }).success,
    ).toBe(false);
  });

  it("defaults browserTaskPendingQueueTimeoutMinutes to 30", () => {
    expect(
      runtimeSettingsSchema.parse({}).browserTaskPendingQueueTimeoutMinutes,
    ).toBe(30);
  });

  it("accepts 5..180 for browserTaskPendingQueueTimeoutMinutes", () => {
    for (const v of [5, 30, 90, 180]) {
      expect(
        runtimeSettingsSchema.parse({
          browserTaskPendingQueueTimeoutMinutes: v,
        }).browserTaskPendingQueueTimeoutMinutes,
      ).toBe(v);
    }
  });

  it("rejects browserTaskPendingQueueTimeoutMinutes outside [5, 180]", () => {
    expect(
      runtimeSettingsSchema.safeParse({
        browserTaskPendingQueueTimeoutMinutes: 4,
      }).success,
    ).toBe(false);
    expect(
      runtimeSettingsSchema.safeParse({
        browserTaskPendingQueueTimeoutMinutes: 181,
      }).success,
    ).toBe(false);
  });

  it("defaults browserTaskRespectQuietHours to true", () => {
    expect(runtimeSettingsSchema.parse({}).browserTaskRespectQuietHours).toBe(
      true,
    );
  });

  it("accepts an explicit false override", () => {
    expect(
      runtimeSettingsSchema.parse({ browserTaskRespectQuietHours: false })
        .browserTaskRespectQuietHours,
    ).toBe(false);
  });
});

describe("runtimeSettingsSchema — feedback learning knobs", () => {
  it("defaults feedback learning on with bounded caps and retention", () => {
    const parsed = runtimeSettingsSchema.parse({});
    expect(parsed.feedbackLearningEnabled).toBe(true);
    expect(parsed.feedbackPromotionThreshold).toBe(2);
    expect(parsed.feedbackLessonMaxBytesGlobal).toBe(8192);
    expect(parsed.feedbackLessonMaxBytesPerAgent).toBe(4096);
    expect(parsed.feedbackLessonStaleDays).toBe(60);
    expect(parsed.feedbackSignalRetentionDays).toBe(180);
  });

  it("rejects out-of-range feedback learning knobs", () => {
    expect(runtimeSettingsSchema.safeParse({ feedbackPromotionThreshold: 0 }).success).toBe(false);
    expect(runtimeSettingsSchema.safeParse({ feedbackLessonMaxBytesGlobal: 999 }).success).toBe(false);
    expect(runtimeSettingsSchema.safeParse({ feedbackLessonMaxBytesPerAgent: 511 }).success).toBe(false);
    expect(runtimeSettingsSchema.safeParse({ feedbackLessonStaleDays: 6 }).success).toBe(false);
    expect(runtimeSettingsSchema.safeParse({ feedbackSignalRetentionDays: 29 }).success).toBe(false);
  });
});
