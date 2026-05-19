import type { Hono } from "hono";
import { getAgentDayBoundsUtc, getAgentDaySqlShiftModifier } from "@aitne/shared";
import type { ApiDependencies } from "../../server.js";

/**
 * Pre-defined static cost queries — no string interpolation of user input.
 * `byModel` is computed in JS via `aggregateByBilledModel` because the SDK
 * can route a request for one model to a sibling (e.g. opus-4-7 →
 * opus-4-6[1m]); SQL `GROUP BY model_used` would lump cost under the
 * requested model and produce a chart that disagrees with the per-row
 * billed-model badge on the same page.
 *
 * `byPeriod` buckets by *agent day* via `date(started_at, ?)` where `?` is
 * the timezone+dayBoundary shift modifier. Without the shift, a single
 * agent day (e.g. 04:00 JST → 04:00 JST next day) gets split across two
 * UTC calendar dates so the chart shows two half-height bars summing to
 * the same Today-card total — the bug reported in the original screenshot
 * where Today=$6.30 rendered as two flat ~$3.15 buckets.
 */
const COST_QUERIES = {
  daily: {
    byPeriod: `SELECT date(started_at, ?) as period,
            SUM(cost_usd) as total_cost, COUNT(*) as session_count,
            SUM(tokens_input) as total_input_tokens, SUM(tokens_output) as total_output_tokens
     FROM agent_actions WHERE started_at > datetime('now', '-30 days') AND cost_usd IS NOT NULL
     GROUP BY date(started_at, ?) ORDER BY period DESC`,
    byModelRows: `SELECT model_used, model_usage_json, cost_usd
     FROM agent_actions
     WHERE started_at > datetime('now', '-30 days')
       AND cost_usd IS NOT NULL
       AND (model_used IS NOT NULL OR model_usage_json IS NOT NULL)`,
    byEventType: `SELECT action_type as event_type, SUM(cost_usd) as total_cost, COUNT(*) as session_count
     FROM agent_actions WHERE started_at > datetime('now', '-30 days') AND cost_usd IS NOT NULL
     GROUP BY action_type ORDER BY total_cost DESC`,
  },
  weekly: {
    byPeriod: `SELECT strftime('%Y-W%W', started_at, ?) as period,
            SUM(cost_usd) as total_cost, COUNT(*) as session_count,
            SUM(tokens_input) as total_input_tokens, SUM(tokens_output) as total_output_tokens
     FROM agent_actions WHERE started_at > datetime('now', '-90 days') AND cost_usd IS NOT NULL
     GROUP BY strftime('%Y-W%W', started_at, ?) ORDER BY period DESC`,
    byModelRows: `SELECT model_used, model_usage_json, cost_usd
     FROM agent_actions
     WHERE started_at > datetime('now', '-90 days')
       AND cost_usd IS NOT NULL
       AND (model_used IS NOT NULL OR model_usage_json IS NOT NULL)`,
    byEventType: `SELECT action_type as event_type, SUM(cost_usd) as total_cost, COUNT(*) as session_count
     FROM agent_actions WHERE started_at > datetime('now', '-90 days') AND cost_usd IS NOT NULL
     GROUP BY action_type ORDER BY total_cost DESC`,
  },
  monthly: {
    byPeriod: `SELECT strftime('%Y-%m', started_at, ?) as period,
            SUM(cost_usd) as total_cost, COUNT(*) as session_count,
            SUM(tokens_input) as total_input_tokens, SUM(tokens_output) as total_output_tokens
     FROM agent_actions WHERE started_at > datetime('now', '-365 days') AND cost_usd IS NOT NULL
     GROUP BY strftime('%Y-%m', started_at, ?) ORDER BY period DESC`,
    byModelRows: `SELECT model_used, model_usage_json, cost_usd
     FROM agent_actions
     WHERE started_at > datetime('now', '-365 days')
       AND cost_usd IS NOT NULL
       AND (model_used IS NOT NULL OR model_usage_json IS NOT NULL)`,
    byEventType: `SELECT action_type as event_type, SUM(cost_usd) as total_cost, COUNT(*) as session_count
     FROM agent_actions WHERE started_at > datetime('now', '-365 days') AND cost_usd IS NOT NULL
     GROUP BY action_type ORDER BY total_cost DESC`,
  },
} as const;

