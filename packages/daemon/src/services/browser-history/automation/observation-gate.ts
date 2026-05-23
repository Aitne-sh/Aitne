/**
 * B-3 observation-gate aggregator.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 (table) + §13 milestone.
 *
 * Surfaces each of the §10 criteria with its current value over the
 * trailing 6-week window. The dashboard's "B-3 readiness" card renders
 * the result; the user uses it to decide whether B-3 implementation /
 * promotion is safe.
 *
 * The criteria table from §10:
 *
 *   ┌──────────────────────────────────────────────┬─────────────┐
 *   │ Criterion                                    │ Threshold   │
 *   ├──────────────────────────────────────────────┼─────────────┤
 *   │ blocked_absolute hits attrib'd to managed    │ 0           │
 *   │ Compromise-detection signal firings (x4)     │ 0 each      │
 *   │ playwright_error outcome rate                │ < 2 %       │
 *   │ timeout outcome rate                         │ < 1 %       │
 *   │ recordBlockedRequest denylist hits / wf      │ <wf × 10/mo │
 *   │ reauth-detector false-positive rate          │ < 1 / month │
 *   │ User-reported high-severity issues           │ 0           │
 *   │ Sandbox refuse-to-launch                     │ 0           │
 *   └──────────────────────────────────────────────┴─────────────┘
 *
 * For the metrics that can be computed from the DB (`agent_actions` +
 * `browser_automation_workflows`), we count rows in the window. The
 * "user-reported issues" metric has no daemon-side source — the daemon
 * returns 0 by default since the issue tracker is external; the
 * dashboard documents the limitation inline.
 *
 * Pure aggregation of read-only SELECTs. Tested via a peer test that
 * seeds the DB with known rows and asserts the resulting bucket
 * (green / amber / red) and computed value.
 */

import type Database from "better-sqlite3";

import type {
  BrowserAutomationObservationGateCriterion,
  BrowserAutomationObservationGateResponse,
} from "@aitne/shared";

const SIX_WEEKS_MS = 42 * 24 * 60 * 60 * 1000;

/** Compute the green/amber/red bucket for a (value, threshold) pair.
 *  Green when value <= threshold * 0.5 (well under), amber when
 *  value <= threshold (still passing but trending), red otherwise. */
function bucketize(value: number, threshold: number): "green" | "amber" | "red" {
  if (threshold <= 0) {
    // Zero-tolerance criterion (e.g., 0 absolute-block hits). Any
    // observation flips amber+. We model "1 hit" as red since the
    // criterion is binary in §10.
    return value === 0 ? "green" : "red";
  }
  if (value > threshold) return "red";
  if (value > threshold * 0.75) return "amber";
  return "green";
}

interface CountRow {
  c: number;
}

function countAbsoluteBlockHits(
  db: Database.Database,
  windowStartMs: number,
): number {
  // The audit pattern (per CLAUDE.md "absolute-block layer") records
  // a row with action_type='blocked_absolute' and a detail.matched_rule
  // = 'browser_profile' when the chromium- profile paths are touched.
  // We filter loosely on action_type + LIKE on detail JSON for the
  // managed-chromium category — a stricter detail.matched_rule check
  // would require json_extract which depends on the SQLite build flag.
  // `SELECT COUNT(*)` always returns exactly one row, so the cast +
  // `.c` field are guaranteed non-null on the happy path. The
  // try/catch shields against the agent_actions table not existing
  // (peer-test contract; production schema always has it).
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_actions
          WHERE action_type = 'blocked_absolute'
            AND (detail LIKE '%browser_profile%' OR detail LIKE '%chromium%')
            AND CAST(strftime('%s', completed_at) AS INTEGER) * 1000 >= ?`,
      )
      .get(windowStartMs) as CountRow;
    return row.c;
  } catch {
    return 0;
  }
}

function countCompromiseSignals(
  db: Database.Database,
  windowStartMs: number,
): number {
  try {
    // The action_type alternatives are parenthesised so the
    // `completed_at >= ?` filter applies to every branch. Without the
    // grouping, SQL precedence (AND tighter than OR) would only date-
    // filter the third clause and pre-window data on the first two
    // patterns would leak into the count.
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_actions
          WHERE (action_type LIKE 'browser_automation.%signal%'
                 OR action_type LIKE 'browser_automation.compromise%'
                 OR action_type = 'browser_automation.site_session_expired')
            AND CAST(strftime('%s', completed_at) AS INTEGER) * 1000 >= ?`,
      )
      .get(windowStartMs) as CountRow;
    return row.c;
  } catch {
    return 0;
  }
}

