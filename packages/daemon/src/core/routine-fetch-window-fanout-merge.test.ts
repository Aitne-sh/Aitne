import { describe, expect, it } from "vitest";
import type { IntegrationKey } from "@aitne/shared";
import {
  aggregateFanOutStatus,
  mergeSubReports,
  summarizeFetchReport,
  summarizeIntegrationReport,
  type FetchReport,
  type SubAttemptRecord,
  type SubReport,
} from "./routine-fetch-window-runner.js";

function record(
  partial: Partial<SubAttemptRecord> & { attempt: number },
): SubAttemptRecord {
  return {
    status: "success",
    fetched: 0,
    posted: 0,
    duplicates: 0,
    errors: [],
    fetcherCorrelationId: `cid-${partial.attempt}`,
    startedAt: "2026-05-13T10:00:00.000Z",
    endedAt: "2026-05-13T10:00:01.000Z",
    costUsd: 0.07,
    numTurns: 1,
    ...partial,
  };
}

function subReport(
  integrationKey: IntegrationKey,
  partial: Partial<SubReport> = {},
): SubReport {
  const baseAttempt = record({ attempt: 1, ...partial });
  return {
    ...baseAttempt,
    integrationKey,
    attempts: partial.attempts ?? [baseAttempt],
    retriesExhausted: partial.retriesExhausted ?? false,
    ...partial,
  };
}

describe("aggregateFanOutStatus — §4.5", () => {
  it("returns 'skipped' for an empty input", () => {
    expect(aggregateFanOutStatus([])).toBe("skipped");
  });

  it("returns 'success' when every non-skipped sub-report is success", () => {
    expect(
      aggregateFanOutStatus([
        subReport("gmail", { status: "success" }),
        subReport("notion", { status: "success" }),
      ]),
    ).toBe("success");
  });

  it("ignores skipped sub-reports when classifying success", () => {
    expect(
      aggregateFanOutStatus([
        subReport("gmail", { status: "success" }),
        subReport("notion", { status: "skipped" }),
      ]),
    ).toBe("success");
  });

  it("returns 'failed' when every non-skipped sub-report is failed", () => {
    expect(
      aggregateFanOutStatus([
        subReport("gmail", { status: "failed" }),
        subReport("google_calendar", { status: "failed" }),
      ]),
    ).toBe("failed");
  });

  it("returns 'partial' for any mix (success + failed)", () => {
    expect(
      aggregateFanOutStatus([
        subReport("gmail", { status: "success" }),
        subReport("google_calendar", { status: "failed" }),
      ]),
    ).toBe("partial");
  });

  it("returns 'partial' when one sub-report is partial and others succeed", () => {
    expect(
      aggregateFanOutStatus([
        subReport("gmail", { status: "success" }),
        subReport("google_calendar", { status: "partial" }),
      ]),
    ).toBe("partial");
  });

  it("returns 'skipped' when every non-skipped slot is empty (every sub skipped)", () => {
    expect(
      aggregateFanOutStatus([
        subReport("gmail", { status: "skipped" }),
        subReport("notion", { status: "skipped" }),
      ]),
    ).toBe("skipped");
  });
});

