"use client";

import { useMemo } from "react";
import { AlertCircle, Info, Sparkles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBackends } from "@/lib/hooks/use-backends";
import {
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";
import {
  AUTO_VALUE,
  SEPARATOR,
  buildPickerGroups,
  decodeSelection,
  encodeSelection,
  heavyTierHint,
  type ChatModelOverride,
} from "./chat-model-picker.logic";

export type { ChatModelOverride } from "./chat-model-picker.logic";

interface ChatModelPickerProps {
  value: ChatModelOverride;
  onChange: (next: ChatModelOverride) => void;
  disabled?: boolean;
}

/**
 * Chat model override picker. The business rules (flatten groups, sort
 * models, heavy-tier cost hint) live in
 * `chat-model-picker.logic.ts` so they can be unit-tested without a
 * React testing library.
 */
export function ChatModelPicker({
  value,
  onChange,
  disabled,
}: ChatModelPickerProps) {
  const backendsQuery = useBackends();

  const groups = useMemo(
    () => buildPickerGroups(backendsQuery.data?.backends ?? []),
    [backendsQuery.data],
  );

  const selectValue = value ? encodeSelection(value) : AUTO_VALUE;
  const costHint = heavyTierHint(value, groups);

  function handleSelect(next: string) {
    onChange(decodeSelection(next));
  }

  const triggerDisabled = disabled || backendsQuery.isLoading;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Model</span>
        <Select
          value={selectValue}
          onValueChange={handleSelect}
          disabled={triggerDisabled}
        >
          <SelectTrigger className="h-7 w-auto min-w-[10rem] px-2 py-0 text-xs">
            <SelectValue placeholder="Auto" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_VALUE}>Auto (default)</SelectItem>
            {groups.map((group) => {
              const groupPreviewOnly = isUiPreviewOnlyBackend(group.backendId);
              return (
                <SelectGroup key={group.backendId}>
                  <SelectLabel className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide">
                    <span>{group.label}</span>
                    {groupPreviewOnly && (
                      <span className="rounded bg-muted px-1 py-0 text-[9px] font-medium text-muted-foreground">
                        coming soon
                      </span>
                    )}
                    {group.authBlocked && !groupPreviewOnly && (
                      <span className="rounded bg-destructive/15 px-1 py-0 text-[9px] font-medium text-destructive">
                        auth {group.authStatus}
                      </span>
                    )}
                  </SelectLabel>
                  {group.models.map((model) => {
                    const itemDisabled =
                      !model.available || group.authBlocked || groupPreviewOnly;
                    return (
                      <SelectItem
                        key={`${group.backendId}${SEPARATOR}${model.modelId}`}
                        value={`${group.backendId}${SEPARATOR}${model.modelId}`}
                        disabled={itemDisabled}
                      >
                        {model.label}
                        {groupPreviewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {backendsQuery.isError && (
        <div
          role="alert"
          className="flex items-center gap-1.5 text-[11px] text-destructive"
        >
          <AlertCircle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span>
            Couldn&apos;t load backend list — falling back to process default.
          </span>
        </div>
      )}

      {costHint && (
        <div
          role="status"
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <Info className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          <span>
            Heavy-tier model ({costHint.modelLabel}) — higher cost &amp; rate
            limits than Auto. Switch to Auto when not needed.
          </span>
        </div>
      )}
    </div>
  );
}
