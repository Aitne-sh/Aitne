"use client";

import { Alert } from "@/components/ui/alert";
import { ApiError } from "@/lib/api-client";
import type { ScheduleWarningIssue } from "@/lib/api-types";

/**
 * Renders the `warnings[]` channel of a 2xx schedule response — per
 * SCHEDULE_API_REDESIGN_PLAN.md §5.0.5 these are non-blocking advisories
 * (deprecated model, no-op `onMissingDay`) that the daemon still
 * persists. Keeping the sheet open and surfacing them inline mirrors the
 * agent-side contract: the LLM is expected to read warnings and refine
 * on the next turn, so a human should see the same hints.
 *
 * Empty arrays render nothing — drop the component anywhere and it's
 * inert when there's nothing to say.
 */
export function ScheduleWarningsList({
  warnings,
  title = "Saved with warnings",
}: {
  warnings: ScheduleWarningIssue[] | null | undefined;
  title?: string;
}) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <Alert variant="warning">
      <div className="font-medium">{title}</div>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
        {warnings.map((w, idx) => (
          <li key={`${w.code}:${idx}`}>
            <span className="font-mono text-[11px] text-muted-foreground">{w.code}</span>
            <span className="ml-2">{w.hint}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * Map an `ApiError` body (whose 4xx shape is the
 * `respondWithAgentError` envelope) to a flat error list the form can
 * render. Falls through to the generic `err.message` when the body
 * doesn't follow the envelope shape (e.g. a 500 surfaced as opaque
 * text). Pure — exported separately so the create/edit sheets share
 * one mapping path.
 */
export function describeMutationError(err: unknown): {
  /** Banner-style summary, falls back to the legacy `err.message`. */
  summary: string;
  /** Per-field issues from `body.errors[]` if the envelope is present. */
  issues: ScheduleWarningIssue[];
} {
  if (err instanceof ApiError) {
    const body = err.body as
      | {
          summary?: string;
          errors?: Array<{
            code: string;
            field: string;
            received: unknown;
            expected?: string;
            hint: string;
            validValues?: unknown;
            docsUrl?: string;
          }>;
        }
      | null;
    const summary = body?.summary ?? `${err.message} (${err.status})`;
    const issues: ScheduleWarningIssue[] = (body?.errors ?? []).map((issue) => ({
      code: issue.code,
      field: issue.field,
      received: issue.received,
      expected: issue.expected,
      hint: issue.hint,
      validValues: issue.validValues,
      docsUrl: issue.docsUrl,
    }));
    return { summary, issues };
  }
  if (err instanceof Error) {
    return { summary: err.message, issues: [] };
  }
  return { summary: "Unknown error", issues: [] };
}