/**
 * Aggregate raw `byModelRows` into the `{ model, total_cost, session_count }`
 * shape the dashboard expects, attributing cost to the actually-billed model
 * from `model_usage_json` rather than the requested `model_used`. When a row
 * has no usage breakdown we fall back to `model_used`. A row that touches
 * multiple billed models contributes its split cost to each bucket and is
 * counted once toward each model's `session_count`.
 *
 * Cost reconciliation: the SDK's `r.modelUsage[*].costUSD` covers LLM
 * inference only — server-side tools (web_search, code_execution) appear in
 * `r.total_cost_usd` (= row.cost_usd) but not in any per-model entry. If
 * `Σ per-model cost < row.cost_usd`, the residual is credited to
 * `model_used` (the requested model) so per-model totals add up to the
 * dashboard's overall cost. Without this, a chart row's "billed total"
 * silently drops tool-use spend.
 */
export function aggregateByBilledModel(
  rows: ReadonlyArray<{
    model_used: string | null;
    model_usage_json: string | null;
    cost_usd: number;
  }>,
): Array<{ model: string; total_cost: number; session_count: number }> {
  const map = new Map<string, { total_cost: number; session_count: number }>();

  // Per-row scratch; a single row counts toward `session_count` exactly once
  // per model it touched, even when residual handling credits the same model
  // twice (once from per-model breakdown, once from tool-use residual).
  const addCost = (model: string, cost: number) => {
    const bucket = map.get(model) ?? { total_cost: 0, session_count: 0 };
    bucket.total_cost += cost;
    map.set(model, bucket);
  };
  const incSession = (rowSeen: Set<string>, model: string) => {
    if (rowSeen.has(model)) return;
    rowSeen.add(model);
    const bucket = map.get(model) ?? { total_cost: 0, session_count: 0 };
    bucket.session_count += 1;
    map.set(model, bucket);
  };

  // 0.0001¢ — below this, treat the residual as float-arithmetic noise and
  // skip the bookkeeping. Real tool-use costs are always orders of magnitude
  // above this.
  const RESIDUAL_EPSILON_USD = 0.000001;

  for (const row of rows) {
    const seenForRow = new Set<string>();

    let parsed: unknown = null;
    if (row.model_usage_json) {
      try {
        parsed = JSON.parse(row.model_usage_json);
      } catch {
        parsed = null;
      }
    }

    let perModelTotal = 0;
    let touchedAny = false;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [modelId, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const v = entry as Record<string, unknown>;
        const cost = typeof v.costUsd === "number" ? v.costUsd : 0;
        addCost(modelId, cost);
        incSession(seenForRow, modelId);
        perModelTotal += cost;
        touchedAny = true;
      }
    }

    if (!touchedAny) {
      if (row.model_used) {
        addCost(row.model_used, row.cost_usd);
        incSession(seenForRow, row.model_used);
      }
      continue;
    }

    // Residual handles server-side tool cost (web_search, code execution)
    // that the SDK adds to total_cost_usd but not to any per-model bucket.
    const residual = row.cost_usd - perModelTotal;
    if (residual > RESIDUAL_EPSILON_USD && row.model_used) {
      addCost(row.model_used, residual);
      incSession(seenForRow, row.model_used);
    }
  }

  return [...map.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.total_cost - a.total_cost);
}

// `bucketExpr` takes a single shift-modifier parameter (e.g. "+300 minutes")
// so each query binds it explicitly — see COST_QUERIES for the rationale.
const COST_PERIOD_SPECS = {
  daily: {
    bucketExpr: "date(started_at, ?)",
    sinceExpr: "-30 days",
  },
  weekly: {
    bucketExpr: "strftime('%Y-W%W', started_at, ?)",
    sinceExpr: "-90 days",
  },
  monthly: {
    bucketExpr: "strftime('%Y-%m', started_at, ?)",
    sinceExpr: "-365 days",
  },
} as const;

