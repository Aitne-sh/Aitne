/**
 * Workflow registry contracts — Phase B-2 of the managed-Chromium plan.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §5.6, §8.3.
 *
 * Workflows are **enumerated**, not synthesised: the registry
 * (`workflows/registry.ts`) is `Object.freeze`d at module load so the
 * LLM cannot define new workflows at runtime. Each workflow ships as
 * one TypeScript file declaring its input/output schemas, allowlist
 * regex, risk tier, per-workflow timeout, and run() implementation.
 *
 * The shape lives in this `types.ts` so the test-only fakes don't
 * pull in `playwright-core` (which the coverage gate excludes anyway).
 */

import type { z } from "zod";
import type { BrowserAutomationOutcome } from "@aitne/shared";
import type { RiskTier } from "../../../safety/risk-classifier.js";

/**
 * Re-exported here so workflow / runner code doesn't need to know about
 * the wire-layer DB store. Same closed set as
 * `browser_automation_workflows.outcome` (CHECK constraint) and the
 * shared package's `browserAutomationOutcomeSchema`. The
 * `outcome-drift.test.ts` lint enforces three-way alignment.
 */
export type WorkflowRunOutcome = BrowserAutomationOutcome;

/** Instance A profile family. B-2 only ships `"anon"`; the other two
 *  are reserved for B-2.5 (`"auth"`) and B-4 (`"purchase"`) so the
 *  registry's type contract is forward-compatible. */
export type WorkflowVariant = "anon" | "auth" | "purchase";

/**
 * Per-workflow Playwright handle exposed to `run()`. Carries the
 * `BrowserContext` (already constructed under the workflow's egress
 * allowlist / global denylist) and the screenshot sink the workflow
 * uses to publish images into the trace dir.
 *
 * `signal` is the workflow's AbortSignal — `run()` MUST honour it (e.g.,
 * abort in-flight `page.goto` calls on user cancellation / cross-workflow
 * shutdown). The runner sets it from the per-workflow timeout AND from
 * the parent dispatch's abort signal, so a single workflow honours both.
 *
 * `playwrightContext` is typed as `unknown` here so the public type
 * surface doesn't drag in `playwright-core` types — workflow modules
 * downcast at the boundary inside their I/O-shaped run() body (which
 * is excluded from coverage). Keeps this `types.ts` module
 * import-light and lets the registry / runner peer tests stay
 * playwright-free.
 */
export interface WorkflowRunContext {
  playwrightContext: unknown;
  screenshotSink: ScreenshotSink;
  signal: AbortSignal;
  /** Stable per-run identifier; used by the workflow to tag screenshot
   *  labels so the trace dir contains predictable filenames. */
  workflowId: string;
}

/** Workflow-side hook into the trace store. `capture(label, page)` writes
 *  one screenshot and returns the **API-served path** (e.g.
 *  `/api/browser-automation/traces/<wfid>/<file>.png`), NOT the
 *  filesystem path — workflows feed the return value straight into
 *  their output schema's `screenshotPath` field, which the dashboard
 *  links to.
 *
 *  The runner injects a real sink (FS-backed) for production runs and
 *  a stub for unit tests. Workflow code never touches the FS directly. */
