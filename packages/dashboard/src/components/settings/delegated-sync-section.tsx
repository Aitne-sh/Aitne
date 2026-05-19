"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  useDelegatedSync,
  usePatchDelegatedSyncCadence,
  usePatchDelegatedSyncActiveHours,
  useRunDelegatedSyncCadence,
} from "@/lib/hooks/use-delegated-sync";
import type { DelegatedSyncCadenceRow } from "@/lib/api-types";

/**
 * Delegated-sync settings section
 * (docs/design/appendices/delegated-sync-opt-in.md).
 *
 * Lives on /settings/schedule between the Hourly Check and Notifications
 * cards. Renders only when the worker reports at least one delegated
 * integration; otherwise it returns null so the page doesn't show an
 * empty stub.
 *
 * UX:
 *  - Each cadence row has its own enable toggle + interval editor + Run
 *    Now button. Toggling persists immediately; the interval persists on
 *    blur / Enter so a user typing intermediate digits doesn't fire 3 PATCHes.
 *  - The active-hours subsection appears only when at least one cadence is
 *    enabled (matches Q2 / "pause all cadences at once"). It mirrors the Hourly Check
 *    fields' look but writes to /api/delegated-sync/active-hours rather
 *    than the runtime-settings PATCH path.
 */
export function DelegatedSyncSection() {
  const { data, isLoading } = useDelegatedSync();

  if (isLoading || !data) return null;

  const cadenceRows = Object.entries(data.cadences).map(([id, row]) => ({
    id,
    ...row,
  }));

  // The route always returns the four production cadences in the catalog,
  // even when no integration is delegated — that's how the dashboard
  // discovers them. To decide whether to render this section we lean on
  // `workerRunning`: the worker is only registered when at least one
  // integration is in delegated mode.
  if (!data.workerRunning && cadenceRows.length === 0) return null;
  if (!data.workerRunning) {
    // Worker absent — render a hint instead of the cadence list, so the
    // user understands why toggles wouldn't have effect right now.
    // Native mode does not run the cadence worker; its observations
    // come from the in-turn routine.fetch_window pre-pass instead.
    return (
      <Card>
        <CardHeader>
          <CardTitle>Background Sync</CardTitle>
        </CardHeader>
        <div className="p-4 text-sm text-muted-foreground">
          No integrations are in delegated mode, so background cadences
          are inactive. Move an integration (Calendar / Gmail / Notion)
          to delegated mode in <code>/connections</code> to enable
          opt-in cadences here. Native-mode integrations fetch their
          observations directly during the hourly check turn and do not
          use this worker.
        </div>
      </Card>
    );
  }

  const anyEnabled = cadenceRows.some((row) => row.enabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>Background Sync</span>
          {data.withinActiveHours ? (
            <Badge variant="green">active</Badge>
          ) : (
            <Badge variant="gray">outside active hours</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <div className="space-y-1 p-4 pt-0">
        <p className="pb-2 text-xs text-muted-foreground">
          Background cadences poll Calendar, Gmail, and Notion through a
          backend MCP subprocess so the hourly check sees fresh observations.
          Every poll spends tokens, so all cadences are off by default —
          enable just the ones you want. Enabled cadences respect the shared
          active-hours window below.
        </p>
        <div className="space-y-2">
          {cadenceRows.map((row) => (
            <CadenceRow key={row.id} row={row} />
          ))}
        </div>
        {anyEnabled && (
          <ActiveHoursEditor
            startHour={data.activeHours.startHour}
            endHour={data.activeHours.endHour}
          />
        )}
      </div>
    </Card>
  );
}

function CadenceRow({ row }: { row: DelegatedSyncCadenceRow & { id: string } }) {
  const patch = usePatchDelegatedSyncCadence();
  const run = useRunDelegatedSyncCadence();

  const [draftMinutes, setDraftMinutes] = useState<string>(
    String(Math.round(row.intervalSeconds / 60)),
  );
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Sync draft when the underlying intervalSeconds changes (e.g. another
  // tab edited it). Don't blow away in-progress edits — only re-sync when
  // the local draft matches the previously-persisted value.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraftMinutes(String(Math.round(row.intervalSeconds / 60)));
  }, [row.intervalSeconds]);

  const minMinutes = Math.ceil(row.softFloorSeconds / 60);
  const maxMinutes = 24 * 60;
  const defaultMinutes = Math.round(row.defaultIntervalSeconds / 60);

  const handleToggle = () => {
    patch.mutate({ cadenceId: row.id, body: { enabled: !row.enabled } });
  };

  const commitInterval = () => {
    setIntervalError(null);
    const parsed = Number(draftMinutes);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setIntervalError("Whole positive number required");
      return;
    }
    if (parsed < minMinutes) {
      setIntervalError(`Minimum ${minMinutes} min`);
      return;
    }
    if (parsed > maxMinutes) {
      setIntervalError(`Maximum ${maxMinutes} min (24 h)`);
      return;
    }
    if (parsed * 60 === row.intervalSeconds) return;
    patch.mutate(
      {
        cadenceId: row.id,
        body: { intervalSeconds: parsed * 60 },
      },
      {
        onError: (err) => setIntervalError(err.message),
      },
    );
  };

  const handleResetInterval = () => {
    setDraftMinutes(String(defaultMinutes));
    patch.mutate({
      cadenceId: row.id,
      body: { intervalSeconds: defaultMinutes * 60 },
    });
  };

  const handleRunNow = async () => {
    setRunError(null);
    try {
      await run.mutateAsync({ cadenceId: row.id });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Run Now failed");
    }
  };

  const isPatching = patch.isPending;
  const isRunning = run.isPending;
  const isDefaultInterval = row.intervalSeconds === row.defaultIntervalSeconds;
  // Native rows surface on the catalog for visibility but the worker
  // does not invoke for them — toggling enabled / changing interval /
  // Run Now would all be inert. Render a passive footer instead so the
  // operator isn't tricked into setting values that have no effect.
  const isNative = row.mode === "native";

  return (
    <div className="rounded border border-border/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              {row.displayName}
            </p>
            {row.mode === "native" && (
              <Badge variant="green">native</Badge>
            )}
            {row.mode === "delegated" && (
              <Badge variant="blue">
                delegated{row.backend ? ` · ${row.backend}` : ""}
              </Badge>
            )}
            {!isNative && row.circuitState === "tripped" && (
              <Badge variant="red">circuit tripped</Badge>
            )}
            {!isNative && row.failureCount > 0 && row.circuitState === "ok" && (
              <Badge variant="amber">
                {row.failureCount} recent failure{row.failureCount === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.description}
          </p>
          {!isNative && <CadenceStatusFooter row={row} />}
        </div>
        {!isNative && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant={row.enabled ? "default" : "outline"}
              size="sm"
              onClick={handleToggle}
              disabled={isPatching}
            >
              {isPatching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : row.enabled ? (
                "Enabled"
              ) : (
                "Disabled"
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunNow}
              disabled={isRunning}
              title="Run this cadence once, regardless of schedule"
            >
              {isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              <span className="ml-1">Run now</span>
            </Button>
          </div>
        )}
      </div>
      {isNative ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Observations land via the in-turn fetch during the hourly
          check turn — no background cadence runs for this row.
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            <span>Interval:</span>
            <Input
              type="number"
              min={minMinutes}
              max={maxMinutes}
              value={draftMinutes}
              onChange={(e) => setDraftMinutes(e.target.value)}
              onBlur={commitInterval}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="h-7 w-20 px-2 text-xs"
            />
            <span>min</span>
          </label>
          <span className="text-muted-foreground/70">
            ({minMinutes}–{maxMinutes}; default {defaultMinutes})
          </span>
          {!isDefaultInterval && (
            <button
              type="button"
              onClick={handleResetInterval}
              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              reset
            </button>
          )}
          {intervalError && (
            <span className="text-destructive">{intervalError}</span>
          )}
        </div>
      )}
      {runError && (
        <p className="mt-1 text-xs text-destructive">Run Now: {runError}</p>
      )}
    </div>
  );
}

function CadenceStatusFooter({ row }: { row: DelegatedSyncCadenceRow }) {
  const lastRun = useMemo(() => formatRelative(row.lastSuccessAt), [row.lastSuccessAt]);
  const nextRun = useMemo(() => formatRelative(row.nextRunAt), [row.nextRunAt]);
  if (!row.lastAttemptAt && !row.nextRunAt) {
    return (
      <p className="mt-1 text-xs text-muted-foreground/70">
        Has not run yet.
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-muted-foreground/70">
      {row.lastSuccessAt ? `Last success ${lastRun}.` : "No successful run yet."}
      {row.enabled && row.nextRunAt && ` Next run ${nextRun}.`}
      {row.lastError && ` Last error: ${truncate(row.lastError, 80)}`}
    </p>
  );
}

function ActiveHoursEditor({
  startHour,
  endHour,
}: {
  startHour: number;
  endHour: number;
}) {
  const patch = usePatchDelegatedSyncActiveHours();
  const [start, setStart] = useState(String(startHour));
  const [end, setEnd] = useState(String(endHour));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStart(String(startHour));
  }, [startHour]);
  useEffect(() => {
    setEnd(String(endHour));
  }, [endHour]);

  const commit = () => {
    setError(null);
    const s = Number(start);
    const e = Number(end);
    if (!Number.isInteger(s) || s < 0 || s > 23) {
      setError("Start must be an integer 0–23");
      return;
    }
    if (!Number.isInteger(e) || e < 1 || e > 24) {
      setError("End must be an integer 1–24");
      return;
    }
    if (s >= e) {
      setError("Start must be earlier than end");
      return;
    }
    if (s === startHour && e === endHour) return;
    patch.mutate(
      { startHour: s, endHour: e },
      { onError: (err) => setError(err.message) },
    );
  };

  return (
    <div className="mt-3 rounded border border-border/50 bg-muted/30 p-3">
      <p className="text-sm font-medium text-foreground">Active hours</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Shared by every enabled cadence. Outside this window no cadence
        runs; Run Now still works. Interpreted in the configured timezone.
        End hour is exclusive — set 24 to run through 23:59.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <span>Start:</span>
          <Input
            type="number"
            min={0}
            max={23}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="h-7 w-16 px-2 text-xs"
          />
          <span>:00</span>
        </label>
        <label className="flex items-center gap-1">
          <span>End:</span>
          <Input
            type="number"
            min={1}
            max={24}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="h-7 w-16 px-2 text-xs"
          />
          <span>:00</span>
        </label>
        {patch.isPending && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
        {error && <span className="text-destructive">{error}</span>}
      </div>
    </div>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const deltaSec = Math.round((ms - Date.now()) / 1000);
  if (deltaSec >= 0) return inFutureWords(deltaSec);
  return inPastWords(-deltaSec);
}

function inFutureWords(deltaSec: number): string {
  if (deltaSec < 60) return `in ${deltaSec}s`;
  if (deltaSec < 60 * 60) return `in ${Math.round(deltaSec / 60)}m`;
  if (deltaSec < 24 * 60 * 60) return `in ${Math.round(deltaSec / 3600)}h`;
  return `in ${Math.round(deltaSec / 86400)}d`;
}

function inPastWords(deltaSec: number): string {
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 60 * 60) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 24 * 60 * 60) return `${Math.round(deltaSec / 3600)}h ago`;
  return `${Math.round(deltaSec / 86400)}d ago`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
