import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ContextFileResponse } from "@/lib/api-types";

export type RegenerateTarget = "today" | "roadmap";
export type RegenerateStatus = "idle" | "triggered" | "running" | "done" | "error";

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 300_000; // 5 minutes — roadmap_refresh can legitimately run 13+ turns

export function useRegenerate() {
  const [target, setTarget] = useState<RegenerateTarget | null>(null);
  const [status, setStatus] = useState<RegenerateStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialModifiedRef = useRef<string | null>(null);
  const startTimeRef = useRef<number>(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const regenerate = useCallback(async (t: RegenerateTarget) => {
    // Prevent double-trigger
    if (status === "triggered" || status === "running") return;

    setTarget(t);
    setStatus("triggered");
    setError(null);
    startTimeRef.current = Date.now();

    // Capture current lastModified before triggering (null = file doesn't exist yet)
    const current = await api.get<ContextFileResponse>(`/context/${t}`).catch(() => null);
    initialModifiedRef.current = current?.lastModified ?? null;

    try {
      await api.post("/agent/regenerate", { target: t });
      setStatus("running");

      // Poll for file change
      pollRef.current = setInterval(async () => {
        // Timeout check
        if (Date.now() - startTimeRef.current > TIMEOUT_MS) {
          stopPolling();
          setStatus("error");
          setError("Timeout — agent may still be processing");
          return;
        }

        try {
          const updated = await api.get<ContextFileResponse>(`/context/${t}`);
          const changed = initialModifiedRef.current === null
            ? true  // file didn't exist before → now it does
            : updated.lastModified !== initialModifiedRef.current;
          if (changed) {
            stopPolling();
            setStatus("done");
            queryClient.invalidateQueries({ queryKey: ["context", t] });
            queryClient.invalidateQueries({ queryKey: ["calendar"] });
            setTimeout(() => {
              setStatus("idle");
              setTarget(null);
            }, 5000);
          }
        } catch {
          // File might not exist yet — keep polling
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Failed to trigger");
    }
  }, [status, queryClient, stopPolling]);

  const dismiss = useCallback(() => {
    stopPolling();
    setStatus("idle");
    setTarget(null);
    setError(null);
  }, [stopPolling]);

  return { regenerate, target, status, error, dismiss };
}
