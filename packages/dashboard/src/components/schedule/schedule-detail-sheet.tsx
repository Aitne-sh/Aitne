"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import type { ScheduleRow, ScheduleWarningIssue } from "@/lib/api-types";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  parseUtcDate,
} from "@/lib/utils";
import { formatShortModelName, modelBadgeVariant } from "@/lib/backend-ui";
import {
  useCancelSchedule,
  useUpdateSchedule,
  type ScheduleUpdateInput,
} from "@/lib/hooks/use-schedule-mutations";
import { ModelPicker } from "./model-picker";
import {
  ScheduleWarningsList,
  describeMutationError,
} from "./schedule-warnings";

interface ScheduleDetailSheetProps {
  row: ScheduleRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseContext(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Convert a UTC sqlite-format string into the local datetime-local input value. */
function toLocalDateTimeInput(utcStr: string): string {
  const d = parseUtcDate(utcStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleDetailSheet({
  row,
  open,
  onOpenChange,
}: ScheduleDetailSheetProps) {
  // Keying by row.id forces a remount whenever the user clicks a different
  // row, so draft edit state from the previous row never bleeds through.
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {row ? (
        <ScheduleDetailContent
          key={row.id}
          row={row}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Sheet>
  );
}

function ScheduleDetailContent({
  row,
  onClose,
}: {
  row: ScheduleRow;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const initialModel = row.model ?? "";
  // `description` and `prompt` are separate fields. For dm rows the daemon
  // only stores `task_description` (the message body), so `draftPrompt` is
  // hidden in that case.
  const [draftDescription, setDraftDescription] = useState(row.task_description ?? "");
  const [draftPrompt, setDraftPrompt] = useState(row.task_prompt ?? "");
  const [draftModel, setDraftModel] = useState<string>(initialModel);
  const [draftTime, setDraftTime] = useState(() => toLocalDateTimeInput(row.scheduled_for));
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ScheduleWarningIssue[]>([]);
  const [warnings, setWarnings] = useState<ScheduleWarningIssue[]>([]);

  const update = useUpdateSchedule();
  const cancel = useCancelSchedule();

  const ctx = parseContext(row.task_context);
  const isPending = row.status === "pending";
  const isDmRow = row.task_type === "dm";

  const beginEdit = () => {
    setDraftDescription(row.task_description ?? "");
    setDraftPrompt(row.task_prompt ?? "");
    setDraftModel(initialModel);
    setDraftTime(toLocalDateTimeInput(row.scheduled_for));
    setError(null);
    setServerIssues([]);
    setWarnings([]);
    setEditing(true);
  };

  const handleSave = async () => {
    setError(null);
    setServerIssues([]);
    setWarnings([]);
    if (isDmRow) {
      // For dm rows the textarea is the message body. The daemon requires ≥1
      // char (no minimum length); validate non-empty here so we don't post
      // an empty message.
      if (draftDescription.trim().length < 1) {
        setError("Message cannot be empty.");
        return;
      }
    } else {
      if (draftDescription.trim().length < 20) {
        setError("Description must be at least 20 characters.");
        return;
      }
      const promptTrimmed = draftPrompt.trim();
      if (promptTrimmed.length > 0 && promptTrimmed.length < 20) {
        setError("Prompt override must be at least 20 characters, or leave empty to use the description.");
        return;
      }
    }
    const parsedTime = new Date(draftTime).getTime();
    if (Number.isNaN(parsedTime)) {
      setError("Invalid date/time.");
      return;
    }
    if (parsedTime < Date.now() - 60_000) {
      setError("Scheduled time must be at least a minute in the future.");
      return;
    }
    const body: ScheduleUpdateInput = { id: row.id };
    // Only send fields that actually changed — keeps the audit log clean and
    // avoids the daemon's optimistic lock racing with no-op writes.
    if (draftTime !== toLocalDateTimeInput(row.scheduled_for)) {
      body.time = new Date(draftTime).toISOString();
    }
    if (draftDescription !== (row.task_description ?? "")) {
      if (isDmRow) body.message = draftDescription;
      else body.description = draftDescription;
    }
    if (!isDmRow) {
      // Compare trimmed prompts: an existing override of "  foo  " and a
      // draft of "foo" are equivalent and shouldn't trigger a write. Empty
      // draft when an override exists → null (clear the override).
      const promptTrimmed = draftPrompt.trim();
      const existingPrompt = row.task_prompt ?? "";
      if (promptTrimmed !== existingPrompt.trim()) {
        body.prompt = promptTrimmed.length === 0 ? null : promptTrimmed;
      }
    }
    // Model PATCH directives — per §4.3a PATCH contract: empty string +
    // prior pin → explicit `null` (clear); empty + no prior → omit; set
    // value + changed → send the new token.
    const trimmedModel = draftModel.trim();
    if (trimmedModel === "") {
      if (initialModel !== "") body.model = null;
    } else if (trimmedModel !== initialModel) {
      body.model = trimmedModel;
    }
    // Nothing changed — bail out so the daemon doesn't reject with
    // "no_changes". Mirror the same UX as a successful save.
    if (Object.keys(body).length === 1) {
      setEditing(false);
      return;
    }
    try {
      const response = await update.mutateAsync(body);
      const responseWarnings = response.warnings ?? [];
      if (responseWarnings.length > 0) {
        setWarnings(responseWarnings);
        // Stay in edit mode just long enough for the user to read the
        // warnings; the form's other controls still reflect the saved
        // state so it's safe to switch out of edit mode here.
        setEditing(false);
        return;
      }
      setEditing(false);
    } catch (e) {
      const { summary, issues } = describeMutationError(e);
      setError(summary);
      setServerIssues(issues);
    }
  };

  const handleCancel = async () => {
    setError(null);
    if (!confirm("Cancel this scheduled task?")) return;
    try {
      await cancel.mutateAsync(row.id);
      onClose();
    } catch (e) {
      setError(describeMutationError(e).summary);
    }
  };

  return (
    <SheetContent className="flex flex-col gap-4 overflow-y-auto">
      <SheetHeader className="pr-8">
        <SheetTitle>Scheduled task #{row.id}</SheetTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge>{row.task_type}</Badge>
          <Badge>{row.status}</Badge>
          {row.model ? (
            <Badge variant={modelBadgeVariant(row.model)}>
              {formatShortModelName(row.model)}
            </Badge>
          ) : (
            <Badge variant="gray">default model</Badge>
          )}
          {ctx.recurringScheduleId !== undefined ? (
            <Badge variant="purple">
              from recurring #{String(ctx.recurringScheduleId)}
            </Badge>
          ) : null}
        </div>
      </SheetHeader>

      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Scheduled for
        </h3>
        {editing ? (
          <Input
            type="datetime-local"
            value={draftTime}
            onChange={(e) => setDraftTime(e.target.value)}
            className="h-9"
          />
        ) : (
          <p className="text-sm text-foreground">
            {formatAbsoluteTime(row.scheduled_for)}{" "}
            <span className="text-muted-foreground">
              ({formatRelativeTime(row.scheduled_for)})
            </span>
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isDmRow ? "Message" : "Description"}
        </h3>
        {editing ? (
          <textarea
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            rows={isDmRow ? 8 : 4}
            className="w-full rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs text-foreground">
            {row.task_description}
          </pre>
        )}
      </section>

      {!isDmRow ? (
        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Prompt <span className="normal-case tracking-normal text-muted-foreground/70">(optional override)</span>
          </h3>
          {editing ? (
            <>
              <textarea
                value={draftPrompt}
                onChange={(e) => setDraftPrompt(e.target.value)}
                rows={8}
                className="w-full rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Leave empty to use the description above as the agent body."
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {draftPrompt.trim().length === 0
                  ? "Empty — description will be used as the agent body."
                  : `${draftPrompt.trim().length} / 20 characters minimum (when set).`}
              </p>
            </>
          ) : row.task_prompt ? (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs text-foreground">
              {row.task_prompt}
            </pre>
          ) : (
            <p className="rounded-md bg-muted p-2 text-xs italic text-muted-foreground">
              No override — description above is used as the agent body.
            </p>
          )}
        </section>
      ) : null}

      {!isDmRow && editing ? (
        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model
          </h3>
          <ModelPicker value={draftModel} onChange={setDraftModel} />
          <p className="mt-1 text-xs text-muted-foreground">
            Pick &ldquo;Default&rdquo; to let the dispatcher use the
            <code className="mx-1">scheduled.task</code>process binding.
            Setting a registered model id pins this row to that backend.
          </p>
        </section>
      ) : null}

      {Object.keys(ctx).length > 0 ? (
        <section>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Task context
          </h3>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] text-muted-foreground">
            {JSON.stringify(ctx, null, 2)}
          </pre>
        </section>
      ) : null}

      <section className="text-xs text-muted-foreground">
        Created {formatAbsoluteTime(row.created_at)}
      </section>

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

      <div className="mt-auto flex justify-between gap-2 pt-4">
        {isPending && !editing ? (
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={cancel.isPending}
          >
            {cancel.isPending ? "Cancelling..." : "Cancel task"}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {isPending && !editing ? (
            <Button onClick={beginEdit}>Edit</Button>
          ) : null}
          {editing ? (
            <>
              <Button
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={update.isPending}
              >
                Discard
              </Button>
              <Button onClick={handleSave} disabled={update.isPending}>
                {update.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </SheetContent>
  );
}
