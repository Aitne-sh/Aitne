"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { BackendId, IntegrationMode } from "@aitne/shared";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { IntegrationListItem } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { availableNativeBackends } from "./integration-card.logic";
import { buildModeExplainer } from "./mode-explainer.logic";

interface Props {
  /** Mode currently in effect for this integration. */
  currentMode: IntegrationMode;
  /** Descriptor used for displayName + supportedModes ordering. */
  descriptor: IntegrationListItem;
  /** Called when the user picks a different mode. */
  onSelectMode: (mode: IntegrationMode) => void;
  /**
   * Backends that can host a delegated session for this integration. When
   * empty, the Delegated card is shown disabled with an explanatory note.
   */
  delegatedBackendCount: number;
  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §3.3 invariant — native binds to the
   * main backend. Required for the Native radio to enable; when omitted
   * (no main backend chosen yet, or descriptor has no connector for it),
   * the Native card renders disabled with an explanatory note instead of
   * being hidden, so the user sees that the option exists and learns why
   * it's unavailable in their current configuration.
   */
  mainBackend?: BackendId | null;
  /** Disables interaction during a pending mutation. */
  disabled?: boolean;
  /** Optional id used to group the radio inputs. */
  groupId?: string;
}

/**
 * Radio-card mode picker that replaces the bare Mode dropdown. Each card
 * carries a one-sentence summary visible by default plus a "Details"
 * disclosure that expands inline to show pros/cons. Mode descriptors
 * come from `buildModeExplainer` so copy stays test-covered and the
 * card layout is purely presentational.
 *
 * Disclosure state is per-mode (Set<IntegrationMode>) and starts empty
 * so brief lines are visible at a glance — matching the user's explicit
 * "press Details to reveal" intent. Multiple modes can be open at once
 * because comparing direct vs delegated is the *whole point* of the
 * picker; forcing a close-on-open would defeat that.
 *
 * Selection bubbles up via `onSelectMode`; the parent (`IntegrationCard`)
 * pops the existing `IntegrationModeDialog` confirmation sheet — this
 * component never mutates state directly.
 */
export function ModeExplainer({
  currentMode,
  descriptor,
  onSelectMode,
  delegatedBackendCount,
  mainBackend,
  disabled = false,
  groupId,
}: Props) {
  const [openModes, setOpenModes] = useState<ReadonlySet<IntegrationMode>>(
    () => new Set(),
  );
  const radioName = groupId ?? `mode-explainer-${descriptor.key}`;

  const toggleMode = (mode: IntegrationMode, next: boolean) => {
    setOpenModes((prev) => {
      const updated = new Set(prev);
      if (next) updated.add(mode);
      else updated.delete(mode);
      return updated;
    });
  };

  // §3.3 — Native is offered only when the current main backend has a
  // registry connector for this integration. We DO render the card when
  // the option is unavailable so the user learns the gate exists; the
  // card just disables the radio with an explanatory note.
  const nativeBackends = availableNativeBackends(descriptor);
  const nativeAvailableForMain =
    mainBackend !== null
    && mainBackend !== undefined
    && nativeBackends.includes(mainBackend);
  const nativeUnsupportedReason: string | null =
    !descriptor.supportedModes.includes("native")
      ? null
      : !mainBackend
        ? "Set a main backend first — native binds to it."
        : !nativeAvailableForMain
          ? `Your main backend (${mainBackend}) ships no native connector for ${descriptor.displayName}.`
          : null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Mode</p>
      <ul className="space-y-2">
        {descriptor.supportedModes.map((mode) => {
          const copy = buildModeExplainer(mode, descriptor, mainBackend ?? null);
          const selected = mode === currentMode;
          const open = openModes.has(mode);
          const isDelegatedDisabled =
            mode === "delegated" && delegatedBackendCount === 0;
          const isNativeDisabled =
            mode === "native" && nativeUnsupportedReason !== null;
          const cardDisabled = disabled || isDelegatedDisabled || isNativeDisabled;

          const onSelect = () => {
            if (cardDisabled) return;
            if (selected) return;
            onSelectMode(mode);
          };

          return (
            <li
              key={mode}
              className={cn(
                "rounded-md border transition-colors",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card",
                cardDisabled && "opacity-60",
              )}
            >
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 p-3",
                  cardDisabled && "cursor-not-allowed",
                )}
              >
                <input
                  type="radio"
                  name={radioName}
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={selected}
                  disabled={cardDisabled}
                  onChange={onSelect}
                  aria-label={`Set mode to ${copy.title}`}
                />
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {copy.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{copy.brief}</p>
                  {isDelegatedDisabled && (
                    <p className="text-xs text-warning">
                      No backend connector is registered for this integration —
                      Delegated mode cannot be activated.
                    </p>
                  )}
                  {isNativeDisabled && nativeUnsupportedReason && (
                    <p className="text-xs text-warning">
                      {nativeUnsupportedReason}
                    </p>
                  )}
                </div>
              </label>

              <Collapsible
                open={open}
                onOpenChange={(next) => toggleMode(mode, next)}
              >
                <CollapsibleTrigger
                  type="button"
                  className="group flex w-full items-center gap-1 border-t border-border/50 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  aria-label={`Toggle details for ${copy.title} mode`}
                >
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform",
                      open && "rotate-180",
                    )}
                  />
                  {open ? "Hide details" : "Show details"}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-2 px-3 pb-3 pt-1 text-xs leading-relaxed">
                    <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                      {copy.details.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                    {copy.footnote && (
                      <p className="rounded bg-muted/50 px-2 py-1 text-[11px] italic text-foreground/80">
                        {copy.footnote}
                      </p>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
