"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  BROWSER_TASK_TERMINAL_STATES,
  BROWSER_TASK_NON_TERMINAL_STATES,
  useBrowserTask,
  useCancelBrowserTask,
  useReRunBrowserTask,
  type BrowserTaskActionLogRow,
  type BrowserTaskClarificationRow,
  type BrowserTaskDetailWire,
  type BrowserTaskRowWire,
} from "@/lib/hooks/use-browser-tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { QueryResult } from "@/components/shared/query-result";
import { BrowserTaskStateBadge } from "@/components/browser-tasks/state-badge";
import { formatAbsoluteTime, formatDuration } from "@/lib/utils";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §9a.3 — per-task detail page.
 *
 * Sections (top to bottom): header, state timeline, allowlist card,
 * action log, clarification queue, final-confirm panel, completed
 * report. Empty / error states from §9a.8 (daemon-restarted explainer
 * + run-again, site-unregistered link).
 */
export default function BrowserTaskDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15+ async `params` (React 19's `use()`).
  const { id } = use(props.params);
  const { data, isLoading, isError, error, refetch } = useBrowserTask(id);

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href="/browser-tasks"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> All browser tasks
        </Link>
      </div>

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
      >
        {data && <BrowserTaskDetailBody data={data} taskId={id} />}
      </QueryResult>
    </div>
  );
}

