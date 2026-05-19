"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Edit2,
  PlayCircle,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  DOMAINS,
  ENTITY_TYPES,
  MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING,
  MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
  TYPE_PLURALS,
  type Domain,
  type EntityType,
  type ManagedTask,
} from "@aitne/shared";
import {
  useDeleteManagedTask,
  useManagedTask,
  useManagedTaskRuns,
  useManagedTasks,
  useRenameManagedTaskApp,
  useRunManagedTaskNow,
  useUpdateManagedTask,
} from "@/lib/hooks/use-managed-tasks";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/lib/utils";
import {
  composeOutputPath,
  extractError,
  isOverSoftWarning,
  modifySheetDirty,
  parseOutputPath,
} from "./managed-tasks-card.logic";
import { RecurrenceRuleEditor } from "./recurrence-rule-editor";
import {
  recurrenceRulesEqual,
  validateRecurrenceRule,
  type RecurrenceFormErrors,
} from "./recurrence-rule-editor.logic";

/**
 * Section B — Managed Tasks (docs/design/21-management-registry-and-
 * entities.md §10.1–10.5).
 *
 * Lists active rows. The table is read-mostly; the Modify sheet edits
 * `intent`, `cadence`, and `output_path` (cadence schedule edits route
 * through `recurring_schedules` server-side — but the rendered cadence
 * label is what the agent sees, so we expose that here). Stop is hard-
 * delete with a destructive confirm dialog.
 *
 * Registration is intentionally agent-driven (LLM dedup + connector
 * probe per §10.1 step 2-4). The dashboard does NOT expose a "create"
 * form: the user types "Check Zoom daily at 10 AM" and the
 * `management-task-register` skill handles the rest. A dashboard-side
 * shortcut would bypass dedup + the connector probe and create
 * orphaned schedules.
 */

interface FailureBadgeProps {
  task: ManagedTask;
  threshold: number;
}

function StatusBadge({ task, threshold }: FailureBadgeProps) {
  if (task.consecutive_failures >= threshold) {
    return (
      <Badge variant="red" className="gap-1">
        <XCircle className="h-3 w-3" />
        {task.consecutive_failures}× failing
      </Badge>
    );
  }
  if (task.consecutive_failures > 0) {
    return (
      <Badge variant="amber" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        {task.consecutive_failures}× recently failed
      </Badge>
    );
  }
  if (!task.last_run_at) {
    return (
      <Badge variant="gray" className="gap-1">
        <Clock className="h-3 w-3" />
        not yet run
      </Badge>
    );
  }
  return (
    <Badge variant="green" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      ok
    </Badge>
  );
}

export function ManagedTasksCard({
  failureThreshold = MANAGEMENT_FAILURE_NOTIFY_THRESHOLD_DEFAULT,
}: {
  failureThreshold?: number;
}) {
  const query = useManagedTasks();
  const [editTask, setEditTask] = useState<ManagedTask | null>(null);
  // §NFR-1a / NFR-8: warn when the active count crosses the soft
  // threshold so the user notices before the rendered file starts
  // bumping into the 32 KB policy-files cap.
  const activeCount = query.data?.count ?? 0;
  const overSoftWarning = isOverSoftWarning(activeCount);

  return (
    <Card className="space-y-4">
      <CardHeader className="p-0">
        <div>
          <CardTitle className="text-base">B. Managed tasks</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground max-w-prose">
            Recurring read-only fetches the agent runs against external apps.
            New tasks are registered through DM (e.g.{" "}
            <code>&ldquo;Check Zoom daily at 10 AM&rdquo;</code>) so the
            <code className="ml-0.5">management-task-register</code> skill can
            run dedup and a live connector probe before commit.
          </p>
        </div>
        <div
          className={
            overSoftWarning
              ? "text-xs font-medium text-amber-600"
              : "text-xs text-muted-foreground"
          }
          title={
            overSoftWarning
              ? `≥ ${MANAGEMENT_ACTIVE_TASKS_SOFT_WARNING} active tasks — rendered management.md may approach the 32 KB policy-files cap.`
              : undefined
          }
        >
          {query.data ? `${activeCount} active` : ""}
        </div>
      </CardHeader>

      <QueryResult
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error as Error | null}
        onRetry={() => query.refetch()}
        skeleton={<TableSkeleton rows={3} />}
      >
        {!query.data || query.data.items.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No managed tasks yet"
            description='Send the agent a DM like "Check Zoom daily at 10 AM" to register one.'
          />
        ) : (
          <ManagedTasksTable
            items={query.data.items}
            failureThreshold={failureThreshold}
            onEdit={setEditTask}
          />
        )}
      </QueryResult>

      <EditManagedTaskSheet
        task={editTask}
        onClose={() => setEditTask(null)}
      />
    </Card>
  );
}

