"use client";

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Loader2,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getBackendIds, type BackendId } from "@aitne/shared";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api, ApiError } from "@/lib/api-client";
import {
  BACKEND_PROVIDER_LABELS,
  BACKEND_PROVIDER_SHORT,
  isBackendSelectionDisabled,
  UI_PREVIEW_ONLY_REASON,
} from "@/lib/backend-ui";
import { cn } from "@/lib/utils";
import { useBackends } from "@/lib/hooks/use-backends";
import { BackendApiKeyPanel } from "@/components/settings/backend-api-key-panel";
import { BackendCard } from "@/components/settings/backend-card";
import { isContinueEligible } from "@/components/settings/backend-card.logic";
import { SubscriptionAuthWarning } from "@/components/settings/subscription-auth-warning";
import {
  buildSetupModePayload,
  EMPTY_OVERRIDES,
  hasDivergentOverride,
  type ExecutionModeUi,
  type PerBackendOverrides,
} from "@/components/settings/execution-mode.logic";
import { WizardStepFrame } from "./wizard-step-frame";

/**
 * Wizard step for the backend selection. Subscription-plan registration
 * has been removed — Aitne is designed to run on provider API keys
 * (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`), so the
 * daemon does not ask the operator which Claude/Codex/Gemini tier they
 * hold. `process_backend_config` is seeded with fixed defaults (Sonnet
 * for main agent surfaces, Haiku for delegated/simple polling). The
 * user picks the main backend, authenticates it via the per-backend
 * API-key panel (or, as a fallback, signs in to the local CLI), and
 * non-main backends can be configured later from /settings/models.
 *
 * On Continue, this step calls `PUT /api/backends/main` with the
 * chosen backend, which seeds default `process_backend_config` rows
 * for that backend on a fresh install.
 */

const BACKENDS = getBackendIds();

// `isBackendSelectionDisabled` combines the runtime gate
// (`RUNTIME_AVAILABLE_BACKEND_IDS`) with the dashboard-only preview gate
// (`UI_PREVIEW_ONLY_BACKEND_IDS`). See `backend-ui.ts` for the rationale
// behind keeping these two layers separate.
const isPreviewOnlyBackend = isBackendSelectionDisabled;

interface BackendsStepProps {
  onNext: () => void;
  onBack?: () => void;
}

interface InstallCheckEntry {
  status: "idle" | "checking" | "ok" | "error";
  error?: string | null;
  version?: string | null;
}