function BrowserTaskDetailBody({
  data,
  taskId,
}: {
  data: BrowserTaskDetailWire;
  taskId: string;
}) {
  const cancel = useCancelBrowserTask();
  const rerun = useReRunBrowserTask();
  const router = useRouter();

  const isCancellable = (
    BROWSER_TASK_NON_TERMINAL_STATES as readonly string[]
  ).includes(data.state);
  const isTerminal = (
    BROWSER_TASK_TERMINAL_STATES as readonly string[]
  ).includes(data.state);
  const isDaemonRestarted = data.outcomeDetail === "daemon_restarted";
  const isSiteUnregistered = data.outcomeDetail === "site_unregistered";

  const handleCancel = () => {
    if (
      !window.confirm(
        `Cancel task ${data.id.slice(0, 8)}? The browser context will be released.`,
      )
    ) {
      return;
    }
    cancel.mutate({ taskId, reason: "user_cancel_from_dashboard" });
  };

  const handleRerun = async () => {
    try {
      const result = await rerun.mutateAsync({
        description: data.description,
        requireFinalConfirm: data.requireFinalConfirm,
      });
      // Land on the new task so the user sees the run progress instead
      // of staying on the (terminal) source row.
      router.push(`/browser-tasks/${result.taskId}`);
    } catch (err) {
      window.alert(
        `Re-run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleCopyJson = () => {
    void navigator.clipboard.writeText(
      JSON.stringify(
        {
          description: data.description,
          siteKey: data.siteKey,
          extraAllowedHosts: data.extraAllowedHosts,
          requireFinalConfirm: data.requireFinalConfirm,
        },
        null,
        2,
      ),
    );
  };

  return (
    <div className="space-y-6">
      {/* §9a.8 — daemon-restarted explainer */}
      {isDaemonRestarted && (
        <Alert variant="warning">
          <div className="space-y-1">
            <p className="font-medium">
              This task was interrupted by a daemon restart
            </p>
            <p>
              The browser context could not be resumed across the
              restart (BROWSER_TASK_REDESIGN_PLAN.md §6.5). Re-run as a
              new task to try again.
            </p>
            <div className="mt-2">
              <Button
                size="sm"
                onClick={handleRerun}
                disabled={rerun.isPending}
              >
                <RefreshCw className="mr-1 h-3 w-3" /> Run again
              </Button>
            </div>
          </div>
        </Alert>
      )}
      {isSiteUnregistered && (
        <Alert variant="warning">
          <div className="space-y-1">
            <p className="font-medium">
              The task&apos;s site is no longer registered
            </p>
            <p>
              The site registry changed between schedule time and fire
              time. Re-register the site under{" "}
              <Link
                href="/settings/integrations/browser-history-managed"
                className="underline"
              >
                Browser Automation
              </Link>{" "}
              and re-run the task.
            </p>
          </div>
        </Alert>
      )}

      {/* 1. Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Browser task
            </h1>
            <BrowserTaskStateBadge state={data.state} />
            <code className="rounded-md bg-muted px-2 py-0.5 text-xs">
              {data.id.slice(0, 8)}
            </code>
          </div>
          <p className="max-w-prose text-sm text-foreground">
            {data.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isCancellable && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={cancel.isPending}
            >
              <Ban className="mr-1 h-3 w-3" /> Cancel
            </Button>
          )}
          {isTerminal && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRerun}
              disabled={rerun.isPending}
            >
              <RefreshCw className="mr-1 h-3 w-3" /> Re-run as new task
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleCopyJson}>
            <ClipboardCopy className="mr-1 h-3 w-3" /> Copy as JSON
          </Button>
        </div>
      </header>

      {/* 2. State timeline */}
      <StateTimeline data={data} />

      {/* 2b. Queue state — only when the slot manager has something to
          say (waiting for a slot, or blocked by another task). Phase 1
          slot policy (§5.1). */}
      <QueueStateCard data={data} />

      {/* 3. Allowlist */}
      <AllowlistCard data={data} />

      {/* 4. Action log */}
      <ActionLogCard taskId={data.id} entries={data.actionLog} />

      {/* 5. Clarification queue */}
      <ClarificationCard rows={data.clarifications} state={data.state} />

      {/* 6. Final-confirm panel */}
      {data.state === "final_confirm" && (
        <FinalConfirmPanel taskId={data.id} />
      )}

      {/* 7. Report */}
      {data.state === "completed" && data.report && (
        <ReportCard report={data.report} />
      )}
    </div>
  );
}

// ── State timeline ────────────────────────────────────────────────────

function StateTimeline({ data }: { data: BrowserTaskRowWire }) {
  // We don't have a full transition history table; the row carries
  // three timestamps (created/started/finished) which are enough to
  // render a meaningful vertical stepper. A future revision can
  // back-fill from `browser_task_action_log` for a more granular view.
  const events: {
    label: string;
    at: number | null;
    actor: string;
  }[] = [
    { label: "Created", at: data.createdAt, actor: "user" },
    { label: "Started", at: data.startedAt, actor: "scheduler" },
    {
      label:
        data.state === "completed"
          ? "Completed"
          : (BROWSER_TASK_TERMINAL_STATES as readonly string[]).includes(
                data.state,
              )
            ? data.state.replace(/_/g, " ")
            : "In progress",
      at: data.finishedAt,
      actor:
        data.outcomeDetail === "daemon_restarted"
          ? "daemon-boot"
          : data.outcomeDetail === "user_cancel" || data.outcomeDetail?.startsWith("cancelled_in_queue")
            ? "user"
            : "agent",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <ol className="space-y-3">
        {events.map((e, idx) => (
          <li key={idx} className="flex items-start gap-3 text-sm">
            <span
              aria-hidden
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                e.at
                  ? "bg-primary"
                  : "border border-border bg-transparent"
              }`}
            />
            <div className="flex-1">
              <div className="font-medium text-foreground">{e.label}</div>
              <div className="text-xs text-muted-foreground">
                {e.at
                  ? `${formatAbsoluteTime(new Date(e.at))} — by ${e.actor}`
                  : "—"}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ── Queue state card ─────────────────────────────────────────────────

function QueueStateCard({ data }: { data: BrowserTaskDetailWire }) {
  const q = data.queueState;
  // Only render when the slot manager has something to say. Tasks that
  // promoted immediately (or have already terminated) carry no useful
  // queue payload — surfacing "position 0 of 0" would be noise.
  if (!q) return null;
  const interesting =
    q.waitingForSlot || q.sitePos > 0 || q.globalPos > 0 || !!q.blockedBy;
  if (!interesting) return null;

  return (
    <Card tone="warning">
      <CardHeader>
        <CardTitle className="text-base">Queue position</CardTitle>
      </CardHeader>
      <dl className="space-y-2 text-sm">
        {q.waitingForSlot && (
          <p className="text-xs text-muted-foreground">
            Waiting for a slot — the runner will start this task as soon as
            its siteKey slot and the global concurrency slot are both free
            (BROWSER_TASK_REDESIGN_PLAN.md §5.1).
          </p>
        )}
        <div className="flex items-baseline gap-2">
          <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
            Per-site queue
          </dt>
          <dd className="text-sm">#{q.sitePos + 1}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
            Global queue
          </dt>
          <dd className="text-sm">#{q.globalPos + 1}</dd>
        </div>
        {q.blockedBy && (
          <div className="flex items-baseline gap-2">
            <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
              Blocked by
            </dt>
            <dd className="text-xs">
              <Link
                href={`/browser-tasks/${q.blockedBy}`}
                className="font-mono underline-offset-4 hover:underline"
              >
                {q.blockedBy.slice(0, 8)}
              </Link>
              {q.blockedByPhase && (
                <span className="ml-2 text-muted-foreground">
                  ({q.blockedByPhase})
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

// ── Allowlist card ────────────────────────────────────────────────────

function AllowlistCard({ data }: { data: BrowserTaskRowWire }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Allowlist</CardTitle>
      </CardHeader>
      <dl className="space-y-2 text-sm">
        <div className="flex items-baseline gap-2">
          <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
            Site key
          </dt>
          <dd>
            {data.siteKey ? (
              <Badge variant="gray">{data.siteKey}</Badge>
            ) : (
              <span className="text-xs text-muted-foreground">none (anon — deferred)</span>
            )}
          </dd>
        </div>
        {data.extraAllowedHosts.length > 0 && (
          <div className="flex items-baseline gap-2">
            <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
              Extra hosts
            </dt>
            <dd className="flex flex-wrap gap-1">
              {data.extraAllowedHosts.map((h) => (
                <Badge key={h} variant="gray">
                  {h}
                </Badge>
              ))}
            </dd>
          </div>
        )}
        <div className="flex items-baseline gap-2">
          <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
            Composed regex
          </dt>
          <dd className="flex-1 break-all font-mono text-xs text-muted-foreground">
            {data.effectiveAllowlistRegex ?? "—"}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-32 text-xs uppercase tracking-wide text-muted-foreground">
            Blocked
          </dt>
          <dd className="text-xs text-muted-foreground">
            {data.blockedRequestsCount} requests blocked by CDP layer ·{" "}
            {data.extractCharsTotal.toLocaleString()} extract chars
          </dd>
        </div>
      </dl>
    </Card>
  );
}

// ── Action log ────────────────────────────────────────────────────────

function ActionLogCard({
  taskId,
  entries,
}: {
  taskId: string;
  entries: readonly BrowserTaskActionLogRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Action log ({entries.length} step{entries.length === 1 ? "" : "s"})
        </CardTitle>
      </CardHeader>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No actions yet. The sub-agent will populate this as it works.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <ActionLogRow key={e.id} taskId={taskId} entry={e} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function outcomeBadgeVariant(
  outcome: string,
): "green" | "red" | "amber" | "gray" {
  if (outcome === "ok") return "green";
  if (outcome === "denied" || outcome === "error") return "red";
  if (
    outcome.includes("block") ||
    outcome === "timeout" ||
    outcome.startsWith("popup") ||
    outcome.startsWith("dialog")
  ) {
    return "amber";
  }
  return "gray";
}

function ActionLogRow({
  taskId,
  entry,
}: {
  taskId: string;
  entry: BrowserTaskActionLogRow;
}) {
  const [expanded, setExpanded] = useState(false);
  // Soft truncation — the args field can be large (e.g., type tool with
  // a long form value); we summarize and let the user click to expand.
  // The daemon now emits args already-parsed (unknown), not an argsJson string.
  const parsedArgs: unknown = entry.args;
  const summary = renderArgsSummary(entry.toolName, parsedArgs);

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-3">
        <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
          {entry.stepIndex}
        </span>
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <code className="font-mono text-foreground">{entry.toolName}</code>
            <Badge variant={outcomeBadgeVariant(entry.outcome)}>
              {entry.outcome}
            </Badge>
            {entry.blockedReason && (
              <span className="text-xs text-muted-foreground">
                — {entry.blockedReason}
              </span>
            )}
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {formatDuration(entry.durationMs)}
            </span>
          </div>
          {summary && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span className="font-mono">{summary}</span>
            </button>
          )}
          {expanded && (
            <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-tight">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          )}
          {entry.screenshotKey && (
            <ScreenshotThumb
              taskId={taskId}
              fileName={entry.screenshotKey}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function renderArgsSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (toolName === "navigate" && typeof a.url === "string") {
    return `navigate → ${truncate(a.url, 80)}`;
  }
  if (toolName === "type" && typeof a.text === "string") {
    return `type ${truncate(a.text, 60)}`;
  }
  if (toolName === "extract" && typeof a.queryHint === "string") {
    return `extract ${truncate(a.queryHint, 60)}`;
  }
  if (toolName === "wait_for") {
    const sel = (a.selector ?? a.urlPattern ?? "") as string;
    return `wait_for ${truncate(sel, 60)}`;
  }
  return "click for args";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function ScreenshotThumb({
  taskId,
  fileName,
}: {
  taskId: string;
  fileName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const url = `/api/browser-task/${taskId}/screenshots/${encodeURIComponent(fileName)}`;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" />
        {expanded ? "Hide screenshot" : "Show screenshot"}{" "}
        <span className="font-mono">{fileName}</span>
      </button>
      {expanded && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          loading="lazy"
          src={url}
          alt={`Screenshot ${fileName}`}
          className="mt-2 max-h-96 max-w-full rounded-md border border-border"
        />
      )}
    </div>
  );
}

// ── Clarification queue ──────────────────────────────────────────────

function ClarificationCard({
  rows,
  state,
}: {
  rows: readonly BrowserTaskClarificationRow[];
  state: BrowserTaskRowWire["state"];
}) {
  if (rows.length === 0 && state !== "awaiting_user") return null;
  const openRow = rows.find((r) => !r.resolved);

  return (
    <Card tone={openRow ? "warning" : "default"}>
      <CardHeader>
        <CardTitle className="text-base">Clarifications</CardTitle>
      </CardHeader>
      {openRow && (
        // §9a.3 — the dashboard intentionally does NOT collect the
        // answer (DM is the chokepoint for the resume path).
        <Alert variant="warning" className="mb-3">
          <div className="space-y-1">
            <p className="font-medium">
              This task is waiting on you in DM
            </p>
            <p>
              Reply to the agent&apos;s question in the originating DM
              channel — the dashboard is read-only for clarification
              answers so the resume path stays single-source.
            </p>
          </div>
        </Alert>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No clarification has been recorded yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {rows.map((r) => (
            <ClarificationRow key={r.id} row={r} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function ClarificationRow({ row }: { row: BrowserTaskClarificationRow }) {
  const isOpen = !row.resolved;
  // Snapshot "now" at mount via a lazy useState initializer — the React Compiler
  // purity rule (react-hooks/purity) rejects a bare Date.now() during render.
  const [now] = useState(() => Date.now());
  const remainingMs = row.deadlineAt - now;
  const deadlineLabel = remainingMs > 0
    ? `${formatDuration(remainingMs)} remaining`
    : `${formatDuration(-remainingMs)} past deadline`;
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">Q: {row.question}</span>
        <Badge variant={isOpen ? "amber" : "green"}>
          {isOpen ? "Awaiting reply" : "Resolved"}
        </Badge>
      </div>
      {row.contextSummary && (
        <p className="mt-1 text-xs text-muted-foreground">
          {row.contextSummary}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>Asked {formatAbsoluteTime(new Date(row.askedAt))}</span>
        {isOpen ? (
          <span>{deadlineLabel}</span>
        ) : row.answer ? (
          <span className="text-foreground">A: {row.answer}</span>
        ) : null}
      </div>
    </li>
  );
}

// ── Final-confirm panel ──────────────────────────────────────────────

function FinalConfirmPanel({ taskId }: { taskId: string }) {
  return (
    <Card tone="warning">
      <CardHeader>
        <CardTitle className="text-base">Final-confirm token issued</CardTitle>
      </CardHeader>
      <Alert variant="warning" className="mb-3">
        <div className="space-y-1">
          <p className="font-medium">
            The agent is waiting for your token in DM
          </p>
          <p>
            A pre-confirm screenshot + a single-use{" "}
            <code className="font-mono">!~xxxxxxxx</code> token was DMed
            to your originating channel. Reply with the token to let
            the activation proceed, or cancel the task below to abort
            it. The token has a 5-min TTL.
          </p>
        </div>
      </Alert>
      <p className="text-xs text-muted-foreground">
        The token itself is not shown here — DM is the second factor by
        design (BROWSER_TASK_REDESIGN_PLAN.md §9a.3 #6).
      </p>
      <div className="mt-3">
        <Link
          href={`/browser-tasks/${taskId}`}
          className="text-xs underline-offset-4 hover:underline"
        >
          Refresh
        </Link>
      </div>
    </Card>
  );
}

// ── Completed report ─────────────────────────────────────────────────

function ReportCard({ report }: { report: string }) {
  return (
    <Card tone="success">
      <CardHeader>
        <CardTitle className="text-base">Final report</CardTitle>
      </CardHeader>
      <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap break-words">
        {report}
      </div>
    </Card>
  );
}
