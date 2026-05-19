"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Generic polling hook for pairing flows.
 *
 * Polls `url` at `intervalMs` until `shouldStop(data)` returns true,
 * then stops polling and invalidates config + health queries.
 */
export function usePairingPoll<T>(
  url: string,
  shouldStop: (data: T) => boolean,
  intervalMs = 2000,
) {
  const queryClient = useQueryClient();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldStopRef = useRef(shouldStop);

  const [status, setStatus] = useState<T | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    shouldStopRef.current = shouldStop;
  });

  const stop = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setActive(false);
  }, []);

  const start = useCallback(() => {
    if (pollRef.current) return;
    setActive(true);
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.get<T>(url);
        setStatus(data);
        if (shouldStopRef.current(data)) {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setActive(false);
          await queryClient.invalidateQueries({ queryKey: ["config"] });
          await queryClient.invalidateQueries({ queryKey: ["health"] });
        }
      } catch {
        // Transient — keep polling.
      }
    }, intervalMs);
  }, [url, intervalMs, queryClient]);

  const reset = useCallback(() => {
    stop();
    setStatus(null);
  }, [stop]);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  return { status, active, start, stop, reset };
}