export function BackendsStep({ onNext, onBack }: BackendsStepProps) {
  const { data: backendsData, refetch: refetchBackends } = useBackends();
  const queryClient = useQueryClient();

  const [mainBackend, setMainBackend] = useState<BackendId | null>("claude");
  const [topMode, setTopMode] = useState<ExecutionModeUi>("safe");
  const [overrides, setOverrides] = useState<PerBackendOverrides>(EMPTY_OVERRIDES);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — when the wizard is re-run
  // after the operator has provisioned native rows (uncommon but possible),
  // changing the main backend cascades non-matching native rows to
  // `disabled`. Surface the cascade inline so the user finds out here
  // rather than discovering silently-disabled rows on /connections.
  const [cascadeNotice, setCascadeNotice] = useState<string | null>(null);
  const [installCheck, setInstallCheck] = useState<
    Record<BackendId, InstallCheckEntry>
  >({
    claude: { status: "idle" },
    codex: { status: "idle" },
    gemini: { status: "idle" },
    opencode: { status: "idle" },
  });

  const pickMain = useCallback((backendId: BackendId) => {
    if (isPreviewOnlyBackend(backendId)) return;
    setMainBackend(backendId);
  }, []);

  const verifyInstall = useCallback(
    async (backendId: BackendId) => {
      setInstallCheck((prev) => ({
        ...prev,
        [backendId]: { status: "checking" },
      }));
      try {
        const res = await api.post<{
          ok: boolean;
          cliInstalled: boolean;
          cliCommand: string;
          exitCode: number | null;
          version: string | null;
          stdout: string;
          stderr: string;
          timedOut: boolean;
        }>(`/backends/${backendId}/verify-install`);
        await refetchBackends();
        if (res.ok) {
          setInstallCheck((prev) => ({
            ...prev,
            [backendId]: { status: "ok", version: res.version },
          }));
        } else {
          const reason = !res.cliInstalled
            ? `${res.cliCommand} not found on PATH`
            : res.timedOut
              ? `${res.cliCommand} --version timed out`
              : (res.stderr.trim() || res.stdout.trim() || "CLI failed to run");
          setInstallCheck((prev) => ({
            ...prev,
            [backendId]: { status: "error", error: reason },
          }));
        }
      } catch (err) {
        setInstallCheck((prev) => ({
          ...prev,
          [backendId]: {
            status: "error",
            error: err instanceof Error ? err.message : "Verify install failed",
          },
        }));
      }
    },
    [refetchBackends],
  );

  const canContinue =
    mainBackend !== null
    && !isPreviewOnlyBackend(mainBackend)
    && isContinueEligible({ mainBackend });

  async function applyAndNext(): Promise<void> {
    if (!mainBackend) return;
    // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — second click after a
    // cascade notice: the user has now acknowledged the cascade. Skip
    // re-PUTting `/backends/main` (the change already landed on the
    // first click) and proceed to the next wizard step.
    if (cascadeNotice !== null) {
      setCascadeNotice(null);
      onNext();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — capture `nativeUnbound`
      // from the response so the wizard can warn the user inline. Mirrors
      // the settings page toast (`backends-section.tsx`) so re-running the
      // wizard after configuring native rows doesn't silently drop them.
      const res = await api.put<{
        status?: string;
        nativeUnbound?: Array<{ key: string; priorNativeBackend: string }>;
      }>("/backends/main", { backendId: mainBackend });
      // /backends/main flips `backends.enabled = 1` server-side and
      // re-seeds process_backend_config rows for the new backend.
      // Invalidate the backends query so the next step (GoogleModeStep)
      // reads the post-apply state.
      // INTEGRATION_NATIVE_MODE_DESIGN.md §11.4 — the same call cascades
      // any native rows whose `nativeBackend` no longer matches. The
      // wizard's first launch never has native rows (defaults all
      // `disabled`/`direct`), but a re-run of the wizard with an
      // operator-provisioned native row would; surface the cascade
      // through the same invalidation chain the settings page uses so
      // /connections renders the §11.5 banner consistently.
      await queryClient.invalidateQueries({ queryKey: ["backends"] });
      await queryClient.invalidateQueries({ queryKey: ["integrations"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      await queryClient.invalidateQueries({
        queryKey: ["agent-actions", "native_unbound"],
      });

      const modePayload = buildSetupModePayload(topMode, overrides);
      if (modePayload) {
        await api.post("/setup/mode", modePayload);
        await queryClient.invalidateQueries({ queryKey: ["config"] });
      }

      // Defer the cascade-confirmation gate to *after* the mode payload
      // POST so a failure in `/setup/mode` doesn't strand the user with
      // a half-applied state. If cascade fired, hold here; the user
      // acknowledges, then clicks Next again — the early-return at the
      // top of this function advances without a redundant PUT.
      const unbound = res?.nativeUnbound ?? [];
      if (unbound.length > 0) {
        const keys = unbound.map((u) => u.key).join(", ");
        setCascadeNotice(
          `${unbound.length} native integration${unbound.length === 1 ? "" : "s"} (${keys}) ` +
          `were bound to a different backend and are now disabled. ` +
          `Re-configure them on /settings/integrations after the wizard completes.`,
        );
        setSaving(false);
        return;
      }
    } catch (err) {
      setSaveError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to apply default presets",
      );
      setSaving(false);
      return;
    }
    onNext();
  }

  return (
    <WizardStepFrame
      title="AI Backend"
      description="Aitne thinks through Claude Code, Codex, or Gemini. Pick which CLI runs the bulk of the work — non-main backends and per-process overrides can be assigned later from Settings → Models."
      onNext={onNext}
      hideNav
      maxWidth="max-w-4xl"
    >
      <SubscriptionAuthWarning />

      <div className="space-y-4">
        {BACKENDS.map((backendId) => {
          const row = backendsData?.backends.find((b) => b.id === backendId);
          const controlsDisabled = isPreviewOnlyBackend(backendId);
          return (
            <div key={backendId} className="space-y-2">
              <BackendCard
                backendId={backendId}
                mode="wizard"
                isMain={mainBackend === backendId}
                authStatus={row?.authStatus ?? "unknown"}
                authStatusDetail={row?.authDetail ?? null}
                authFirstExpiredAt={row?.authFirstExpiredAt ?? null}
                authLastSuccessAt={row?.authLastSuccessAt ?? null}
                authNotificationCount={row?.authNotificationCount ?? 0}
                cliInstalled={row?.cliInstalled ?? true}
                enabled={row?.enabled ?? true}
                webSearchEnabled={row?.webSearchEnabled ?? false}
                webSearchSupported={row?.webSearchSupported ?? false}
                permissionMode={null}
                controlsDisabled={controlsDisabled}
                disabledReason={controlsDisabled ? UI_PREVIEW_ONLY_REASON : undefined}
                installCheck={installCheck[backendId]}
                onCliInstalled={() => {
                  void refetchBackends();
                }}
                onVerifyInstall={() => {
                  void verifyInstall(backendId);
                }}
              />
              {!controlsDisabled && <BackendApiKeyPanel backendId={backendId} />}
            </div>
          );
        })}

        {/* Main backend radio */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <h3 className="text-sm font-semibold text-foreground">
            Main backend
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Runs routines, owner DMs, and any process you don&rsquo;t bind to a
            different backend in Settings → Models.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            {BACKENDS.map((backendId) => {
              const isActive = mainBackend === backendId;
              const controlsDisabled = isPreviewOnlyBackend(backendId);
              return (
                <label
                  key={backendId}
                  className={`flex flex-1 min-w-[180px] items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "border-primary bg-primary/10"
                      : controlsDisabled
                        ? "border-border bg-muted/40 text-muted-foreground"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="main-backend"
                    className="mt-1"
                    checked={isActive}
                    disabled={controlsDisabled}
                    onChange={() => pickMain(backendId)}
                  />
                  <span className="font-medium">
                    {BACKEND_PROVIDER_SHORT[backendId]}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <ExecutionModeSection
        topMode={topMode}
        overrides={overrides}
        advancedOpen={advancedOpen}
        onTopModeChange={setTopMode}
        onOverridesChange={setOverrides}
        onAdvancedOpenChange={setAdvancedOpen}
      />

      {saveError && (
        <p className="text-sm text-destructive text-center">{saveError}</p>
      )}
      {cascadeNotice && (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          role="status"
        >
          {cascadeNotice}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        ) : (
          <div />
        )}
        <Button
          onClick={() => void applyAndNext()}
          disabled={!canContinue || saving}
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Applying defaults…
            </>
          ) : cascadeNotice ? (
            <>
              Acknowledge &amp; continue <ArrowRight className="ml-2 h-4 w-4" />
            </>
          ) : (
            <>
              Next <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </WizardStepFrame>
  );
}

interface ExecutionModeSectionProps {
  topMode: ExecutionModeUi;
  overrides: PerBackendOverrides;
  advancedOpen: boolean;
  onTopModeChange: (mode: ExecutionModeUi) => void;
  onOverridesChange: (
    next: PerBackendOverrides | ((prev: PerBackendOverrides) => PerBackendOverrides),
  ) => void;
  onAdvancedOpenChange: (open: boolean) => void;
}

function ExecutionModeSection({
  topMode,
  overrides,
  advancedOpen,
  onTopModeChange,
  onOverridesChange,
  onAdvancedOpenChange,
}: ExecutionModeSectionProps) {
  const divergent = hasDivergentOverride(topMode, overrides);
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          Execution permissions
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          How strictly the daemon should gate the agent&rsquo;s shell, file,
          and tool calls. The absolute-block layer (recursive deletes,
          privilege escalation, secret-file reads) stays on in both modes.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <ModeCard
          icon={<ShieldCheck className="h-4 w-4" />}
          title="Safe"
          badge="Recommended"
          selected={topMode === "safe"}
          onSelect={() => onTopModeChange("safe")}
        >
          Per-tool permission checks plus the daemon&rsquo;s curl/jq hooks
          and CLI sandboxes. Side-effectful commands need approval.
        </ModeCard>
        <ModeCard
          icon={<Unlock className="h-4 w-4" />}
          title="Allow"
          selected={topMode === "allow"}
          onSelect={() => onTopModeChange("allow")}
        >
          Skips per-tool checks and the CLI sandboxes. Faster, but only the
          absolute-block layer stops the agent.
        </ModeCard>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
          >
            <span className="flex items-center gap-2">
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
              Per-backend overrides
              {divergent && (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                  mixed
                </span>
              )}
            </span>
            <span className="text-[11px]">
              {advancedOpen ? "Hide" : "Show"}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2 rounded-md border border-border bg-background p-3">
          {BACKENDS.map((backend) => (
            <BackendOverrideRow
              key={backend}
              backend={backend}
              topMode={topMode}
              override={overrides[backend] ?? null}
              disabled={isPreviewOnlyBackend(backend)}
              onChange={(next) =>
                onOverridesChange((prev) => ({ ...prev, [backend]: next }))
              }
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

interface ModeCardProps {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}

function ModeCard({
  icon,
  title,
  badge,
  selected,
  onSelect,
  children,
}: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "block w-full rounded-md border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/10 shadow-sm"
          : "border-border bg-background hover:border-foreground/30",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
        {badge && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{children}</p>
    </button>
  );
}

interface BackendOverrideRowProps {
  backend: BackendId;
  topMode: ExecutionModeUi;
  override: ExecutionModeUi | null;
  disabled?: boolean;
  onChange: (next: ExecutionModeUi | null) => void;
}

function BackendOverrideRow({
  backend,
  topMode,
  override,
  disabled = false,
  onChange,
}: BackendOverrideRowProps) {
  const effective = override ?? topMode;
  const showCodexAllowWarning = backend === "codex" && effective === "allow";
  return (
    <div
      className={cn(
        "rounded-md border border-border/60 px-3 py-2",
        disabled && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          <div className="font-medium text-foreground">
            {BACKEND_PROVIDER_LABELS[backend]}
            <span className="ml-1 text-xs text-muted-foreground">
              ({BACKEND_PROVIDER_SHORT[backend]})
            </span>
            {disabled && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Coming soon
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            runs as: {effective}
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <OverrideChip
            active={override === null}
            label="Follow"
            disabled={disabled}
            onClick={() => onChange(null)}
          />
          <OverrideChip
            active={override === "safe"}
            label="Safe"
            disabled={disabled}
            onClick={() => onChange("safe")}
          />
          <OverrideChip
            active={override === "allow"}
            label="Allow"
            disabled={disabled}
            onClick={() => onChange("allow")}
          />
        </div>
      </div>
      {showCodexAllowWarning && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Codex Allow runs sandbox-off; the daemon&apos;s absolute-block
            layer cannot intercept destructive shell commands for Codex.
          </span>
        </p>
      )}
    </div>
  );
}

function OverrideChip({
  active,
  label,
  disabled = false,
  onClick,
}: {
  active: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border px-2 py-1 transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:border-foreground/30",
        disabled && "cursor-not-allowed opacity-60 hover:border-border",
      )}
    >
      {label}
    </button>
  );
}
