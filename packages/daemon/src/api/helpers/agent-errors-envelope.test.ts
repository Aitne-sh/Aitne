import { describe, expect, it } from "vitest";

import {
  buildEnvelope,
  composeIssue,
  composeWarning,
} from "./agent-errors-envelope.js";
import { AGENT_ERROR_REGISTRY } from "./agent-errors-registry.js";

// ── composeIssue / buildEnvelope / composeWarning ────────────────────────────
//
// Peer tests for `agent-errors-envelope.ts`. Imports the module-under-test
// directly (not through the public barrel) so the source/test mapping is
// 1:1 and a future change to the barrel cannot silently shadow a regression
// here. `AGENT_ERROR_REGISTRY` is pulled in because the envelope helpers
// merge per-code defaults (`hint`, `expected`, `skillAnchor`, `constraint`,
// `retryable`, `legacyErrorCode`) from the registry — verifying those
// merges require reading the source-of-truth entries.

describe("composeIssue", () => {
  it("pulls expected / hint / skillAnchor / constraint from the registry", () => {
    const issue = composeIssue("schedule.scheduled_for_in_past", {
      field: "rows[4].scheduledFor",
      received: "2026-05-15T03:45:00",
      rowIndex: 4,
    });

    expect(issue.code).toBe("schedule.scheduled_for_in_past");
    expect(issue.field).toBe("rows[4].scheduledFor");
    expect(issue.received).toBe("2026-05-15T03:45:00");
    expect(issue.rowIndex).toBe(4);
    expect(issue.expected).toBe(
      AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].expected,
    );
    expect(issue.hint).toBe(
      AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].hint,
    );
    expect(issue.skillAnchor).toBe(
      AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].skillAnchor,
    );
    expect(issue.constraint).toEqual(
      AGENT_ERROR_REGISTRY["schedule.scheduled_for_in_past"].constraint,
    );
    expect(issue.severity).toBe("error");
  });

  it("respects per-call overrides over registry defaults", () => {
    const issue = composeIssue("schedule.description_too_short", {
      field: "rows[0].description",
      received: "tiny",
      hint: "Custom hint for this row.",
      expected: "Custom expected.",
      severity: "warning",
    });

    expect(issue.hint).toBe("Custom hint for this row.");
    expect(issue.expected).toBe("Custom expected.");
    expect(issue.severity).toBe("warning");
  });

  it("returns a placeholder issue with a warning hint for an unregistered code", () => {
    const issue = composeIssue("nonexistent.unregistered_code" as never, {
      field: "rows[0].mystery",
      received: undefined,
    });

    expect(issue.code).toBe("nonexistent.unregistered_code");
    expect(issue.hint).toMatch(/unregistered code/);
    expect(issue.severity).toBe("error");
  });

  it("normalizes rowIndex to null when omitted", () => {
    const issue = composeIssue("schedule.scheduled_for_invalid", {
      field: "scheduledFor",
      received: "not-a-date",
    });

    expect(issue.rowIndex).toBeNull();
  });
});

