"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, RefreshCw, X } from "lucide-react";
import type {
  BackendId,
  IntegrationKey,
  IntegrationMode,
} from "@aitne/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useBackends } from "@/lib/hooks/use-backends";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import {
  useIntegrations,
  useIntegrationProbeLive,
  useNativeUnboundActions,
  usePatchIntegration,
  useProxyModels,
  useRecentProxyCalls,
} from "@/lib/hooks/use-integrations";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { useQueryClient } from "@tanstack/react-query";
import type {
  IntegrationHealthEntry,
  IntegrationListItem,
} from "@/lib/api-types";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  availableDelegatedBackends,
  availableNativeBackends,
  buildFeatureMatrix,
  canFlipToNative,
  directCredentialsPresent,
  estimateCostPerCallUsd,
  formatPerCallUsd,
  formatRecentCallCost,
  formatRecentCallDuration,
  formatRecentCallTimestamp,
  modeLabel,
  PROXY_MODEL_AUTO_VALUE,
  shortenRecentCallTool,
  shouldShowReconfigureBanner,
  subTierLabel,
  type FeatureMatrixRow,
} from "./integration-card.logic";
import { purgeCopyForIntegration } from "./integration-mode-dialog.logic";
import {
  IntegrationModeDialog,
  type TokenHandling,
} from "./integration-mode-dialog";
import { ModeExplainer } from "./mode-explainer";
import { ToolPermissionsCard } from "./tool-permissions-card";
import {
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";

interface Props {
  integrationKey: IntegrationKey;
  /**
   * Count of direct Gmail accounts for the multi-account warning.
   * Only relevant for the Gmail card; Calendar pages can pass 0.
   */
  gmailAccountCount?: number;
  /**
   * Extra integration-specific UI rendered inside the card, after the
   * mode-specific section. Used by the Knowledge page to fold Notion's API
   * key + database mappings into the same card as the mode dropdown so the
   * user sees a single "Notion" card instead of two stacked ones.
   */
  children?: React.ReactNode;
}

/**
 * Per-integration card (§4.9) — mode dropdown, feature matrix, probe
 * status, direct-mode credential hand-off. Rendered on `/connections/mail`
 * (Gmail) and `/connections/calendar` (Google Calendar) alongside the
 * existing provider / OAuth cards. Registry-driven: adding a new integration
 * key to `packages/shared/src/integrations.ts` is enough for a card to render
 * anywhere this component is mounted.
 */
export function IntegrationCard({
  integrationKey,
  gmailAccountCount = 0,
  children,
}: Props) {
  const integrations = useIntegrations();
  const health = useHealth();
  const config = useConfig();
  const backends = useBackends();
  const nativeUnbound = useNativeUnboundActions();
  const patch = usePatchIntegration();
  const probeLive = useIntegrationProbeLive();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [dialogState, setDialogState] = useState<{
    open: boolean;
    targetMode: IntegrationMode;
    targetBackend?: BackendId;
  } | null>(null);
  const [tokenHandling, setTokenHandling] = useState<TokenHandling>("keep");
  const [patchError, setPatchError] = useState<string | null>(null);
  const [backendSwapError, setBackendSwapError] = useState<string | null>(null);
  const [reconfigureDismissed, setReconfigureDismissed] = useState(false);

  const descriptor: IntegrationListItem | undefined = useMemo(() => {
    return integrations.data?.integrations.find(
      (x) => x.key === integrationKey,
    );
  }, [integrations.data, integrationKey]);

  const entry: IntegrationHealthEntry | undefined =
    health.data?.integrationModes?.[integrationKey];

  // INTEGRATION_NATIVE_MODE_DESIGN.md §3.3 — current main backend drives
  // both the §11.5 re-configure banner and the §11.1 wizard / radio gate.
  const mainBackend: BackendId | null = backends.data?.defaultBackend ?? null;

  if (integrations.isLoading || health.isLoading) {
    return <CardShell name={integrationKey}>Loading…</CardShell>;
  }

  if (!descriptor || !entry) {
    return (
      <CardShell name={integrationKey}>
        <Alert variant="error">
          Could not load integration metadata. The daemon may be offline.
        </Alert>
      </CardShell>
    );
  }

  const delegatedBackends = availableDelegatedBackends(descriptor);
  const nativeBackendsList = availableNativeBackends(descriptor);
  const credentialsPresent = directCredentialsPresent(integrationKey, config.data);
  const purge = purgeCopyForIntegration(descriptor);

  // INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — re-configure banner. Show
  // when the integration was unbound by a recent main-backend switch and
  // the user has not re-bound it yet (mode still `disabled`). Dismissal
  // is local; the durable acknowledgement is touching the mode via the
  // picker — `shouldShowReconfigureBanner` compares the row's
  // `lastChangedAt` against the cascade audit row's `startedAt` so a
  // manual re-disable doesn't get pestered for the rest of the 7-day
  // lookup window. The hook returns entries newest-first, so `.find()`
  // picks up the most recent cascade.
  const unboundEntry = (nativeUnbound.data ?? []).find(
    (a) => a.key === integrationKey,
  );
  const showReconfigureBanner = shouldShowReconfigureBanner({
    mode: entry.mode,
    unboundEntry,
    stateLastChangedAt: descriptor.state.lastChangedAt,
    dismissedLocally: reconfigureDismissed,
  });

  // §14.1 — one-click hint when the current delegated binding equals the
  // main backend AND native is supported for that pair. Switching reuses
  // the same backend and turns off the worker cadence.
  const showDelegatedToNativeHint =
    entry.mode === "delegated"
    && mainBackend !== null
    && entry.delegatedBackend === mainBackend
    && canFlipToNative(descriptor, mainBackend);

  const featureMatrix = buildFeatureMatrix(
    entry.features,
    descriptor,
    entry.mode === "native" ? entry.nativeBackend : entry.delegatedBackend,
  );

  const onSelectMode = (next: IntegrationMode) => {
    if (next === entry.mode) return;
    setPatchError(null);
    setTokenHandling("keep");
    if (next === "delegated") {
      const firstBackend = delegatedBackends[0];
      if (!firstBackend) return;
      setDialogState({ open: true, targetMode: "delegated", targetBackend: firstBackend });
      return;
    }
    if (next === "native") {
      // §3.3 invariant — native binds to main backend; the radio is
      // already gated on `canFlipToNative(...)`, so reaching this branch
      // means we have a valid main backend that supports native.
      if (!mainBackend || !nativeBackendsList.includes(mainBackend)) return;
      setDialogState({ open: true, targetMode: "native", targetBackend: mainBackend });
      return;
    }
    setDialogState({ open: true, targetMode: next });
  };

  // Within delegated mode, swapping backends is a low-impact change — only
  // skill/task-flow variants re-materialize, no features are lost. The
  // confirmation dialog used for direct↔delegated transitions adds no value
  // here, so we apply directly (mirroring DelegatedModelPicker below) and
  // surface any error inline. The dialog still owns the higher-stakes
  // mode-change paths (direct↔delegated, enable, disable).
  const onSelectBackend = async (next: BackendId) => {
    if (entry.mode !== "delegated" || next === entry.delegatedBackend) return;
    setBackendSwapError(null);
    try {
      await patch.mutateAsync({
        key: integrationKey,
        body: { mode: "delegated", delegatedBackend: next },
      });
      void probeLive.mutateAsync({
        key: integrationKey,
        backend: next,
        liveProbe: true,
      }).catch(() => undefined);
    } catch (err) {
      setBackendSwapError(formatPatchError(err));
    }
  };

  const applySwitch = async () => {
    if (!dialogState) return;
    // Clear any stale error from a prior attempt so clicking Continue a
    // second time (after fixing the external config, e.g. enabling the
    // connector on claude.ai) retries cleanly instead of showing the old
    // message stacked with the new outcome.
    setPatchError(null);

    // Direct → delegated + Purge requires a second confirmation per §4.12.4.
    // Copy + secret-key list are descriptor-driven so a future integration
    // (e.g. Notion) does not silently inherit Google's wording or keys —
    // see purgeCopyForIntegration. If the descriptor exposes no
    // directSetup, the picker is hidden upstream and this branch is dead.
    if (
      entry.mode === "direct"
      && dialogState.targetMode === "delegated"
      && tokenHandling === "purge"
      && purge
    ) {
      const ok = await confirm({
        title: purge.confirmTitle,
        description: purge.confirmDescription,
        confirmLabel: "Purge",
        cancelLabel: "Keep dormant",
        variant: "destructive",
        requireText: "purge",
      });
      if (!ok) {
        setTokenHandling("keep");
        return;
      }
    }

    const body = {
      mode: dialogState.targetMode,
      ...(dialogState.targetMode === "delegated" && dialogState.targetBackend
        ? { delegatedBackend: dialogState.targetBackend }
        : {}),
      ...(dialogState.targetMode === "native" && dialogState.targetBackend
        ? { nativeBackend: dialogState.targetBackend }
        : {}),
    };
    try {
      await patch.mutateAsync({ key: integrationKey, body });
      if (
        (dialogState.targetMode === "delegated"
          || dialogState.targetMode === "native")
        && dialogState.targetBackend
      ) {
        // Keep Apply responsive: mode changes commit immediately, then the
        // slow backend connector probe refreshes the feature matrix in the
        // background. Explicit Re-probe still surfaces connector errors.
        // §9.3 — native flips share the same probe contract as delegated,
        // so the same live probe call gives the user immediate feedback
        // about connector health.
        void probeLive.mutateAsync({
          key: integrationKey,
          backend: dialogState.targetBackend,
          liveProbe: true,
        }).catch(() => undefined);
      }
      if (
        entry.mode === "direct"
        && dialogState.targetMode === "delegated"
        && tokenHandling === "purge"
        && purge
      ) {
        // Best-effort: if any delete fails the card surfaces the error
        // but the PATCH already succeeded, so mode state is correct.
        // Drives off `descriptor.directSetup.credentialKeys` so a Notion
        // purge deletes notionApiKey, not Google's secrets — the prior
        // hardcoded list was active data loss for non-Google integrations.
        await Promise.all(
          purge.secretKeys.map((k) =>
            api.delete(`/secrets/${k}`).catch(() => {}),
          ),
        );
        queryClient.invalidateQueries({ queryKey: ["config"] });
      }
      setDialogState(null);
    } catch (err) {
      setPatchError(formatPatchError(err));
    }
  };

  return (
    <>
      <CardShell
        name={descriptor.displayName}
        badge={
          <div className="flex items-center gap-2">
            {entry.subTier && (
              <Badge variant="blue">{subTierLabel(entry.subTier)}</Badge>
            )}
            <Badge variant={modeBadgeVariant(entry.mode)}>
              {modeLabel(
                entry.mode,
                entry.mode === "native"
                  ? entry.nativeBackend
                  : entry.delegatedBackend,
              )}
            </Badge>
          </div>
        }
      >
        <div className="space-y-3">
          {/* §11.5 — Re-configure banner. Shown when the main backend was
              switched while this integration was native, leaving the row
              cascaded to `disabled`. Dismissible (local) — the durable
              acknowledgement is flipping the mode below. */}
          {showReconfigureBanner && unboundEntry && (
            <Alert variant="error">
              <p className="text-sm font-medium">
                Native binding lost — re-configure {descriptor.displayName}.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {descriptor.displayName} was set to native mode on{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  {unboundEntry.priorNativeBackend ?? "?"}
                </code>{" "}
                but you switched the main backend to{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  {unboundEntry.newMainBackend ?? mainBackend ?? "?"}
                </code>
                . Native bindings are explicit — pick a mode below to restore
                agent awareness.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-6 px-2 text-[11px]"
                onClick={() => setReconfigureDismissed(true)}
              >
                Dismiss
              </Button>
            </Alert>
          )}

          {/* §14.1 — One-click delegated→native conversion hint. The user
              has delegated to their own main backend already; switching to
              native is operationally simpler. The copy branches on
              `userManagedConnector` because for those descriptors the
              delegated-sync-worker has no cadence registered (no descriptor-
              driven probe → no cadence), so "stops the worker cadence" would
              be inaccurate. Both branches surface the same actionable
              outcome but with truthful framing for each path. */}
          {showDelegatedToNativeHint && mainBackend && (
            <Alert variant="info">
              {descriptor.userManagedConnector ? (
                <p className="text-sm">
                  You&apos;re delegated to your main backend (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    {mainBackend}
                  </code>
                  ). Switching to <strong>Native</strong> swaps the row to an
                  explicit binding against {mainBackend} — the user-installed{" "}
                  {descriptor.displayName} MCP is reached the same way, but
                  the mode label honestly reflects that the daemon never
                  proxies this integration, and a future main-backend change
                  will prompt you to re-confirm the binding instead of
                  silently moving the delegation.
                </p>
              ) : (
                <p className="text-sm">
                  You&apos;re delegated to your main backend (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    {mainBackend}
                  </code>
                  ). Switching to <strong>Native</strong> stops the background
                  worker cadence and lets the agent fetch{" "}
                  {descriptor.displayName} in-turn through {mainBackend}&apos;s
                  own connector — fewer moving parts, no proxy hop.
                </p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={patch.isPending}
                  onClick={() => {
                    setPatchError(null);
                    setTokenHandling("keep");
                    setDialogState({
                      open: true,
                      targetMode: "native",
                      targetBackend: mainBackend,
                    });
                  }}
                >
                  Switch to native
                </Button>
              </div>
            </Alert>
          )}

          {/* Mode picker — radio cards with per-mode "Show details" disclosure
              that explains pros/cons. The bare Select previously here gave the
              user no way to make an informed choice; this surface fixes that. */}
          <ModeExplainer
            currentMode={entry.mode}
            descriptor={descriptor}
            delegatedBackendCount={delegatedBackends.length}
            mainBackend={mainBackend}
            disabled={patch.isPending}
            onSelectMode={onSelectMode}
          />
          {entry.mode === "delegated" && delegatedBackends.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Backend
              </label>
              <Select
                value={entry.delegatedBackend ?? delegatedBackends[0]}
                onValueChange={(v) => void onSelectBackend(v as BackendId)}
                disabled={patch.isPending}
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
              {backendSwapError && (
                <Alert variant="error" className="mt-2">
                  <p className="text-xs">{backendSwapError}</p>
                </Alert>
              )}
            </div>
          )}

          {/* Variant-missing surface — §4.7 (delegated) and §7.4 / §8.5 (native). */}
          {entry.variantsMissing && entry.variantsMissing.length > 0 && (
            <Alert variant="error">
              <p className="font-medium">
                Missing {entry.mode === "native" ? "native" : "delegated"}{" "}
                variant file(s) — agent will silently fall back to the direct-
                mode skill body.
              </p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                {entry.variantsMissing.map((p) => (
                  <li key={p} className="break-all">{p}</li>
                ))}
              </ul>
            </Alert>
          )}

          {/* Delegated-mode context */}
          {entry.mode === "delegated" && (
            <>
              <DelegatedDetails
                integrationKey={integrationKey}
                entry={entry}
                descriptor={descriptor}
                featureMatrix={featureMatrix}
              />
              {/* DELEGATED-PROXY-API-DESIGN.md §7 — model picker.
                  Suppressed for user-managed connectors — the daemon has
                  no proxy to configure a model on. */}
              {entry.delegatedBackend && !descriptor.userManagedConnector && (
                <DelegatedModelPicker
                  integrationKey={integrationKey}
                  delegatedBackend={entry.delegatedBackend}
                  delegatedModel={descriptor.state.delegatedModel ?? null}
                  currentMode={entry.mode}
                />
              )}
              {/* §7.7 Tool permissions — per-capability deny toggles.
                  Suppressed for user-managed connectors because the
                  descriptor ships no capability list to enforce against. */}
              {entry.delegatedBackend && !descriptor.userManagedConnector && (
                <ToolPermissionsCard
                  integrationKey={integrationKey}
                  descriptor={descriptor}
                  delegatedBackend={entry.delegatedBackend}
                  deniedTools={descriptor.state.deniedTools}
                  currentMode={entry.mode}
                />
              )}
              {/* DELEGATED-PROXY-API-DESIGN.md §7 — Recent proxy calls.
                  Suppressed for user-managed connectors (no proxy log). */}
              {!descriptor.userManagedConnector && (
                <RecentProxyCallsTable integrationKey={integrationKey} />
              )}
            </>
          )}

          {/* Native-mode context — §11.5. Feature matrix mirrors delegated
              mode because the probe contract (§9.3) is identical, but the
              copy distinguishes "fetched in-turn through <backend>" from
              "proxied through delegated worker". */}
          {entry.mode === "native" && (
            <NativeDetails
              integrationKey={integrationKey}
              entry={entry}
              descriptor={descriptor}
              featureMatrix={featureMatrix}
              mainBackend={mainBackend}
            />
          )}

          {/* Direct-mode context */}
          {entry.mode === "direct" && (
            <DirectDetails
              integrationKey={integrationKey}
              credentialsPresent={credentialsPresent}
            />
          )}

          {/* Disabled-mode context */}
          {entry.mode === "disabled" && (
            <Alert variant="info">
              <p>
                Disabled. The agent does not observe or act on this
                integration. Flip the mode above to re-enable.
              </p>
            </Alert>
          )}

          {children}
        </div>
      </CardShell>

      {dialogState && (
        <IntegrationModeDialog
          open={dialogState.open}
          onOpenChange={(open) => {
            setDialogState((prev) => (prev ? { ...prev, open } : null));
            if (!open) setPatchError(null);
          }}
          descriptor={descriptor}
          currentMode={entry.mode}
          currentBackend={
            // Both delegatedBackend and nativeBackend collapse to the
            // single "current backend" the dialog uses to label the
            // source side of the flip. The fields are mutually exclusive
            // per the schema's `superRefine`, so coalesce.
            entry.mode === "native"
              ? entry.nativeBackend
              : entry.delegatedBackend
          }
          targetMode={dialogState.targetMode}
          targetBackend={dialogState.targetBackend}
          onTargetBackendChange={(b) =>
            setDialogState((prev) => (prev ? { ...prev, targetBackend: b } : null))
          }
          directCredentialsPresent={credentialsPresent}
          gmailAccountCount={gmailAccountCount}
          tokenHandling={tokenHandling}
          onTokenHandlingChange={setTokenHandling}
          onConfirm={applySwitch}
          isPending={patch.isPending}
          error={patchError}
        />
      )}
    </>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function CardShell({
  name,
  badge,
  children,
}: {
  name: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">{name}</h3>
        {badge}
      </div>
      {children}
    </Card>
  );
}

function modeBadgeVariant(
  mode: IntegrationMode,
): "green" | "amber" | "blue" | "gray" {
  if (mode === "direct") return "green";
  if (mode === "delegated") return "amber";
  // INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — distinct hue from delegated
  // (amber) so the 4-state pill is glanceable. Blue mirrors the subTier
  // chip palette used for "draft-only" / "full-auto" — a different axis
  // of metadata but the same "informational" semantic.
  if (mode === "native") return "blue";
  return "gray";
}

function formatPatchError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as
      | {
          error?: string;
          mode?: "delegated" | "native";
          missingSkills?: string[];
          missingTaskFlows?: string[];
          message?: string;
          // INTEGRATION_NATIVE_MODE_DESIGN.md §11.2 — backend gates.
          supportedNativeBackends?: string[];
          mainBackend?: string;
          nativeBackend?: string;
        }
      | undefined;
    if (body?.error === "missing_variants") {
      const missing = [
        ...(body.missingSkills ?? []),
        ...(body.missingTaskFlows ?? []),
      ];
      const modeLabel = body.mode === "native" ? "native" : "delegated";
      return `Missing variant file(s) for ${modeLabel} mode:\n${missing.join("\n")}`;
    }
    if (body?.error === "backend_not_supported_native") {
      const supported = body.supportedNativeBackends?.join(", ") ?? "—";
      return `${body.message ?? "Backend has no native connector."} Supported native backends: ${supported}.`;
    }
    if (body?.error === "native_backend_mismatches_main") {
      return body.message
        ?? `Native mode must bind to the current main backend (${body.mainBackend ?? "?"}).`;
    }
    return body?.message ?? err.message;
  }
  return err instanceof Error ? err.message : "Unexpected error";
}

// ── Delegated details — feature matrix + probe recency ─────────────────────

interface DelegatedDetailsProps {
  integrationKey: IntegrationKey;
  entry: IntegrationHealthEntry;
  descriptor: IntegrationListItem;
  featureMatrix: FeatureMatrixRow[];
}

/**
 * Per-backend recipe for installing a user-managed MCP / connector.
 * Integration-agnostic: parameterized by the displayName so it stays
 * correct as more user-managed integrations land (Outlook today;
 * future candidates: Teams, OneDrive, custom MCP servers).
 */
function userManagedConnectorHint(
  backend: BackendId,
  displayName: string,
): string {
  switch (backend) {
    case "claude":
      return `Claude Code: register an MCP server via \`claude mcp add\` or wire up a connector at claude.ai/connections that exposes ${displayName}.`;
    case "codex":
      return `Codex: add an MCP server entry to your Codex configuration that exposes ${displayName} so the connector surfaces in Codex's tool list.`;
    case "gemini":
      return `Gemini CLI: install an MCP extension that exposes ${displayName} (e.g. \`gemini mcp add\` or a \`~/.gemini/extensions/<name>/\` directory).`;
    case "opencode":
      return `OpenCode: configure an MCP server for ${displayName} once OpenCode runtime support is enabled.`;
  }
}

function UserManagedConnectorNotice({
  descriptor,
  backend,
  mode,
}: {
  descriptor: IntegrationListItem;
  backend: BackendId | null | undefined;
  mode: "delegated" | "native";
}) {
  const hint = backend
    ? userManagedConnectorHint(backend, descriptor.displayName)
    : null;
  const modeLabel = mode === "native" ? "Native" : "Delegated";
  return (
    <Alert variant="info">
      <p className="text-xs font-medium">
        User-managed connector — the daemon does not poll, proxy, or store
        credentials for {descriptor.displayName}.
      </p>
      <p className="mt-1 text-xs">
        {modeLabel} mode requires you to register an MCP server or connector
        on the {backend ?? "selected"} backend that gives it access to
        {" "}
        {descriptor.displayName}. The agent uses those tools directly; no
        capability probe runs and no daemon-side proxy is exposed.
      </p>
      {hint && (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      )}
    </Alert>
  );
}

function DelegatedDetails({
  integrationKey,
  entry,
  descriptor,
  featureMatrix,
}: DelegatedDetailsProps) {
  const present = featureMatrix.filter((r) => r.present).length;
  const total = featureMatrix.length;
  const probeDate = entry.lastProbeAt
    ? new Date(entry.lastProbeAt).toLocaleString()
    : null;
  const backend = entry.delegatedBackend;
  const connector = backend ? descriptor.backendConnectors[backend] : null;
  const probeLive = useIntegrationProbeLive();
  const [probeError, setProbeError] = useState<string | null>(null);

  // User-managed connector: the daemon ships no descriptor-side tool
  // inventory for this integration (e.g. Outlook). Render a clear notice
  // explaining the user must register an MCP server / connector on the
  // selected agent backend; suppress the namespace / feature matrix /
  // probe controls because none of them apply.
  if (descriptor.userManagedConnector) {
    return (
      <UserManagedConnectorNotice
        descriptor={descriptor}
        backend={backend}
        mode="delegated"
      />
    );
  }

  const onReprobe = async () => {
    if (!backend) return;
    setProbeError(null);
    try {
      await probeLive.mutateAsync({
        key: integrationKey,
        backend,
        liveProbe: true,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as
          | { error?: string; message?: string }
          | undefined;
        if (body?.error === "live_probe_unsupported") {
          setProbeError(
            body.message ?? "Live probe not yet supported on this backend.",
          );
        } else {
          setProbeError(body?.message ?? err.message);
        }
      } else {
        setProbeError(err instanceof Error ? err.message : "Unexpected error");
      }
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Tool namespace{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            {entry.toolNamespace ?? "?"}
          </code>
        </span>
        <span>
          Capabilities{" "}
          <span className="text-foreground">
            {present}/{total}
          </span>
        </span>
        <span>
          Probe{" "}
          <span className="text-foreground">
            {probeDate ?? "defaults (no live probe yet)"}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => void onReprobe()}
          disabled={probeLive.isPending || !backend}
          aria-label="Re-probe connector"
        >
          <RefreshCw
            className={cn(
              "h-3 w-3",
              probeLive.isPending && "animate-spin",
            )}
          />
          {probeLive.isPending ? "Probing…" : "Re-probe"}
        </Button>
      </div>
      {probeError && (
        <Alert variant="error">
          <p className="text-xs">{probeError}</p>
        </Alert>
      )}

      {total > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            Feature matrix
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {featureMatrix.map((row) => (
                <li
                  key={row.capability}
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    !row.present && "text-muted-foreground/70",
                  )}
                >
                  {row.present ? (
                    <Check className="h-3 w-3 text-success" />
                  ) : (
                    <X className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span>{row.label}</span>
                  {row.required && !row.present && (
                    <Badge variant="red" className="h-4 px-1 text-[10px]">
                      required
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// ── Native details — feature matrix + probe (mirrors delegated) ───────────

interface NativeDetailsProps {
  integrationKey: IntegrationKey;
  entry: IntegrationHealthEntry;
  descriptor: IntegrationListItem;
  featureMatrix: FeatureMatrixRow[];
  mainBackend: BackendId | null;
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md §11.5 — body rendered when the
 * integration is in `native` mode. Visually parallels `DelegatedDetails`
 * so the user can compare the two surfaces at a glance, but the copy
 * differs in three ways:
 *
 *   1. No "proxy model" or "deny list" panels — native skips the daemon
 *      proxy entirely, so the registry's per-tool policy controls don't
 *      apply (per §11.4 — destructive-MCP-under-native still applies the
 *      §6 absolute-block layer, but the per-integration deny list is a
 *      delegated-mode concept).
 *   2. The probe contract is identical (§9.3) so the feature matrix and
 *      Re-probe button work the same way.
 *   3. A backend-binding indicator is rendered prominently because
 *      §11.4 cascades a row to `disabled` on main-backend change — the
 *      user needs to see at a glance which backend the native binding
 *      currently points at.
 */
function NativeDetails({
  integrationKey,
  entry,
  descriptor,
  featureMatrix,
  mainBackend,
}: NativeDetailsProps) {
  const present = featureMatrix.filter((r) => r.present).length;
  const total = featureMatrix.length;
  const probeDate = entry.lastProbeAt
    ? new Date(entry.lastProbeAt).toLocaleString()
    : null;
  const backend = entry.nativeBackend;
  const probeLive = useIntegrationProbeLive();
  const [probeError, setProbeError] = useState<string | null>(null);

  // User-managed connector (e.g. Outlook native): the daemon ships no
  // descriptor-side tool inventory and no `SKILL.native.<backend>.md`.
  // Render the same notice as the delegated branch so the user sees
  // exactly what they need to install on the bound backend. Suppress the
  // namespace / feature matrix / probe controls — none of them apply.
  // §5.3 (2026-05 amendment).
  if (descriptor.userManagedConnector) {
    return (
      <UserManagedConnectorNotice
        descriptor={descriptor}
        backend={backend}
        mode="native"
      />
    );
  }

  // Show a soft warning when the live main backend has drifted away from
  // the native binding — this can happen between the time the daemon
  // accepts a flip and the time the user changes their main backend in
  // another tab. The §11.4 cascade should already have flipped the row,
  // but if there is a race (e.g. the user is viewing a stale tab) we
  // surface the drift so the user knows the row is no longer authoritative.
  const driftDetected =
    backend !== null && mainBackend !== null && backend !== mainBackend;

  const onReprobe = async () => {
    if (!backend) return;
    setProbeError(null);
    try {
      await probeLive.mutateAsync({
        key: integrationKey,
        backend,
        liveProbe: true,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as
          | { error?: string; message?: string }
          | undefined;
        if (body?.error === "live_probe_unsupported") {
          setProbeError(
            body.message ?? "Live probe not yet supported on this backend.",
          );
        } else {
          setProbeError(body?.message ?? err.message);
        }
      } else {
        setProbeError(err instanceof Error ? err.message : "Unexpected error");
      }
    }
  };

  return (
    <div className="space-y-2">
      <Alert variant="info">
        <p className="text-xs">
          Native mode — the agent fetches {descriptor.displayName} via{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            {backend ?? "?"}
          </code>
          &apos;s connector during DM and activity_scan turns. The daemon
          does not poll, does not proxy, and does not store{" "}
          {descriptor.displayName} credentials. Destructive operations still
          require user confirmation via the absolute-block layer.
        </p>
      </Alert>

      {driftDetected && (
        <Alert variant="warning">
          <p className="text-xs">
            This row is bound to{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {backend}
            </code>{" "}
            but the current main backend is{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {mainBackend}
            </code>
            . The next session refresh will cascade this row to disabled —
            re-configure on the new main backend.
          </p>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Tool namespace{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            {entry.toolNamespace ?? "?"}
          </code>
        </span>
        {total > 0 && (
          <span>
            Capabilities{" "}
            <span className="text-foreground">
              {present}/{total}
            </span>
          </span>
        )}
        <span>
          Probe{" "}
          <span className="text-foreground">
            {probeDate ?? "defaults (no live probe yet)"}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => void onReprobe()}
          disabled={probeLive.isPending || !backend}
          aria-label="Re-probe connector"
        >
          <RefreshCw
            className={cn(
              "h-3 w-3",
              probeLive.isPending && "animate-spin",
            )}
          />
          {probeLive.isPending ? "Probing…" : "Re-probe"}
        </Button>
      </div>
      {probeError && (
        <Alert variant="error">
          <p className="text-xs">{probeError}</p>
        </Alert>
      )}

      {total > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
            Feature matrix
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {featureMatrix.map((row) => (
                <li
                  key={row.capability}
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    !row.present && "text-muted-foreground/70",
                  )}
                >
                  {row.present ? (
                    <Check className="h-3 w-3 text-success" />
                  ) : (
                    <X className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span>{row.label}</span>
                  {row.required && !row.present && (
                    <Badge variant="red" className="h-4 px-1 text-[10px]">
                      required
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// ── Delegated model picker (DELEGATED-PROXY-API-DESIGN.md §7) ──────────────

/**
 * Per-integration model dropdown rendered below the feature-matrix when the
 * integration is delegated. The dropdown's "Auto" entry maps to
 * `delegatedModel: null` (canonical light-tier fallback resolved at call
 * time); any other entry pins the model on PATCH and persists into the
 * integrations JSON blob.
 *
 * The estimated-cost chip multiplies the per-token rate of the selected
 * model by the §7 prompt-length estimate so the user sees roughly what each
 * proxy call will cost. The chip hides when the registry has no pricing.
 *
 * Stale-pin handling: if `delegatedModel` references a model that no longer
 * appears in the backend's option list (after a backend swap), the daemon
 * silently falls back to canonical at call time. The dashboard exposes
 * a "Reset to default" affordance so the user can clear the stale value
 * explicitly without waiting for the next call to drop it.
 */
function DelegatedModelPicker({
  integrationKey,
  delegatedBackend,
  delegatedModel,
  currentMode,
}: {
  integrationKey: IntegrationKey;
  delegatedBackend: BackendId;
  delegatedModel: string | null;
  currentMode: "direct" | "delegated" | "disabled";
}) {
  const proxyModels = useProxyModels(delegatedBackend);
  const patch = usePatchIntegration();
  const [error, setError] = useState<string | null>(null);

  const options = proxyModels.data?.options ?? [];
  const canonical = proxyModels.data?.canonical ?? null;
  const selectedValue = delegatedModel ?? PROXY_MODEL_AUTO_VALUE;
  const isStalePin =
    delegatedModel !== null
    && options.length > 0
    && !options.some((o) => o.modelId === delegatedModel);

  const selected = delegatedModel
    ? options.find((o) => o.modelId === delegatedModel)
    : options.find((o) => o.modelId === canonical) ?? options.find((o) => o.tier === "lite") ?? options[0];
  const estimateUsd = selected
    ? estimateCostPerCallUsd(selected.usdPer1kIn, selected.usdPer1kOut)
    : null;

  const onSelect = async (value: string) => {
    setError(null);
    const nextModel = value === PROXY_MODEL_AUTO_VALUE ? null : value;
    if (nextModel === delegatedModel) return;
    try {
      await patch.mutateAsync({
        key: integrationKey,
        body: {
          mode: "delegated",
          delegatedBackend,
          delegatedModel: nextModel,
        },
      });
    } catch (err) {
      setError(formatPatchError(err));
    }
  };

  if (currentMode !== "delegated") return null;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`proxy-model-${integrationKey}`}>
          Proxy model
        </label>
        <Select
          value={selectedValue}
          onValueChange={(v) => void onSelect(v)}
        >
          <SelectTrigger
            id={`proxy-model-${integrationKey}`}
            className="h-8 w-auto min-w-[16rem] text-xs"
            disabled={proxyModels.isLoading || patch.isPending}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROXY_MODEL_AUTO_VALUE}>
              Auto (light tier{canonical ? ` — ${canonical}` : ""})
            </SelectItem>
            {options.map((o) => (
              <SelectItem key={o.modelId} value={o.modelId}>
                {o.displayName}
                {o.tier !== "lite" ? ` · ${o.tier}` : ""}
                {o.deprecated ? " · deprecated" : ""}
              </SelectItem>
            ))}
            {/* Stale-pin escape hatch: keep the dropdown selectable on a
                value the registry no longer recognizes so the user can
                see what's currently pinned. Real fix is the "Reset to
                default" button below. */}
            {isStalePin && delegatedModel && (
              <SelectItem value={delegatedModel}>
                {delegatedModel} · stale
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {estimateUsd !== null && (
          <Badge variant="gray" title="Estimate based on a typical proxy call (≈800 in / 200 out tokens). Actual costs vary by tool.">
            ≈ {formatPerCallUsd(estimateUsd)} / call
          </Badge>
        )}
      </div>
      {isStalePin && (
        <Alert variant="warning">
          <p className="text-xs">
            Pinned model <code>{delegatedModel}</code> is not registered for
            backend <code>{delegatedBackend}</code>. Calls fall back to the
            canonical light-tier model until you reset.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 px-2 text-[11px]"
            onClick={() => void onSelect(PROXY_MODEL_AUTO_VALUE)}
            disabled={patch.isPending}
          >
            Reset to default
          </Button>
        </Alert>
      )}
      {error && (
        <Alert variant="error">
          <p className="text-xs">{error}</p>
        </Alert>
      )}
    </div>
  );
}

// ── Direct details — hand-off to direct-mode setup ─────────────────────────

/**
 * Direct-mode setup is integration-shaped: Google asks for OAuth tokens via
 * the dashboard's 5-step GCP flow, Notion asks for an internal-integration
 * API key plus per-database sharing. Copy is keyed off integrationKey so
 * the alert names the credential the user actually needs to provide,
 * instead of always claiming "Google Cloud OAuth credential".
 */
function DirectDetails({
  integrationKey,
  credentialsPresent,
}: {
  integrationKey: IntegrationKey;
  credentialsPresent: boolean;
}) {
  const present = directDetailsCopy[integrationKey].present;
  const absent = directDetailsCopy[integrationKey].absent;
  return (
    <Alert variant={credentialsPresent ? "success" : "warning"}>
      <p className="text-xs">{credentialsPresent ? present : absent}</p>
    </Alert>
  );
}

const directDetailsCopy: Readonly<
  Record<IntegrationKey, { present: string; absent: string }>
> = {
  gmail: {
    present: "Google OAuth credentials present. The daemon is polling Gmail directly.",
    absent: "Direct mode requires a Google Cloud OAuth credential. Complete the credential upload + authorize step below.",
  },
  google_calendar: {
    present: "Google OAuth credentials present. The daemon is polling Calendar directly.",
    absent: "Direct mode requires a Google Cloud OAuth credential. Complete the credential upload + authorize step below.",
  },
  notion: {
    present: "Notion API key present. The daemon is polling configured databases directly.",
    absent: "Direct mode requires a Notion internal-integration API key. Paste it below and share each target database with the integration.",
  },
  git: {
    present: "Direct mode active. The daemon polls watched repositories with the local git CLI.",
    absent: "Direct mode uses the local git CLI and watched repository list; no daemon-managed credential is required.",
  },
  github: {
    present: "Direct mode active. The daemon polls GitHub through the local gh CLI.",
    absent: "Direct mode uses gh auth login outside the daemon keychain; no daemon-managed credential is required.",
  },
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook ships direct-or-disabled in v1
  // (no MCP connector for any backend). Mail reaches Graph through the
  // unified mail poller; Calendar is on-demand-only (no OutlookCalendarPoller
  // until §13's follow-up). `credentialsPresent` is driven by the BYOA
  // client config blob, not per-account MSAL tokens — those surface via the
  // health pill, not /api/config.
  outlook_mail: {
    present: "Outlook BYOA client config present. The unified mail poller covers authenticated Outlook mailboxes.",
    absent: "Direct mode requires a Microsoft Identity (BYOA) client config. Register an Azure app and paste the client id below.",
  },
  outlook_calendar: {
    present: "Outlook BYOA client config present. Calendar reads are on-demand and reuse the MSAL token from Outlook Mail; no background poller in v1.",
    absent: "Direct mode requires the BYOA client config used by Outlook Mail. Configure it via the Outlook Mail card; calendar reads reuse the same authenticated session.",
  },
  browser_history: {
    present: "Browser history ingest is active. The daemon reads local browser history databases on the configured cadence.",
    absent: "Direct mode requires accepting the on-device browser history consent latch. No external credentials are required.",
  },
};

// ── Recent proxy calls table (DELEGATED-PROXY-API-DESIGN.md §7) ────────────

/**
 * Collapsible per-integration table of the last 50 `delegated_proxy.invoke`
 * rows. Hidden by default — the user opens it when they suspect a slow or
 * failing connector. Pure read; no mutations or row-level actions in v0.1.
 */
function RecentProxyCallsTable({
  integrationKey,
}: {
  integrationKey: IntegrationKey;
}) {
  const recent = useRecentProxyCalls(integrationKey);
  const calls = recent.data?.calls ?? [];
  const hasFailures = calls.some((c) => c.result === "failed");

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronDown className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" />
        Recent proxy calls
        {!recent.isLoading && (
          <span className="text-muted-foreground/70">
            ({calls.length}
            {hasFailures && (
              <span className="ml-1 text-warning">
                · failures
              </span>
            )}
            )
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {recent.isLoading && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {recent.error && (
          <Alert variant="error">
            <p className="text-xs">
              Could not load recent calls:{" "}
              {recent.error instanceof Error
                ? recent.error.message
                : "Unexpected error"}
            </p>
          </Alert>
        )}
        {!recent.isLoading && !recent.error && calls.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No proxy calls have been recorded for this integration yet. They
            land here as the agent invokes the connector.
          </p>
        )}
        {/* DELEGATED-MODE-V2-DESIGN.md §7.2 — cross- vs same-backend
            asymmetry note. Rendered above the table so the user reads it
            before drawing conclusions from "no rows" or "fewer rows than
            expected" — same-backend native MCP traffic is invisible here
            by design and only the cross-backend invoke path lands here. */}
        <p className="mb-2 text-[11px] text-muted-foreground">
          Only <strong>cross-backend</strong> delegated calls show up here —
          calls where your DM session runs on a different backend than the
          connector&apos;s owner. Same-backend delegated calls (for example,
          a Codex DM session using Codex&apos;s own Gmail connector) skip
          the proxy and roll up under the parent session&apos;s totals.
          Per-tool cost isn&apos;t measurable in those cases.
        </p>
        {calls.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 pr-3 font-medium">Time</th>
                  <th className="pb-1 pr-3 font-medium">Tool</th>
                  <th className="pb-1 pr-3 font-medium">Model</th>
                  <th className="pb-1 pr-3 font-medium">Duration</th>
                  <th className="pb-1 pr-3 font-medium">Cost</th>
                  <th className="pb-1 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr
                    key={call.id}
                    className="border-t border-border/50 align-top"
                  >
                    <td className="py-1 pr-3 text-muted-foreground">
                      {formatRecentCallTimestamp(call.startedAt)}
                    </td>
                    <td className="py-1 pr-3 font-mono">
                      {shortenRecentCallTool(call.toolName)}
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {call.modelId ?? "—"}
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {formatRecentCallDuration(call.durationMs)}
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {formatRecentCallCost(call.costUsd)}
                    </td>
                    <td className="py-1">
                      {call.result === "success" ? (
                        <Badge variant="green" className="h-4 px-1 text-[10px]">
                          ok
                        </Badge>
                      ) : (
                        <span
                          className="text-warning"
                          title={call.errorMessage ?? undefined}
                        >
                          {call.errorClass ?? call.result ?? "failed"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
