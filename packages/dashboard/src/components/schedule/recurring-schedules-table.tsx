"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { CalendarRange, Edit2, Trash2 } from "lucide-react";
import {
  useRecurringSchedules,
  useUpdateRecurringSchedule,
  useDeleteRecurringSchedule,
} from "@/lib/hooks/use-recurring-schedules";
import {
  EMPTY_FORM_STATE,
  ScheduleForm,
  toSubmitPayload,
  validateScheduleForm,
  type ScheduleFormErrors,
  type ScheduleFormState,
} from "./schedule-form";
import {
  ScheduleWarningsList,
  describeMutationError,
} from "./schedule-warnings";
import type {
  RecurringScheduleDTO,
  ScheduleWarningIssue,
} from "@/lib/api-types";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/lib/utils";
import { formatShortModelName, modelBadgeVariant } from "@/lib/backend-ui";

/**
 * Pure DTO → form-state mapping. Exported so the unit tests in
 * `schedule-form.test.ts` can cover the hourly + onMissingDay round-trip
 * without spinning up the Sheet.
 *
 * Key invariants:
 *   - `frequency` is `hourly|daily|weekly|monthly` (the recurring DTO
 *     never carries "once"; that's a client-only sentinel for the
 *     create flow).
 *   - `model` is free-form per §4.3 — store it verbatim. The Phase D
 *     daemon normalises aliases (`sonnet`/`opus`) into `tier_override`
 *     on insert, so any value coming back here is either an empty
 *     string (no pin) or a concrete model id.
 *   - `recurringTime` falls back to `"00:00"` for hourly rules so the
 *     placeholder is non-empty when the operator flips the frequency.
 */
export function dtoToFormState(dto: RecurringScheduleDTO): ScheduleFormState {
  const r = dto.recurrenceRule;
  return {
    ...EMPTY_FORM_STATE,
    frequency: r.frequency,
    oneOffDateTime: "",
    recurringTime: r.time ?? "00:00",
    intervalHours: r.intervalHours ?? 1,
    minuteOfHour: r.minuteOfHour ?? 0,
    daysOfWeek: r.daysOfWeek ?? [],
    daysOfMonth: r.daysOfMonth ?? [],
    onMissingDay: r.onMissingDay ?? "",
    model: dto.model ?? "",
    description: dto.description,
    prompt: dto.prompt ?? "",
  };
}

