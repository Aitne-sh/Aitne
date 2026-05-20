import { describe, expect, it } from "vitest";
import type { SubAttemptRecord } from "./routine-fetch-window-runner.js";
import {
  RETRY_REASONS,
  buildPriorAttemptHintBlock,
  cumulativeAttemptCost,
  defaultRetryDecision,
  type RetryPolicy,
} from "./routine-fetch-window-retry.js";

const BASE_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: [1000, 2000],
  perIntegrationBudgetUsd: 0.6,
};

function attempt(
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

describe("cumulativeAttemptCost", () => {
  it("sums prior + current attempt cost", () => {
    const current = attempt({ attempt: 3, costUsd: 0.1 });
    const priors = [
      attempt({ attempt: 1, costUsd: 0.07 }),
      attempt({ attempt: 2, costUsd: 0.08 }),
    ];
    expect(cumulativeAttemptCost(current, priors)).toBeCloseTo(0.25, 5);
  });

  it("returns the current cost when priorAttempts is empty", () => {
    const current = attempt({ attempt: 1, costUsd: 0.12 });
    expect(cumulativeAttemptCost(current, [])).toBeCloseTo(0.12, 5);
  });
});

describe("defaultRetryDecision — §4.4 decision matrix", () => {
  it("does not retry when status=success with no errors", () => {
    const decision = defaultRetryDecision(
      attempt({ attempt: 1, status: "success", fetched: 5, posted: 5 }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.SUCCESS);
  });

  it("does not retry when status=partial and posted>0 (some progress)", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 10,
        posted: 7,
        errors: [{ type: "fetch-failed", status: 400 }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.PARTIAL_WITH_POST);
  });

  it("RETRIES when status=partial AND posted=0 AND fetched>0 (motivating §1.1 case)", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 21,
        posted: 0,
        errors: [
          {
            type: "fetch-failed",
            status: 400,
            message: 'Unknown name "limit": Cannot find field.',
          },
        ],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe(RETRY_REASONS.PARTIAL_NO_POST);
  });

  it("RETRIES when status=failed (agent crash / parse error)", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "failed",
        parseError: "no-json-object",
        errors: [{ type: "pre-pass-parse-failed", reason: "no-json-object" }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe(RETRY_REASONS.FAILED_STATUS);
  });

  it("does not retry when status=skipped (structurally empty)", () => {
    const decision = defaultRetryDecision(
      attempt({ attempt: 1, status: "skipped" }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.SKIPPED);
  });

  it("does not retry when an error has type=flip-locked (wait for next tick)", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 5,
        posted: 0,
        errors: [{ type: "flip-locked", integration: "gmail" }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.FLIP_LOCKED);
  });

  it("does not retry when an error has type=budget-exhausted", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 5,
        posted: 0,
        errors: [{ type: "budget-exhausted" }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.BUDGET_EXHAUSTED);
  });

  it("does not retry when fetch-failed status is permission-denied (SDK Bash too-complex)", () => {
    // Motivating 2026-05-18 incident: gmail pre-pass fetched 16 messages,
    // tried `curl -X POST .../observations/batch -d '{...subject with NBSP...}'`,
    // SDK's bash parser flagged the body as `too-complex`
    // (Contains Unicode whitespace), fell through to ask-mode, dontAsk
    // denied. Retrying the same source data re-trips the same gate; the
    // pre-Phase A behaviour burned $0.16 across 3 attempts and surfaced
    // budget-cap as the visible failure.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 16,
        posted: 0,
        errors: [
          {
            type: "fetch-failed",
            integration: "gmail",
            status: "permission-denied",
            message: "Bash tool blocked by don't-ask-mode configuration.",
          },
        ],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.DETERMINISTIC_FAILURE);
  });

  it("RETRIES when fetch-failed status is validation-error (recoverable via prior-attempt-hint)", () => {
    // Per-row daemon Zod rejection. Distinct from permission-denied:
    // the agent receives `detail` in the next attempt's
    // <prior_attempt_error> block (§4.4 hint mechanism), so it can
    // correct the payload shape. Matches the §1.1 motivating case
    // ("Unknown name limit": Cannot find field) — the agent fixes
    // `limit` → `maxResults` on retry. Tagging validation-error as
    // deterministic would suppress this recovery path.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 5,
        posted: 0,
        errors: [
          {
            type: "fetch-failed",
            integration: "gmail",
            status: "validation-error",
            ref: "abc",
            detail: "payload.kind required",
          },
        ],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe(RETRY_REASONS.PARTIAL_NO_POST);
  });

  it("does NOT misclassify partial-with-progress as deterministic-failure when one item hit permission-denied", () => {
    // 9 items succeeded, 1 hit a permission-denied surface. The right
    // reason is `partial-with-progress` (rule 5, no retry), NOT
    // `deterministic-failure`. The previous draft (rule 3.5 standalone,
    // ran BEFORE the partial-with-progress branch) returned the wrong
    // reason because it checked deterministic before posted>0.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 10,
        posted: 9,
        errors: [
          { type: "fetch-failed", integration: "gmail", status: "permission-denied" },
        ],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.PARTIAL_WITH_POST);
  });

  it("does not retry when status=failed AND every error is deterministic", () => {
    // Failed-status normally triggers FAILED_STATUS retry, but if the
    // attempt died after the same Bash too-complex denial it will die the
    // same way next time. The deterministic check embedded in rule 4's
    // status=failed branch short-circuits the loop.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "failed",
        errors: [
          {
            type: "fetch-failed",
            integration: "gmail",
            status: "permission-denied",
            message: "Bash tool blocked...",
          },
        ],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.DETERMINISTIC_FAILURE);
  });

  it("RETRIES when deterministic error is paired with a 5xx (mixed report)", () => {
    // Some items failed permission-denied (won't retry-fix), but other
    // items hit a transient 503. Retry gives the 503-side a chance to
    // make progress; the deterministic items keep failing but get
    // dropped on the next attempt without consuming additional budget
    // beyond what they cost the first time.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 10,
        posted: 0,
        errors: [
          { type: "fetch-failed", status: "permission-denied" },
          { type: "fetch-failed", status: 503 },
        ],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe(RETRY_REASONS.UPSTREAM_5XX);
  });

  it("does not retry when fetch-failed status is 401 (auth issue, retry won't help)", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 0,
        posted: 0,
        errors: [{ type: "fetch-failed", status: 401, message: "Unauthorized" }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.AUTH_FAILED);
  });

  it("does not retry when fetch-failed status is 403 (auth issue)", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 0,
        posted: 0,
        errors: [{ type: "fetch-failed", status: 403 }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.AUTH_FAILED);
  });

  it("RETRIES when fetch-failed status is 5xx (transient upstream)", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const decision = defaultRetryDecision(
        attempt({
          attempt: 1,
          status: "partial",
          fetched: 0,
          posted: 0,
          errors: [{ type: "fetch-failed", status }],
        }),
        1,
        BASE_POLICY,
        [],
      );
      expect(decision.retry).toBe(true);
      expect(decision.reason).toBe(RETRY_REASONS.UPSTREAM_5XX);
    }
  });

  it("does not retry when cumulative cost is at/over the per-integration budget cap", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 2,
        status: "partial",
        fetched: 21,
        posted: 0,
        costUsd: 0.31,
        errors: [{ type: "fetch-failed", status: 400 }],
      }),
      2,
      BASE_POLICY,
      [attempt({ attempt: 1, costUsd: 0.31 })],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.BUDGET_CAP);
  });

  it("does not retry when attempt has reached policy.maxAttempts", () => {
    const decision = defaultRetryDecision(
      attempt({
        attempt: 3,
        status: "partial",
        fetched: 21,
        posted: 0,
        errors: [{ type: "fetch-failed", status: 400 }],
      }),
      3,
      BASE_POLICY,
      [
        attempt({ attempt: 1 }),
        attempt({ attempt: 2 }),
      ],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.MAX_ATTEMPTS);
  });

  it("terminal error classes take precedence over retry-worthy patterns", () => {
    // status=failed normally retries; but if there's also a 403 error,
    // auth-failed wins (auth-failed must be terminal even when other
    // signals would suggest retry).
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "failed",
        errors: [{ type: "fetch-failed", status: 403 }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.AUTH_FAILED);
  });

  it("status as string (numeric coercion of fetch-failed status from MCP transports)", () => {
    // MCP transports sometimes stringify status codes — exercising the
    // numeric-string coercion path so a 5xx coming through as "503"
    // still classifies as retry-worthy.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 0,
        posted: 0,
        errors: [{ type: "fetch-failed", status: "503" }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe(RETRY_REASONS.UPSTREAM_5XX);
  });

  it("partial with fetched=0 AND posted=0 (no progress at all) does not retry by default", () => {
    // §4.4 explicitly retries on `fetched > 0 && posted === 0`.
    // The "fetched=0, posted=0, errors present" case is not in the
    // matrix; the conservative policy is no-retry. Operators can
    // override via policy.retryOn.
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 0,
        posted: 0,
        errors: [{ type: "fetch-failed", status: 400 }],
      }),
      1,
      BASE_POLICY,
      [],
    );
    expect(decision.retry).toBe(false);
    expect(decision.reason).toBe(RETRY_REASONS.NO_PROGRESS);
  });

  // §6 / Phase 1 — `prePassRetryOnPartial` runtime knob, threaded into
  // `RetryPolicy.retryOnPartial`. When false, the partial-no-post branch
  // (rule 4) is suppressed and the motivating §1.1 outcome ("fetched > 0,
  // posted = 0") falls through to the conservative no-retry default
  // instead of consuming the per-integration retry budget on a partial
  // that the operator has explicitly classified as final.
  it("policy.retryOnPartial=false suppresses the partial-no-post retry branch", () => {
    const policy: RetryPolicy = { ...BASE_POLICY, retryOnPartial: false };
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 21,
        posted: 0,
        errors: [
          {
            type: "fetch-failed",
            status: 400,
            message: 'Unknown name "limit": Cannot find field.',
          },
        ],
      }),
      1,
      policy,
      [],
    );
    expect(decision.retry).toBe(false);
    // Falls through to (5) — the conservative fetched>0/posted=0 case has
    // no dedicated reason, so it bottoms out at NO_PROGRESS the same way
    // the fetched=0/posted=0 case does. Distinct from the default policy
    // (retryOnPartial=true) which would return retry=true / PARTIAL_NO_POST.
    expect(decision.reason).toBe(RETRY_REASONS.NO_PROGRESS);
  });

  it("policy.retryOnPartial=false leaves the 5xx upstream retry branch intact", () => {
    // The knob suppresses ONLY rule (4)'s partial-no-post; rule (4)'s 5xx
    // arm still fires so transient upstream errors don't get demoted to
    // "final" alongside the schema-class errors the knob is targeting.
    const policy: RetryPolicy = { ...BASE_POLICY, retryOnPartial: false };
    const decision = defaultRetryDecision(
      attempt({
        attempt: 1,
        status: "partial",
        fetched: 0,
        posted: 0,
        errors: [{ type: "fetch-failed", status: 503 }],
      }),
      1,
      policy,
      [],
    );
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe(RETRY_REASONS.UPSTREAM_5XX);
  });
});

