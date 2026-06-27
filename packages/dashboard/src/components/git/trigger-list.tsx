"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Pause,
  Pencil,
  Play,
  Plus,
  TestTube2,
  Trash2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeMs } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/shared/confirm-dialog";
import {
  type RepositoryDTO,
  type RepositoryTriggerDTO,
  useDeleteRepoTrigger,
  useFireRepoTrigger,
  useRepositoryTriggers,
  useTestRepoTrigger,
  useUpdateRepoTrigger,
} from "@/lib/hooks/use-repositories";
import { TriggerEditor } from "./trigger-editor";

export function TriggerList({ repo }: { repo: RepositoryDTO }) {
  const triggers = useRepositoryTriggers(repo.id);
  const [editing, setEditing] = useState<RepositoryTriggerDTO | "new" | null>(
    null,
  );

  const items = triggers.data?.triggers ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Triggers fire when matching events arrive on this repository. They
          run alongside the project-wide task-flow defaults, not in place of
          them.
        </p>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          New trigger
        </Button>
      </div>

      {triggers.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <Card className="text-xs text-muted-foreground">
          No triggers yet. Add one to react to specific GitHub or Git events
          on this repository.
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((t) => (
            <TriggerRow
              key={t.id}
              repo={repo}
              trigger={t}
              onEdit={() => setEditing(t)}
            />
          ))}
        </div>
      )}

      <TriggerEditor
        repo={repo}
        open={editing !== null}
        initial={editing === "new" || editing === null ? undefined : editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function TriggerRow({
  repo,
  trigger,
  onEdit,
}: {
  repo: RepositoryDTO;
  trigger: RepositoryTriggerDTO;
  onEdit: () => void;
}) {
  const update = useUpdateRepoTrigger();
  const remove = useDeleteRepoTrigger();
  const test = useTestRepoTrigger();
  const fire = useFireRepoTrigger();
  const confirm = useConfirm();
  const [testResult, setTestResult] = useState<string | null>(null);

  const togglePause = () => {
    void update.mutateAsync({
      repositoryId: repo.id,
      triggerId: trigger.id,
      body: { enabled: !trigger.enabled },
    });
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Delete trigger '${trigger.name}'?`,
      description: "Past fires stay in the agent action log.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    await remove.mutateAsync({ repositoryId: repo.id, triggerId: trigger.id });
  };

  const handleTest = async () => {
    setTestResult(null);
    try {
      const result = await test.mutateAsync({
        repositoryId: repo.id,
        triggerId: trigger.id,
        eventType: trigger.eventType,
        payload: synthesizeMockPayload(trigger),
      });
      setTestResult(
        result.matched
          ? "Filters match — trigger would fire."
          : "Filters do not match — trigger would not fire on this mock event.",
      );
    } catch (err) {
      setTestResult(
        err instanceof Error ? `Test failed: ${err.message}` : "Test failed",
      );
    }
  };

  const handleFire = async () => {
    const ok = await confirm({
      title: `Fire '${trigger.name}' now?`,
      description: `Schedules a ${trigger.backend} session against ${repo.slug} (workdir: ${trigger.workdirMode}).`,
      confirmLabel: "Fire",
    });
    if (!ok) return;
    await fire.mutateAsync({ repositoryId: repo.id, triggerId: trigger.id });
  };

  const filterSummary = summarizeFilters(trigger.filters);

  return (
    <Card className={trigger.enabled ? "" : "opacity-60"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {trigger.name}
            </span>
            {!trigger.enabled && (
              <Badge variant="gray" className="text-[10px]">
                Paused
              </Badge>
            )}
            <Badge variant="gray" className="text-[10px]">
              {trigger.backend}/{trigger.model}
            </Badge>
            <Badge variant="gray" className="text-[10px]">
              workdir: {trigger.workdirMode}
            </Badge>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{trigger.eventType}</span>
            {filterSummary && (
              <>
                {" · "}
                <span>{filterSummary}</span>
              </>
            )}
          </p>
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
            {trigger.prompt}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Fired {trigger.fireCount}× ·{" "}
            {trigger.lastFiredAt
              ? `last ${formatRelativeMs(trigger.lastFiredAt)}`
              : "never fired"}
          </p>
          {testResult && (
            <p className="mt-2 flex items-center gap-1 text-[11px] text-foreground">
              <CheckCircle2 className="h-3 w-3" />
              {testResult}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleTest}
            disabled={test.isPending}
            title="Test with mock event"
          >
            <TestTube2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleFire}
            disabled={fire.isPending}
            title="Fire now"
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={togglePause}
            disabled={update.isPending}
            title={trigger.enabled ? "Pause" : "Resume"}
          >
            {trigger.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            disabled={remove.isPending}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function summarizeFilters(filters: Record<string, unknown>): string | null {
  const entries = Object.entries(filters);
  if (entries.length === 0) return null;
  const out: string[] = [];
  for (const [k, v] of entries) {
    if (k === "path_pattern") {
      const list = Array.isArray(v) ? v.join(",") : String(v);
      out.push(`paths: ${list}`);
    } else {
      out.push(`${k}=${String(v)}`);
    }
  }
  return out.join(" · ");
}

function synthesizeMockPayload(
  trigger: RepositoryTriggerDTO,
): Record<string, unknown> {
  // Mirror the fields each event type's path extractor / classifier
  // expects, populating just enough to demonstrate filter behaviour. The
  // dashboard is a UX surface — full payload fidelity belongs to the
  // observers, not to the test button.
  const base: Record<string, unknown> = { mock: true };
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(trigger.filters)) {
    if (k === "path_pattern") continue;
    flat[k] = v;
  }
  if (trigger.eventType.startsWith("git.push.") ||
      trigger.eventType === "git.merge_to_default") {
    return {
      ...base,
      ...flat,
      branch: flat.branch ?? "main",
      commits: [
        {
          added: ["packages/daemon/src/index.ts"],
          modified: ["README.md"],
          removed: [],
        },
      ],
    };
  }
  if (trigger.eventType.startsWith("github.pull_request")) {
    return {
      ...base,
      ...flat,
      action: flat.action ?? "opened",
      files: ["packages/daemon/src/dispatcher.ts"],
    };
  }
  if (trigger.eventType === "github.workflow_run.failed") {
    return {
      ...base,
      ...flat,
      branch: flat.branch ?? "main",
      conclusion: "failure",
    };
  }
  return { ...base, ...flat };
}
