"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, GitBranch, Lock, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { useRepositories, repositoryDisplayName, repositoryHasGithub, repositoryHasLocal, type RepositoryDTO } from "@/lib/hooks/use-repositories";
import { PollingSection } from "@/components/git/polling-section";
import { TriggerList } from "@/components/git/trigger-list";
import { ManagementSection } from "@/components/git/management-section";
import { cn } from "@/lib/utils";

export default function GitPage() {
  const repos = useRepositories();
  const items = useMemo(() => repos.data?.repositories ?? [], [repos.data?.repositories]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Git"
        badge={
          <Badge variant="amber" className="uppercase tracking-wide">
            Experimental
          </Badge>
        }
        description="Configure how the agent watches each repository: polling cadence (how often it checks for changes), automation triggers (rules that fire follow-up work), and daily git management (housekeeping the morning routine performs). Register repositories on the connections page."
        actions={
          <Link
            href="/connections/repositories"
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            <Settings2 className="h-4 w-4" />
            Manage repositories
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        }
      >
        <p className="mt-1 max-w-2xl text-xs text-warning">
          Triggers and daily management are still under active testing &mdash;
          expect rough edges and please report bugs.
        </p>
      </PageHeader>

      {repos.isLoading ? (
        <Card className="text-sm text-muted-foreground">Loading…</Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No repositories registered"
          description="Add a repository on the connections page, then return here to configure polling cadence, triggers, and daily git management."
        >
          <Link
            href="/connections/repositories"
            className="mt-4 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            <Settings2 className="h-4 w-4" />
            Go to connections › repositories
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {items.map((repo) => (
            <RepositoryPanel key={repo.id} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepositoryPanel({ repo }: { repo: RepositoryDTO }) {
  const hasLocal = repositoryHasLocal(repo);
  const hasGithub = repositoryHasGithub(repo);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {repositoryDisplayName(repo)}
            </span>
            {repo.localOnly && (
              <Badge variant="gray" className="text-[10px]">
                <Lock className="mr-1 h-3 w-3" />
                local-only
              </Badge>
            )}
            {hasGithub && (
              <Badge variant="gray" className="text-[10px]">
                {repo.githubOwner}/{repo.githubRepo}
              </Badge>
            )}
            {hasLocal && (
              <Badge variant="gray" className="text-[10px]">
                {repo.localPath}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            slug: <span className="font-mono">{repo.slug}</span> · classification: {repo.classification}
            · category: {repo.category}
          </p>
        </div>
        <Link
          href="/connections/repositories"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Edit registration
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="mt-3 space-y-2">
        <Section title="Polling" defaultOpen>
          <PollingSection repo={repo} />
        </Section>
        <Section title="Triggers" defaultOpen>
          <TriggerList repo={repo} />
        </Section>
        <Section title="Daily git management" defaultOpen>
          <ManagementSection repo={repo} />
        </Section>
      </div>
    </Card>
  );
}

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent"
        >
          <span className="font-medium">{title}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              "group-data-[state=open]:rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
