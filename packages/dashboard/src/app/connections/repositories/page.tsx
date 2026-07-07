"use client";

import { useState } from "react";
import { GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";
import { GitAccountsCard } from "@/components/connections/git-accounts-card";
import { GitTemplatesCard } from "@/components/connections/git-templates-card";
import { TaskFlowOverridesCard } from "@/components/connections/task-flow-overrides-card";
import { ProcessModelCard } from "@/components/connections/process-model-card";
import { IntegrationCard } from "@/components/connections/integration-card";
import { RepositoryCard } from "@/components/connections/repository-card";
import { AddRepositorySheet } from "@/components/connections/add-repository-sheet";
import { useRepositories } from "@/lib/hooks/use-repositories";
import { useHealth } from "@/lib/hooks/use-health";

export default function RepositoriesConnectionsPage() {
  const repos = useRepositories();
  const { data: health, isLoading: healthLoading } = useHealth();
  const [adding, setAdding] = useState(false);

  const items = repos.data?.repositories ?? [];
  const total = items.length;
  const githubLinked = items.filter(
    (r) => r.githubOwner && r.githubRepo,
  ).length;
  const localLinked = items.filter((r) => r.localPath).length;

  const loading = repos.isLoading || healthLoading;
  const disconnected = !loading && (!repos.data || !health);

  return (
    <>
      <ConnectionsSectionHeader
        title="Repositories"
        description="Each repository links an optional GitHub remote with an optional local clone. Polling cadence, automation triggers, and daily git management live on the My Life › Git page."
        healthy={total > 0 ? 1 : 0}
        total={1}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add repository
          </Button>
        }
      />

      {disconnected && (
        <p className="text-sm text-muted-foreground">
          Daemon not connected. Start the daemon to manage repositories.
        </p>
      )}

      {!loading && (
        <div className="space-y-4">
          <IntegrationCard integrationKey="git" />
          <IntegrationCard integrationKey="github" />

          {items.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No repositories registered"
              description="Add a repository to start watching commits, polling GitHub events, and wiring per-repo triggers."
            >
              <Button className="mt-4" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
                Add your first repository
              </Button>
            </EmptyState>
          ) : (
            <>
              <Card className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {total} repositor{total === 1 ? "y" : "ies"} ·{" "}
                  {githubLinked} with GitHub · {localLinked} with local clone
                </span>
              </Card>
              <div className="space-y-3">
                {items.map((repo) => (
                  <RepositoryCard key={repo.id} repo={repo} />
                ))}
              </div>
            </>
          )}

          <GitAccountsCard />
          <GitTemplatesCard />
          <TaskFlowOverridesCard />

          {/* git.project.init / git.project.update intentionally have no
              model card: the daemon writes overview skeletons and daily
              journals with a deterministic in-process writer — no agent
              session, so a model setting would be a dead knob. */}
          <ProcessModelCard
            processKey="git.project.refresh_architecture"
            title="Architecture Refresh Model"
            description="Agent session that reads the repository and rewrites the ## Architecture section of its overview MD."
          />
          <ProcessModelCard
            processKey="git.project.retemplate"
            title="Git Project Re-template Model"
            description="One-shot session that re-conforms existing project documents to the current template body."
          />
        </div>
      )}

      <AddRepositorySheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