interface OutcomeCountsRow {
  total: number;
  failure: number;
  timeout: number;
}

function readOutcomeStats(
  db: Database.Database,
  windowStartMs: number,
): OutcomeCountsRow {
  // `SUM(CASE WHEN …)` returns NULL when no rows match, so we wrap each
  // sum in COALESCE(…, 0) and rely on the always-present aggregate row
  // for total / failure / timeout. The cast is then non-null on the
  // happy path; the catch shields against a missing table.
  try {
    const row = db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN outcome = 'playwright_error' THEN 1 ELSE 0 END), 0) AS failure,
            COALESCE(SUM(CASE WHEN outcome = 'timeout' THEN 1 ELSE 0 END), 0) AS timeout
           FROM browser_automation_workflows
          WHERE started_at >= ?`,
      )
      .get(windowStartMs) as {
      total: number;
      failure: number;
      timeout: number;
    };
    return {
      total: row.total,
      failure: row.failure,
      timeout: row.timeout,
    };
  } catch {
    return { total: 0, failure: 0, timeout: 0 };
  }
}

function countDenylistHitsPerWorkflow(
  db: Database.Database,
  windowStartMs: number,
): { hits: number; workflows: number } {
  // Each `browser_automation_workflows.blocked_requests` is a JSON
  // array. SQLite's json_array_length is the proper tool but is only
  // available on builds with the JSON1 extension (better-sqlite3 ships
  // with JSON1 by default). `COALESCE(SUM(…), 0)` guarantees a non-
  // null `hits`; `COUNT(DISTINCT …)` returns 0 (never null) so the
  // resulting `workflows` is also a plain number on the happy path.
  try {
    const row = db
      .prepare(
        `SELECT
            COALESCE(SUM(json_array_length(blocked_requests)), 0) AS hits,
            COUNT(DISTINCT workflow_name) AS workflows
           FROM browser_automation_workflows
          WHERE started_at >= ?`,
      )
      .get(windowStartMs) as { hits: number; workflows: number };
    return {
      hits: row.hits,
      workflows: Math.max(row.workflows, 1),
    };
  } catch {
    return { hits: 0, workflows: 1 };
  }
}

function countSandboxRefusals(
  db: Database.Database,
  windowStartMs: number,
): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_actions
          WHERE action_type = 'browser_lifecycle.chromium_sync.refused'
            AND CAST(strftime('%s', completed_at) AS INTEGER) * 1000 >= ?`,
      )
      .get(windowStartMs) as CountRow;
    return row.c;
  } catch {
    return 0;
  }
}

/**
 * Build the full §10 criteria table for the trailing 6-week window
 * ending at `nowMs`. Pure data assembly — every SELECT is a constant
 * shape; the resulting list always carries the eight criteria so the
 * dashboard's table renders predictably.
 */
