/**
 * /api/browser-automation/* — Phase B-2 workflow execution surface.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.10.
 *
 * Routes:
 *   GET    /workflows              — list registered workflows (autonomous)
 *   POST   /workflows/:name        — run a workflow with `{params}` (approve at route, deny-on-unknown at runner)
 *   GET    /traces/:wfid/:file     — serve a screenshot / trace asset
 *   GET    /allowlist              — list per-domain user allowlist
 *   POST   /allowlist              — add (approve)
 *   DELETE /allowlist/:domain      — remove (approve)
 *   GET    /recent-runs            — paged audit (approve, dashboard-only)
 *
 * Risk tiers enforced in `risk-classifier.ts`; this module performs
 * input validation, calls the runner, and renders the response. The
 * runtime workflow-execution layer (Playwright) is excluded from
 * coverage — this thin handler matches the dashboard/* rationale and
 * is excluded too.
 */

import { readFile } from "node:fs/promises";

import {
  browserAutomationAllowlistAddRequestSchema,
  browserAutomationAllowlistResponseSchema,
  browserAutomationApprovalDenyRequestSchema,
  browserAutomationApprovalDenyResponseSchema,
  browserAutomationApprovalIssueResponseSchema,
  browserAutomationApprovalsListResponseSchema,
  browserAutomationObservationGateResponseSchema,
  browserAutomationRecentRunsResponseSchema,
  browserAutomationRunRequestSchema,
  browserAutomationRunResponseSchema,
  browserAutomationWorkflowListResponseSchema,
  type BrowserAutomationApprovalRow,
} from "@aitne/shared";
import { Hono } from "hono";

import {
  approveApproval,
  denyApproval,
  getApprovalById,
  listPendingApprovals,
  listRecentApprovals,
  type ApprovalRow,
} from "../../db/browser-automation-approvals-store.js";
import {
  listAllowlistEntries,
  listRecentWorkflowRuns,
  removeAllowlistEntry,
  upsertAllowlistEntry,
} from "../../db/browser-automation-store.js";
import { readManagedChromiumState } from "../../db/managed-chromium-state.js";
import { createLogger } from "../../logging.js";
import {
  computeApprovalExpiry,
  hashApprovalToken,
  mintApprovalToken,
} from "../../services/browser-history/automation/approval-tokens.js";
import { computeObservationGate } from "../../services/browser-history/automation/observation-gate.js";
import { resolveTraceFilePath } from "../../services/browser-history/automation/trace-store-paths.js";
import { runWorkflow } from "../../services/browser-history/automation/workflow-runner.js";
import { listWorkflows } from "../../services/browser-history/automation/workflows/registry.js";
import { createHostProfile } from "../../services/browser-history/lifecycle/platform.js";
import type { RiskTier } from "../../safety/risk-classifier.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("browser-automation-routes");

/** Project an internal `ApprovalRow` (DB shape) onto the
 *  dashboard-facing `BrowserAutomationApprovalRow`. The token hash is
 *  intentionally NOT in the wire shape — only the metadata + status. */
function toApprovalWire(row: ApprovalRow): BrowserAutomationApprovalRow {
  return {
    id: row.id,
    workflowName: row.workflowName,
    paramsHash: row.paramsHash,
    paramsSummary: row.paramsSummary,
    status: row.status,
    origin: row.origin,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    approvedAt: row.approvedAt,
    consumedAt: row.consumedAt,
    deniedAt: row.deniedAt,
    denialReason: row.denialReason,
  };
}

function riskTierToWire(tier: RiskTier): "autonomous" | "read_sensitive" | "approve" {
  switch (tier) {
    case ("autonomous" as RiskTier):
      return "autonomous";
    case ("read_sensitive" as RiskTier):
      return "read_sensitive";
    case ("approve" as RiskTier):
      return "approve";
    default:
      // Defensive — every entry in RiskTier maps to one of the three.
      return "approve";
  }
}

