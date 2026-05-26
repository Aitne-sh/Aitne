"use client";

import { useEffect, useState } from "react";
import { FolderCog, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ConfigSection,
} from "@/components/settings/editors";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { Alert } from "@/components/ui/alert";
import {
  SettingsToast,
  type SettingsToastState,
} from "@/components/settings/settings-navigation";
import { ManagementModeDialog } from "@/components/settings/management-mode-dialog";

const TOAST_AUTO_DISMISS_MS = 6000;

/**
 * Management Mode settings-page card that displays the current mode +
 * effective context directory and launches the migration dialog.
 *
 * Reads:
 *  - `vaultMode`, `primaryVaultPath`, `contextDir` from `/api/config`
 *  - degraded-mode flag from `/api/health` to surface an inline hint
 *    when the configured primary vault is unreachable (the
 *    dashboard-wide banner covers this too — here we add a section
 *    -local echo so the user sees it right next to the control).
 */
export function ManagementModeSection() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const [toast, setToast] = useState<SettingsToastState | null>(null);

  // Auto-dismiss the toast after a few seconds so a stale "Migrated
  // X files…" message doesn't cling to the page indefinitely. `SettingsToast`
  // has no dismiss affordance of its own, so the parent owns the lifecycle.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast]);

  if (!config) return null;

  const mode = config.vaultMode;
  const primaryPath = config.primaryVaultPath;
  const effectiveDir = config.contextDir;
  const degraded = health?.degraded ?? null;
  const isDegradedForVault =
    degraded?.reason === "primary_vault_unreachable";

  const modeLabel =
    mode === "obsidian" ? "Obsidian-style local directory" : "This app";

  return (
    <section id="management-mode" className="scroll-mt-4">
      <ConfigSection title="Management Mode">
        <p className="pb-2 text-xs text-muted-foreground">
          Where the agent stores its personal data — the six-class vault
          (identity, state, plans, journal, knowledge, policies). Switching
          here moves every existing file to the new location atomically — no
          reinstall needed.
        </p>

        <div className="space-y-3 pb-2">
          <Row label="Mode" value={modeLabel} />
          {mode === "obsidian" && (
            <Row
              label="Directory"
              value={
                primaryPath ? (
                  <code className="font-mono text-xs break-all">
                    {primaryPath}
                  </code>
                ) : (
                  <span className="italic text-muted-foreground">
                    Not configured
                  </span>
                )
              }
            />
          )}
          <Row
            label="Effective path"
            value={
              <span className="inline-flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                <code className="font-mono text-xs break-all">
                  {effectiveDir}
                </code>
              </span>
            }
          />

          {isDegradedForVault && (
            <Alert variant="error">
              <div>
                <p className="font-medium">Primary vault unreachable</p>
                <p className="mt-0.5">
                  The configured directory
                  {degraded?.path ? (
                    <>
                      {" "}
                      <code className="font-mono">{degraded.path}</code>
                    </>
                  ) : null}
                  {" "}is missing or not writable. Writes to the context API
                  are currently blocked. Fix the path or switch back to “This
                  app” to restore normal operation.
                </p>
              </div>
            </Alert>
          )}

          <div className="flex items-center gap-2 pt-1">
            <ManagementModeDialog
              currentVaultMode={mode}
              currentPrimaryVaultPath={primaryPath}
              onToast={(type, message) => setToast({ type, message })}
              trigger={
                <Button size="sm" variant="outline">
                  <FolderCog className="h-3.5 w-3.5" />
                  Change…
                </Button>
              }
            />
          </div>

          <SettingsToast toast={toast} />
        </div>
      </ConfigSection>
    </section>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="text-sm text-muted-foreground min-w-[140px]">
        {label}
      </span>
      <div className="text-sm text-foreground text-right">{value}</div>
    </div>
  );
}
