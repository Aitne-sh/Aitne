"use client";

import { AlertTriangle, Info } from "lucide-react";
import { ADVISOR_ALLOWED_MODELS } from "@aitne/shared";
import { ApiError } from "@/lib/api-client";
import { useAdvisor } from "@/lib/hooks/use-advisor";
import { useProcessConfig } from "@/lib/hooks/use-process-config";

/**
 * SDK gate (`zR6` in `@anthropic-ai/claude-agent-sdk` cli.js): the advisor
 * tool is only registered when the base model id contains one of the
 * `ADVISOR_ALLOWED_MODELS` substrings (today: `sonnet-4-6`, `opus-4-6`).
 * Anything else — any Haiku variant, older Sonnet/Opus, future unnamed
 * variants — is rejected with a stderr log and the advisor call becomes a
 * silent no-op.
 *
 * Substrings are derived from the shared allowlist so a registry bump
 * cascades here without a dashboard edit.
 */
const ADVISOR_ALLOWED_SUBSTRINGS = ADVISOR_ALLOWED_MODELS.map((m) =>
  m.replace(/^claude-/, "").toLowerCase(),
);

function isAdvisorCompatibleBase(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return ADVISOR_ALLOWED_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Processes where skipping advisor materially hurts quality. Low-stakes
 * observer-style flows (`schedule.approaching`, `calendar.change`) don't
 * really benefit from advisor consultation, so incompatibility there is
 * not worth escalating into a loud warning.
 *
 * If advisor-incompatible bindings only exist on low-stakes processes we
 * surface an `info` (muted) note instead of a full yellow warning.
 */
const HIGH_STAKES_PROCESS_KEYS = new Set([
  "message.dm",
  "message.mention",
  "dashboard.chat",
  "agent.task",
  "routine.morning_routine",
  "routine.evening_review",
  "routine.weekly_review",
  "routine.monthly_review",
  "routine.hourly_check",
]);

/**
 * Surface the silent no-op trap where a process is pinned to a model the
 * Claude Agent SDK will reject as an advisor base (Haiku, older variants,
 * future unnamed models) AND advisor is enabled in `backend_global_defaults`.
 *
 * Uses TanStack Query (shared `queryKey`s with `useBackends` / `useProcessConfig`)
 * so an edit on the Models page invalidates and re-evaluates this warning
 * without a page refresh.
 */
export function HaikuAdvisorWarning() {
  const advisorQuery = useAdvisor();
  const processQuery = useProcessConfig();

  // Multi-backend tables not yet provisioned (503) → silently hide. This is
  // the only case we swallow; other errors are surfaced as a muted note so
  // the user isn't misled about advisor state.
  const isMultiBackendUnavailable =
    (advisorQuery.error instanceof ApiError
      && advisorQuery.error.status === 503)
    || (processQuery.error instanceof ApiError
      && processQuery.error.status === 503);

  if (isMultiBackendUnavailable) return null;
  if (advisorQuery.isLoading || processQuery.isLoading) return null;

  if (advisorQuery.error || processQuery.error) {
    // Non-503 failure — we can't evaluate the invariant, so tell the user
    // rather than silently hiding the warning surface.
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
      >
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>
          Advisor compatibility check unavailable. Refresh the page or check
          the daemon logs if you rely on the advisor tool.
        </span>
      </div>
    );
  }

  const advisor = advisorQuery.data;
  const processConfigs = processQuery.data?.configs ?? [];

  if (!advisor?.enabled) return null;

  const incompatibleRows = processConfigs.filter(
    (row) => !isAdvisorCompatibleBase(row.mainModel),
  );
  if (incompatibleRows.length === 0) return null;

  const highStakes = incompatibleRows.filter((row) =>
    HIGH_STAKES_PROCESS_KEYS.has(row.processKey),
  );
  const lowStakes = incompatibleRows.filter(
    (row) => !HIGH_STAKES_PROCESS_KEYS.has(row.processKey),
  );

  // High-stakes banner: yellow warning with action guidance.
  if (highStakes.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm"
      >
        <AlertTriangle
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-600"
          aria-hidden="true"
        />
        <div className="space-y-1 [&>p]:max-w-prose">
          <p className="font-medium text-yellow-900 dark:text-yellow-100">
            Advisor-incompatible models on high-stakes processes
          </p>
          <p className="text-yellow-900/80 dark:text-yellow-100/80">
            Advisor is enabled on{" "}
            <code className="rounded bg-yellow-500/20 px-1 py-0.5">
              {advisor.model ?? "(unset)"}
            </code>
            , but the Claude Agent SDK only registers the{" "}
            <code>advisor_20260301</code> tool on base models whose id
            contains{" "}
            {ADVISOR_ALLOWED_SUBSTRINGS.map((s, i) => (
              <span key={s}>
                {i > 0 && (i === ADVISOR_ALLOWED_SUBSTRINGS.length - 1
                  ? " or "
                  : ", ")}
                <code>{s}</code>
              </span>
            ))}
            . The following processes are pinned to incompatible models and
            will silently skip advisor calls:
          </p>
          <p className="text-yellow-900/80 dark:text-yellow-100/80">
            {highStakes.map((row, idx) => (
              <span key={row.processKey}>
                {idx > 0 && ", "}
                <code className="rounded bg-yellow-500/20 px-1 py-0.5">
                  {row.processKey}
                </code>
                {" → "}
                <code className="rounded bg-yellow-500/20 px-1 py-0.5">
                  {row.mainModel}
                </code>
              </span>
            ))}
          </p>
          <p className="text-yellow-900/70 dark:text-yellow-100/70">
            Either switch these processes to a Sonnet/Opus model above,
            or disable advisor on{" "}
            <a className="underline" href="/settings/models">
              /settings/models
            </a>
            .
          </p>
          {lowStakes.length > 0 && (
            <p className="text-yellow-900/60 dark:text-yellow-100/60">
              ({lowStakes.length} additional low-stakes process
              {lowStakes.length === 1 ? "" : "es"} also incompatible.)
            </p>
          )}
        </div>
      </div>
    );
  }

  // Only low-stakes processes are incompatible → muted info note (not alarm).
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>
        {lowStakes.length} low-stakes process
        {lowStakes.length === 1 ? "" : "es"} pinned to an advisor-incompatible
        model. Advisor is skipped there — usually harmless. (
        {lowStakes.map((r) => r.processKey).join(", ")})
      </span>
    </div>
  );
}