export function createBrowserAutomationRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const host = createHostProfile();
  const paDataDir = deps.config.dataDir;

  // ── GET /workflows ──
  app.get("/browser-automation/workflows", (c) => {
    const managed = readManagedChromiumState(deps.db);
    const summaries = listWorkflows().map((def) => ({
      name: def.name,
      riskTier: riskTierToWire(def.riskTier),
      allowlistRegex: def.allowlistRegex.source,
      variant: def.variant,
      ...(def.siteKey ? { siteKey: def.siteKey } : {}),
      perWorkflowTimeoutMs: def.perWorkflowTimeoutMs,
    }));
    const payload = browserAutomationWorkflowListResponseSchema.parse({
      workflows: summaries,
      automationEnabled: managed.enabled && managed.state === "ready",
    });
    return c.json(payload);
  });

  // ── POST /workflows/:name ──
  app.post("/browser-automation/workflows/:name", async (c) => {
    const managed = readManagedChromiumState(deps.db);
    if (!managed.enabled || managed.state !== "ready") {
      return c.json(
        { error: "automation_disabled", state: managed.state },
        409,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = browserAutomationRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", issues: parsed.error.issues },
        400,
      );
    }
    const name = c.req.param("name");
    // Phase B-4: the dispatcher injects an `x-pa-channel-ref` header
    // (e.g. `slack:C123`) when this workflow run originates from a DM
    // session. The purchase handler uses the ref to single-channel
    // DM the confirmation request when the originating channel is in
    // the primary set; absent → token fans out to every primary
    // channel (scheduled flow). The header is purely informational —
    // an agent forging it gains nothing because the destination list
    // is still constrained to the primary-channel set.
    const originatingChannel = c.req.header("x-pa-channel-ref") ?? null;
    const envelope = await runWorkflow({
      db: deps.db,
      host,
      paDataDir,
      workflowName: name,
      params: parsed.data.params,
      approvalToken: parsed.data.approvalToken,
      // Origin defaults to "agent" — every HTTP request through this
      // route is at the agent's behest (the dashboard's "Run workflow"
      // button also fires this endpoint, but per §10 the approval gate
      // treats both as the same surface for accounting).
      approvalOrigin: "agent",
      purchaseHandler: deps.purchaseHandler,
      originatingChannel,
    });
    const status = envelope.result.status;
    const payload = browserAutomationRunResponseSchema.parse({
      status,
      workflowId: envelope.workflowId,
      ...("output" in envelope.result
        ? { output: envelope.result.output }
        : {}),
      ...("validationErrors" in envelope.result
        ? { validationErrors: envelope.result.validationErrors }
        : {}),
      ...("detail" in envelope.result
        ? { detail: envelope.result.detail }
        : {}),
    });
    const httpStatus =
      status === "success"
        ? 200
        : status === "unknown_workflow"
          ? 404
          : status === "input_validation_error" ||
              status === "url_not_allowlisted" ||
              status === "approval_token_invalid" ||
              status === "approval_expired"
            ? 400
            : status === "user_allowlist_blocked" ||
                status === "site_not_connected" ||
                status === "payment_path_blocked"
              ? 403
              : status === "needs_approval"
                ? 202
                : status === "rate_limited"
                  ? 429
                  : 500;
    return c.json(payload, httpStatus);
  });

  // ── GET /traces/:wfid/:file ──
  app.get("/browser-automation/traces/:wfid/:file", async (c) => {
    const wfid = c.req.param("wfid");
    const fileName = c.req.param("file");
    const resolved = resolveTraceFilePath(paDataDir, wfid, fileName);
    if (!resolved) {
      return c.json({ error: "invalid_trace_path" }, 400);
    }
    let buf: Buffer;
    try {
      buf = await readFile(resolved);
    } catch (err) {
      logger.warn({ err, wfid, fileName }, "trace asset read failed");
      return c.json({ error: "trace_not_found" }, 404);
    }
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    const contentType =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : ext === "zip"
              ? "application/zip"
              : ext === "json"
                ? "application/json"
                : "application/octet-stream";
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=60",
      },
    });
  });

  // ── GET /allowlist ──
  app.get("/browser-automation/allowlist", (c) => {
    const entries = listAllowlistEntries(deps.db);
    return c.json(
      browserAutomationAllowlistResponseSchema.parse({ entries }),
    );
  });

  // ── POST /allowlist ──
  app.post("/browser-automation/allowlist", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = browserAutomationAllowlistAddRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", issues: parsed.error.issues },
        400,
      );
    }
    upsertAllowlistEntry(deps.db, {
      domain: parsed.data.domain,
      mode: parsed.data.mode,
      addedAt: Date.now(),
      addedBy: "user",
    });
    return c.json({ ok: true }, 201);
  });

  // ── DELETE /allowlist/:domain ──
  app.delete("/browser-automation/allowlist/:domain", (c) => {
    const domain = c.req.param("domain");
    const deleted = removeAllowlistEntry(deps.db, domain);
    if (deleted === 0) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ok: true });
  });

  // ── GET /approvals — Phase B-3 ──
  // Returns the dashboard's pending + recent approvals projection.
  // The pending list is the queue the user triages; the recent list
  // is the audit trail of approved / consumed / denied / expired rows.
  // Raw tokens (and even token hashes) are NEVER returned here.
  app.get("/browser-automation/approvals", (c) => {
    const now = Date.now();
    const pending = listPendingApprovals(deps.db, now).map(toApprovalWire);
    const recent = listRecentApprovals(deps.db).map(toApprovalWire);
    return c.json(
      browserAutomationApprovalsListResponseSchema.parse({ pending, recent }),
    );
  });

  // ── POST /approvals/:id/approve — Phase B-3 ──
  // Dashboard-only path (route-level Approve tier). Mints a fresh
  // 32-hex-char token, persists the SHA-256 hash on the row, flips
  // status pending→approved, and returns the raw token in the
  // response body. This is the ONLY time the raw token is observable
  // — the user copies it once and pastes into the agent prompt.
  app.post("/browser-automation/approvals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const now = Date.now();
    const existing = getApprovalById(deps.db, id);
    if (!existing) return c.json({ error: "approval_not_found" }, 404);
    if (existing.status !== "pending") {
      return c.json(
        { error: "approval_not_pending", status: existing.status },
        409,
      );
    }
    if (existing.expiresAt <= now) {
      return c.json({ error: "approval_expired" }, 410);
    }
    const token = mintApprovalToken();
    const tokenHash = hashApprovalToken(token);
    // Rewrite expires_at to give the freshly-minted token a full TTL
    // from approval time. The spec's "5-min TTL approval token" is the
    // token lifetime (approve → consume), not the request lifetime
    // (request → approve); without this reset, a row approved 4:30
    // into the original window leaves the agent only 30 s to redeem.
    const newExpiresAt = computeApprovalExpiry(now);
    const updated = approveApproval(deps.db, {
      id,
      tokenHash,
      approvedAt: now,
      newExpiresAt,
      nowMs: now,
    });
    if (!updated) {
      // Concurrent path (denial / expiry / second approve) won the
      // race. Surface the live state so the dashboard can re-render.
      const refreshed = getApprovalById(deps.db, id);
      return c.json(
        { error: "approval_state_changed", status: refreshed?.status ?? "expired" },
        409,
      );
    }
    logger.info(
      { approvalId: id, workflowName: updated.workflowName },
      "B-3 approval issued",
    );
    const payload = browserAutomationApprovalIssueResponseSchema.parse({
      ok: true,
      approval: toApprovalWire(updated),
      token,
    });
    return c.json(payload, 201);
  });

  // ── POST /approvals/:id/deny — Phase B-3 ──
  app.post("/browser-automation/approvals/:id/deny", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = browserAutomationApprovalDenyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", issues: parsed.error.issues },
        400,
      );
    }
    const existing = getApprovalById(deps.db, id);
    if (!existing) return c.json({ error: "approval_not_found" }, 404);
    if (existing.status !== "pending") {
      return c.json(
        { error: "approval_not_pending", status: existing.status },
        409,
      );
    }
    const updated = denyApproval(deps.db, {
      id,
      reason: parsed.data.reason ?? null,
      deniedAt: Date.now(),
    });
    if (!updated) {
      const refreshed = getApprovalById(deps.db, id);
      return c.json(
        { error: "approval_state_changed", status: refreshed?.status ?? "expired" },
        409,
      );
    }
    logger.info(
      {
        approvalId: id,
        workflowName: updated.workflowName,
        reason: parsed.data.reason ?? null,
      },
      "B-3 approval denied",
    );
    const payload = browserAutomationApprovalDenyResponseSchema.parse({
      ok: true,
      approval: toApprovalWire(updated),
    });
    return c.json(payload, 200);
  });

  // ── GET /observation-gate — Phase B-3 (§10 telemetry panel) ──
  // Aggregates the §10 observation-gate criteria over the most recent
  // 6-week window. The dashboard's B-3 readiness card renders this.
  app.get("/browser-automation/observation-gate", (c) => {
    const now = Date.now();
    const payload = computeObservationGate(deps.db, now);
    return c.json(
      browserAutomationObservationGateResponseSchema.parse(payload),
    );
  });

  // ── GET /recent-runs ──
  app.get("/browser-automation/recent-runs", (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.max(1, Math.min(200, Number(limitParam) || 50)) : 50;
    const runs = listRecentWorkflowRuns(deps.db, limit).map((r) => ({
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      paramsHash: r.paramsHash,
      targetUrls: [...r.targetUrls],
      blockedRequests: [...r.blockedRequests],
      durationMs: r.durationMs,
      outcome: r.outcome,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      screenshotPath: r.screenshotPath,
      tracePath: r.tracePath,
    }));
    return c.json(
      browserAutomationRecentRunsResponseSchema.parse({ runs }),
    );
  });

  return app;
}