describe("mergeSubReports — §4.5", () => {
  // `routine.morning_routine_initial` was used as the canonical
  // fixture key here until Phase 7 (2026-05-16) retired it. Switching
  // to `routine.morning_routine` keeps the rendered-output prose
  // (e.g. `routine="morning_routine"` in the embedded block) on a
  // process key the daemon still routes, so any drift in the routine-
  // prefix stripper is caught by the same set of assertions.
  const ROUTINE = "routine.morning_routine";
  const AGENT_DAY = "2026-05-13";

  it("sums fetched / posted / duplicates across sub-reports", () => {
    const { report } = mergeSubReports(
      [
        subReport("gmail", { fetched: 5, posted: 5, duplicates: 1 }),
        subReport("google_calendar", { fetched: 3, posted: 3, duplicates: 0 }),
        subReport("notion", { fetched: 2, posted: 1, duplicates: 0 }),
      ],
      ROUTINE,
      AGENT_DAY,
    );
    expect(report.fetched).toBe(10);
    expect(report.posted).toBe(9);
    expect(report.duplicates).toBe(1);
  });

  it("concatenates errors and tags each with the integration key", () => {
    const { report } = mergeSubReports(
      [
        subReport("gmail", {
          status: "success",
          fetched: 1,
          posted: 1,
        }),
        subReport("google_calendar", {
          status: "failed",
          fetched: 5,
          posted: 0,
          errors: [
            { type: "fetch-failed", status: 400, message: 'Unknown name "limit"' },
            { type: "fetch-failed", status: 400, message: 'Unknown name "limit"' },
          ],
        }),
      ],
      ROUTINE,
      AGENT_DAY,
    );
    expect(report.errors.length).toBe(2);
    for (const err of report.errors) {
      expect(err.integration).toBe("google_calendar");
      expect(err.type).toBe("fetch-failed");
    }
  });

  it("emits status='success' when every sub-report succeeded", () => {
    const { report, block } = mergeSubReports(
      [
        subReport("gmail", { status: "success", fetched: 1, posted: 1 }),
        subReport("notion", { status: "success", fetched: 1, posted: 1 }),
      ],
      ROUTINE,
      AGENT_DAY,
    );
    expect(report.status).toBe("success");
    expect(report.failureReason).toBeUndefined();
    expect(block).toContain('status="success"');
  });

  it("emits status='failed' + failureReason summary when every non-skipped sub is failed", () => {
    const failedGmail = subReport("gmail", {
      status: "failed",
      attempts: [
        record({ attempt: 1, status: "failed" }),
        record({ attempt: 2, status: "failed" }),
        record({ attempt: 3, status: "failed" }),
      ],
      retriesExhausted: true,
    });
    const failedCal = subReport("google_calendar", {
      status: "failed",
      attempts: [
        record({ attempt: 1, status: "failed" }),
        record({ attempt: 2, status: "failed" }),
        record({ attempt: 3, status: "failed" }),
      ],
      retriesExhausted: true,
    });
    const { report, block } = mergeSubReports(
      [failedGmail, failedCal],
      ROUTINE,
      AGENT_DAY,
    );
    expect(report.status).toBe("failed");
    expect(report.failureReason).toContain("2 integrations failed");
    expect(report.failureReason).toContain("gmail (3 attempts)");
    expect(report.failureReason).toContain("google_calendar (3 attempts)");
    expect(block).toContain("<failure>");
    expect(block).toContain("2 integrations failed");
  });

  it("emits status='partial' for a mixed outcome (success + failed)", () => {
    const { report } = mergeSubReports(
      [
        subReport("gmail", { status: "success", fetched: 5, posted: 5 }),
        subReport("google_calendar", { status: "failed", fetched: 21, posted: 0 }),
      ],
      ROUTINE,
      AGENT_DAY,
    );
    expect(report.status).toBe("partial");
    // failureReason is set only when aggregate is 'failed'.
    expect(report.failureReason).toBeUndefined();
  });

  it("emits status='skipped' when the input list is empty", () => {
    const { report, block } = mergeSubReports([], ROUTINE, AGENT_DAY);
    expect(report.status).toBe("skipped");
    expect(report.fetched).toBe(0);
    expect(report.posted).toBe(0);
    expect(report.duplicates).toBe(0);
    expect(block).toContain('status="skipped"');
  });

  it("sorts perIntegration breakdown by INTEGRATION_KEYS order regardless of input order", () => {
    const { report, block } = mergeSubReports(
      [
        subReport("notion", { status: "success" }),
        subReport("gmail", { status: "success" }),
        subReport("google_calendar", { status: "success" }),
      ],
      ROUTINE,
      AGENT_DAY,
    );
    const orderedKeys = (report.perIntegration ?? []).map((p) => p.integrationKey);
    expect(orderedKeys).toEqual(["gmail", "google_calendar", "notion"]);
    // Block ordering matches the sorted breakdown.
    const gmailIdx = block.indexOf('key="gmail"');
    const calIdx = block.indexOf('key="google_calendar"');
    const notionIdx = block.indexOf('key="notion"');
    expect(gmailIdx).toBeGreaterThanOrEqual(0);
    expect(calIdx).toBeGreaterThan(gmailIdx);
    expect(notionIdx).toBeGreaterThan(calIdx);
  });

  it("renders an <integration> child per sub-report with status/fetched/posted/duplicates/attempts", () => {
    const { block } = mergeSubReports(
      [
        subReport("gmail", {
          status: "success",
          fetched: 5,
          posted: 5,
          duplicates: 0,
          attempts: [record({ attempt: 1 })],
        }),
      ],
      ROUTINE,
      AGENT_DAY,
    );
    expect(block).toContain('<integration key="gmail"');
    expect(block).toContain('status="success"');
    expect(block).toContain('fetched="5"');
    expect(block).toContain('posted="5"');
    expect(block).toContain('duplicates="0"');
    expect(block).toContain('attempts="1"');
  });

  it("nests <error> children inside <integration> when the sub-report carries errors", () => {
    // Errors live on the per-attempt records — `mergeSubReports` walks
    // `sub.attempts` to flatten error history (matching how the runner
    // actually builds SubReports in `runOneIntegrationWithRetry`, where
    // `sub.errors` is derived from `attempts.flatMap(e => e.errors)`).
    const failedCal = subReport("google_calendar", {
      status: "failed",
      fetched: 21,
      posted: 0,
      attempts: [
        record({
          attempt: 1,
          status: "failed",
          errors: [
            {
              type: "fetch-failed",
              status: 400,
              message: 'Unknown name "limit"',
            },
          ],
        }),
        record({ attempt: 2, status: "failed" }),
        record({ attempt: 3, status: "failed" }),
      ],
      retriesExhausted: true,
    });
    const { block } = mergeSubReports([failedCal], ROUTINE, AGENT_DAY);
    expect(block).toMatch(
      /<integration key="google_calendar"[^>]*>\s*<error type="fetch-failed"/,
    );
    expect(block).toContain("</integration>");
    expect(block).toContain("&quot;limit&quot;");
  });

  it("self-closes <integration> children that have no errors (compact rendering)", () => {
    const { block } = mergeSubReports(
      [subReport("gmail", { status: "success", fetched: 5, posted: 5 })],
      ROUTINE,
      AGENT_DAY,
    );
    expect(block).toMatch(/<integration key="gmail"[^>]*\/>/);
  });

  it("strips the routine. prefix on the top-level routine attribute", () => {
    // Use a still-valid routine key. Pre-Phase-7 this assertion used
    // `routine.morning_routine_initial`; the stripping contract is the
    // same regardless of which routine name is in play.
    const { block } = mergeSubReports(
      [subReport("gmail", { status: "success" })],
      "routine.morning_routine",
      AGENT_DAY,
    );
    expect(block).toContain('routine="morning_routine"');
    expect(block).not.toContain('routine="routine.morning_routine"');
  });

  it("preserves perIntegration as the same SubReport objects for downstream consumers", () => {
    const gmail = subReport("gmail", { status: "success" });
    const cal = subReport("google_calendar", { status: "failed" });
    const { report } = mergeSubReports([cal, gmail], ROUTINE, AGENT_DAY);
    const breakdown = report.perIntegration ?? [];
    expect(breakdown).toHaveLength(2);
    // Sorted by INTEGRATION_KEYS — gmail before google_calendar.
    expect(breakdown[0]).toBe(gmail);
    expect(breakdown[1]).toBe(cal);
  });
});