export function registerCostApprovalsRoutes(app: Hono, deps: ApiDependencies): void {
  const { db, config } = deps;
  const agentActionColumns = new Set(
    (db.pragma("table_info(agent_actions)") as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  const backendExpr = agentActionColumns.has("backend")
    ? "COALESCE(backend, 'claude')"
    : "'claude'";

  // ── Cost API ──

  /** GET /cost — cost analytics */
  app.get("/cost", (c) => {
    const period = c.req.query("period") ?? "daily"; // daily, weekly, monthly
    const periodKey = period in COST_QUERIES
      ? (period as keyof typeof COST_QUERIES)
      : "daily";
    const queries = COST_QUERIES[periodKey];
    const spec = COST_PERIOD_SPECS[periodKey];

    const shift = getAgentDaySqlShiftModifier(config.timezone, config.dayBoundaryHour);
    const byPeriod = db.prepare(queries.byPeriod).all(shift, shift);
    const byModelRaw = db.prepare(queries.byModelRows).all() as Array<{
      model_used: string | null;
      model_usage_json: string | null;
      cost_usd: number;
    }>;
    const byModel = aggregateByBilledModel(byModelRaw);
    const byEventType = db.prepare(queries.byEventType).all();
    const byBackend = db
      .prepare(
        `SELECT ${backendExpr} as backend,
                SUM(cost_usd) as total_cost,
                COUNT(*) as session_count
           FROM agent_actions
          WHERE started_at > datetime('now', ?)
            AND cost_usd IS NOT NULL
          GROUP BY 1
          ORDER BY total_cost DESC`,
      )
      .all(spec.sinceExpr);
    const byBackendPeriod = db
      .prepare(
        `SELECT ${spec.bucketExpr} as period,
                ${backendExpr} as backend,
                SUM(cost_usd) as total_cost,
                COUNT(*) as session_count
           FROM agent_actions
          WHERE started_at > datetime('now', ?)
            AND cost_usd IS NOT NULL
          GROUP BY 1, 2
          ORDER BY period DESC, backend ASC`,
      )
      .all(shift, spec.sinceExpr);

    // Today's total (timezone-aware agent day, executed sessions only).
    // datetime(started_at) normalizes mixed ISO-8601 / SQL formats — same
    // rationale as the /events ORDER BY fix above.
    const bounds = getAgentDayBoundsUtc(config.timezone, config.dayBoundaryHour);
    const today = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as cost,
                COUNT(*) as sessions
         FROM agent_actions
         WHERE datetime(started_at) >= ? AND datetime(started_at) < ?
           AND cost_usd IS NOT NULL`,
      )
      .get(bounds.start, bounds.end) as { cost: number; sessions: number };

    return c.json({
      period,
      today: { costUsd: today.cost, sessions: today.sessions },
      byPeriod,
      byModel,
      byEventType,
      byBackend,
      byBackendPeriod,
    });
  });

  // ── Approvals API ──

  /** GET /approvals — list pending approval requests */
  app.get("/approvals", (c) => {
    const rows = db
      .prepare(
        `SELECT id, scheduled_for, task_type, task_description,
                task_context, model, status, created_at
         FROM agent_schedule
         WHERE status = 'pending' AND task_type = 'approval'
         ORDER BY created_at DESC`,
      )
      .all();

    return c.json({ approvals: rows });
  });

  /** POST /approvals/:id/approve — approve a pending request */
  app.post("/approvals/:id/approve", (c) => {
    const id = Number(c.req.param("id"));

    const result = db
      .prepare(
        "UPDATE agent_schedule SET status = 'pending', task_type = 'approved_task' WHERE id = ? AND status = 'pending' AND task_type = 'approval'",
      )
      .run(id);

    if (result.changes === 0) {
      return c.json({ error: "approval not found or already processed" }, 404);
    }

    return c.json({ status: "approved", id });
  });

  /** POST /approvals/:id/deny — deny a pending request */
  app.post("/approvals/:id/deny", (c) => {
    const id = Number(c.req.param("id"));

    const result = db
      .prepare(
        "UPDATE agent_schedule SET status = 'skipped' WHERE id = ? AND status = 'pending' AND task_type = 'approval'",
      )
      .run(id);

    if (result.changes === 0) {
      return c.json({ error: "approval not found or already processed" }, 404);
    }

    return c.json({ status: "denied", id });
  });
}