function EditRecurringSheet({
  dto,
  open,
  onOpenChange,
}: {
  dto: RecurringScheduleDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Keep the Sheet root mounted across open→closed so Radix can clear its
  // body pointer-events lock. Unmounting the Root while open freezes clicks
  // page-wide (e.g. tab switcher on the Agent Log page).
  // Key by dto.id so the content remounts and reseeds its form state when
  // a different row is opened.
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {dto && (
        <EditRecurringSheetContent
          key={dto.id}
          dto={dto}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Sheet>
  );
}

function EditRecurringSheetContent({
  dto,
  onClose,
}: {
  dto: RecurringScheduleDTO;
  onClose: () => void;
}) {
  const [state, setState] = useState<ScheduleFormState>(() => dtoToFormState(dto));
  const [errors, setErrors] = useState<ScheduleFormErrors | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ScheduleWarningIssue[]>([]);
  const [warnings, setWarnings] = useState<ScheduleWarningIssue[]>([]);
  const [savedWithWarnings, setSavedWithWarnings] = useState(false);
  const update = useUpdateRecurringSchedule();

  const initialModel = dto.model ?? "";

  const handleSave = async () => {
    if (savedWithWarnings) {
      onClose();
      return;
    }
    const validation = validateScheduleForm(state);
    setErrors(validation);
    if (validation) return;
    const payload = toSubmitPayload(state);
    if (payload.kind !== "recurring") {
      setError("Cannot convert a recurring schedule to a one-off — delete and recreate.");
      return;
    }
    try {
      // Build the PATCH body. We always send the rule + description +
      // prompt (the daemon ignores no-ops). For `model`, we send the
      // chosen value when present; an empty string clears the pin by
      // explicit `null` (the API distinguishes "no change" / "clear" /
      // "set" — see §4.3a / the resolveModelTokenForPatch contract).
      const trimmedModel = state.model.trim();
      const modelDirective =
        trimmedModel === ""
          ? initialModel !== ""
            ? { model: null as null }
            : {}
          : trimmedModel !== initialModel
            ? { model: trimmedModel }
            : {};
      const response = await update.mutateAsync({
        id: dto.id,
        description: payload.body.description,
        // `prompt: undefined` from payload means "user left it empty" — convert
        // to `null` so the daemon clears any existing override (instead of
        // leaving a stale prompt in place).
        prompt: payload.body.prompt ?? null,
        recurrenceRule: payload.body.recurrenceRule,
        ...modelDirective,
      });
      const responseWarnings = response.warnings ?? [];
      if (responseWarnings.length > 0) {
        setWarnings(responseWarnings);
        setSavedWithWarnings(true);
        return;
      }
      onClose();
    } catch (e) {
      const { summary, issues } = describeMutationError(e);
      setError(summary);
      setServerIssues(issues);
    }
  };

  return (
    <SheetContent className="flex flex-col gap-4 overflow-y-auto">
      <SheetHeader className="pr-8">
        <SheetTitle>Edit recurring schedule #{dto.id}</SheetTitle>
      </SheetHeader>
      <ScheduleForm
        state={state}
        onChange={setState}
        errors={errors}
        lockFrequency
        onEdit={() => {
          if (errors) setErrors(null);
          if (error) setError(null);
          if (serverIssues.length > 0) setServerIssues([]);
          if (savedWithWarnings) {
            setSavedWithWarnings(false);
            setWarnings([]);
          }
        }}
      />
      {error ? (
        <Alert variant="error">
          <div className="font-medium">{error}</div>
          {serverIssues.length > 0 ? (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
              {serverIssues.map((issue, idx) => (
                <li key={`${issue.code}:${idx}`}>
                  <span className="font-mono text-[11px] opacity-80">
                    {issue.code}
                  </span>
                  <span className="ml-2">{issue.hint}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      <ScheduleWarningsList warnings={warnings} />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={onClose}
          disabled={update.isPending}
        >
          {savedWithWarnings ? "Close" : "Cancel"}
        </Button>
        <Button onClick={handleSave} disabled={update.isPending}>
          {update.isPending
            ? "Saving..."
            : savedWithWarnings
              ? "Acknowledge"
              : "Save"}
        </Button>
      </div>
    </SheetContent>
  );
}

export function RecurringSchedulesTable() {
  const { data, isLoading, isError, error, refetch } = useRecurringSchedules();
  const update = useUpdateRecurringSchedule();
  const remove = useDeleteRecurringSchedule();
  const [editing, setEditing] = useState<RecurringScheduleDTO | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleToggle = async (dto: RecurringScheduleDTO) => {
    setActionError(null);
    try {
      await update.mutateAsync({ id: dto.id, enabled: !dto.enabled });
    } catch (e) {
      setActionError(describeMutationError(e).summary);
    }
  };

  const handleDelete = async (dto: RecurringScheduleDTO) => {
    setActionError(null);
    if (!confirm(`Delete recurring schedule "${dto.description.slice(0, 40)}..."?`)) return;
    try {
      await remove.mutateAsync(dto.id);
    } catch (e) {
      setActionError(describeMutationError(e).summary);
    }
  };

  const items = data?.items ?? [];

  return (
    <>
      {actionError ? <Alert variant="error">{actionError}</Alert> : null}
      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<TableSkeleton rows={3} />}
      >
        {items.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No recurring schedules"
            description="Create one with the Schedule button — pick hourly, daily, weekly (with weekdays), or monthly cadence."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left" aria-label="Recurring schedules">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Cadence</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Next run</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Enabled</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-b border-border">
                    <td className="px-3 py-2 text-sm">{it.recurrenceLabel}</td>
                    <td className="max-w-md px-3 py-2 text-sm">
                      <div className="flex items-start gap-2">
                        <span className="line-clamp-2 flex-1">{it.description}</span>
                        {it.prompt ? (
                          <Tooltip>
                            <TooltipTrigger>
                              <Badge variant="purple" className="shrink-0">prompt</Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Description above is the list label; a separate prompt is what the agent receives. Open the row to view or edit.
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {it.model ? (
                        <Badge variant={modelBadgeVariant(it.model)}>
                          {formatShortModelName(it.model)}
                        </Badge>
                      ) : (
                        <Badge variant="gray">default</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {it.nextRunAt ? (
                        <>
                          <div>{formatAbsoluteTime(it.nextRunAt)}</div>
                          <div className="text-muted-foreground">
                            {formatRelativeTime(it.nextRunAt)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant={it.enabled ? "default" : "outline"}
                        onClick={() => handleToggle(it)}
                        disabled={update.isPending}
                      >
                        {it.enabled ? "On" : "Off"}
                      </Button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditing(it)}
                          aria-label="Edit recurring schedule"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDelete(it)}
                          disabled={remove.isPending}
                          aria-label="Delete recurring schedule"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryResult>

      <EditRecurringSheet
        dto={editing}
        open={editing !== null}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
      />
    </>
  );
}