// docs/design/appendices/pre-pass-fan-out.md §7.1 / §7.2 — shared headline helpers
// consumed by both the coordinator daemon log line and the
// `prepass_completed` SSE payload. The shapes MUST match the design
// example in §7.1 so a reader correlating the two surfaces never sees
// disagreeing numbers.
describe("summarizeIntegrationReport — §7.1 / §7.2", () => {
  it("sums costUsd and durationMs across the full attempt chain", () => {
    const sub = subReport("gmail", {
      status: "success",
      attempts: [
        record({
          attempt: 1,
          startedAt: "2026-05-13T10:00:00.000Z",
          endedAt: "2026-05-13T10:00:01.500Z",
          costUsd: 0.05,
        }),
        record({
          attempt: 2,
          startedAt: "2026-05-13T10:00:02.000Z",
          endedAt: "2026-05-13T10:00:04.500Z",
          costUsd: 0.07,
        }),
      ],
    });
    const summary = summarizeIntegrationReport(sub);
    expect(summary.attempts).toBe(2);
    expect(summary.costUsd).toBeCloseTo(0.12, 5);
    expect(summary.durationMs).toBe(1500 + 2500);
  });

  it("omits finalError on non-failed sub-reports", () => {
    const sub = subReport("gmail", {
      status: "partial",
      attempts: [record({ attempt: 1, status: "partial" })],
    });
    expect(summarizeIntegrationReport(sub).finalError).toBeUndefined();
  });

  it("populates finalError from the LAST attempt's first error message on failed sub-reports", () => {
    const sub = subReport("google_calendar", {
      status: "failed",
      attempts: [
        record({ attempt: 1, status: "failed" }),
        record({
          attempt: 2,
          status: "failed",
          errors: [
            {
              type: "fetch-failed",
              status: 400,
              message: 'Unknown name "limit"',
            },
            { type: "fetch-failed", status: 400, message: "should be ignored" },
          ],
        }),
      ],
    });
    expect(summarizeIntegrationReport(sub).finalError).toBe(
      'Unknown name "limit"',
    );
  });

  it("falls back to error.reason when message is absent (parse-failure path)", () => {
    const sub = subReport("gmail", {
      status: "failed",
      attempts: [
        record({
          attempt: 1,
          status: "failed",
          errors: [{ type: "pre-pass-parse-failed", reason: "no-json-object" }],
        }),
      ],
    });
    expect(summarizeIntegrationReport(sub).finalError).toBe("no-json-object");
  });

  it("returns undefined finalError when the failed final attempt has no errors", () => {
    // Defensive: the runner always pushes an error row on failure paths,
    // but the helper still tolerates an empty-errors final attempt by
    // reporting no message rather than throwing.
    const sub = subReport("gmail", {
      status: "failed",
      attempts: [record({ attempt: 1, status: "failed", errors: [] })],
    });
    expect(summarizeIntegrationReport(sub).finalError).toBeUndefined();
  });

  it("treats invalid timestamps as zero duration (no NaN poisoning)", () => {
    const sub = subReport("gmail", {
      status: "success",
      attempts: [
        record({
          attempt: 1,
          startedAt: "not-a-timestamp",
          endedAt: "also-not",
        }),
      ],
    });
    expect(summarizeIntegrationReport(sub).durationMs).toBe(0);
  });
});

