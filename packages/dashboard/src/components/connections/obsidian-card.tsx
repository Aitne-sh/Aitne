"use client";

import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { BookText, ChevronDown, FolderOpen } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ExternalObsidianVaultSettings } from "@/components/settings/composite-fields";
import { ConnectionCard, deriveIntegrationStatus } from "./connection-card";

const DESCRIPTION = (
  <p className="max-w-prose pb-2 text-xs text-muted-foreground">
    A personal Obsidian vault — distinct from the agent&apos;s own memory
    directory — that the agent can read from and write to via the Obsidian
    CLI. Pick any local folder, including cloud-synced ones (iCloud,
    Dropbox, OneDrive, Google Drive). The agent&apos;s own files
    (<code>today.md</code>, <code>roadmap.md</code>, …) live under
    Settings → Management Mode, not here.
  </p>
);

export function ObsidianCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const { toast, saveMultipleFields } = useSaveConfig();

  const obsStatus = health?.integrations?.obsidian;

  if (!config) return null;

  const vaultPath = config.externalObsidianVaultPath;
  const vaultName = config.externalObsidianVaultName;
  const configured = !!vaultPath;

  return (
    <ConnectionCard
      name="External Obsidian Vault"
      icon={<BookText className="h-4 w-4" />}
      status={deriveIntegrationStatus(obsStatus)}
      error={obsStatus?.error}
    >
      <div className="mt-2">
        {toast && <Alert variant={toast.type} className="mb-2">{toast.message}</Alert>}

        {configured ? (
          <>
            {/* Source identity first: which vault, which directory. */}
            <div className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium text-foreground">
                  {vaultName || "Obsidian vault"}
                </span>
              </div>
              <div
                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                title={vaultPath}
              >
                {vaultPath}
              </div>
            </div>

            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                Change vault <ChevronDown className="h-3 w-3" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2">
                  {DESCRIPTION}
                  <ExternalObsidianVaultSettings
                    vaultPath={vaultPath}
                    vaultName={vaultName}
                    onSave={saveMultipleFields}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        ) : (
          <>
            {DESCRIPTION}
            <ExternalObsidianVaultSettings
              vaultPath={vaultPath}
              vaultName={vaultName}
              onSave={saveMultipleFields}
            />
          </>
        )}
      </div>
    </ConnectionCard>
  );
}