describe("buildEnvelope", () => {
  it("synthesises a single-issue summary when only one issue is present", () => {
    const env = buildEnvelope([
      composeIssue("schedule.scheduled_for_in_past", {
        field: "rows[4].scheduledFor",
        received: "2026-05-15T03:45:00",
        rowIndex: 4,
      }),
    ]);

    expect(env.ok).toBe(false);
    expect(env.summary).toBe(
      "Request rejected: schedule.scheduled_for_in_past on rows[4].scheduledFor.",
    );
    expect(env.errors).toHaveLength(1);
    expect(env.retryable).toBe(true);
  });

  it("counts multi-issue summaries by number of errors", () => {
    const env = buildEnvelope([
      composeIssue("schedule.description_too_short", { field: "rows[0].description", received: "x" }),
      composeIssue("schedule.scheduled_for_in_past", { field: "rows[1].scheduledFor", received: "yesterday" }),
    ]);

    expect(env.summary).toBe("2 validation errors. Fix the listed errors and retry.");
  });

  it("propagates rowsAttempted / rowsCommitted / retryHint when provided", () => {
    const env = buildEnvelope(
      [
        composeIssue("schedule.task_context_field_missing", {
          field: "rows[2].taskContext.background",
          received: "<missing>",
          rowIndex: 2,
        }),
      ],
      {
        summary: "5 rows submitted; 1 rejected.",
        rowsAttempted: 5,
        rowsCommitted: 0,
        retryHint: "Fix the error and POST the same body again.",
      },
    );

    expect(env.summary).toBe("5 rows submitted; 1 rejected.");
    expect(env.rowsAttempted).toBe(5);
    expect(env.rowsCommitted).toBe(0);
    expect(env.retryHint).toBe("Fix the error and POST the same body again.");
  });

  it("marks retryable=false when any issue's registry entry sets retryable:false", () => {
    const env = buildEnvelope([
      composeIssue("agent_actions.session_identity_missing", {
        field: "headers.x-pa-event-correlation-id",
        received: "<missing>",
      }),
    ]);

    expect(env.retryable).toBe(false);
  });

  it("returns retryable=false on an empty issue array", () => {
    const env = buildEnvelope([]);
    expect(env.retryable).toBe(false);
  });

  it("warnings do not affect retryable", () => {
    const env = buildEnvelope([
      composeIssue("schedule.description_too_short", {
        field: "rows[0].description",
        received: "tiny",
        severity: "warning",
      }),
    ]);
    expect(env.retryable).toBe(true);
  });

  it("respects retryable override", () => {
    const env = buildEnvelope(
      [
        composeIssue("schedule.scheduled_for_in_past", {
          field: "scheduledFor",
          received: "past",
        }),
      ],
      { retryable: false },
    );
    expect(env.retryable).toBe(false);
  });

  it("explicit `legacyErrorCode: null` opts out of the registry-set legacy alias", () => {
    // Exercises the `options.legacyErrorCode ?? undefined` fallback
    // inside resolveLegacyAlias — the explicit null branch.
    const env = buildEnvelope(
      [
        composeIssue("schedule.task_context_field_missing", {
          field: "rows[0].taskContext.background",
          received: "<missing>",
        }),
      ],
      { legacyErrorCode: null },
    );
    expect((env as Record<string, unknown>).error).toBeUndefined();
  });

  it("explicit `legacyErrorCode: \"forced_alias\"` overrides the registry default", () => {
    // Exercises the truthy left-hand path of `?? undefined` —
    // explicit string passed in.
    const env = buildEnvelope(
      [
        composeIssue("schedule.task_context_field_missing", {
          field: "rows[0].taskContext.background",
          received: "<missing>",
        }),
      ],
      { legacyErrorCode: "forced_alias" },
    );
    expect((env as Record<string, unknown>).error).toBe("forced_alias");
  });
});

// ── Phase C envelope upgrade — validValues + docsUrl + warnings[] ───────────

describe("composeIssue with new fields", () => {
  it("accepts validValues and docsUrl as overrides", () => {
    const issue = composeIssue("schedule.model_unknown", {
      field: "model",
      received: "gpt-5.4-turbo",
      validValues: {
        aliases: ["sonnet", "opus"],
        models: { claude: ["claude-opus-4-7"], codex: ["gpt-5.4"] },
      },
      docsUrl: "agent-assets/skills/schedule/references/errors.md#model_unknown",
    });

    expect(issue.validValues).toEqual({
      aliases: ["sonnet", "opus"],
      models: { claude: ["claude-opus-4-7"], codex: ["gpt-5.4"] },
    });
    expect(issue.docsUrl).toBe(
      "agent-assets/skills/schedule/references/errors.md#model_unknown",
    );
  });

  it("pulls docsUrl from the registry default when no override is supplied", () => {
    const issue = composeIssue("schedule.task_type_unknown", {
      field: "taskType",
      received: "invoke",
    });
    expect(issue.docsUrl).toBe(
      "agent-assets/skills/schedule/references/errors.md#task_type_unknown",
    );
  });

  it("override docsUrl wins over registry default", () => {
    const issue = composeIssue("schedule.task_type_unknown", {
      field: "taskType",
      received: "invoke",
      docsUrl: "docs/design/02-event-pipeline.md#scheduled-tasks",
    });
    expect(issue.docsUrl).toBe("docs/design/02-event-pipeline.md#scheduled-tasks");
  });

  it("validValues is undefined by default — there is no registry-level default", () => {
    // Per §5.3 the registry never declares validValues — it's dynamic.
    const issue = composeIssue("schedule.task_type_unknown", {
      field: "taskType",
      received: "invoke",
    });
    expect(issue.validValues).toBeUndefined();
  });

  it("docsUrl on a placeholder (unregistered code) flows through from override", () => {
    const issue = composeIssue("nonexistent.unregistered_code" as never, {
      field: "mystery",
      received: undefined,
      docsUrl: "docs/design/missing.md#mystery",
      validValues: ["a", "b"],
    });
    expect(issue.docsUrl).toBe("docs/design/missing.md#mystery");
    expect(issue.validValues).toEqual(["a", "b"]);
  });
});

