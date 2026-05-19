"use client";

import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { BookText } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { ExternalObsidianVaultSettings } from "@/components/settings/composite-fields";
import { ConnectionCard, deriveIntegrationStatus } from "./connection-card";

export function ObsidianCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const { toast, saveMultipleFields } = useSaveConfig();

  const obsStatus = health?.integrations?.obsidian;

  if (!config) return null;

  return (
    <ConnectionCard
      name="External Obsidian Vault"
      icon={<BookText className="h-4 w-4" />}
      status={deriveIntegrationStatus(obsStatus)}
      error={obsStatus?.error}
    >
      <div className="mt-2">
        {toast && <Alert variant={toast.type} className="mb-2">{toast.message}</Alert>}
        <p className="max-w-prose pb-2 text-xs text-muted-foreground">
          A personal Obsidian vault — distinct from the agent&apos;s own
          memory directory — that the agent can read from and write to via
          the Obsidian CLI. Pick any local folder, including cloud-synced
          ones (iCloud, Dropbox, OneDrive, Google Drive). The agent&apos;s
          own files (<code>today.md</code>, <code>roadmap.md</code>, …)
          live under Settings → Management Mode, not here.
        </p>
        <ExternalObsidianVaultSettings
          vaultPath={config.externalObsidianVaultPath}
          vaultName={config.externalObsidianVaultName}
          onSave={saveMultipleFields}
        />
      </div>
    </ConnectionCard>
  );
}
