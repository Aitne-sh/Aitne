"use client";

import { ArrowLeft, FolderSymlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { useConfig } from "@/lib/hooks/use-config";
import { cn } from "@/lib/utils";
import {
  canContinue,
  validatePrimaryVaultPathClient,
  vaultPathIssueMessage,
  type VaultMode,
  type VaultPathIssue,
} from "./vault-step.logic";
import { WizardStepFrame } from "./wizard-step-frame";

/**
 * SETUP-FLOW-REDESIGN-PLAN §5.2 — vault step.
 *
 * The user picks vault mode + path here, but the actual
 * `/setup/migrate-context` call is deferred to the Customize Rules step
 * (see `conversation-step.tsx`). Holding off on file creation lets the
 * user Back-navigate from any later step and re-pick the same directory
 * without seeing it already populated with agent skeleton files.
 */

interface VaultStepProps {
  onNext: () => void;
  onBack?: () => void;
  pendingVaultMode: VaultMode;
  onPendingVaultModeChange: (mode: VaultMode) => void;
  pendingVaultPath: string;
  onPendingVaultPathChange: (path: string) => void;
}

export function VaultStep({
  onNext,
  onBack,
  pendingVaultMode,
  onPendingVaultModeChange,
  pendingVaultPath,
  onPendingVaultPathChange,
}: VaultStepProps) {
  const { data: config } = useConfig();

  const dataDir = config?.contextDir ?? "";
  const pathIssue: VaultPathIssue | null = pendingVaultMode === "obsidian"
    ? validatePrimaryVaultPathClient({ path: pendingVaultPath, dataDir })
    : null;
  const ready = canContinue({
    vaultMode: pendingVaultMode,
    pathIssue,
    saving: false,
  });

  return (
    <WizardStepFrame
      title="Vault"
      description="Where should the agent keep its memory? Obsidian users can point it at an existing vault."
      onNext={onNext}
      hideNav
    >
      <div className="w-full max-w-xl mx-auto space-y-5 rounded-xl border border-border bg-card p-5 text-left">
        <div className="grid grid-cols-1 gap-2">
          {(["plain", "obsidian"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onPendingVaultModeChange(mode)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                pendingVaultMode === mode
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary/50",
              )}
            >
              <span className="block font-medium">
                {mode === "plain"
                  ? "Plain markdown"
                  : "Obsidian"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {mode === "plain"
                  ? "Files live at ~/.personal-agent/context. Only this app reads or writes them."
                  : "Use one of your Obsidian vaults — the agent's notes sit alongside yours."}
              </span>
            </button>
          ))}
        </div>

        {pendingVaultMode === "obsidian" && (
          <div className="space-y-2 border-t border-border pt-4">
            <label
              htmlFor="primary-vault-path"
              className="text-sm font-medium text-foreground"
            >
              Vault path
            </label>
            <p className="text-xs text-muted-foreground">
              Pick an existing folder. Cloud-sync directories (iCloud,
              Dropbox, OneDrive, Google Drive) work; local SSDs are faster.
              Nothing is written there until you finish the wizard.
            </p>
            <DirectoryPickerField
              id="primary-vault-path"
              value={pendingVaultPath}
              onChange={onPendingVaultPathChange}
              title="Choose primary vault directory"
              placeholder="Choose a folder for the primary vault"
              defaultPath={config?.primaryVaultPath || undefined}
            />
            {pathIssue && pathIssue !== "empty" && (
              <p className="text-xs text-destructive">
                {vaultPathIssueMessage(pathIssue)}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-center gap-3 pt-4">
        {onBack && (
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        )}
        <Button
          size="lg"
          onClick={onNext}
          disabled={!ready}
          className="gap-2"
        >
          <FolderSymlink className="h-4 w-4" />
          Continue
        </Button>
      </div>
    </WizardStepFrame>
  );
}
