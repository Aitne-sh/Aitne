/**
 * Workflow execution shell — the I/O glue around the pure helpers in
 * `workflow-runner-utils.ts`.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.4.
 *
 * Holds the concurrency slot (1 instance globally), spawns Playwright
 * via `acquirePlaywrightContext`, races the workflow's `run()` against
 * its declared timeout, persists the audit row, and returns the
 * structured `WorkflowRunResult` to the API route.
 *
 * The safety-critical decision tree (URL allowlist regex, user-domain
 * allowlist deny-on-unknown, host extraction, output validation,
 * external-content wrapping) lives in pure helpers tested at 100%
 * coverage. This module only wires them to Playwright + the DB.
 *
 * Excluded from the coverage gate — same Playwright + DB I/O rationale
 * as `cdp-connect.ts` / `instance-a-launcher.ts`.
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  consumeApproval,
  createApprovalRequest,
  findApprovedRowByTokenHash,
  truncateParamsSummary,
} from "../../../db/browser-automation-approvals-store.js";
import {
  getB4Enabled,
  getSiteB4Config,
} from "../../../db/browser-automation-b4-config-store.js";
import {
  insertWorkflowRun,
  isDomainAllowed,
} from "../../../db/browser-automation-store.js";
import {
  clearSiteConnection,
  readSiteConnection,
  updateSiteConnection,
} from "../../../db/managed-chromium-sites-store.js";
import { createLogger } from "../../../logging.js";
import type { HostProfile } from "../types.js";
import { acquirePlaywrightContext } from "../managed-chromium/cdp-connect.js";
import {
  computeApprovalExpiry,
  hashApprovalToken,
} from "./approval-tokens.js";
import { wrapTaggedUntrusted } from "./external-content.js";
import type { PurchaseHandler } from "./purchase-handler.js";
import { getSite, type SiteDefinition } from "./site-registry.js";
import { makeScreenshotSink } from "./trace-store.js";
import type { ScreenshotSink, WorkflowRunResult } from "./types.js";
import {
  acquireSemaphoreSlot,
  checkPaymentPathBlock,
  checkUrlAndHostAllowlist,
  classifyRunFailure,
  extractPrimaryUrlFromParams,
  hashParams,
  resolveApprovalGate,
  resolveAuthSiteGate,
  validateWorkflowInput,
  validateWorkflowOutput,
  validationFailureToOutcome,
  withTimeout,
} from "./workflow-runner-utils.js";
import { getWorkflow } from "./workflows/registry.js";
import { RiskTier } from "../../../safety/risk-classifier.js";

const logger = createLogger("browser-automation-workflow-runner");

// Single-slot concurrency cap (plan §8.1 / parent §18.7). Queued FIFO.
// Chain pointer; `acquireSemaphoreSlot` does the atomic swap so two
// concurrent `runWorkflow` callers cannot both read the same `slot`
// snapshot. The previous in-file implementation returned a release fn
// synchronously without ever exposing the `wait` promise, so nothing
// awaited the chain and the cap silently became "unbounded".
let slot: Promise<unknown> = Promise.resolve();

export interface RunWorkflowOptions {
  db: Database.Database;
  host: HostProfile;
  paDataDir: string;
  workflowName: string;
  params: unknown;
  abortSignal?: AbortSignal;
  /** Phase B-3 (MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step
   *  43) — single-use, 5-min-TTL approval token. Required when the
   *  workflow's `riskTier === Approve` and `variant !== purchase`.
   *  Absent → runner creates a pending approval row and returns
   *  `needs_approval`. Present but invalid → `approval_token_invalid`
   *  or `approval_expired`. Present and valid → atomic CAS-consume,
   *  then proceed. */
  approvalToken?: string;
  /** Phase B-3 — origin of the approval request. The runner persists
   *  this on the approval row so the dashboard can render "requested
   *  by agent / by schedule" alongside the pending list. Defaults to
   *  "agent" because the HTTP route is the agent-curl surface; the
   *  scheduler-driven dispatcher overrides to "schedule". */
  approvalOrigin?: "agent" | "dashboard" | "schedule";
  /** Phase B-4 — purchase-workflow handler. Optional only because B-2 /
   *  B-2.5 / B-3 workflows never reach the purchase code path; for any
   *  `variant: "purchase"` workflow the runner refuses to run when
   *  this is undefined (the absence is a startup-wiring miss, not a
   *  request-level error). Injected at daemon startup via
   *  `bootstrap/api.ts`. */
  purchaseHandler?: PurchaseHandler;
  /** Phase B-4 — originating channel ref (`<platform>:<channel_id>`)
   *  when the workflow was invoked from a user DM, null for
   *  scheduled / autonomous invocations. The purchase handler uses
   *  this to decide whether to DM the token to just the originating
   *  channel (when it's a primary channel) or fan out to every
   *  primary channel (scheduled flow). The API route reads this from
   *  the `x-pa-channel-ref` header the dispatcher injects. */
  originatingChannel?: string | null;
}

