"use client";

import { useMemo } from "react";
import type { BackendId } from "@aitne/shared";
import { BACKEND_IDS } from "@aitne/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useScheduleOptions } from "@/lib/hooks/use-schedule-options";
import {
  BACKEND_LABELS,
  getBackendDeprecation,
  isBackendSelectionDisabled,
} from "@/lib/backend-ui";
import type {
  ScheduleOptionsModelEntry,
  ScheduleOptionsResponse,
} from "@/lib/api-types";

/**
 * Sentinel value used by the native `<Select>` for the "Default
 * (process config)" choice. Empty string is the natural fit but Radix
 * Select rejects empty values — we use a separate non-empty sentinel
 * and translate to/from empty at the boundary.
 */
const DEFAULT_SENTINEL = "__default__";

export interface ModelOption {
  /** Free-form token sent to the daemon — alias, registered id, or composite. */
  value: string;
  /** What to render in the dropdown row. */
  label: string;
  /** Detail line under the label — tier, deprecation tag, etc. */
  hint?: string;
  /** True when the registry flagged this model deprecated. */
  deprecated?: boolean;
}

export interface ModelOptionGroup {
  label: string;
  options: ModelOption[];
}

/**
 * Pure helper — project a `/schedule/options` payload into the picker's
 * grouped option list. Mirrors §4.3 resolution order so the dashboard's
 * dropdown is consistent with how the daemon validates: legacy aliases
 * first, then registered IDs grouped by backend.
 *
 * Excludes:
 *  - backends gated as preview-only via `isBackendSelectionDisabled`
 *    (today: opencode) — the daemon would accept the wire value but the
 *    runtime is not user-selectable yet.
 *  - empty backend buckets (no entries to show).
 *
 * Deprecated entries are kept in the list (visible with a "deprecated"
 * tag) so an operator with an existing pinned row sees the same value
 * they bound to; they just can't accidentally pick it for new rows
 * without seeing the warning.
 *
 * Pure / DI-tested — no hooks, no React. The component below feeds
 * `useScheduleOptions().data` in; the test passes a synthetic payload.
 */
export function projectModelOptions(
  data: ScheduleOptionsResponse | undefined,
): ModelOptionGroup[] {
  if (!data) return [];
  const groups: ModelOptionGroup[] = [];

  const aliases: ModelOption[] = [];
  for (const alias of Object.keys(data.modelAliases) as Array<keyof typeof data.modelAliases>) {
    const tier = data.modelAliases[alias];
    aliases.push({
      value: alias,
      label: `${alias.charAt(0).toUpperCase()}${alias.slice(1)}`,
      hint: `Legacy alias → ${tier} tier`,
    });
  }
  if (aliases.length > 0) {
    groups.push({ label: "Tier aliases", options: aliases });
  }

  for (const backendId of BACKEND_IDS as readonly BackendId[]) {
    if (isBackendSelectionDisabled(backendId)) continue;
    const entries: ScheduleOptionsModelEntry[] = data.models[backendId] ?? [];
    if (entries.length === 0) continue;
    const backendDeprecation = getBackendDeprecation(backendId);
    groups.push({
      label: backendDeprecation
        ? `${BACKEND_LABELS[backendId]}${backendDeprecation.shortSuffix}`
        : BACKEND_LABELS[backendId],
      options: entries.map((entry) => ({
        value: entry.id,
        label: entry.id,
        hint: entry.deprecated ? `${entry.tier} tier · deprecated` : `${entry.tier} tier`,
        deprecated: entry.deprecated,
      })),
    });
  }

  return groups;
}

/**
 * Render label for the current value when the user has picked something
 * other than "default". Pure — the model-picker.test.ts unit covers the
 * "value not in registry" fall-through case so a stale recurring rule
 * doesn't crash the dropdown.
 */
export function describeModelValue(
  value: string,
  groups: ModelOptionGroup[],
): string {
  if (value.trim().length === 0) return "Default (process config)";
  for (const group of groups) {
    for (const option of group.options) {
      if (option.value === value) {
        return option.deprecated ? `${option.label} (deprecated)` : option.label;
      }
    }
  }
  // Free-form / unknown — e.g. an old pinned row whose model was removed
  // from the registry. Show verbatim so the user can identify it.
  return `${value} (unrecognised)`;
}

export interface ModelPickerProps {
  /** Empty string = use the process_backend_config default. */
  value: string;
  onChange: (next: string) => void;
  id?: string;
  /** Disable while submitting. */
  disabled?: boolean;
}

export function ModelPicker({ value, onChange, id, disabled }: ModelPickerProps) {
  const { data, isLoading, isError } = useScheduleOptions();
  const groups = useMemo(() => projectModelOptions(data), [data]);

  const selectValue = value.trim().length === 0 ? DEFAULT_SENTINEL : value;

  // Surface a stale value (e.g. an existing recurring rule pinned to a
  // model no longer in the registry) as a free-form option so Radix
  // doesn't error when it can't find the active value among children.
  const valueIsRegistered =
    selectValue === DEFAULT_SENTINEL ||
    groups.some((g) => g.options.some((o) => o.value === selectValue));

  return (
    <Select
      value={selectValue}
      disabled={disabled || isLoading || isError}
      onValueChange={(next) =>
        onChange(next === DEFAULT_SENTINEL ? "" : next)
      }
    >
      <SelectTrigger id={id} className="h-9 w-full">
        <SelectValue placeholder="Default">
          {describeModelValue(value, groups)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={DEFAULT_SENTINEL}>Default (process config)</SelectItem>
        </SelectGroup>
        {!valueIsRegistered ? (
          <SelectGroup>
            <SelectLabel>Current pin</SelectLabel>
            <SelectItem value={selectValue}>
              <span className="flex flex-col">
                <span>{value}</span>
                <span className="text-xs text-muted-foreground">
                  Not in the live registry — keeping the existing pin
                </span>
              </span>
            </SelectItem>
          </SelectGroup>
        ) : null}
        {groups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex flex-col">
                  <span>
                    {option.label}
                    {option.deprecated ? (
                      <span className="ml-2 rounded-sm bg-warning/15 px-1 text-[10px] font-medium uppercase tracking-wide text-warning">
                        deprecated
                      </span>
                    ) : null}
                  </span>
                  {option.hint ? (
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
