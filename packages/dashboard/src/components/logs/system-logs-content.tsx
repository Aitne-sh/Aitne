"use client";

import { useState, useEffect, useRef, useMemo, memo, useCallback } from "react";
import { useSystemLogs, useLogStream } from "@/lib/hooks/use-system-logs";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollText, Trash2, ArrowDown, ChevronRight } from "lucide-react";
import { cn, parseUtcDate } from "@/lib/utils";
import type { LogEntry } from "@aitne/shared";

const LEVEL_STYLES: Record<
  string,
  { badge: "blue" | "amber" | "red" | "gray" | "default"; text: string }
> = {
  info: { badge: "blue", text: "text-foreground" },
  warn: { badge: "amber", text: "text-warning" },
  error: { badge: "red", text: "text-destructive" },
  fatal: {
    badge: "red",
    text: "text-destructive font-semibold",
  },
};

function formatTime(iso: string): string {
  try {
    const d = parseUtcDate(iso);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

const LogEntryRow = memo(function LogEntryRow({
  entry,
}: {
  entry: LogEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const style = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.info;
  const hasData = Boolean(entry.data);
  const toggle = useCallback(() => {
    if (hasData) setExpanded((v) => !v);
  }, [hasData]);

  return (
    <div
      className={cn(
        "group border-b border-border/50 px-3 py-1.5 font-mono text-[13px] leading-relaxed hover:bg-muted/30 transition-colors",
        entry.level === "error" || entry.level === "fatal"
          ? "bg-destructive/10"
          : entry.level === "warn"
            ? "bg-warning/5"
            : "",
      )}
    >
      <div
        className={cn(
          "flex items-start gap-2",
          hasData && "cursor-pointer select-none",
        )}
        onClick={hasData ? toggle : undefined}
        role={hasData ? "button" : undefined}
        tabIndex={hasData ? 0 : undefined}
        onKeyDown={
          hasData
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
        aria-expanded={hasData ? expanded : undefined}
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatTime(entry.timestamp)}
        </span>
        <Badge
          variant={style.badge}
          className="shrink-0 w-12 justify-center uppercase text-[10px]"
        >
          {entry.level}
        </Badge>
        <span
          className="shrink-0 text-muted-foreground w-28 truncate"
          title={entry.logger}
        >
          {entry.logger}
        </span>
        <span className={cn("min-w-0 flex-1 break-all", style.text)}>
          {entry.message}
        </span>
        {hasData && (
          <span
            className="shrink-0 p-0.5 text-muted-foreground"
            aria-hidden="true"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </span>
        )}
      </div>
      {expanded && entry.data && (
        <pre className="mt-1 ml-44 min-w-0 max-w-full max-h-[50vh] overflow-auto rounded bg-muted/50 p-2 text-xs text-muted-foreground">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
});

export function SystemLogsContent({ enabled }: { enabled: boolean }) {
  const [level, setLevel] = useState("all");
  const [logger, setLogger] = useState("all");
  const [live, setLive] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearedAt, setClearedAt] = useState(0);

  const filters = {
    level: level === "all" ? undefined : level,
    logger: logger === "all" ? undefined : logger,
  };

  const {
    data: initialData,
    isLoading,
    isError,
    error,
    refetch,
  } = useSystemLogs(filters, { enabled });

  const { entries: streamEntries, connected, clear: clearStream } = useLogStream(
    live && enabled ? 1000 : 0,
    filters,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const merged = useMemo(() => {
    const initialLogs = clearedAt === 0 ? (initialData?.logs ?? []) : [];
    const seen = new Set<number>();
    const all: LogEntry[] = [];

    for (const e of initialLogs) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
    if (live) {
      for (const e of streamEntries) {
        if (seen.has(e.id)) continue;
        if (e.id <= clearedAt) continue;
        if (filters.level && e.level !== filters.level) continue;
        if (filters.logger && e.logger !== filters.logger) continue;
        seen.add(e.id);
        all.push(e);
      }
    }

    all.sort((a, b) => a.id - b.id);
    return all;
  }, [initialData, streamEntries, live, filters.level, filters.logger, clearedAt]);

  const loggerNames = useMemo(() => {
    const fromApi = initialData?.loggers ?? [];
    const fromStream = new Set(streamEntries.map((e) => e.logger));
    const combined = new Set([...fromApi, ...fromStream]);
    return [...combined].sort();
  }, [initialData?.loggers, streamEntries]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [merged.length, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const handleClear = useCallback(() => {
    const maxId = streamEntries.length > 0
      ? Math.max(...streamEntries.map((e) => e.id))
      : (initialData?.logs ?? []).reduce((m, e) => Math.max(m, e.id), 0);
    setClearedAt(maxId);
    clearStream();
  }, [streamEntries, initialData?.logs, clearStream]);

  return (
    <div className="flex h-full flex-col">
      {/* Header with connection status */}
      <div className="mb-4 flex items-center justify-end">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connected ? "bg-success" : "bg-gray-400",
            )}
          />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warn">Warn</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="fatal">Fatal</SelectItem>
          </SelectContent>
        </Select>

        <Select value={logger} onValueChange={setLogger}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Logger" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Loggers</SelectItem>
            {loggerNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" onClick={handleClear}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Clear
        </Button>

        <div className="flex-1" />

        <button
          onClick={() => setLive(!live)}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            live
              ? "bg-success/15 text-success"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              live ? "bg-success animate-pulse" : "bg-gray-400",
            )}
          />
          Live
        </button>

        {!autoScroll && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAutoScroll(true);
              bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
            Scroll to bottom
          </Button>
        )}
      </div>

      {/* Log entries */}
      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<TableSkeleton rows={12} />}
      >
        {merged.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No logs yet"
            description="Application logs will appear here as the daemon runs"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
            <ScrollArea
              ref={scrollRef}
              className="h-full"
              onScrollCapture={handleScroll}
            >
              {merged.map((entry) => (
                <LogEntryRow key={entry.id} entry={entry} />
              ))}
              <div ref={bottomRef} />
            </ScrollArea>
          </div>
        )}
      </QueryResult>

      <div className="mt-2 shrink-0 text-xs text-muted-foreground">
        {merged.length} entries
      </div>
    </div>
  );
}
