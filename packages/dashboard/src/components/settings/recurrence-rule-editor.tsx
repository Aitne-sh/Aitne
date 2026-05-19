"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RecurrenceRule } from "@/lib/api-types";
import {
  FREQUENCY_OPTIONS,
  WEEKDAY_LABELS,
  applyFrequency,
  toggleDayOfMonth,
  toggleDayOfWeek,
  type Frequency,
  type RecurrenceFormErrors,
} from "./recurrence-rule-editor.logic";

/**
 * Structured editor for a managed-task `RecurrenceRule`. Closes
 * follow-ups item #1 — previously the modify sheet pushed the user to
 * a non-existent "Settings → Routines" workflow to change the actual
 * fire schedule.
 *
 * The component is a thin shell over the pure helpers in
 * `recurrence-rule-editor.logic.ts`: every state transition (frequency
 * change, day toggle, time edit) goes through one of those helpers so
 * the daemon's mutual-exclusion invariants (no daysOfWeek on `daily`,
 * etc.) cannot be violated mid-render.
 *
 * Sub-daily cadences (hourly, every-N-minutes) are intentionally
 * absent from the frequency options — the daemon's recurrence engine
 * only accepts daily/weekly/monthly (see SKILL.md step 5).
 */

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export interface RecurrenceRuleEditorProps {
  rule: RecurrenceRule;
  onChange: (next: RecurrenceRule) => void;
  errors?: RecurrenceFormErrors | null;
}

export function RecurrenceRuleEditor({
  rule,
  onChange,
  errors,
}: RecurrenceRuleEditorProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            Frequency
          </label>
          <Select
            value={rule.frequency}
            onValueChange={(v) => onChange(applyFrequency(rule, v as Frequency))}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FREQUENCY_OPTIONS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label
            className="text-[11px] font-medium text-muted-foreground"
            htmlFor="recurrence-time"
          >
            Time of day
          </label>
          <Input
            id="recurrence-time"
            type="time"
            value={rule.time}
            onChange={(e) => onChange({ ...rule, time: e.target.value })}
            className="h-8 text-xs"
          />
          {errors?.time && (
            <p className="text-[11px] text-destructive">{errors.time}</p>
          )}
        </div>
      </div>

      {rule.frequency === "weekly" && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            Days of week
          </label>
          <div className="flex flex-wrap gap-1">
            {WEEKDAY_LABELS.map((label, idx) => {
              const active = (rule.daysOfWeek ?? []).includes(idx);
              return (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => onChange(toggleDayOfWeek(rule, idx))}
                  aria-pressed={active}
                  className="h-7 px-2 text-xs"
                >
                  {label}
                </Button>
              );
            })}
          </div>
          {errors?.daysOfWeek && (
            <p className="text-[11px] text-destructive">
              {errors.daysOfWeek}
            </p>
          )}
        </div>
      )}

      {rule.frequency === "monthly" && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">
            Days of month
          </label>
          <div className="grid grid-cols-7 gap-1 sm:grid-cols-10">
            {MONTH_DAYS.map((day) => {
              const active = (rule.daysOfMonth ?? []).includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => onChange(toggleDayOfMonth(rule, day))}
                  aria-pressed={active}
                  className={cn(
                    "h-7 rounded-md border text-[11px] tabular-nums transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-muted",
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">
            29-31 clamp to the last day on shorter months.
          </p>
          {errors?.daysOfMonth && (
            <p className="text-[11px] text-destructive">
              {errors.daysOfMonth}
            </p>
          )}
        </div>
      )}

      {rule.timezone && (
        <p className="text-[10px] text-muted-foreground">
          Timezone: <code>{rule.timezone}</code>
        </p>
      )}
    </div>
  );
}