export interface RunWorkflowEnvelope {
  result: WorkflowRunResult;
  /** Stable per-run id, also persisted in the audit row. Returned in
   *  every branch so the API caller can correlate to a trace dir even
   *  on early-short-circuit failures. */
  workflowId: string;
}

/**
 * Public entry point. Always returns — never throws. The result
 * envelope carries the wire-layer status the route translates to JSON.
 */
export async function runWorkflow(
  opts: RunWorkflowOptions,
): Promise<RunWorkflowEnvelope> {
  // Take the global semaphore. `acquireSemaphoreSlot` updates the
  // `slot` chain pointer atomically, then we `await acquire.wait` so the
  // critical section below only runs once the previous holder released.
  // `acquire.release` MUST be invoked exactly once (the `finally` here
  // is the only path), otherwise the next caller blocks forever.
  const { acquire, nextSlot } = acquireSemaphoreSlot(slot);
  slot = nextSlot;
  await acquire.wait;
  try {
    return await runWorkflowInner(opts);
  } finally {
    acquire.release();
  }
}

async function runWorkflowInner(
  opts: RunWorkflowOptions,
): Promise<RunWorkflowEnvelope> {
  const workflowId = randomUUID();
  const startedAt = Date.now();

  // Step 1 — workflow lookup
  const def = getWorkflow(opts.workflowName);
  if (!def) {
    await persistAudit(opts.db, {
      workflowId,
      workflowName: opts.workflowName,
      paramsHash: "",
      targetUrls: [],
      blockedRequests: [],
      durationMs: 0,
      outcome: "unknown_workflow",
      startedAt,
      finishedAt: Date.now(),
      screenshotPath: null,
      tracePath: null,
    });
    return {
      workflowId,
      result: { status: "unknown_workflow", workflowId },
    };
  }

  // Step 2 — input validation
  const inputCheck = validateWorkflowInput(def, workflowId, opts.params);
  const paramsHash = hashParams(opts.params);
  if (!inputCheck.ok) {
    await persistAudit(opts.db, {
      workflowId,
      workflowName: def.name,
      paramsHash,
      targetUrls: [],
      blockedRequests: [],
      durationMs: Date.now() - startedAt,
      outcome: "input_validation_error",
      startedAt,
      finishedAt: Date.now(),
      screenshotPath: null,
      tracePath: null,
    });
    return { workflowId, result: inputCheck.result };
  }
  const params = inputCheck.value;

  // Step 2.5 — Phase B-3 payment-path block. Hard-fail any
  // non-purchase workflow whose primary URL navigates to a payment
  // surface (`/checkout`, `/payment`, `/place-order`, `/buy`,
  // `/place-bid`). Even a valid B-3 approval token cannot reach these
  // paths — they categorically belong to B-4 (DM-token gate, per-site
  // spend caps, screenshot-first consent). Runs BEFORE the workflow's
  // own allowlist regex so a workflow that mistakenly includes a
  // payment sub-tree still fails closed.
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 step 46.
  const primaryUrl = extractPrimaryUrlFromParams(params);
  if (primaryUrl) {
    const paymentBlock = checkPaymentPathBlock(def, primaryUrl);
    if (paymentBlock) {
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: [primaryUrl],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "payment_path_blocked",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      logger.warn(
        {
          workflowName: def.name,
          url: primaryUrl,
          paymentPathCategory: paymentBlock.category,
        },
        "workflow rejected — payment URL pattern blocked (B-4 territory)",
      );
      return {
        workflowId,
        result: {
          status: "payment_path_blocked",
          workflowId,
          detail: {
            url: primaryUrl,
            paymentPathCategory: paymentBlock.category,
          },
        },
      };
    }
  }

  // Steps 3+4 — URL + user-domain allowlist
  // Workflows that don't hit the network can omit the URL fields; the
  // runner skips both steps for them. (None of the B-2 workflows do
  // this today — every shipping workflow takes a URL — but the path
  // is forward-compatible.)
  if (primaryUrl) {
    const allowlistDecision = checkUrlAndHostAllowlist(
      def,
      primaryUrl,
      (host) => isDomainAllowed(opts.db, host),
    );
    if (!allowlistDecision.ok) {
      const detail: Record<string, unknown> = {};
      if ("detail" in allowlistDecision) {
        Object.assign(detail, allowlistDecision.detail);
      }
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: [primaryUrl],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: allowlistDecision.status,
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      const result: WorkflowRunResult =
        allowlistDecision.status === "host_not_extractable"
          ? { status: "host_not_extractable", workflowId }
          : allowlistDecision.status === "url_not_allowlisted"
            ? {
                status: "url_not_allowlisted",
                workflowId,
                detail: allowlistDecision.detail,
              }
            : {
                status: "user_allowlist_blocked",
                workflowId,
                detail: allowlistDecision.detail,
              };
      return { workflowId, result };
    }
  }

  // Steps 5a — B-4 (purchase) variant pre-flight gates.
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 step 58.
  //
  // Runs BEFORE Playwright spawn so a disabled / unenabled / over-cap
  // workflow does not pay the cold-start cost just to fail. The
  // per-site cap enforcement inside `issuePurchaseToken` is atomic
  // (single-transaction CAS) — these gates are the cheap pre-checks
  // that short-circuit the obvious deny paths. The runner injects the
  // `PurchaseHandler` into the workflow context for the actual
  // issuance + await flow.
  if (def.variant === "purchase") {
    if (!opts.purchaseHandler) {
      logger.error(
        { workflowName: def.name, workflowId },
        "purchase workflow invoked but no PurchaseHandler injected — B-4 not wired at startup",
      );
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "purchase_b4_disabled",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result: {
          status: "purchase_b4_disabled",
          workflowId,
        },
      };
    }
    if (!getB4Enabled(opts.db)) {
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "purchase_b4_disabled",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result: { status: "purchase_b4_disabled", workflowId },
      };
    }
    const siteConfig = def.siteKey
      ? getSiteB4Config(opts.db, def.siteKey)
      : null;
    if (!siteConfig || !siteConfig.enabled) {
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "purchase_site_not_enabled",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result: {
          status: "purchase_site_not_enabled",
          workflowId,
          detail: { siteKey: def.siteKey ?? "" },
        },
      };
    }
  }

  // Steps 5b — B-2.5 per-site site_not_connected gate. The pure
  // resolver verifies (a) the siteKey is registered, (b) the
  // workflow's allowlistRegex is a subset of the site's
  // allowedHostPattern, (c) a persistent connection row exists, (d)
  // the connection is within `sessionMaxAgeDays`. Any failure folds
  // into the wire-level `site_not_connected` outcome — the registry-
  // misconfiguration cases (unknown_site / allowlist_not_subset) also
  // map there so the LLM-facing surface stays a single status code,
  // with the categorical detail captured in the audit row only.
  if (def.variant === "auth") {
    if (def.riskTier === RiskTier.Autonomous) {
      // §16.5 floor — authenticated workflows are at minimum
      // ReadSensitive. The registry validator covers this for
      // shipping entries; doubling it here means a future workflow
      // that bypasses the registry helper still fails closed.
      logger.error(
        { workflowName: def.name },
        "auth-variant workflow declared Autonomous tier; refusing to run",
      );
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "playwright_error",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result: {
          status: "playwright_error",
          workflowId,
          detail: {
            reason: "auth-variant workflow must declare RiskTier.ReadSensitive or Approve",
          },
        },
      };
    }
    const siteKey = def.siteKey ?? "";
    const gate = resolveAuthSiteGate({
      siteKey,
      allowlistRegex: def.allowlistRegex,
      connection: readSiteConnection(opts.db, siteKey),
      nowMs: Date.now(),
    });
    if (!gate.ok) {
      logger.warn(
        { workflowName: def.name, siteKey, status: gate.status },
        "auth-variant workflow gate rejected; returning site_not_connected",
      );
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "site_not_connected",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result: {
          status: "site_not_connected",
          workflowId,
          detail: { siteKey },
        },
      };
    }
  }

  // Step 5c — Phase B-3 approval-token gate. For any workflow whose
  // `riskTier === Approve` and `variant !== purchase`:
  //   - Token absent → create a pending approval row + return
  //     `needs_approval` to the caller. The dashboard surfaces the row
  //     for user Approve / Deny.
  //   - Token present → look it up via SHA-256 hash, run the pure
  //     `classifyApprovalValidation` decision tree, then atomically
  //     CAS-consume the row (approved → consumed). The CAS predicate
  //     binds the consumption to (workflowName, paramsHash) so a
  //     token issued for one workflow cannot redeem against another.
  // The purchase variant is already short-circuited above (step 5a) so
  // at this point TS has narrowed `def.variant` to `"anon" | "auth"`.
  // We only check the riskTier here.
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 steps 43-44.
  if (def.riskTier === RiskTier.Approve) {
    const tokenHashIfPresent = opts.approvalToken
      ? hashApprovalToken(opts.approvalToken)
      : null;
    const persistedRow = tokenHashIfPresent
      ? findApprovedRowByTokenHash(opts.db, tokenHashIfPresent)
      : null;
    const gate = resolveApprovalGate({
      workflowDef: def,
      workflowName: def.name,
      paramsHash,
      approvalToken: opts.approvalToken,
      row: persistedRow
        ? {
            id: persistedRow.id,
            workflowName: persistedRow.workflowName,
            paramsHash: persistedRow.paramsHash,
            status: persistedRow.status,
            expiresAt: persistedRow.expiresAt,
            tokenHash: persistedRow.tokenHash,
          }
        : null,
      nowMs: Date.now(),
    });

    if (gate.kind === "missing_token") {
      const requestedAt = Date.now();
      const expiresAt = computeApprovalExpiry(requestedAt);
      let pending;
      try {
        pending = createApprovalRequest(opts.db, {
          workflowName: def.name,
          paramsHash,
          paramsSummary: truncateParamsSummary(params),
          origin: opts.approvalOrigin ?? "agent",
          requestedAt,
          expiresAt,
        });
      } catch (err) {
        // A DB insert failure here is rare but possible (e.g., disk
        // full). Surface as playwright_error rather than masking the
        // failure mode — the user / agent should retry once the
        // daemon health recovers.
        logger.error(
          { err, workflowName: def.name },
          "approval-request insert failed; cannot enter B-3 needs_approval state",
        );
        await persistAudit(opts.db, {
          workflowId,
          workflowName: def.name,
          paramsHash,
          targetUrls: primaryUrl ? [primaryUrl] : [],
          blockedRequests: [],
          durationMs: Date.now() - startedAt,
          outcome: "playwright_error",
          startedAt,
          finishedAt: Date.now(),
          screenshotPath: null,
          tracePath: null,
        });
        return {
          workflowId,
          result: {
            status: "playwright_error",
            workflowId,
            detail: { reason: "approval-request insert failed" },
          },
        };
      }
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome: "needs_approval",
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result: {
          status: "needs_approval",
          workflowId,
          detail: { approvalId: pending.id, expiresAt: pending.expiresAt },
        },
      };
    }

    if (gate.kind === "validation_failed") {
      const outcome = validationFailureToOutcome(gate.failure);
      logger.warn(
        {
          workflowName: def.name,
          reason: gate.failure.reason,
          outcome,
        },
        "B-3 approval gate rejected",
      );
      await persistAudit(opts.db, {
        workflowId,
        workflowName: def.name,
        paramsHash,
        targetUrls: primaryUrl ? [primaryUrl] : [],
        blockedRequests: [],
        durationMs: Date.now() - startedAt,
        outcome,
        startedAt,
        finishedAt: Date.now(),
        screenshotPath: null,
        tracePath: null,
      });
      return {
        workflowId,
        result:
          outcome === "approval_expired"
            ? { status: "approval_expired", workflowId }
            : { status: "approval_token_invalid", workflowId },
      };
    }

    if (gate.kind === "validated") {
      // Atomic CAS — approved → consumed, gated by token_hash +
      // workflow_name + params_hash + expires_at. Even if a concurrent
      // call also presents the same token, exactly one UPDATE wins.
      const consumed = consumeApproval(opts.db, {
        id: gate.row.id,
        tokenHash: gate.row.tokenHash ?? "",
        workflowName: def.name,
        paramsHash,
        consumedAt: Date.now(),
        nowMs: Date.now(),
      });
      if (!consumed) {
        // Concurrent consumer won the race; surface as invalid so the
        // caller knows the token is no longer redeemable. No audit
        // row beyond the standard one — the winning consumer already
        // recorded its success.
        logger.warn(
          {
            workflowName: def.name,
            approvalId: gate.row.id,
          },
          "B-3 approval CAS lost a race; token already consumed",
        );
        await persistAudit(opts.db, {
          workflowId,
          workflowName: def.name,
          paramsHash,
          targetUrls: primaryUrl ? [primaryUrl] : [],
          blockedRequests: [],
          durationMs: Date.now() - startedAt,
          outcome: "approval_token_invalid",
          startedAt,
          finishedAt: Date.now(),
          screenshotPath: null,
          tracePath: null,
        });
        return {
          workflowId,
          result: { status: "approval_token_invalid", workflowId },
        };
      }
      logger.info(
        {
          workflowName: def.name,
          approvalId: gate.row.id,
          workflowId,
        },
        "B-3 approval gate validated; proceeding",
      );
    }
    // gate.kind === "not_required" falls through to Playwright spawn.
  }

  // Step 6 — spawn Playwright. Variant-specific options dispatched at
  // the launcher boundary; the rest of the pipeline (run / output
  // validate / wrap / audit) is variant-agnostic.
  const acquireResult = await acquirePlaywrightContext(
    def.variant === "auth"
      ? {
          db: opts.db,
          host: opts.host,
          paDataDir: opts.paDataDir,
          workflowId,
          variant: "auth",
          siteKey: def.siteKey ?? "",
          allowlistRegex: def.allowlistRegex,
        }
      : def.variant === "purchase"
        ? {
            db: opts.db,
            host: opts.host,
            paDataDir: opts.paDataDir,
            workflowId,
            variant: "purchase",
            siteKey: def.siteKey ?? "",
            allowlistRegex: def.allowlistRegex,
          }
        : {
            db: opts.db,
            host: opts.host,
            paDataDir: opts.paDataDir,
            workflowId,
            variant: "anon",
            allowlistRegex: def.allowlistRegex,
          },
  );
  if (!acquireResult.ok) {
    const outcome =
      acquireResult.reason === "cdp_timeout"
        ? "playwright_launch_timeout"
        : "playwright_error";
    await persistAudit(opts.db, {
      workflowId,
      workflowName: def.name,
      paramsHash,
      targetUrls: primaryUrl ? [primaryUrl] : [],
      blockedRequests: [],
      durationMs: Date.now() - startedAt,
      outcome,
      startedAt,
      finishedAt: Date.now(),
      screenshotPath: null,
      tracePath: null,
    });
    return {
      workflowId,
      result:
        outcome === "playwright_launch_timeout"
          ? { status: "playwright_launch_timeout", workflowId }
          : {
              status: "playwright_error",
              workflowId,
              detail: { reason: acquireResult.reason },
            },
    };
  }

  const playwrightHandle = acquireResult.handle;
  const screenshotSink: ScreenshotSink = makeScreenshotSink({
    paDataDir: opts.paDataDir,
    workflowId,
  });
  const abort = combineAbortSignals(opts.abortSignal, def.perWorkflowTimeoutMs);

  // Step 7 — run() with timeout. Purchase-variant workflows receive an
  // augmented context with the `PurchaseHandler` and `originatingChannel`
  // (plan §17.5); other variants get the base shape. The augment is
  // structural (extra fields on the same object) — the workflow downcasts
  // at the boundary inside `run()` and reads the extras.
  const baseRunCtx = {
    params,
    playwrightContext: playwrightHandle.context,
    signal: abort.signal,
    screenshotSink,
    workflowId,
  };
  const runCtx =
    def.variant === "purchase" && opts.purchaseHandler
      ? {
          ...baseRunCtx,
          purchaseHandler: opts.purchaseHandler,
          originatingChannel: opts.originatingChannel ?? null,
        }
      : baseRunCtx;
  let runOutput: unknown;
  let runFailure: WorkflowRunResult | null = null;
  try {
    runOutput = await withTimeout(
      def.run(runCtx),
      def.perWorkflowTimeoutMs,
    );
  } catch (err) {
    runFailure = classifyRunFailure(err, workflowId);
    logger.warn(
      { err, workflowName: def.name, workflowId },
      "workflow run() failed",
    );
  } finally {
    abort.dispose();
  }

  // For the run-failure / output-validation-error paths we release the
  // handle eagerly — nothing else needs the live context. The success
  // path defers release until after the post-run signed-in probe (§8a)
  // so the probe can navigate on the same context.
  if (runFailure) {
    const blockedRequests = [...playwrightHandle.blockedRequests.list()];
    await playwrightHandle.release();
    await persistAudit(opts.db, {
      workflowId,
      workflowName: def.name,
      paramsHash,
      targetUrls: primaryUrl ? [primaryUrl] : [],
      blockedRequests,
      durationMs: Date.now() - startedAt,
      outcome: runFailure.status === "timeout" ? "timeout" : "playwright_error",
      startedAt,
      finishedAt: Date.now(),
      screenshotPath: null,
      tracePath: null,
    });
    return { workflowId, result: runFailure };
  }

  // Step 8 — output validation
  const outputCheck = validateWorkflowOutput(def, workflowId, runOutput);
  if (!outputCheck.ok) {
    const blockedRequests = [...playwrightHandle.blockedRequests.list()];
    await playwrightHandle.release();
    await persistAudit(opts.db, {
      workflowId,
      workflowName: def.name,
      paramsHash,
      targetUrls: primaryUrl ? [primaryUrl] : [],
      blockedRequests,
      durationMs: Date.now() - startedAt,
      outcome: "output_validation_error",
      startedAt,
      finishedAt: Date.now(),
      screenshotPath: null,
      tracePath: null,
    });
    return { workflowId, result: outputCheck.result };
  }

  // Step 8a — post-run signed-in re-check for auth-variant workflows.
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.6 (signal #2): when the
  // workflow expected logged-in state but the site silently signed the
  // user out (typically because the user signed out from another device,
  // or the session cookie expired mid-run), the data we just scraped is
  // a degraded view — Amazon renders an empty orders list when not
  // signed in, Netflix renders a generic landing page. We re-probe the
  // site's `signedInSelector` on the same context BEFORE release so we
  // either:
  //   - Confirm the session is healthy (no action).
  //   - Detect silent expiry → clear the persistent connection row so
  //     the NEXT auth workflow returns `site_not_connected`, prompting
  //     the user to re-auth. No DM (low signal per §16.6); the audit
  //     row is the surfacing channel.
  // The probe navigates to `site.profileVerifyUrl`, which the registry
  // validator ensures matches the workflow's `allowlistRegex` (so the
  // CDP interception layer permits it).
  let sessionExpired = false;
  if (def.variant === "auth" && def.siteKey) {
    const site = getSite(def.siteKey);
    if (site) {
      try {
        sessionExpired = !(await probeSignedInOnContext(
          playwrightHandle.context,
          site,
        ));
      } catch (err) {
        logger.warn(
          { err, workflowName: def.name, siteKey: def.siteKey },
          "post-run signed-in probe raised; treating as healthy (conservative)",
        );
      }
    }
  }

  const blockedRequests = [...playwrightHandle.blockedRequests.list()];
  await playwrightHandle.release();

  // Step 9 — external-content wrapping
  const wrappedOutput = wrapTaggedUntrusted(
    outputCheck.value,
    primaryUrl ?? "",
  );

  // Step 9a — auth-variant bookkeeping. If the post-run probe says the
  // session is gone, clear the connection row so the next auth-workflow
  // invocation returns `site_not_connected` and the dashboard prompts a
  // re-auth. Otherwise advance `lastWorkflowAt` so the §16.6 #1
  // filesystem watcher (future work) has a cross-check timestamp.
  // Best-effort: a DB failure here does not poison the success path —
  // the data we already gathered is returned regardless.
  if (def.variant === "auth" && def.siteKey) {
    if (sessionExpired) {
      try {
        clearSiteConnection(opts.db, def.siteKey);
        recordSessionExpiredAudit(opts.db, def.siteKey, def.name, workflowId);
        logger.info(
          { workflowName: def.name, siteKey: def.siteKey, workflowId },
          "auth-variant post-run probe detected session expired; cleared connection row",
        );
      } catch (err) {
        logger.warn(
          { err, workflowName: def.name, siteKey: def.siteKey },
          "clearSiteConnection on session expiry failed (continuing)",
        );
      }
    } else {
      try {
        updateSiteConnection(opts.db, def.siteKey, (draft) => {
          draft.lastWorkflowAt = Date.now();
        });
      } catch (err) {
        logger.warn(
          { err, workflowName: def.name, siteKey: def.siteKey },
          "lastWorkflowAt advance failed (continuing)",
        );
      }
    }
  }

  await persistAudit(opts.db, {
    workflowId,
    workflowName: def.name,
    paramsHash,
    targetUrls: primaryUrl ? [primaryUrl] : [],
    blockedRequests,
    durationMs: Date.now() - startedAt,
    outcome: "success",
    startedAt,
    finishedAt: Date.now(),
    screenshotPath: extractScreenshotPath(wrappedOutput),
    tracePath: null,
  });

  return {
    workflowId,
    result: {
      status: "success",
      workflowId,
      output: wrappedOutput,
    },
  };
}

