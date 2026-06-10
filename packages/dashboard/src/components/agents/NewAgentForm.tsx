"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FormField } from "@/components/ui/form-field";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  AGENT_BACKEND_CHOICES,
  AGENT_SCHEDULE_FREQUENCIES,
  AGENT_TIER_CHOICES,
  EMPTY_AGENT_FORM_STATE,
  MONTH_DAYS,
  WEEKDAY_LABELS,
  agentFormToMarkdown,
  slugifyAgentName,
  validateAgentForm,
  type AgentFormState,
  type AgentScheduleFrequency,
} from "@/lib/agents/agent-form";

/**
 * Field-based "+ New Agent" form (§10.1) — the friendly alternative to
 * hand-authoring `agent.md` YAML. Each control is wrapped in `FormField` so its
 * label and helper description sit directly above the input, per the operator
 * ask. The schedule section swaps its time picker by frequency: a day-of-week
 * grid for weekly, a day-of-month grid for monthly, and a plain time for daily.
 * `/agents` is recurring-only — there is no one-shot option (use `/schedule`).
 *
 * All conversion + validation lives in `@/lib/agents/agent-form` (unit-tested);
 * this component is state + layout glue. On Save it renders the markdown and
 * hands it to the parent, which writes it through the context-vault PUT
 * chokepoint (the only legal definition write path).
 */

const FREQUENCY_LABELS: Record<AgentScheduleFrequency, string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export interface NewAgentFormProps {
  saving: boolean;
  saveError?: string | null;
  /** Slugs already in use (built-in + user) — blocks an overwriting collision. */
  existingSlugs: readonly string[];
  /** Called with the rendered `agent.md` + derived slug when Save is pressed. */
  onSave: (markdown: string, slug: string) => void;
  onCancel: () => void;
}