function ManagedTasksTable({
  items,
  failureThreshold,
  onEdit,
}: {
  items: ManagedTask[];
  failureThreshold: number;
  onEdit: (task: ManagedTask) => void;
}) {
  const runNow = useRunManagedTaskNow();
  const remove = useDeleteManagedTask();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleRunNow = async (task: ManagedTask) => {
    setError(null);
    setBusyId(task.id);
    try {
      await runNow.mutateAsync({ id: task.id, reason: "dashboard" });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (task: ManagedTask) => {
    const ok = await confirm({
      title: `Stop ${task.id}?`,
      description: `Hard-deletes the row and the underlying recurring schedule. The history stays in agent_actions and can be reviewed under History. Type the id to confirm.`,
      requireText: task.id,
      confirmLabel: "Stop",
      cancelLabel: "Cancel",
      variant: "destructive",
    });
    if (!ok) return;
    setError(null);
    setBusyId(task.id);
    try {
      await remove.mutateAsync(task.id);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-2 font-medium">ID</th>
              <th className="px-2 py-2 font-medium">Intent</th>
              <th className="px-2 py-2 font-medium">App</th>
              <th className="px-2 py-2 font-medium">Cadence</th>
              <th className="px-2 py-2 font-medium">Output path</th>
              <th className="px-2 py-2 font-medium">Last run</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="w-32 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((task) => (
              <tr
                key={task.id}
                className="border-b border-border/40 align-top text-xs"
              >
                <td className="px-2 py-2 font-mono text-[11px]">{task.id}</td>
                <td className="px-2 py-2">{task.intent}</td>
                <td className="px-2 py-2">{task.app}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {task.cadence}
                </td>
                <td className="px-2 py-2 font-mono text-[11px]">
                  {task.output_path ?? (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  {task.last_run_at ? (
                    <>
                      <span title={formatAbsoluteTime(task.last_run_at)}>
                        {formatRelativeTime(task.last_run_at)}
                      </span>
                      {task.last_result && (
                        <span className="block text-[11px] text-muted-foreground/70">
                          {task.last_result}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <StatusBadge task={task} threshold={failureThreshold} />
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Run ${task.id} now`}
                      title="Run now"
                      onClick={() => handleRunNow(task)}
                      disabled={busyId === task.id}
                      className="h-7 w-7"
                    >
                      <PlayCircle className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Modify ${task.id}`}
                      title="Modify"
                      onClick={() => onEdit(task)}
                      disabled={busyId === task.id}
                      className="h-7 w-7"
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Stop ${task.id}`}
                      title="Stop"
                      onClick={() => handleStop(task)}
                      disabled={busyId === task.id}
                      className="h-7 w-7 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <Alert variant="error" className="text-xs">
          {error}
        </Alert>
      )}
    </div>
  );
}

// ── Modify sheet ──────────────────────────────────────────────────────────

function EditManagedTaskSheet({
  task,
  onClose,
}: {
  task: ManagedTask | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      {task && (
        <EditManagedTaskSheetContent
          key={task.id}
          task={task}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function EditManagedTaskSheetContent({
  task,
  onClose,
}: {
  task: ManagedTask;
  onClose: () => void;
}) {
  const detail = useManagedTask(task.id);
  const update = useUpdateManagedTask();
  const renameApp = useRenameManagedTaskApp();
  const runs = useManagedTaskRuns(task.id, 25);
  const confirm = useConfirm();
  const [intent, setIntent] = useState(task.intent);
  const [cadence, setCadence] = useState(task.cadence);
  const [outputPathState, setOutputPathState] = useState<{
    domain: Domain | "";
    type: EntityType | "";
  }>(() => parseOutputPath(task.output_path));
  const [recurrence, setRecurrence] = useState<
    import("@/lib/api-types").RecurrenceRule | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the structured rule when the detail GET resolves. The fetch is
  // keyed on `task.id` so re-opening the sheet for a different task
  // refreshes the rule. We intentionally do NOT overwrite a draft the
  // user has already started editing (`recurrence !== null`) — that
  // would silently undo their change if a refetch fired mid-edit.
  //
  // useEffect (not a render-time setState) so React 19's StrictMode does
  // not flag the seed as a render-side effect. The dependency on
  // `detail.data?.recurrenceRule` re-runs the seed when a refetch
  // resolves, but the `recurrence === null` guard makes it idempotent
  // for an already-seeded sheet.
  const fetchedRule = detail.data?.recurrenceRule ?? null;
  useEffect(() => {
    if (recurrence === null && fetchedRule !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecurrence(fetchedRule);
    }
  }, [recurrence, fetchedRule]);
  const baselineRule = fetchedRule;

  const composedOutputPath = useMemo(
    () => composeOutputPath(outputPathState),
    [outputPathState],
  );

  const recurrenceErrors: RecurrenceFormErrors | null = useMemo(
    () => (recurrence ? validateRecurrenceRule(recurrence) : null),
    [recurrence],
  );

  const dirty = useMemo(
    () =>
      modifySheetDirty(
        {
          intent,
          cadence,
          outputPath: composedOutputPath,
          recurrenceRule: recurrence,
        },
        { task, recurrenceRule: baselineRule },
      ),
    [intent, cadence, composedOutputPath, recurrence, task, baselineRule],
  );

  const intentValid = intent.trim().length > 0 && intent.trim().length <= 200;
  const cadenceValid =
    cadence.trim().length > 0 && cadence.trim().length <= 200;
  const canSave =
    dirty && intentValid && cadenceValid && recurrenceErrors === null;

  const handleSave = async () => {
    setError(null);
    const patch: Parameters<typeof update.mutateAsync>[0] = { id: task.id };
    if (intent.trim() !== task.intent) patch.intent = intent.trim();
    if (cadence.trim() !== task.cadence) patch.cadence = cadence.trim();
    if (composedOutputPath !== task.output_path) {
      patch.output_path = composedOutputPath;
    }
    if (recurrence && !recurrenceRulesEqual(recurrence, baselineRule)) {
      // Send recurrenceRule only when the structured form actually
      // changed. Keeps the patch minimal so the server's audit row's
      // `changed` array doesn't grow spurious entries when only the
      // cadence label moved. Same comparator the dirty-check uses.
      patch.recurrenceRule = recurrence;
    }
    try {
      await update.mutateAsync(patch);
      onClose();
    } catch (err) {
      setError(extractError(err));
    }
  };

  const handleClearPath = () => {
    setOutputPathState({ domain: "", type: "" });
  };

  const handleRenameApp = async () => {
    const newAppRaw = window.prompt(
      `Rename ${task.app} to:`,
      task.app,
    );
    if (newAppRaw === null) return;
    const newApp = newAppRaw.trim();
    if (newApp === "" || newApp === task.app) return;
    const ok = await confirm({
      title: `Rename ${task.id}'s app to "${newApp}"?`,
      description: `Rewrites every entity file's frontmatter \`sources.${task.app}\` to \`sources.${newApp}\`. Irreversible — entity files are touched on disk. Type the task id to confirm.`,
      requireText: task.id,
      confirmLabel: "Rename app",
      cancelLabel: "Cancel",
      variant: "destructive",
    });
    if (!ok) return;
    setError(null);
    try {
      await renameApp.mutateAsync({ id: task.id, newApp });
    } catch (err) {
      setError(extractError(err));
    }
  };

  return (
    <SheetContent className="flex w-full max-w-xl flex-col gap-4 overflow-y-auto">
      <SheetHeader>
        <SheetTitle>Modify {task.id}</SheetTitle>
        <p className="text-xs text-muted-foreground">
          {task.app} · created {formatAbsoluteTime(task.created_at)}
        </p>
      </SheetHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="intent">
            Intent
          </label>
          <Input
            id="intent"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            maxLength={200}
          />
          <p className="text-[11px] text-muted-foreground">
            Free text (≤200 chars). Rendered in the management.md table and
            included in the scheduled-task description.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="cadence">
            Cadence label
          </label>
          <Input
            id="cadence"
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            maxLength={200}
            placeholder="daily 10:00 (Asia/Tokyo)"
          />
          <p className="text-[11px] text-muted-foreground">
            Free-text label rendered in §B. The structured fire schedule
            is edited below — they round-trip independently so the agent
            can keep its preferred phrasing while the cron form moves.
          </p>
        </div>

        <div className="space-y-1.5 rounded-md border border-border/60 p-3">
          <p className="text-xs font-medium">Schedule</p>
          {detail.isLoading && !recurrence && (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          )}
          {detail.isError && (
            <Alert variant="error" className="text-xs">
              Could not load the recurring schedule. Save other fields, or
              refresh and retry.
            </Alert>
          )}
          {recurrence && (
            <RecurrenceRuleEditor
              rule={recurrence}
              onChange={setRecurrence}
              errors={recurrenceErrors}
            />
          )}
          <p className="text-[10px] text-muted-foreground">
            Underlying schedule: <code>rs:{task.schedule_id}</code>. Saving
            updates the same row — the daemon regenerates the next
            <code className="ml-0.5">agent_schedule</code> fire.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium">Output path</label>
          <div className="flex items-center gap-2">
            <Select
              value={outputPathState.domain}
              onValueChange={(v) =>
                setOutputPathState((prev) => ({
                  ...prev,
                  domain: v as Domain,
                }))
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="domain" />
              </SelectTrigger>
              <SelectContent>
                {DOMAINS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">/</span>
            <Select
              value={outputPathState.type}
              onValueChange={(v) =>
                setOutputPathState((prev) => ({
                  ...prev,
                  type: v as EntityType,
                }))
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="type" />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_PLURALS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClearPath}
              className="h-8 px-2 text-xs"
            >
              Clear
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Where this task writes entity files. Composed path:{" "}
            <code className="font-mono">
              {composedOutputPath ?? "—"}
            </code>
          </p>
        </div>

        {error && (
          <Alert variant="error" className="text-xs">
            {error}
          </Alert>
        )}

        <div className="flex justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRenameApp}
            disabled={renameApp.isPending || update.isPending}
            className="text-destructive hover:text-destructive"
          >
            Rename app…
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={!canSave || update.isPending}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Recent activity
        </h4>
        {runs.isLoading && (
          <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
        )}
        {runs.data && runs.data.runs.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            No history recorded yet.
          </p>
        )}
        {runs.data && runs.data.runs.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {runs.data.runs.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-2 rounded-md border border-border/40 px-2 py-1.5 text-[11px]"
              >
                <span
                  className={
                    row.result === "success"
                      ? "text-emerald-500"
                      : row.result === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  ●
                </span>
                <div className="flex-1">
                  <code className="font-mono text-[10px]">
                    {row.kind.replace("management_task.", "")}
                  </code>
                  {row.startedAt && (
                    <span
                      className="ml-2 text-muted-foreground"
                      title={formatAbsoluteTime(row.startedAt)}
                    >
                      {formatRelativeTime(row.startedAt)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SheetContent>
  );
}

