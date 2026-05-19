"use client";

import { useEffect, useState, startTransition } from "react";
import { useSSE } from "@/providers/sse-provider";
import type { EventRow } from "@/lib/api-types";

export function useEventStream(maxItems = 10) {
  const { subscribeEvent } = useSSE();
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    if (!maxItems) {
      startTransition(() => setEvents([]));
      return;
    }

    return subscribeEvent((data) => {
      const raw = data as Record<string, unknown>;
      const id = Number(raw.id);
      if (!Number.isFinite(id) || id <= 0) return;
      const event = { ...raw, id } as EventRow;
      setEvents((prev) => [event, ...prev].slice(0, maxItems));
    });
  }, [subscribeEvent, maxItems]);

  return events;
}
