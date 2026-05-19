"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
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
import { useCreateSchedule } from "@/lib/hooks/use-schedule-mutations";
import { useCreateRecurringSchedule } from "@/lib/hooks/use-recurring-schedules";
import type { ScheduleWarningIssue } from "@/lib/api-types";

export function CreateScheduleSheet({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ScheduleFormState>(EMPTY_FORM_STATE);
  const [errors, setErrors] = useState<ScheduleFormErrors | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ScheduleWarningIssue[]>([]);
  const [warnings, setWarnings] = useState<ScheduleWarningIssue[]>([]);
  /** True once a save succeeded and only warnings keep the sheet open. */
  const [savedWithWarnings, setSavedWithWarnings] = useState(false);

  const createOnce = useCreateSchedule();
  const createRecurring = useCreateRecurringSchedule();
  const submitting = createOnce.isPending || createRecurring.isPending;

  const reset = () => {
    setState(EMPTY_FORM_STATE);
    setErrors(null);
    setSubmitError(null);
    setServerIssues([]);
    setWarnings([]);
    setSavedWithWarnings(false);
  };

  const handleSubmit = async () => {
    // SCHEDULE_API_REDESIGN_PLAN §5.0.5 — the warnings channel is
    // non-blocking. Once the user has acknowledged a saved-with-warnings
    // state, the next click closes the sheet rather than re-submitting.
    if (savedWithWarnings) {
      setOpen(false);
      reset();
      return;
    }

    const validation = validateScheduleForm(state);
    setErrors(validation);
    if (validation) return;

    setSubmitError(null);
    setServerIssues([]);
    setWarnings([]);
    const payload = toSubmitPayload(state);
    try {
      const response =
        payload.kind === "once"
          ? await createOnce.mutateAsync(payload.body)
          : await createRecurring.mutateAsync(payload.body);
      const responseWarnings = response.warnings ?? [];
      if (responseWarnings.length > 0) {
        // Hold the sheet open so the user sees the §5.0.5 advisories.
        setWarnings(responseWarnings);
        setSavedWithWarnings(true);
        return;
      }
      setOpen(false);
      reset();
    } catch (err) {
      const { summary, issues } = describeMutationError(err);
      setSubmitError(summary);
      setServerIssues(issues);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="flex flex-col gap-4 overflow-y-auto">
        <SheetHeader className="pr-8">
          <SheetTitle>New scheduled task</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Runs in a fresh per-session workdir. The
            <code className="mx-1">notify</code>and
            <code className="mx-1">schedule</code>skills are provisioned, so
            the agent can DM you and reschedule itself.
          </p>
        </SheetHeader>

        <ScheduleForm
          state={state}
          onChange={setState}
          errors={errors}
          onEdit={() => {
            if (errors) setErrors(null);
            if (submitError) setSubmitError(null);
            if (serverIssues.length > 0) setServerIssues([]);
            // User started editing again after a "saved with warnings" pause —
            // treat the next click as a fresh submit, not the acknowledge step.
            if (savedWithWarnings) {
              setSavedWithWarnings(false);
              setWarnings([]);
            }
          }}
        />

        {submitError ? (
          <Alert variant="error">
            <div className="font-medium">{submitError}</div>
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
            onClick={() => {
              setOpen(false);
              reset();
            }}
            disabled={submitting}
          >
            {savedWithWarnings ? "Close" : "Cancel"}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? "Saving..."
              : savedWithWarnings
                ? "Acknowledge"
                : "Create"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
