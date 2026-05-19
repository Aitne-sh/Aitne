"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useCallback, startTransition } from "react";
import { api } from "@/lib/api-client";
import type { LogEntry, SystemLogsResponse } from "@aitne/shared";

/** Fetch recent buffered logs via REST. */
export function useSystemLogs(
  filters?: { level?: string; logger?: string },
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["system-logs", filters],
    queryFn: () =>
      api.get<SystemLogsResponse>("/logs", {
        limit: 500,
        level: filters?.level,
        logger: filters?.logger,
      }),
    enabled: options?.enabled,
  });
}

function mergeLogEntries(
  current: LogEntry[],
  incoming: LogEntry[],
  maxItems: number,
): LogEntry[] {
  const byId = new Map<number, LogEntry>();
  for (const entry of current) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .slice(-maxItems);
}

/** Subscribe to real-time log entries via SSE.
 *  Pass `maxItems=0` or a falsy value to disconnect the stream entirely. */
export function useLogStream(
  maxItems = 500,
  filters?: { level?: string; logger?: string },
) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const lastSeenIdRef = useRef(0);

  const clear = useCallback(() => {
    lastSeenIdRef.current = 0;
    setEntries([]);
  }, []);

  const mergeEntries = useCallback((incoming: LogEntry[]) => {
    if (incoming.length === 0) return;

    setEntries((prev) => {
      const next = mergeLogEntries(prev, incoming, maxItems);
      const last = next[next.length - 1];
      lastSeenIdRef.current = last?.id ?? lastSeenIdRef.current;
      return next;
    });
  }, [maxItems]);

  useEffect(() => {
    startTransition(() => {
      clear();
      if (!maxItems) setConnected(false);
    });
    if (!maxItems) return;

    // Protected SSE stays on the same-origin dashboard proxy so the browser
    // never needs direct access to the daemon's Bearer token.
    const es = new EventSource("/api/logs/stream");
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);

      // EventSource auto-reconnects, but it does not replay missed events.
      // On each reconnect, backfill anything newer than the last seen ID
      // from the in-memory log buffer.
      if (lastSeenIdRef.current > 0) {
        void api.get<SystemLogsResponse>("/logs", {
          limit: maxItems,
          afterId: lastSeenIdRef.current,
          level: filters?.level,
          logger: filters?.logger,
        }).then((data) => mergeEntries(data.logs)).catch(() => {});
      }
    };
    es.onerror = () => setConnected(false);

    es.addEventListener("log", (e) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        mergeEntries([entry]);
      } catch {
        /* ignore parse errors */
      }
    });

    es.addEventListener("ping", () => {});

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [clear, filters?.level, filters?.logger, maxItems, mergeEntries]);

  return { entries, connected, clear };
}
