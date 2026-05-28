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
type SseEventName =
  | "event"
  | "context_migration_progress"
  // BROWSER_TASK_REDESIGN_PLAN.md §9a.5 Shape B — daemon emits one
  // `browser_task` named event per state transition (pending → running
  // → awaiting_user → final_confirm → completed / failed / cancelled /
  // timeout / abandoned). The dashboard invalidates exactly three keys
  // on receipt: the list, the per-id detail, and the awaiting-count.
  | "browser_task";

/** Shape of the `browser_task` SSE payload — mirrors the daemon's
 *  `BrowserTaskTransitionPayload`. Kept narrow for forward compat. */
export interface BrowserTaskSsePayload {
  taskId: string;
  state: string;
  transitionedAt: number;
  brief: string;
  outcomeDetail: string | null;
  originatingChannel: string | null;
}

/**
 * Minimal slice of TanStack's QueryClient — narrow enough that the
 * pure-logic test in `sse-provider.browser-tasks.test.ts` can hand in
 * a recorder without booting a full client.
 */
interface InvalidateSink {
  invalidateQueries(filter: { queryKey: readonly unknown[] }): unknown;
}

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §13 — pure invalidation contract for
 * the `browser_task` SSE event. Extracted out of the provider so the
 * acceptance test can assert "exactly these three keys, no extras"
 * without standing up a React render harness.
 *
 * Contract: on every `browser_task` event the dashboard invalidates
 * the list key, the awaiting-count key, and (when a taskId is present)
 * the per-id detail key. Nothing else.
 */
export function invalidateBrowserTaskCaches(
  sink: InvalidateSink,
  payload: Partial<BrowserTaskSsePayload> | null | undefined,
): void {
  sink.invalidateQueries({ queryKey: ["browser-tasks"] });
  sink.invalidateQueries({ queryKey: ["browser-tasks", "awaiting-count"] });
  if (payload?.taskId) {
    sink.invalidateQueries({ queryKey: ["browser-tasks", payload.taskId] });
  }
}

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
  "browser_task",
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
          if (eventName === "browser_task") {
            // §9a.5 Shape B — invalidate exactly three keys per the
            // design. List + detail repopulate from the daemon; the
            // awaiting-count query is the anchor for the cross-cutting
            // "needs your attention" surfaces (banner / nav badge / list
            // strip). No global cache thrash. Logic lives in
            // `invalidateBrowserTaskCaches` so the §13 acceptance test
            // can assert the contract without a render harness.
            invalidateBrowserTaskCaches(
              queryClient,
              data as Partial<BrowserTaskSsePayload>,
            );
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
