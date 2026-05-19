"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ContextMigrationProgressEvent } from "@/lib/api-types";

type EventHandler = (data: unknown) => void;
type SseEventName = "event" | "context_migration_progress";

interface SSEContextValue {
  connected: boolean;
  /** Subscribe to the default persisted-event stream on /api/events/stream. */
  subscribeEvent: (handler: EventHandler) => () => void;
  /** Subscribe to a named SSE event on /api/events/stream. */
  subscribeNamedEvent: (
    eventName: SseEventName,
    handler: EventHandler,
  ) => () => void;
}

const SSEContext = createContext<SSEContextValue | null>(null);
const KNOWN_EVENT_NAMES: readonly SseEventName[] = [
  "event",
  "context_migration_progress",
] as const;

export function SSEProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(
    new Map<SseEventName, Set<EventHandler>>(),
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced cache invalidation
  const invalidateCaches = useCallback(() => {
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["health"] });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["metrics"] });
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      queryClient.invalidateQueries({ queryKey: ["next-check"] });
    }, 500);
  }, [queryClient]);

  const dispatchEvent = useCallback((eventName: SseEventName, data: unknown) => {
    const handlers = handlersRef.current.get(eventName);
    if (!handlers) return;
    for (const handler of handlers) handler(data);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    const listeners = new Map<SseEventName, (e: MessageEvent<string>) => void>();

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    for (const eventName of KNOWN_EVENT_NAMES) {
      const listener = (e: MessageEvent<string>) => {
        try {
          const data = JSON.parse(e.data);
          dispatchEvent(eventName, data);
          if (eventName === "event") {
            invalidateCaches();
            return;
          }
          if (eventName === "context_migration_progress") {
            const progress = data as Partial<ContextMigrationProgressEvent>;
            if (progress.status === "completed" || progress.status === "failed") {
              queryClient.invalidateQueries({ queryKey: ["config"] });
              queryClient.invalidateQueries({ queryKey: ["health"] });
            }
          }
        } catch {
          // ignore parse errors
        }
      };
      listeners.set(eventName, listener);
      es.addEventListener(eventName, listener as EventListener);
    }

    // Ignore keepalive pings
    es.addEventListener("ping", () => {});

    return () => {
      for (const [eventName, listener] of listeners) {
        es.removeEventListener(eventName, listener as EventListener);
      }
      es.close();
      setConnected(false);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [dispatchEvent, invalidateCaches, queryClient]);

  const subscribeNamedEvent = useCallback((eventName: SseEventName, handler: EventHandler) => {
    const existing = handlersRef.current.get(eventName) ?? new Set<EventHandler>();
    existing.add(handler);
    handlersRef.current.set(eventName, existing);
    return () => {
      const current = handlersRef.current.get(eventName);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        handlersRef.current.delete(eventName);
      }
    };
  }, []);

  const subscribeEvent = useCallback(
    (handler: EventHandler) => subscribeNamedEvent("event", handler),
    [subscribeNamedEvent],
  );

  return (
    <SSEContext.Provider value={{ connected, subscribeEvent, subscribeNamedEvent }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used within SSEProvider");
  return ctx;
}