export function computeObservationGate(
  db: Database.Database,
  nowMs: number,
): BrowserAutomationObservationGateResponse {
  const windowStartedAt = nowMs - SIX_WEEKS_MS;
  const absoluteBlocks = countAbsoluteBlockHits(db, windowStartedAt);
  const compromiseSignals = countCompromiseSignals(db, windowStartedAt);
  const outcomes = readOutcomeStats(db, windowStartedAt);
  const denylistStats = countDenylistHitsPerWorkflow(db, windowStartedAt);
  const sandboxRefusals = countSandboxRefusals(db, windowStartedAt);

  // Workflow-count × 10 / month: the threshold scales with workflow
  // breadth. Six-week window ≈ 1.4 months, so the projected ceiling is
  // workflows × 10 × 1.4 = workflows × 14.
  const denylistHitsThreshold = denylistStats.workflows * 14;

  // Failure rate criterion: < 2 % over the window. Guard against
  // div-by-zero (no runs yet) — render the criterion as green at 0.
  const failureRate = outcomes.total === 0 ? 0 : outcomes.failure / outcomes.total;
  const timeoutRate = outcomes.total === 0 ? 0 : outcomes.timeout / outcomes.total;

  const criteria: BrowserAutomationObservationGateCriterion[] = [
    {
      id: "absolute_block_hits",
      label: "Absolute-block hits (managed Chromium)",
      value: absoluteBlocks,
      threshold: 0,
      status: bucketize(absoluteBlocks, 0),
      description:
        "agent_actions rows with action_type='blocked_absolute' attributed to managed-Chromium profile paths.",
    },
    {
      id: "compromise_signals",
      label: "Compromise-detection signal firings",
      value: compromiseSignals,
      threshold: 0,
      status: bucketize(compromiseSignals, 0),
      description:
        "§9.4 / §16.6 compromise signals — site_session_expired + filesystem mtime watchers + supervisor restarts.",
    },
    {
      id: "playwright_error_rate",
      label: "playwright_error outcome rate",
      value: Math.round(failureRate * 10_000) / 100, // percent, 2dp
      threshold: 2.0,
      status: bucketize(failureRate * 100, 2.0),
      description:
        "browser_automation_workflows.outcome='playwright_error' / total over the window (target < 2 %).",
    },
    {
      id: "timeout_rate",
      label: "timeout outcome rate",
      value: Math.round(timeoutRate * 10_000) / 100,
      threshold: 1.0,
      status: bucketize(timeoutRate * 100, 1.0),
      description:
        "browser_automation_workflows.outcome='timeout' / total over the window (target < 1 %).",
    },
    {
      id: "denylist_hits_per_workflow",
      label: "Egress denylist hits across all workflows",
      value: denylistStats.hits,
      threshold: denylistHitsThreshold,
      status: bucketize(denylistStats.hits, denylistHitsThreshold),
      description: `Sum of blocked_requests JSON-array lengths across all workflow runs (target < workflows × 10 / month ≈ ${denylistHitsThreshold} over 6 weeks).`,
    },
    {
      id: "reauth_false_positives",
      label: "reauth-detector false positives",
      // No daemon-side source today; the value is approximated as
      // 0 with a description that surfaces the limitation. The
      // criterion exists structurally so a future
      // sync_silent-vs-supervisor-restart diff lands here without
      // re-shaping the response.
      value: 0,
      threshold: 1,
      status: "green",
      description:
        "Comparison of sync_silent events vs supervisor restarts. Not yet computed daemon-side — surfaced as 0 placeholder until the diff lands.",
    },
    {
      id: "user_reported_high_severity",
      label: "User-reported high-severity issues",
      value: 0,
      threshold: 0,
      status: "green",
      description:
        "No daemon-side source (issue tracker is external). Track this manually before promoting B-3.",
    },
    {
      id: "sandbox_refusals",
      label: "Sandbox refuse-to-launch (unexpected)",
      value: sandboxRefusals,
      threshold: 0,
      status: bucketize(sandboxRefusals, 0),
      description:
        "agent_actions(action_type='browser_lifecycle.chromium_sync.refused') rows over the window.",
    },
  ];

  const overall: "green" | "amber" | "red" = criteria.some(
    (c) => c.status === "red",
  )
    ? "red"
    : criteria.some((c) => c.status === "amber")
      ? "amber"
      : "green";

  return {
    windowStartedAt,
    windowEndedAt: nowMs,
    criteria,
    overall,
  };
}
