"use client";

import { Loader2 } from "lucide-react";
import type { BackendId } from "@aitne/shared";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  IntegrationHealthEntry,
  IntegrationListItem,
} from "@/lib/api-types";
import {
  availableDelegatedBackends,
  classifyModeSwitch,
  type ModeSwitchAction,
} from "./integration-card.logic";
import {
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";
import {
  delegatedToDirectResumeMessage,
  directToDelegatedLosses,
  formatDailyUsd,
  multiAccountWarning,
  nativeCostDelta,
  nativeToDirectResumeMessage,
  purgeCopyForIntegration,
  toNativeImpacts,
} from "./integration-mode-dialog.logic";

/** How the parent wants the dialog to treat direct-mode OAuth tokens on flip. */
export type TokenHandling = "keep" | "purge";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descriptor: IntegrationListItem;
  currentMode: IntegrationHealthEntry["mode"];
  currentBackend: BackendId | null;
  /** Target mode the user just selected. */
  targetMode: IntegrationHealthEntry["mode"];
  /** Target backend when `targetMode === "delegated"`. */
  targetBackend?: BackendId;
  /**
   * Called when the user changes the target backend inside the dialog
   * (pre-commit backend picker for direct→delegated and disabled→delegated).
   */
  onTargetBackendChange?: (backend: BackendId) => void;
  /** Whether direct-mode credentials are present in the keychain. */
  directCredentialsPresent: boolean;
  /** Count of direct Gmail accounts — drives the multi-account warning. */
  gmailAccountCount: number;
  /** Token-handling choice for direct→delegated flips. Only read on that branch. */
  tokenHandling: TokenHandling;
  onTokenHandlingChange: (next: TokenHandling) => void;
  /** Called on confirm. Parent owns the PATCH + optional purge + toast. */
  onConfirm: () => Promise<void>;
  /** External mutation state — surfaces "Applying…" copy. */
  isPending: boolean;
  /** Last error from the mutation, if any. Cleared by the parent on re-open. */
  error: string | null;
}

/**
 * Mode-switch dialog for an integration card (§4.12.4). Handles four
 * transitions: direct→delegated, delegated→direct, delegated-backend-change,
 * and disabled→* / *→disabled. Rendering is driven entirely from
 * `classifyModeSwitch` — the dialog is a thin shell around a strategy table.
 */
