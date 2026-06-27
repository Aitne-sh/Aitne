"use client";

import {
  CheckCircle2,
  Globe,
  Loader2,
  Lock as _Lock,
  Terminal,
  XCircle,
} from "lucide-react";
import type { BackendId } from "@aitne/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BACKEND_BADGE_VARIANTS,
  BACKEND_PROVIDER_LABELS,
  BACKEND_WEB_SEARCH_DESCRIPTIONS,
  getBackendDeprecation,
} from "@/lib/backend-ui";
import { AuthStatusBadge } from "./auth-status-badge";
import { CliInstallPanel } from "./cli-install-panel";
import {
  isAllowModeActive,
  isRecommended,
  shouldEnableVerifyInstall,
  shouldShowCliInstall,
  shouldShowWizardConfigureLaterHint,
} from "./backend-card.logic";

export interface BackendCardProps {
  backendId: BackendId;
  mode: "wizard" | "settings";

  // Identity + state
  isMain: boolean;
  authStatus: string;
  authStatusDetail?: string | null;
  authFirstExpiredAt?: string | null;
  authLastSuccessAt?: string | null;
  authNotificationCount?: number;
  cliInstalled: boolean;
  enabled: boolean;
  webSearchEnabled: boolean;
  webSearchSupported?: boolean;
  /**
   * Derived by the parent from `config.{backendId}ExecutionPermissionMode`.
   * Passed through `isAllowModeActive()` so the card stays pure — no
   * second `useConfig()` subscription.
   */
  permissionMode: string | null | undefined;

  // Transient UI state
  /** True while enable/disable, web-search, verify-install, install are in flight. */
  busy?: boolean;
  /** Phase-gated backends are shown for discoverability but cannot be operated yet. */
  controlsDisabled?: boolean;
  disabledReason?: React.ReactNode;
  /** Inline state for the Verify-Install button — card-local, not global. */
  installCheck?: {
    status: "idle" | "checking" | "ok" | "error";
    error?: string | null;
    version?: string | null;
  };

  // Callbacks
  onCliInstalled?: () => void;
  onVerifyInstall: () => void;
  onToggleEnable?: () => void;
  onToggleWebSearch?: () => void;

  /**
   * Optional slot rendered between the auth strip and the settings-only
   * control row. Used to inline an "Advanced — default light/heavy
   * models" collapsible on the MAIN card only. Keeping it as a slot —
   * rather than hoisting model-draft state into the card — preserves
   * `BackendCard`'s "pure presentation" contract.
   */
  renderExtra?: () => React.ReactNode;
}

/**
 * Single-row card rendering one backend's identity + CLI + auth +
 * toggles. Subscription-plan picker has been removed — Aitne is
 * designed to run on provider API keys (`ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` / `GEMINI_API_KEY`), and the daemon does not ask
 * the operator which Claude/Codex/Gemini tier they hold. Consumed by:
 *   - the wizard's `backends-step.tsx` (mode="wizard") — no enable /
 *     web-search controls, inline auth-check state, hint shown when
 *     the non-main card is incomplete;
 *   - the settings page (mode="settings") — adds enable / web-search
 *     / Allow pill + anchor back to the Execution Mode card.
 *
 * The card itself owns zero data-fetching. Parents thread in backend
 * status (from `useBackends()`) and the derived `permissionMode` /
 * `isMain` flags as props.
 */