describe("summarizeFetchReport — §7.1 / §7.2", () => {
  function fakeReport(opts: {
    status?: FetchReport["status"];
    fetched?: number;
    posted?: number;
    duplicates?: number;
    perIntegration?: SubReport[];
  } = {}): FetchReport {
    return {
      status: opts.status ?? "success",
      fetched: opts.fetched ?? 0,
      posted: opts.posted ?? 0,
      duplicates: opts.duplicates ?? 0,
      errors: [],
      skipped: false,
      perIntegration: opts.perIntegration,
    };
  }

  it("sums costUsd from every per-integration attempt", () => {
    const report = fakeReport({
      fetched: 8,
      posted: 6,
      duplicates: 2,
      perIntegration: [
        subReport("gmail", {
          attempts: [
            record({ attempt: 1, costUsd: 0.05 }),
            record({ attempt: 2, costUsd: 0.07 }),
          ],
        }),
        subReport("google_calendar", {
          attempts: [record({ attempt: 1, costUsd: 0.03 })],
        }),
      ],
    });
    const aggregate = summarizeFetchReport(report);
    expect(aggregate.fetched).toBe(8);
    expect(aggregate.posted).toBe(6);
    expect(aggregate.duplicates).toBe(2);
    expect(aggregate.costUsd).toBeCloseTo(0.15, 5);
    expect(aggregate.status).toBe("success");
  });

  it("returns zero costUsd when perIntegration is undefined (skip / failed short-circuit)", () => {
    const aggregate = summarizeFetchReport(fakeReport({ status: "skipped" }));
    expect(aggregate.costUsd).toBe(0);
    expect(aggregate.status).toBe("skipped");
  });
});
