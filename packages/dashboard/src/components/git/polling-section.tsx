"use client";

import { useState } from "react";
import { Activity, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type RepositoryDTO,
  observationSourcesForRepo,
  repositoryHasGithub,
  repositoryHasLocal,
  useUpdateRepository,
} from "@/lib/hooks/use-repositories";
import { useConfig } from "@/lib/hooks/use-config";
import { api } from "@/lib/api-client";
import { useQuery } from "@tanstack/react-query";

const FIELD_LABEL =
  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

interface ObservationRow {
  id: number;
  source: string;
  ref: string;
  changeType: string;
  actor: string;
  observedAt: string;
  payload: unknown;
}

function useObservationsForSources(sources: string[], limit: number) {
  return useQuery({
    queryKey: ["observations", "by-sources", { sources, limit }],
    queryFn: async () => {
      // The /observations endpoint filters by a single source param. Fetch
      // each source in parallel and merge — this stays cheap for the 1-3
      // sources a single repository has, and avoids enriching the API just
      // for the dashboard tail.
      if (sources.length === 0) return { observations: [] as ObservationRow[] };
      const results = await Promise.all(
        sources.map((source) =>
          api.get<{ observations: ObservationRow[] }>("/observations", {
            source,
            pending: "false",
            limit,
          }),
        ),
      );
      const merged = results
        .flatMap((r) => r.observations)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
        .slice(0, limit);
      return { observations: merged };
    },
    staleTime: 15_000,
    enabled: sources.length > 0,
  });
}

export function PollingSection({ repo }: { repo: RepositoryDTO }) {
  const { data: config } = useConfig();
  const update = useUpdateRepository();
  // Track the prop value alongside the draft so a refetch after save
  // (which mutates `repo.pollIntervalSec`) refreshes the input without
  // a setState-in-effect roundtrip — the React-recommended pattern for
  // derived state.
  const [savedPollIntervalSec, setSavedPollIntervalSec] = useState<number | null>(
    repo.pollIntervalSec,
  );
  const [draftSec, setDraftSec] = useState<string>(
    repo.pollIntervalSec === null ? "" : String(repo.pollIntervalSec),
  );
  if (repo.pollIntervalSec !== savedPollIntervalSec) {
    setSavedPollIntervalSec(repo.pollIntervalSec);
    setDraftSec(
      repo.pollIntervalSec === null ? "" : String(repo.pollIntervalSec),
    );
  }
  const [saveError, setSaveError] = useState<string | null>(null);

  const sources = observationSourcesForRepo(repo);
  const observations = useObservationsForSources(sources, 8);

  const polledSides: string[] = [];
  if (repositoryHasGithub(repo)) polledSides.push("GitHub remote");
  if (repositoryHasLocal(repo)) polledSides.push("local clone");

  const githubDefaultSec = config?.githubPollIntervalSeconds ?? 300;
  const gitDefaultSec = config?.gitPollIntervalSeconds ?? 300;
  const defaultHint = repositoryHasGithub(repo)
    ? `GitHub default: ${githubDefaultSec}s`
    : `Git default: ${gitDefaultSec}s`;

  const dirty =
    (draftSec === "" ? null : Number(draftSec)) !== repo.pollIntervalSec;

  const onSave = async () => {
    setSaveError(null);
    let parsed: number | null;
    if (draftSec.trim() === "") {
      parsed = null;
    } else {
      const n = Number(draftSec);
      if (!Number.isFinite(n) || n <= 0) {
        setSaveError("poll_interval_sec must be a positive integer or empty (= use default).");
        return;
      }
      parsed = Math.round(n);
    }
    try {
      await update.mutateAsync({
        id: repo.id,
        body: { pollIntervalSec: parsed },
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-background/40 p-3">
        <p className={FIELD_LABEL}>Polled</p>
        <p className="mt-1 text-sm">
          {polledSides.length > 0 ? polledSides.join(" + ") : "—"}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className={FIELD_LABEL}>Poll interval (seconds)</label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            value={draftSec}
            onChange={(e) => setDraftSec(e.target.value)}
            placeholder={defaultHint}
            className="w-52"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || update.isPending}
            onClick={onSave}
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            Save
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Empty falls back to the global cadence ({defaultHint}). The global
          interval is the floor: an override only slows polling for this
          repository — values smaller than the global cadence are ignored. To
          poll faster, lower the global interval in Settings › Infrastructure.
        </p>
        {saveError && (
          <p className="text-xs text-destructive">{saveError}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <label className={FIELD_LABEL}>Recent observations</label>
        {sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No polled sources for this repository.
          </p>
        ) : observations.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : observations.data && observations.data.observations.length > 0 ? (
          <ul className="space-y-1 rounded-md border bg-background/40 p-2 text-xs">
            {observations.data.observations.map((o) => (
              <li
                key={`${o.source}:${o.ref}:${o.id}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Activity className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatObservedAt(o.observedAt)}
                  </span>
                  <span className="truncate">{o.ref}</span>
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {sourceShortLabel(o.source)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No observations yet. The poller records here once it sees activity.
          </p>
        )}
      </div>
    </div>
  );
}

function formatObservedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function sourceShortLabel(source: string): string {
  if (source.startsWith("git:")) return "git";
  if (source.startsWith("github:notification")) return "notif";
  if (source.startsWith("github:workflow")) return "workflow";
  return source.split(":")[0] ?? source;
}
