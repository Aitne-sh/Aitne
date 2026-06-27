"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  ShieldCheck,
  Unlock,
} from "lucide-react";
import { getBackendIds, type BackendId } from "@aitne/shared";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DocsHelpInline } from "@/components/docs/docs-help-inline";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api, ApiError } from "@/lib/api-client";
import {
  BACKEND_PROVIDER_LABELS,
  BACKEND_PROVIDER_SHORT,
  isUiPreviewOnlyBackend,
} from "@/lib/backend-ui";
import { useConfig } from "@/lib/hooks/use-config";
import { cn } from "@/lib/utils";
import type { SettingsToastState } from "./settings-navigation";
import {
  buildSetupModePayload,
  canApply,
  hasDivergentOverride,
  type ExecutionModeUi,
  type PerBackendOverrides,
} from "@/components/settings/execution-mode.logic";
import {
  seedStateFromConfig,
  type ConfigModeSlice,
} from "./execution-mode-settings.logic";

/**
 * Settings-page counterpart to the setup wizard's Execution Mode step
 * (EXECUTION-MODE-DESIGN.md §5.2). Same copy as the wizard step so users
 * see one consistent explanation. Writes through `POST /api/setup/mode`,
 * which also records one `agent_actions` row per backend whose value
 * moved (§6.3).
 *
 * Unlike the setup step, this surface seeds the top-level pick from the
 * currently-persisted backend modes: if all three agree, that value is
 * highlighted; if they disagree, the accordion is force-opened so the
 * user sees the divergence before re-collapsing it.
 */

interface Props {
  onToast: (type: SettingsToastState["type"], message: string) => void;
}

const BACKENDS = getBackendIds();

export function ExecutionModeSettings({ onToast }: Props) {
  const { data: config } = useConfig();
  // Generation counter — bump on successful apply so the inner card
  // remounts with a fresh seed from the refetched config. Without this
  // the local draft keeps showing the user's just-submitted deltas even
  // after the server is unified, so the "mixed" badge would stick.
  const [generation, setGeneration] = useState(0);

  if (!config) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </Card>
    );
  }

  return (
    <ExecutionModeSettingsCard
      key={generation}
      config={config}
      onToast={onToast}
      onApplied={() => setGeneration((g) => g + 1)}
    />
  );
}

export interface ExecutionModeSettingsCardProps {
  config: ConfigModeSlice;
  onToast: (type: SettingsToastState["type"], message: string) => void;
  onApplied: () => void;
}

/**
 * Seed-bearing inner card. Exported for render tests so the seed path
 * can be exercised directly without the `useConfig()` / loading wrapper.
 * The outer `ExecutionModeSettings` is the production entry point.
 */
export function ExecutionModeSettingsCard({
  config,
  onToast,
  onApplied,
}: ExecutionModeSettingsCardProps) {
  const queryClient = useQueryClient();

  // Lazy useState initializer — seeds synchronously from the config snapshot
  // captured at mount. Remount-on-apply (via the outer `key`) is how the
  // card picks up a newly-persisted server state; user edits after mount
  // persist until the next successful apply.
  const initial = useState(() => seedStateFromConfig(config))[0];

  const [topLevel, setTopLevel] = useState<ExecutionModeUi | null>(
    initial.topLevel,
  );
  const [overrides, setOverrides] = useState<PerBackendOverrides>(
    initial.overrides,
  );
  const [advancedOpen, setAdvancedOpen] = useState(initial.forceAccordionOpen);
  const [saving, setSaving] = useState(false);

  // "mixed" indicator fires whenever the effective per-backend config is
  // not uniform — either the seed itself was divergent (topLevel === null)
  // or the user has set an override that differs from the top-level pick.
  const divergent =
    topLevel === null || hasDivergentOverride(topLevel, overrides);

  async function applyChange() {
    const payload = buildSetupModePayload(topLevel, overrides);
    if (payload === null) return;
    setSaving(true);
    try {
      await api.post("/setup/mode", payload);
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      onToast("success", "Execution mode updated");
      // Bump the generation counter so the parent remounts this card
      // with a fresh seed from the just-refetched config.
      onApplied();
    } catch (err) {
      if (err instanceof ApiError) onToast("error", err.message);
      else if (err instanceof Error) onToast("error", err.message);
      else onToast("error", "Failed to update execution mode");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="execution-mode">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="flex items-center gap-1.5 text-base">
          <span>Execution Mode</span>
          <DocsHelpInline
            docId="concepts/safety-and-execution"
            label="Execution Mode"
          />
        </CardTitle>
      </CardHeader>
      <p className="text-sm text-muted-foreground">
        Pick how freely the agent may run shell, file, and tool commands on
        your machine. Dangerous operations — recursive deletes, privilege
        escalation, and secret-file reads — remain blocked in both modes.
      </p>

      <div className="mt-4 space-y-3">
        <ModeCard
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Safe"
          badge="Recommended"
          selected={topLevel === "safe"}
          onSelect={() => setTopLevel("safe")}
        >
          Agent runs with strict permission checks and confirms before any
          side-effectful action. Pick this when you want the agent to stay
          narrow.
        </ModeCard>
        <ModeCard
          icon={<Unlock className="h-5 w-5" />}
          title="Allow"
          selected={topLevel === "allow"}
          onSelect={() => setTopLevel("allow")}
        >
          Agent runs without the daemon&rsquo;s per-call permission prompts,
          using the skills, plugins, and MCP servers installed in your CLI
          harness. Faster and more capable, but the harness — not the daemon —
          decides which tools are reachable.
          <CodexAllowCaveat />
        </ModeCard>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
            >
              <span className="flex items-center gap-2">
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    advancedOpen && "rotate-180",
                  )}
                />
                Advanced — per-backend overrides
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
                topLevel={topLevel}
                override={overrides[backend] ?? null}
                disabled={isUiPreviewOnlyBackend(backend)}
                onChange={(next) =>
                  setOverrides((prev) => ({ ...prev, [backend]: next }))
                }
              />
            ))}
          </CollapsibleContent>
        </Collapsible>

        <div className="flex justify-end pt-2">
          <Button
            onClick={applyChange}
            disabled={!canApply(topLevel, overrides) || saving}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Apply"
            )}
          </Button>
        </div>
      </div>
    </Card>
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
        "block w-full rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border hover:border-foreground/30",
      )}
    >
      <div className="flex items-center gap-2 font-semibold text-foreground">
        {icon}
        {title}
        {badge && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </button>
  );
}

