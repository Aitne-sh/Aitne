"use client";

import Link from "next/link";
import { Settings2 } from "lucide-react";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";

import { IntegrationCard } from "@/components/connections/integration-card";
import { NotionDirectSettingsBody } from "@/components/connections/notion-card";
import { ObsidianCard } from "@/components/connections/obsidian-card";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";

export default function NotesConnectionsPage() {
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
        title="Notes"
        description="Your personal note sources. The agent reads them and records change observations — Obsidian is a local vault folder, Notion is a hosted workspace."
        healthy={healthy}
        total={2}
      />

      <p className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Settings2 className="h-3.5 w-3.5 shrink-0" />
        <span>
          Looking for the agent&apos;s own memory vault (primary vault)? Manage
          and relocate it from{" "}
          <Link
            href="/settings#management-mode"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings → Management Mode
          </Link>
          .
        </span>
      </p>

      {disconnected && (
        <p className="text-sm text-muted-foreground">
          Daemon not connected. Start the daemon to configure note sources.
        </p>
      )}

      {!loading && (
        <div className="space-y-4">
          <ObsidianCard />
          <IntegrationCard integrationKey="notion">
            <NotionDirectSettingsBody />
          </IntegrationCard>
        </div>
      )}
    </>
  );
}