interface AuditFields {
  workflowId: string;
  workflowName: string;
  paramsHash: string;
  targetUrls: readonly string[];
  blockedRequests: readonly string[];
  durationMs: number;
  outcome:
    | "success"
    | "unknown_workflow"
    | "input_validation_error"
    | "output_validation_error"
    | "url_not_allowlisted"
    | "user_allowlist_blocked"
    | "host_not_extractable"
    | "rate_limited"
    | "site_not_connected"
    | "playwright_launch_timeout"
    | "playwright_error"
    | "timeout"
    // ── Phase B-3 (gated write automation) outcomes ──
    | "needs_approval"
    | "approval_expired"
    | "approval_token_invalid"
    | "payment_path_blocked"
    // ── Phase B-4 (experimental purchase) outcomes ──
    | "purchase_b4_disabled"
    | "purchase_site_not_enabled"
    | "purchase_pending_exists"
    | "purchase_daily_cap_exceeded";
  startedAt: number;
  finishedAt: number;
  screenshotPath: string | null;
  tracePath: string | null;
}

async function persistAudit(
  db: Database.Database,
  fields: AuditFields,
): Promise<void> {
  try {
    insertWorkflowRun(db, {
      workflowId: fields.workflowId,
      workflowName: fields.workflowName,
      paramsHash: fields.paramsHash,
      targetUrls: fields.targetUrls,
      blockedRequests: fields.blockedRequests,
      durationMs: fields.durationMs,
      outcome: fields.outcome,
      startedAt: fields.startedAt,
      finishedAt: fields.finishedAt,
      screenshotPath: fields.screenshotPath,
      tracePath: fields.tracePath,
    });
  } catch (err) {
    logger.warn({ err, fields }, "audit row INSERT failed");
  }
}