interface BackendOverrideRowProps {
  backend: BackendId;
  topLevel: ExecutionModeUi | null;
  override: ExecutionModeUi | null;
  disabled?: boolean;
  onChange: (next: ExecutionModeUi | null) => void;
}

function BackendOverrideRow({
  backend,
  topLevel,
  override,
  disabled = false,
  onChange,
}: BackendOverrideRowProps) {
  const effective: ExecutionModeUi | null = override ?? topLevel;
  const effectiveLabel =
    effective === null ? "pick a top-level mode first" : `runs as: ${effective}`;
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
            {effectiveLabel}
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
            Codex Allow disables the daemon&apos;s absolute-block layer
            (sandbox-off). See the Allow card above.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Inline caveat shown inside the Allow mode card.
 *
 * The setup wizard no longer hosts an Execution Mode step
 * (SETUP-FLOW-REDESIGN-PLAN §4) — Settings → Backends is now the only
 * surface where this posture can be flipped, so this card body is the
 * single source of truth for the Codex Allow-mode caveat.
 *
 * The card-level "Dangerous operations are still blocked" reassurance is
 * accurate for Claude Code and Gemini CLI — both backends expose a
 * pre-tool hook / admin policy surface the daemon attaches the
 * absolute-block layer to. Codex CLI does not. Codex Allow runs under
 * `--dangerously-bypass-approvals-and-sandbox`, a binary sandbox-off
 * switch with no per-command hook layer, so the absolute-block patterns
 * (`rm -rf`, `eval $(curl …)`, secret-file reads, …) are not pre-blocked
 * for Codex in Allow mode.
 */
function CodexAllowCaveat() {
  return (
    <span className="mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="space-y-1">
        <span className="block">
          <span className="font-semibold">Codex caveat.</span> Codex CLI
          runs Allow mode under{" "}
          <code className="rounded bg-black/10 px-1 font-mono text-[11px] dark:bg-white/10">
            --dangerously-bypass-approvals-and-sandbox
          </code>
          , a binary sandbox-off switch. Codex has no per-command hook
          layer for the daemon to attach the absolute-block patterns to,
          so destructive shell commands (
          <code className="rounded bg-black/10 px-1 font-mono text-[11px] dark:bg-white/10">
            rm -rf
          </code>
          ,{" "}
          <code className="rounded bg-black/10 px-1 font-mono text-[11px] dark:bg-white/10">
            eval $(curl …)
          </code>
          , secret-file reads) are <span className="font-semibold">not</span>{" "}
          pre-blocked for Codex in Allow mode the way they are for Claude
          Code and Gemini CLI.
        </span>
        <span className="block">
          Use the Advanced section below to keep Codex on Safe (its
          workspace-write sandbox still applies) unless you accept this
          gap.
        </span>
      </span>
    </span>
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
