"use client";

import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";

import { IntegrationCard } from "@/components/connections/integration-card";
import { NotionDirectSettingsBody } from "@/components/connections/notion-card";
import { ObsidianCard } from "@/components/connections/obsidian-card";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";
import { VaultHealthCard } from "@/components/connections/vault-health-card";

export default function KnowledgeConnectionsPage() {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: health, isLoading: healthLoading } = useHealth();

  const loading = configLoading || healthLoading;
  const disconnected = !loading && (!config || !health);

  const obsidian = health?.integrations?.obsidian;
  const notion = health?.integrations?.notion;
  const healthy =
    (obsidian?.connected ? 1 : 0) + (notion?.connected ? 1 : 0);

  return (
    <>
      <ConnectionsSectionHeader
        title="Knowledge"
        description="The agent's long-form knowledge sources. Obsidian is a local Markdown vault; Notion is a hosted workspace with shared databases."
        healthy={healthy}
        total={2}
      />

      {disconnected && (
        <p className="text-sm text-muted-foreground">
          Daemon not connected. Start the daemon to configure knowledge sources.
        </p>
      )}

      {!loading && (
        <div className="space-y-4">
          <VaultHealthCard />
          <ObsidianCard />
          <IntegrationCard integrationKey="notion">
            <NotionDirectSettingsBody />
          </IntegrationCard>
        </div>
      )}
    </>
  );
}