/**
 * Open a new page on the live workflow context and check whether the
 * site's `signedInSelector` resolves at `profileVerifyUrl`. Returns
 * true when signed-in, false when the selector is absent (or any
 * navigation / lookup error occurs and the caller's `try/catch` wins —
 * the caller treats raises as "still healthy", since a network blip
 * should not trigger a spurious session-clear).
 *
 * The probe stays on the workflow's existing context so the CDP
 * interception layer's allowlist is honoured. The registry validator
 * (`workflows/registry.ts:validateWorkflowRegistry`) MUST ensure every
 * auth-variant workflow's `allowlistRegex` covers its site's
 * `profileVerifyUrl`; otherwise the probe navigation gets denied at
 * the CDP layer and falls through to "treat as healthy".
 *
 * Pure-ish wrt the daemon's state — never writes to the DB, never
 * touches the filesystem; the runner owns the side-effects.
 */
async function probeSignedInOnContext(
  context: unknown,
  site: SiteDefinition,
): Promise<boolean> {
  const ctx = context as {
    newPage: () => Promise<unknown>;
  };
  const page = (await ctx.newPage()) as {
    goto: (
      url: string,
      opts: { waitUntil: "domcontentloaded"; timeout: number },
    ) => Promise<unknown>;
    locator: (sel: string) => {
      first: () => {
        waitFor: (opts: {
          state: "visible";
          timeout: number;
        }) => Promise<unknown>;
      };
    };
    close: () => Promise<void>;
  };
  try {
    await page.goto(site.profileVerifyUrl, {
      waitUntil: "domcontentloaded",
      timeout: 8_000,
    });
    try {
      await page.locator(site.signedInSelector).first().waitFor({
        state: "visible",
        timeout: 2_500,
      });
      return true;
    } catch {
      return false;
    }
  } finally {
    await page.close().catch(() => {});
  }
}