describe("buildPriorAttemptHintBlock", () => {
  it("returns the empty string when attempts is empty", () => {
    expect(buildPriorAttemptHintBlock([])).toBe("");
  });

  it("renders one <prior_attempt_error> per attempt", () => {
    const block = buildPriorAttemptHintBlock([
      attempt({
        attempt: 1,
        status: "partial",
        errors: [
          {
            type: "fetch-failed",
            status: 400,
            message: 'Unknown name "limit"',
          },
        ],
      }),
    ], "google_calendar");
    const opens = block.match(/<prior_attempt_error /g) ?? [];
    expect(opens.length).toBe(1);
    expect(block).toContain('attempt="1"');
    expect(block).toContain('integration="google_calendar"');
    expect(block).toContain("<fetch_failed ");
    expect(block).toContain("<hint>");
  });

  it("orders newest-first when multiple priors are supplied", () => {
    const block = buildPriorAttemptHintBlock(
      [
        attempt({ attempt: 1, errors: [{ type: "fetch-failed", status: 400, marker: "first" }] }),
        attempt({ attempt: 2, errors: [{ type: "fetch-failed", status: 400, marker: "second" }] }),
        attempt({ attempt: 3, errors: [{ type: "fetch-failed", status: 400, marker: "third" }] }),
      ],
      "google_calendar",
    );
    const firstIdx = block.indexOf('marker="first"');
    const secondIdx = block.indexOf('marker="second"');
    const thirdIdx = block.indexOf('marker="third"');
    // Newest first: third < second < first.
    expect(thirdIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(thirdIdx);
    expect(firstIdx).toBeGreaterThan(secondIdx);
    const opens = block.match(/<prior_attempt_error /g) ?? [];
    expect(opens.length).toBe(3);
  });

  it("XML-escapes error attributes (quotes, ampersands, angle brackets)", () => {
    const block = buildPriorAttemptHintBlock(
      [
        attempt({
          attempt: 1,
          errors: [
            {
              type: "fetch-failed",
              status: 400,
              message: 'Unknown name "limit" & <bad>',
            },
          ],
        }),
      ],
      "google_calendar",
    );
    // The literal " must not break the attribute delimiter.
    expect(block).toContain("&quot;");
    expect(block).toContain("&amp;");
    expect(block).toContain("&lt;");
    expect(block).toContain("&gt;");
    expect(block).not.toMatch(/message="Unknown name "limit"/);
  });

  it("omits the integration attribute when integrationKey is not supplied", () => {
    const block = buildPriorAttemptHintBlock([
      attempt({ attempt: 1, errors: [{ type: "fetch-failed", status: 400 }] }),
    ]);
    expect(block).toContain("<prior_attempt_error ");
    expect(block).toContain('attempt="1"');
    expect(block).not.toContain("integration=");
  });

  it("falls back to <parse_failed> when errors is empty but parseError is set", () => {
    const block = buildPriorAttemptHintBlock(
      [
        attempt({
          attempt: 1,
          status: "failed",
          errors: [],
          parseError: "no-json-object",
        }),
      ],
      "gmail",
    );
    expect(block).toContain("<parse_failed ");
    expect(block).toContain('reason="no-json-object"');
  });

  it("falls back to <failed> when neither errors nor parseError is present", () => {
    const block = buildPriorAttemptHintBlock(
      [attempt({ attempt: 1, status: "failed", errors: [] })],
      "gmail",
    );
    expect(block).toContain("<failed ");
    expect(block).toContain('status="failed"');
  });

  it("always carries the generic MVP hint prose pointing back at the partial", () => {
    const block = buildPriorAttemptHintBlock(
      [attempt({ attempt: 1, errors: [{ type: "fetch-failed", status: 400 }] })],
      "gmail",
    );
    expect(block).toContain("partial is the source of truth");
  });

  it("renders <unknown /> when err.type is not a string (defensive fallback)", () => {
    // Covers the false branch of `typeof err.type === 'string' ? err.type : 'unknown'`.
    // A malformed error row from a non-conforming integration that surfaces
    // up the retry path should not break the prompt.
    const block = buildPriorAttemptHintBlock(
      [
        attempt({
          attempt: 1,
          // `errors` is typed as Record<string, unknown> rows, so a missing
          // type is structurally valid — the renderer normalizes it.
          errors: [{ type: 42 as unknown as string, status: 500 }],
        }),
      ],
      "gmail",
    );
    expect(block).toContain("<unknown ");
  });

  it("renders a self-closing tag with no attrs when err has only a type", () => {
    // Covers the false branch of `attrs ? ' ' + attrs : ''` — when the
    // error row has no string/number attributes other than `type`, the
    // rendered tag must close cleanly without a trailing space.
    const block = buildPriorAttemptHintBlock(
      [attempt({ attempt: 1, errors: [{ type: "fetch-failed" }] })],
      "gmail",
    );
    // `<fetch_failed />` — no extra space between tag name and the closing ` />`.
    expect(block).toContain("<fetch_failed />");
    // No double-spaced separator (`<fetch_failed  />`) and no stray attr-like
    // residue (a wrong false-branch would leave ` ` from " " + "").
    expect(block).not.toMatch(/<fetch_failed\s\s+\/>/);
  });
});