export function NewAgentForm({
  saving,
  saveError,
  existingSlugs,
  onSave,
  onCancel,
}: NewAgentFormProps) {
  const [state, setState] = useState<AgentFormState>(EMPTY_AGENT_FORM_STATE);
  // Stop auto-deriving the slug from the name once the operator edits it by hand.
  const [slugTouched, setSlugTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const errors = useMemo(
    () => validateAgentForm(state, existingSlugs),
    [state, existingSlugs],
  );

  const set = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const onNameChange = (name: string) =>
    setState((prev) => ({
      ...prev,
      name,
      slug: slugTouched ? prev.slug : slugifyAgentName(name),
    }));

  const onSlugChange = (slug: string) => {
    setSlugTouched(true);
    set("slug", slug);
  };

  const toggleDayOfWeek = (idx: number) =>
    set(
      "daysOfWeek",
      state.daysOfWeek.includes(idx)
        ? state.daysOfWeek.filter((d) => d !== idx)
        : [...state.daysOfWeek, idx],
    );

  const toggleDayOfMonth = (day: number) =>
    set(
      "daysOfMonth",
      state.daysOfMonth.includes(day)
        ? state.daysOfMonth.filter((d) => d !== day)
        : [...state.daysOfMonth, day],
    );

  const handleSave = () => {
    setAttempted(true);
    if (errors) return;
    onSave(agentFormToMarkdown(state), state.slug.trim());
  };

  // Only surface field errors after a save attempt so the form doesn't open red.
  const err = (key: keyof NonNullable<typeof errors>) =>
    attempted ? errors?.[key] : undefined;

  return (
    <div className="space-y-5">
      {/* ── Identity ── */}
      <FormField
        htmlFor="agent-name"
        label="Name"
        description="A human label shown in the agents list. e.g. “Daily Digest”."
        error={err("name")}
      >
        <Input
          id="agent-name"
          value={state.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Daily Digest"
        />
      </FormField>

      <FormField
        htmlFor="agent-slug"
        label="ID"
        description="URL and folder name, auto-filled from the name. Lowercase letters, numbers and hyphens; cannot be changed later."
        error={err("slug")}
      >
        <Input
          id="agent-slug"
          value={state.slug}
          onChange={(e) => onSlugChange(e.target.value)}
          placeholder="daily-digest"
          className="font-mono"
        />
      </FormField>

      <FormField
        htmlFor="agent-description"
        label="Description"
        description="One line on what this agent is for. Shown in the list and its detail page."
        error={err("description")}
      >
        <Input
          id="agent-description"
          value={state.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Summarise the day and surface what needs attention."
        />
      </FormField>

      {/* ── Enabled ── */}
      <FormField
        label="Enabled"
        description="When on, the agent runs automatically on its schedule. Turn off to keep the definition without firing it."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <span className="text-muted-foreground">
            {state.enabled ? "On — will run on schedule" : "Off — paused"}
          </span>
        </label>
      </FormField>

      {/* ── Schedule ── */}
      <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
        <FormField
          label="Schedule"
          description="How often the agent runs. Pick a cadence, then set when."
          error={err("daysOfWeek") ?? err("daysOfMonth")}
        >
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Schedule frequency">
            {AGENT_SCHEDULE_FREQUENCIES.map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={state.frequency === f ? "default" : "outline"}
                onClick={() => set("frequency", f)}
                aria-pressed={state.frequency === f}
              >
                {FREQUENCY_LABELS[f]}
              </Button>
            ))}
          </div>
        </FormField>

        {state.frequency === "hourly" && (
          <div className="flex flex-wrap gap-3">
            <FormField
              htmlFor="agent-interval-hours"
              label="Every N hours"
              description="1–23."
              error={err("intervalHours")}
            >
              <Input
                id="agent-interval-hours"
                type="number"
                min={1}
                max={23}
                value={Number.isNaN(state.intervalHours) ? "" : state.intervalHours}
                onChange={(e) => set("intervalHours", e.target.valueAsNumber)}
                className="w-24"
              />
            </FormField>
            <FormField
              htmlFor="agent-minute-of-hour"
              label="At minute"
              description="0–59 past the hour."
              error={err("minuteOfHour")}
            >
              <Input
                id="agent-minute-of-hour"
                type="number"
                min={0}
                max={59}
                value={Number.isNaN(state.minuteOfHour) ? "" : state.minuteOfHour}
                onChange={(e) => set("minuteOfHour", e.target.valueAsNumber)}
                className="w-24"
              />
            </FormField>
          </div>
        )}

        {state.frequency === "weekly" && (
          <FormField label="Days of week" description="Select one or more days.">
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_LABELS.map((label, idx) => {
                const active = state.daysOfWeek.includes(idx);
                return (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => toggleDayOfWeek(idx)}
                    aria-pressed={active}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          </FormField>
        )}

        {state.frequency === "monthly" && (
          <FormField label="Days of month" description="Select one or more days (1–31).">
            <div className="grid grid-cols-7 gap-1 sm:grid-cols-10">
              {MONTH_DAYS.map((day) => {
                const active = state.daysOfMonth.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDayOfMonth(day)}
                    aria-pressed={active}
                    className={cn(
                      "h-7 rounded-md border text-xs tabular-nums transition-colors",
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
          </FormField>
        )}

        {state.frequency !== "hourly" && (
          <FormField
            htmlFor="agent-time"
            label="Time of day"
            description="Interpreted in the daemon's configured timezone."
            error={err("time")}
          >
            <Input
              id="agent-time"
              type="time"
              value={state.time}
              onChange={(e) => set("time", e.target.value)}
              className="w-auto"
            />
          </FormField>
        )}

        <FormField
          label="Respect quiet hours"
          description="When a run lands inside your quiet hours, wait and run at the end of the window instead. Turn this on whenever the agent messages you; leave it off for silent overnight work."
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={state.deferInQuietHours}
              onChange={(e) => set("deferInQuietHours", e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <span className="text-muted-foreground">
              {state.deferInQuietHours
                ? "On — runs move past quiet hours"
                : "Off — runs at the scheduled time"}
            </span>
          </label>
        </FormField>
      </div>

      {/* ── Backend ── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          htmlFor="agent-backend"
          label="Backend engine"
          description="Which CLI runs the agent. Default uses your configured routing."
        >
          <NativeSelect
            id="agent-backend"
            value={state.backendId}
            onChange={(e) => set("backendId", e.target.value)}
          >
            {AGENT_BACKEND_CHOICES.map((b) => (
              <option key={b || "default"} value={b}>
                {b === "" ? "Default" : b}
              </option>
            ))}
          </NativeSelect>
        </FormField>

        <FormField
          htmlFor="agent-tier"
          label="Model tier"
          description="Lite is cheapest, high is most capable. Default uses the routing tier."
        >
          <NativeSelect
            id="agent-tier"
            value={state.tier}
            onChange={(e) => set("tier", e.target.value)}
          >
            {AGENT_TIER_CHOICES.map((t) => (
              <option key={t || "default"} value={t}>
                {t === "" ? "Default" : t}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>

      {/* ── Limits ── */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Limits (per run)</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField
            htmlFor="agent-max-turns"
            label="Max turns"
            description="Agent ↔ tool round-trips."
            error={err("maxTurns")}
          >
            <Input
              id="agent-max-turns"
              type="number"
              min={1}
              step={1}
              value={Number.isNaN(state.maxTurns) ? "" : state.maxTurns}
              onChange={(e) => set("maxTurns", e.target.valueAsNumber)}
            />
          </FormField>
          <FormField
            htmlFor="agent-max-budget"
            label="Max budget (USD)"
            description="Soft spend cap per run."
            error={err("maxBudgetUsd")}
          >
            <Input
              id="agent-max-budget"
              type="number"
              min={0}
              step={0.05}
              value={Number.isNaN(state.maxBudgetUsd) ? "" : state.maxBudgetUsd}
              onChange={(e) => set("maxBudgetUsd", e.target.valueAsNumber)}
            />
          </FormField>
          <FormField
            htmlFor="agent-timeout"
            label="Timeout (min)"
            description="Hard stop after this long."
            error={err("timeoutMinutes")}
          >
            <Input
              id="agent-timeout"
              type="number"
              min={1}
              step={1}
              value={Number.isNaN(state.timeoutMinutes) ? "" : state.timeoutMinutes}
              onChange={(e) => set("timeoutMinutes", e.target.valueAsNumber)}
            />
          </FormField>
        </div>
      </div>

      {/* ── Prompt ── */}
      <FormField
        htmlFor="agent-prompt"
        label="Task prompt"
        description="The instructions the agent follows each time it runs. Be specific about what to read, do, and produce."
        error={err("prompt")}
      >
        <textarea
          id="agent-prompt"
          value={state.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={6}
          placeholder="Read today's notes, summarise what changed, and DM me the three things that need attention."
          className="w-full resize-y rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </FormField>

      {saveError && <Alert variant="error">{saveError}</Alert>}

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Creating…" : "Create agent"}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