export function IntegrationModeDialog(props: Props) {
  const {
    open,
    onOpenChange,
    descriptor,
    currentMode,
    currentBackend,
    targetMode,
    targetBackend,
    onTargetBackendChange,
    directCredentialsPresent,
    gmailAccountCount,
    tokenHandling,
    onTokenHandlingChange,
    onConfirm,
    isPending,
    error,
  } = props;

  const action = safeClassify({
    from: { mode: currentMode, backend: currentBackend, directCredentialsPresent },
    to: { mode: targetMode, backend: targetBackend },
  });

  const delegatedBackends = availableDelegatedBackends(descriptor);
  const showBackendPicker =
    targetMode === "delegated" && delegatedBackends.length > 1;
  const showTokenHandling =
    currentMode === "direct"
    && targetMode === "delegated"
    && directCredentialsPresent
    && descriptor.directSetup !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <div className="flex h-full flex-col">
        <SheetHeader>
          <SheetTitle>
            {dialogTitle(descriptor.displayName, action)}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
          {showBackendPicker && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Backend
              </label>
              <Select
                value={targetBackend ?? delegatedBackends[0]}
                onValueChange={(v) => onTargetBackendChange?.(v as BackendId)}
                disabled={isPending}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {delegatedBackends.map((b) => {
                    const previewOnly = isUiPreviewOnlyBackend(b);
                    return (
                      <SelectItem key={b} value={b} disabled={previewOnly}>
                        {b}
                        {previewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}
          {action && (
            <DialogBody
              action={action}
              descriptor={descriptor}
              gmailAccountCount={gmailAccountCount}
            />
          )}
          {showTokenHandling && (
            <TokenHandlingPicker
              value={tokenHandling}
              onChange={onTokenHandlingChange}
              disabled={isPending}
              purgeDescription={
                purgeCopyForIntegration(descriptor)?.optionDescription
              }
            />
          )}
          {error && <Alert variant="error">{error}</Alert>}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant={action?.kind === "disable-from-active" ? "destructive" : "default"}
            size="sm"
            onClick={() => void onConfirm()}
            disabled={isPending || action === null || action.kind === "no-op"}
          >
            {isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {confirmLabel(action)}
          </Button>
        </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function safeClassify(args: {
  from: {
    mode: IntegrationHealthEntry["mode"];
    backend: BackendId | null;
    directCredentialsPresent: boolean;
  };
  to: { mode: IntegrationHealthEntry["mode"]; backend?: BackendId };
}): ModeSwitchAction | null {
  try {
    return classifyModeSwitch(args.from, {
      toMode: args.to.mode,
      toBackend: args.to.backend,
    });
  } catch {
    // classifyModeSwitch throws when required inputs are missing (e.g.
    // direct→delegated with no toBackend). Surface as null so the dialog
    // renders the error path instead of crashing — the card UI prevents
    // reaching here in normal flow.
    return null;
  }
}

function dialogTitle(
  name: string,
  action: ModeSwitchAction | null,
): string {
  if (!action || action.kind === "no-op") return `${name} — no change`;
  if (action.kind === "direct-to-delegated") {
    return `Delegate ${name} to ${action.toBackend}?`;
  }
  if (action.kind === "delegated-to-direct") {
    return `Switch ${name} to direct mode?`;
  }
  if (action.kind === "delegated-backend-change") {
    return `Change ${name} delegate to ${action.toBackend}?`;
  }
  if (action.kind === "enable-from-disabled") {
    const target = action.to === "direct" ? "direct" : `delegated to ${action.toBackend ?? "?"}`;
    return `Enable ${name} (${target})?`;
  }
  if (action.kind === "to-native") {
    return `Switch ${name} to native (${action.toBackend})?`;
  }
  if (action.kind === "native-to-direct") {
    return `Switch ${name} to direct mode?`;
  }
  if (action.kind === "native-to-delegated") {
    return `Switch ${name} to delegated (${action.toBackend})?`;
  }
  if (action.kind === "native-to-disabled") {
    return `Disable ${name}?`;
  }
  return `Disable ${name}?`;
}

function confirmLabel(action: ModeSwitchAction | null): string {
  if (!action) return "Apply";
  switch (action.kind) {
    case "direct-to-delegated":
    case "enable-from-disabled":
      return "Apply";
    case "delegated-to-direct":
      return action.needsOauthSetup ? "Continue to setup" : "Resume direct mode";
    case "delegated-backend-change":
      return "Change delegate";
    case "disable-from-active":
      return "Disable";
    case "to-native":
      return "Switch to native";
    case "native-to-direct":
      return action.needsOauthSetup ? "Continue to setup" : "Resume direct mode";
    case "native-to-delegated":
      return "Switch to delegated";
    case "native-to-disabled":
      return "Disable";
    case "no-op":
      return "—";
  }
}

interface DialogBodyProps {
  action: ModeSwitchAction;
  descriptor: IntegrationListItem;
  gmailAccountCount: number;
}

export function DialogBody({ action, descriptor, gmailAccountCount }: DialogBodyProps) {
  if (action.kind === "direct-to-delegated") {
    const losses = directToDelegatedLosses(
      descriptor.key,
      action.toBackend,
      descriptor,
    );
    const multi = multiAccountWarning(descriptor.key, gmailAccountCount);
    return (
      <>
        <Alert variant="warning">
          <p className="font-medium">You will lose these direct-mode features</p>
          <p className="mt-1 text-xs text-muted-foreground">
            All losses are reversible — OAuth tokens stay in the keychain
            by default so switching back is frictionless.
          </p>
        </Alert>
        {multi && <Alert variant="warning">{multi}</Alert>}
        <ul className="space-y-1.5 text-sm">
          {losses.map((l, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <span className="text-muted-foreground">{l.message}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  if (action.kind === "delegated-to-direct") {
    // DELEGATED-MODE-V2 §7.2 — `deniedTools` is a delegated-mode control
    // surface. The deny list is retained on the flip (so re-enabling
    // delegated mode restores the floor without re-curation) but inactive
    // while in direct mode. Surface this only when there are entries to
    // keep dormant; the `?? 0` fallback guards against the optional field
    // being undefined for an integration whose state has never recorded
    // a deny list.
    const hasDeniedTools = (descriptor.state.deniedTools?.length ?? 0) > 0;
    return (
      <div className="space-y-2">
        <Alert variant={action.needsOauthSetup ? "warning" : "success"}>
          <p className="text-sm">
            {delegatedToDirectResumeMessage(descriptor.key, !action.needsOauthSetup)}
          </p>
        </Alert>
        {hasDeniedTools && (
          <Alert variant="info">
            <p className="text-sm">
              Your tool deny list will be retained but is inactive in direct
              mode. Re-enabling delegated mode restores it.
            </p>
          </Alert>
        )}
      </div>
    );
  }

  if (action.kind === "delegated-backend-change") {
    return (
      <Alert variant="info">
        <p className="text-sm">
          The integration stays delegated — only the backend changes to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {action.toBackend}
          </code>
          . Skills and task-flow variants re-materialize on the next session.
        </p>
      </Alert>
    );
  }

  if (action.kind === "enable-from-disabled") {
    return (
      <Alert variant="info">
        <p className="text-sm">
          {action.to === "direct"
            ? "The integration will poll the service directly. You may need to complete OAuth setup."
            : `The integration will delegate to the ${action.toBackend} backend connector.`}
        </p>
      </Alert>
    );
  }

  if (action.kind === "disable-from-active") {
    return (
      <Alert variant="warning">
        <p className="text-sm">
          The daemon stops observing this integration. Any poller associated
          with it pauses; the agent&apos;s session templates drop the skill / task-flow
          body that depends on it. Re-enabling is one click — credentials stay
          in the keychain.
        </p>
      </Alert>
    );
  }

  if (action.kind === "to-native") {
    const impacts = toNativeImpacts(action.fromMode, descriptor, action.toBackend);
    const multi = action.fromMode === "direct"
      ? multiAccountWarning(descriptor.key, gmailAccountCount)
      : null;
    const cost = nativeCostDelta(action.fromMode);
    return (
      <>
        <Alert variant="info">
          <p className="text-sm font-medium">
            Native mode — the agent fetches {descriptor.displayName} in-turn
            via {action.toBackend}&apos;s connector. No background poller, no
            delegated worker.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            We run a live capability probe before committing the flip so a
            missing connector capability surfaces here, not at the next
            DM / hourly_check turn.
          </p>
        </Alert>
        {multi && <Alert variant="warning">{multi}</Alert>}

        {/* §11.6 / §14.4 cost delta. Rendered as a typical-range chip —
            the §16 open question 0 captures the follow-up to compute a
            measurement-driven estimate per integration. */}
        <div className="rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-xs dark:border-amber-700/50 dark:bg-amber-950/30">
          <p className="font-medium text-amber-800 dark:text-amber-200">
            Estimated cost shift (typical workload)
          </p>
          <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
            From {cost.fromLabel}{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px] dark:bg-amber-900/50">
              ≈ {formatDailyUsd(cost.fromDailyUsd)}/day
            </code>{" "}
            → native MCP on {action.toBackend}{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px] dark:bg-amber-900/50">
              ≈ {formatDailyUsd(cost.toDailyUsd)}/day
            </code>
            {cost.multiplier !== null && (
              <>
                {" "}— roughly{" "}
                <strong>{cost.multiplier}×</strong> more per integration
              </>
            )}
            .
          </p>
          <p className="mt-1 text-[11px] text-amber-900/70 dark:text-amber-100/70">
            Marginal ~${cost.yearlyDeltaUsd}/year per integration at typical
            volume. Native is recommended when the alternative is leaving the
            integration disabled — not as a free upgrade from delegated.
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            What changes
          </p>
          <ul className="space-y-1.5 text-sm">
            {impacts.map((impact, i) => (
              <li key={i} className="flex items-start gap-2">
                <span
                  className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    impact.reversible ? "bg-amber-500" : "bg-red-500"
                  }`}
                />
                <span className="text-muted-foreground">{impact.message}</span>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  if (action.kind === "native-to-direct") {
    return (
      <Alert variant={action.needsOauthSetup ? "warning" : "success"}>
        <p className="text-sm">
          {nativeToDirectResumeMessage(descriptor.key, !action.needsOauthSetup)}
        </p>
      </Alert>
    );
  }

  if (action.kind === "native-to-delegated") {
    return (
      <Alert variant="info">
        <p className="text-sm">
          The agent stops calling {descriptor.displayName} directly through the
          main backend. Instead, the daemon proxies through{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {action.toBackend}
          </code>{" "}
          and the delegated-sync worker resumes its cadence — observations land
          server-side again.
        </p>
      </Alert>
    );
  }

  if (action.kind === "native-to-disabled") {
    return (
      <Alert variant="warning">
        <p className="text-sm">
          The agent loses awareness of {descriptor.displayName}. No background
          poller, no in-turn fetch — the hourly check and DM flow drop the
          integration from their actionable steps. Re-enabling is one click; no
          data is destroyed.
        </p>
      </Alert>
    );
  }

  return null;
}

// ── Token-handling picker (direct→delegated) ───────────────────────────────

function TokenHandlingPicker({
  value,
  onChange,
  disabled,
  purgeDescription,
}: {
  value: TokenHandling;
  onChange: (next: TokenHandling) => void;
  disabled?: boolean;
  /**
   * Per-integration purge body — names the actual secret-store keys to
   * delete and the cost of restoring direct mode later. Falls back to a
   * generic line when the descriptor exposes no directSetup (delegated-only
   * integration, where the purge picker would not normally show anyway).
   */
  purgeDescription?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="mb-2 text-sm font-medium">Direct-mode credential handling</p>
      <div className="space-y-2">
        <TokenOption
          checked={value === "keep"}
          disabled={disabled}
          onSelect={() => onChange("keep")}
          label="Keep dormant (recommended)"
          description="Credentials stay in the keychain. Reverting to direct is a one-click flip with no re-consent step."
        />
        <TokenOption
          checked={value === "purge"}
          disabled={disabled}
          onSelect={() => onChange("purge")}
          label="Purge from keychain"
          description={
            purgeDescription
            ?? "Deletes the direct-mode credentials after the mode flip. Reverting to direct later will require redoing the original setup. Asks for a second confirmation."
          }
        />
      </div>
    </div>
  );
}

function TokenOption({
  checked,
  disabled,
  onSelect,
  label,
  description,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  label: string;
  description: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition ${
        checked
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/50"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <input
        type="radio"
        name="token-handling"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <div>
        <p className="font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}
