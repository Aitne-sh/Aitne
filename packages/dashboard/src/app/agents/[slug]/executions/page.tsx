"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronRight, History } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryResult } from "@/components/shared/query-result";
import { EmptyState } from "@/components/shared/empty-state";
import {
  useAgentExecutionsInfinite,
  useAgentLiveRefresh,
} from "@/lib/hooks/use-agents";
import {
  executionDurationMs,
  formatCostUsd,
  formatDurationShort,
  resultBadgeVariant,
} from "@/lib/agents/format";
import type { AgentExecution, AgentExecutionResult } from "@/lib/agents/types";

const RESULT_FILTERS: { value: "all" | AgentExecutionResult; label: string }[] = [
  { value: "all", label: "All" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "timeout", label: "Timeout" },
  { value: "skipped", label: "Skipped" },
];

export default function AgentExecutionsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  useAgentLiveRefresh();

  const [result, setResult] = useState<"all" | AgentExecutionResult>("all");
  const query = useAgentExecutionsInfinite(slug, {
    result: result === "all" ? undefined : result,
  });

  const executions = useMemo(
    () => query.data?.pages.flatMap((p) => p.executions) ?? [],
    [query.data],
  );

  return (
    <div className="space-y-6 p-6">
      <Link
        href={`/agents/${slug}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to {slug}
      </Link>

      <PageHeader
        title="Execution history"
        description={
          <>
            Every recorded run of <code>{slug}</code>. Expand a row to see cost, tokens, turns,
            error detail, and success-criteria results.
          </>
        }
      />

      <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Result filter">
        {RESULT_FILTERS.map((f) => (
          <Button
            key={f.value}
            variant={result === f.value ? "default" : "outline"}
            size="sm"
            onClick={() => setResult(f.value)}
            aria-pressed={result === f.value}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <QueryResult
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        onRetry={() => query.refetch()}
      >
        {executions.length === 0 ? (
          <EmptyState icon={History} title="No executions" description="This Agent has not run yet." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Trigger</th>
                  <th className="px-3 py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((e) => (
                  <ExecutionRow key={e.id} execution={e} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </QueryResult>
    </div>
  );
}

function ExecutionRow({ execution: e }: { execution: AgentExecution }) {
  const [open, setOpen] = useState(false);
  const criteria = e.success_criteria ? Object.entries(e.success_criteria) : [];
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="px-3 py-2 text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
          {e.started_at ? new Date(e.started_at).toLocaleString() : "—"}
        </td>
        <td className="px-3 py-2">
          <Badge variant={resultBadgeVariant(e.result)}>{e.result ?? "running"}</Badge>
        </td>
        <td className="px-3 py-2 tabular-nums">{formatDurationShort(executionDurationMs(e))}</td>
        <td className="px-3 py-2 text-xs text-muted-foreground">{e.trigger ?? "—"}</td>
        <td className="px-3 py-2 tabular-nums">{formatCostUsd(e.cost_usd)}</td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={6} className="px-6 py-3">
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <Detail label="Execution id">#{e.id}</Detail>
              <Detail label="Schedule row">{e.schedule_row_id ?? "—"}</Detail>
              <Detail label="Tokens in / out">
                {e.tokens_input ?? "—"} / {e.tokens_output ?? "—"}
              </Detail>
              <Detail label="Turns">{e.turns ?? "—"}</Detail>
              {e.error_kind && <Detail label="Error kind">{e.error_kind}</Detail>}
              {e.error_message && <Detail label="Error">{e.error_message}</Detail>}
            </dl>

            {criteria.length > 0 && (
              <div className="mt-2">
                <div className="text-xs font-medium text-muted-foreground">Success criteria</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {criteria.map(([id, hit]) => (
                    <Badge key={id} variant={hit ? "green" : "red"}>
                      {hit ? "✓" : "✗"} {id}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {e.output_summary && (
              <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {e.output_summary}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="font-medium text-muted-foreground">{label}:</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}