export interface ScreenshotSink {
  capture(label: string, page: unknown): Promise<string>;
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  /** Stable identifier — also the URL path segment for `POST /workflows/:name`.
   *  Must match `/^[a-zA-Z][a-zA-Z0-9_]*$/` (enforced by the registry test). */
  name: string;
  /** Zod schema for the per-workflow params object. */
  inputSchema: z.ZodType<TInput>;
  /** Zod schema for the workflow's success result. Validated AFTER
   *  `run()` returns; a parse failure flips the outcome to
   *  `output_validation_error` and the result is not surfaced to the
   *  caller (the dashboard's recent-runs row carries the outcome). */
  outputSchema: z.ZodType<TOutput>;
  /**
   * Per-workflow URL allowlist. Checked BEFORE Playwright is touched
   * (in `workflow-runner.ts:runWorkflow` step 2) — a workflow whose
   * `inputSchema` has a `url` field uses this to assert the requested
   * URL is in-scope for the workflow. Independent of the per-domain
   * user allowlist (step 3) which is the user's deny-on-unknown gate.
   */
  allowlistRegex: RegExp;
  /** Coarse risk classification surfaced through `GET /workflows` and
   *  enforced by the API layer's middleware. B-2 ships
   *  `Autonomous`-tier read workflows only; B-3 introduces `Notify` /
   *  `Approve`. */
  riskTier: RiskTier;
  /** Hard ceiling on `run()` wall time. The runner wraps the call in
   *  `Promise.race` against `sleepThenThrow(timeout)`; on timeout the
   *  outcome is `timeout` and the Playwright handle is force-closed. */
  perWorkflowTimeoutMs: number;
  /** `"anon"` for B-2 read-only workflows. */
  variant: WorkflowVariant;
  /** Required when `variant !== "anon"`. Identifies the per-site
   *  profile dir (e.g., `"amazon_jp"`). Reserved for B-2.5+. */
  siteKey?: string;
  run(ctx: WorkflowRunContext & { params: TInput }): Promise<TOutput>;
}

/** Wire-layer result from `runWorkflow`. The success branch carries
 *  the validated output; every failure branch carries enough context
 *  for the API layer to render a structured error. */
export type WorkflowRunResult =
  | {
      status: "success";
      workflowId: string;
      output: unknown;
    }
  | {
      status: "input_validation_error";
      workflowId: string;
      validationErrors: unknown;
    }
  | {
      status: "output_validation_error";
      workflowId: string;
      validationErrors: unknown;
    }
  | {
      status: "url_not_allowlisted";
      workflowId: string;
      detail: { url: string };
    }
  | {
      status: "user_allowlist_blocked";
      workflowId: string;
      detail: { host: string };
    }
  | {
      status: "host_not_extractable";
      workflowId: string;
    }
  | {
      status: "rate_limited";
      workflowId: string;
    }
  | {
      status: "site_not_connected";
      workflowId: string;
      detail: { siteKey: string };
    }
  | {
      status: "unknown_workflow";
      workflowId: string;
    }
  | {
      status: "playwright_launch_timeout";
      workflowId: string;
    }
  | {
      status: "playwright_error";
      workflowId: string;
      detail: { reason: string };
    }
  | {
      status: "timeout";
      workflowId: string;
    }
  // ── Phase B-3 (gated write automation) outcomes ──
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 steps 43-46.
  | {
      status: "needs_approval";
      workflowId: string;
      detail: { approvalId: string; expiresAt: number };
    }
  | {
      status: "approval_expired";
      workflowId: string;
    }
  | {
      status: "approval_token_invalid";
      workflowId: string;
    }
  | {
      status: "payment_path_blocked";
      workflowId: string;
      detail: {
        url: string;
        paymentPathCategory:
          | "checkout"
          | "payment"
          | "place-order"
          | "buy"
          | "place-bid";
      };
    }
  // ── Phase B-4 (experimental purchase) runner-level outcomes ──
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 step 58.
  | {
      status: "purchase_b4_disabled";
      workflowId: string;
    }
  | {
      status: "purchase_site_not_enabled";
      workflowId: string;
      detail: { siteKey: string };
    }
  | {
      status: "purchase_pending_exists";
      workflowId: string;
      detail: { siteKey: string; pendingJti: string };
    }
  | {
      status: "purchase_daily_cap_exceeded";
      workflowId: string;
      detail: { siteKey: string; reason: string };
    };

/** Constant-time check: a workflow that declares `variant !== "anon"` MUST
 *  carry a non-empty `siteKey`. The registry test enforces this so a
 *  B-2.5 workflow can't accidentally ship without a site declaration. */
export function workflowDeclarationIsConsistent(
  def: Pick<WorkflowDefinition, "variant" | "siteKey">,
): boolean {
  if (def.variant === "anon") return def.siteKey === undefined;
  return typeof def.siteKey === "string" && def.siteKey.length > 0;
}