export function BackendCard(props: BackendCardProps) {
  const {
    backendId,
    mode,
    isMain,
    authStatus,
    authStatusDetail,
    authFirstExpiredAt,
    authLastSuccessAt,
    authNotificationCount,
    cliInstalled,
    enabled,
    webSearchEnabled,
    webSearchSupported,
    permissionMode,
    busy = false,
    controlsDisabled = false,
    disabledReason,
    installCheck,
    onCliInstalled,
    onVerifyInstall,
    onToggleEnable,
    onToggleWebSearch,
    renderExtra,
  } = props;

  const allowModeActive = isAllowModeActive(permissionMode);
  const recommended = isRecommended(backendId);
  const deprecation = getBackendDeprecation(backendId);
  const showInstall = !controlsDisabled && shouldShowCliInstall(cliInstalled);
  const verifyEnabled = !controlsDisabled && shouldEnableVerifyInstall(busy);
  // Prominent CTA when the CLI is on PATH but we have not yet confirmed
  // it can actually run (or last run failed). Once the user clicks Verify
  // install and gets `ok`, we drop the callout.
  const verifyInstallRequired =
    cliInstalled
    && installCheck?.status !== "ok"
    && installCheck?.status !== "checking";
  const showHint = shouldShowWizardConfigureLaterHint({
    mode,
    isMain,
    cliInstalled,
  });

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={BACKEND_BADGE_VARIANTS[backendId]}>
              {BACKEND_PROVIDER_LABELS[backendId]}
            </Badge>
            {recommended && (
              <Badge variant="gray" className="font-normal">
                Recommended
              </Badge>
            )}
            {isMain && <Badge variant="amber">MAIN</Badge>}
            <AuthStatusBadge
              status={authStatus}
              detail={authStatusDetail ?? null}
              firstExpiredAt={authFirstExpiredAt ?? null}
              lastSuccessAt={authLastSuccessAt ?? null}
              notificationCount={authNotificationCount ?? 0}
            />
            {mode === "settings" && allowModeActive && (
              <a href="#execution-mode" className="inline-flex">
                <Badge
                  variant="red"
                  className="cursor-pointer"
                  title="Allow mode is on for this backend — click to jump to the Execution Mode card"
                >
                  Allow
                </Badge>
              </a>
            )}
            {mode === "settings" && (
              <Badge variant={enabled ? "green" : "gray"}>
                {enabled ? "Enabled" : "Disabled"}
              </Badge>
            )}
            {controlsDisabled && <Badge variant="gray">Preview</Badge>}
            {deprecation && (
              <Badge variant="amber" title={deprecation.reason}>
                {deprecation.badgeLabel}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* ── CLI + auth strip ───────────────────────────────── */}
      <div className="mt-4 space-y-3 border-t border-border pt-4">
        {controlsDisabled && disabledReason && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {disabledReason}
          </p>
        )}
        {deprecation && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {deprecation.reason}
          </p>
        )}
        {!controlsDisabled && (
          <>
            {showInstall ? (
              <CliInstallPanel
                backendId={backendId}
                cliInstalled={cliInstalled}
                compact
                onInstalled={() => {
                  onCliInstalled?.();
                }}
              />
            ) : (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" />
                <span>CLI installed</span>
              </div>
            )}

            <div
              className={cn(
                "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
                verifyInstallRequired &&
                  "rounded-lg border border-primary/40 bg-primary/5 p-3",
              )}
            >
              <div className="space-y-1">
                {verifyInstallRequired ? (
                  <>
                    <p className="text-sm font-semibold text-foreground">
                      Verify the CLI runs on this machine
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Confirms the {BACKEND_PROVIDER_LABELS[backendId]} CLI is
                      on your{" "}
                      <code className="rounded bg-muted px-1">PATH</code> and
                      responds to{" "}
                      <code className="rounded bg-muted px-1">--version</code>.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {cliInstalled
                      ? "Re-run this whenever you reinstall or update the CLI to confirm it still launches."
                      : "Install the CLI first, then verify it runs."}
                  </p>
                )}
              </div>
              <Button
                size={verifyInstallRequired ? "default" : "sm"}
                variant={verifyInstallRequired ? "default" : "outline"}
                disabled={!verifyEnabled}
                onClick={onVerifyInstall}
                className={cn(
                  "gap-2",
                  verifyInstallRequired &&
                    "shrink-0 self-start ring-2 ring-primary/40 ring-offset-2 ring-offset-background sm:self-auto",
                )}
              >
                {installCheck?.status === "checking" ? (
                  <Loader2
                    className={cn(
                      "animate-spin",
                      verifyInstallRequired ? "h-4 w-4" : "h-3.5 w-3.5",
                    )}
                  />
                ) : installCheck?.status === "ok" ? (
                  <CheckCircle2
                    className={cn(
                      "text-success",
                      verifyInstallRequired ? "h-4 w-4" : "h-3.5 w-3.5",
                    )}
                  />
                ) : installCheck?.status === "error" ? (
                  <XCircle
                    className={cn(
                      "text-destructive",
                      verifyInstallRequired ? "h-4 w-4" : "h-3.5 w-3.5",
                    )}
                  />
                ) : verifyInstallRequired ? (
                  <Terminal className="h-4 w-4" />
                ) : null}
                {installCheck?.status === "checking"
                  ? "Checking…"
                  : "Verify install"}
              </Button>
            </div>
            {installCheck?.status === "ok" && installCheck.version && (
              <p className="text-xs text-success">
                CLI runs OK —{" "}
                <code className="rounded bg-muted px-1">
                  {installCheck.version}
                </code>
              </p>
            )}
            {installCheck?.status === "error" && installCheck.error && (
              <p className="text-xs text-destructive">
                {installCheck.error}
              </p>
            )}
            {showHint && (
              <p className="text-xs text-muted-foreground">
                You can install the CLI and verify it later from{" "}
                <code className="rounded bg-muted px-1">/settings/models</code>.
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Optional extra slot (e.g. main-card Advanced) ──── */}
      {renderExtra && (
        <div className="mt-4 border-t border-border pt-4">
          {renderExtra()}
        </div>
      )}

      {/* ── Settings-only controls ─────────────────────────── */}
      {mode === "settings" && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {onToggleEnable && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                variant={enabled ? "outline" : "default"}
                onClick={onToggleEnable}
                disabled={controlsDisabled || busy}
              >
                {enabled ? "Disable backend" : "Enable backend"}
              </Button>
            </div>
          )}
          {onToggleWebSearch && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    Web search
                  </p>
                  <Badge
                    variant={webSearchEnabled ? "green" : "gray"}
                    className="text-[10px]"
                  >
                    {!webSearchSupported
                      ? "Not supported"
                      : webSearchEnabled
                        ? "On"
                        : "Off"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {webSearchSupported
                    ? BACKEND_WEB_SEARCH_DESCRIPTIONS[backendId]
                    : "This backend does not expose a web-search tool."}
                </p>
                {webSearchSupported && !enabled && (
                  <p className="text-xs text-warning">
                    Enable the backend first to toggle web search.
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={webSearchEnabled ? "outline" : "default"}
                onClick={onToggleWebSearch}
                disabled={controlsDisabled || !webSearchSupported || !enabled || busy}
                className="shrink-0 self-start sm:self-center"
              >
                {webSearchEnabled ? "Disable web search" : "Enable web search"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