describe("composeWarning", () => {
  it("pins severity to 'warning' regardless of registry default", () => {
    const issue = composeWarning("schedule.task_type_unknown", {
      field: "taskType",
      received: "invoke",
    });
    expect(issue.severity).toBe("warning");
    expect(issue.code).toBe("schedule.task_type_unknown");
  });

  it("propagates validValues / docsUrl / hint overrides", () => {
    const issue = composeWarning("schedule.model_unknown", {
      field: "model",
      received: "claude-opus-4-5",
      hint: "Model is deprecated; replacement: claude-opus-4-7.",
      validValues: { aliases: ["sonnet", "opus"] },
    });
    expect(issue.hint).toBe("Model is deprecated; replacement: claude-opus-4-7.");
    expect(issue.validValues).toEqual({ aliases: ["sonnet", "opus"] });
    expect(issue.severity).toBe("warning");
  });
});

describe("buildEnvelope with warnings channel", () => {
  it("serialises warnings[] as a separate field on the envelope", () => {
    const env = buildEnvelope(
      [
        composeIssue("schedule.scheduled_for_in_past", {
          field: "time",
          received: "2026-05-15T03:45:00",
        }),
      ],
      {
        warnings: [
          composeWarning("schedule.task_type_unknown", {
            field: "taskType",
            received: "wakeup",
            hint: "Maybe you meant 'wake'.",
          }),
        ],
      },
    );

    expect(env.warnings).toBeDefined();
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings?.[0].code).toBe("schedule.task_type_unknown");
    expect(env.warnings?.[0].severity).toBe("warning");
    // Errors are unaffected.
    expect(env.errors).toHaveLength(1);
    expect(env.errors[0].code).toBe("schedule.scheduled_for_in_past");
  });

  it("normalises issue severity to 'warning' when placed in warnings[]", () => {
    // Even when a caller forgets composeWarning and passes a stock
    // composeIssue result (severity:"error"), the channel placement
    // is the source of truth.
    const env = buildEnvelope([], {
      warnings: [
        composeIssue("schedule.task_type_unknown", {
          field: "taskType",
          received: "wakeup",
        }),
      ],
    });
    expect(env.warnings?.[0].severity).toBe("warning");
  });

  it("omits warnings[] from the envelope when none are passed", () => {
    const env = buildEnvelope([
      composeIssue("schedule.scheduled_for_in_past", {
        field: "time",
        received: "past",
      }),
    ]);
    expect((env as Record<string, unknown>).warnings).toBeUndefined();
  });

  it("omits warnings[] when the warnings array is explicitly empty", () => {
    // Empty array is treated as no warnings — no field appears on
    // the wire. Mirrors how `rowsAttempted` / `retryHint` behave.
    const env = buildEnvelope(
      [
        composeIssue("schedule.scheduled_for_in_past", {
          field: "time",
          received: "past",
        }),
      ],
      { warnings: [] },
    );
    expect((env as Record<string, unknown>).warnings).toBeUndefined();
  });

  it("retryable computation ignores warnings (severity check is on errors[] only)", () => {
    // Warnings on a non-retryable-coded error must not flip retryable to true.
    const env = buildEnvelope(
      [
        composeIssue("agent_actions.session_identity_missing", {
          field: "headers.x-pa-event-correlation-id",
          received: "<missing>",
        }),
      ],
      {
        warnings: [
          composeWarning("schedule.task_type_unknown", {
            field: "taskType",
            received: "wakeup",
          }),
        ],
      },
    );
    expect(env.retryable).toBe(false);
  });

  it("warnings-only envelope (no errors) still serialises warnings[]", () => {
    // The 2xx + warnings response shape from SCHEDULE_API_REDESIGN_PLAN.md §5.2.
    // buildEnvelope is the error builder; callers using it for a warnings-
    // only success body must override `retryable` and `summary` to make sense.
    const env = buildEnvelope([], {
      retryable: false,
      summary: "Created with 1 warning.",
      warnings: [
        composeWarning("schedule.task_type_unknown", {
          field: "taskType",
          received: "wakeup",
        }),
      ],
    });
    expect(env.errors).toHaveLength(0);
    expect(env.warnings).toHaveLength(1);
    expect(env.summary).toBe("Created with 1 warning.");
  });

  it("legacyFields cannot overwrite the warnings channel", () => {
    // `warnings` is structural — call sites cannot smuggle a different
    // shape through legacyFields.
    const env = buildEnvelope(
      [
        composeIssue("schedule.scheduled_for_in_past", {
          field: "time",
          received: "past",
        }),
      ],
      {
        warnings: [
          composeWarning("schedule.task_type_unknown", {
            field: "taskType",
            received: "wakeup",
          }),
        ],
        legacyFields: {
          warnings: "this-string-must-be-ignored",
        },
      },
    );
    expect(Array.isArray(env.warnings)).toBe(true);
    expect(env.warnings).toHaveLength(1);
  });
});
