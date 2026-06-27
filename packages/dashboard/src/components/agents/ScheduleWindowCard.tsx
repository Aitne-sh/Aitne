"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { usePatchAgent } from "@/lib/hooks/use-agents";
import type { AgentDetailResponse, ScheduleWindowOverrides } from "@/lib/agents/types";

/**
 * Cadence editor for the runtime-window built-in (activity-scan) —
 * AGENTS_HUB_REDESIGN_PLAN §2. The values live on the agent row
 * (`PATCH /api/agents/:slug` `schedule_window`); a field left untouched keeps
 * following the daemon default. Interval / active-hours edits rebuild the
 * cron live; the observation threshold applies on the next tick.
 */

type WindowBlock = NonNullable<AgentDetailResponse["schedule_window"]>;

interface FieldSpec {
  key: keyof ScheduleWindowOverrides;
  label: string;
  hint: string;
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  {
    key: "interval_minutes",
    label: "Interval (minutes)",
    hint: "How often the check fires inside the active window.",
    min: 5,
    max: 1440,
  },
  {
    key: "active_start_hour",
    label: "Active from (hour)",
    hint: "Local hour the window opens (0–23).",
    min: 0,
    max: 23,
  },
  {
    key: "active_end_hour",
    label: "Active until (hour)",
    hint: "Local hour the window closes, exclusive (1–24).",
    min: 1,
    max: 24,
  },
  {
    key: "min_observations",
    label: "Min observations",
    hint: "Skip the run when fewer observations are pending.",
    min: 0,
    max: 1000,
  },
];

export function ScheduleWindowCard({
  slug,
  window: block,
}: {
  slug: string;
  window: WindowBlock;
}) {
  const patch = usePatchAgent();
  const [values, setValues] = useState<Record<string, number>>(() => ({
    ...block.resolved,
  }));
  const [clientError, setClientError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const overriddenKeys = Object.keys(block.overrides) as Array<keyof ScheduleWindowOverrides>;
  const dirty = FIELDS.some(
    (f) => values[f.key] !== block.resolved[f.key as keyof typeof block.resolved],
  );

  const validate = (): string | null => {
    for (const f of FIELDS) {
      const v = values[f.key];
      if (!Number.isInteger(v) || v < f.min || v > f.max) {
        return `${f.label} must be an integer between ${f.min} and ${f.max}.`;
      }
    }
    if (values.active_end_hour <= values.active_start_hour) {
      return "The active window must end after it starts.";
    }
    return null;
  };

  const onSave = () => {
    const error = validate();
    setClientError(error);
    if (error) return;
    // Send only the fields that differ from the current effective values —
    // untouched fields keep following the daemon default.
    const body: Record<string, number> = {};
    for (const f of FIELDS) {
      if (values[f.key] !== block.resolved[f.key as keyof typeof block.resolved]) {
        body[f.key] = values[f.key];
      }
    }
    patch.mutate(
      { slug, body: { schedule_window: body } },
      {
        onSuccess: () => {
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2500);
        },
      },
    );
  };

  const onReset = () => {
    if (overriddenKeys.length === 0) return;
    const body = Object.fromEntries(overriddenKeys.map((k) => [k, null]));
    patch.mutate(
      { slug, body: { schedule_window: body } },
      {
        onSuccess: () => {
          setClientError(null);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2500);
        },
      },
    );
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 p-0 pb-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
            Cadence
          </CardTitle>
          <p className="max-w-prose pt-1 text-xs text-muted-foreground">
            When and how often this agent fires. Interval and active-hours changes apply
            immediately (the cron is rebuilt live). Quiet hours and notification caps on the
            Hours &amp; Notifications page still apply on top.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {overriddenKeys.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReset}
              disabled={patch.isPending}
            >
              Reset to defaults
            </Button>
          )}
          <Button type="button" size="sm" onClick={onSave} disabled={!dirty || patch.isPending}>
            {patch.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {f.label}
              {f.key in block.overrides && (
                <span
                  className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary"
                  title="Customized — no longer follows the daemon default"
                >
                  custom
                </span>
              )}
            </span>
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={values[f.key]}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))
              }
              aria-label={f.label}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 tabular-nums"
            />
            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              {f.hint}
            </span>
          </label>
        ))}
      </div>

      {clientError && <Alert variant="error">{clientError}</Alert>}
      {patch.isError && <Alert variant="error">{(patch.error as Error).message}</Alert>}
      {saved && <p className="text-xs text-muted-foreground">Saved.</p>}
    </Card>
  );
}