function recordSessionExpiredAudit(
  db: Database.Database,
  siteKey: string,
  workflowName: string,
  workflowId: string,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, completed_at, source_kind)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
    ).run(
      "browser_automation.site_session_expired",
      "browser_automation",
      "failed",
      JSON.stringify({ siteKey, workflowName, workflowId }),
      "cron",
    );
  } catch (err) {
    logger.warn(
      { err, siteKey, workflowName },
      "failed to write site_session_expired audit row",
    );
  }
}

/**
 * Combine the caller's abort signal (if any) with a per-workflow
 * timeout signal. Returns a single signal both branches can await on.
 *
 * `AbortSignal.any` is Node 20+ — the project's engines pin `>=22`, so
 * this is safe.
 */
function combineAbortSignals(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("workflow timeout")), timeoutMs);
  const cleanup: Array<() => void> = [() => clearTimeout(timer)];
  if (outer) {
    if (outer.aborted) ac.abort(outer.reason);
    else {
      const handler = (): void => ac.abort(outer.reason);
      outer.addEventListener("abort", handler);
      cleanup.push(() => outer.removeEventListener("abort", handler));
    }
  }
  return {
    signal: ac.signal,
    dispose(): void {
      for (const fn of cleanup) fn();
    },
  };
}

/** If the validated + wrapped output carries a `screenshotPath` string,
 *  surface it on the audit row so the dashboard's recent-runs panel can
 *  link to the asset without re-running the workflow. Tolerant of
 *  outputs that don't carry the field. */
function extractScreenshotPath(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const obj = output as Record<string, unknown>;
  if (typeof obj.screenshotPath === "string") return obj.screenshotPath;
  return null;
}
