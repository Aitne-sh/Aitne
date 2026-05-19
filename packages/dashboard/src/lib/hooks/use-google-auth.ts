"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api-client";
import { OAUTH_POPUP_TIMEOUT_MS } from "@/lib/google-auth";

interface UseGoogleAuthOptions {
  /** Daemon API port (from config). Falls back to 8321. */
  apiPort?: number;
  /** Called when authorization succeeds (via postMessage or popup close). */
  onSuccess?: () => void;
}

interface UseGoogleAuthReturn {
  authorizing: boolean;
  authError: string | null;
  /** Auth URL for manual fallback when popup is blocked. Expires after 10 min. */
  fallbackAuthUrl: string | null;
  handleAuthorize: () => Promise<void>;
}

/**
 * Shared hook that manages the Google OAuth popup flow:
 * - Opens popup, polls for close, listens for postMessage
 * - Handles popup-blocked fallback, timeout, cleanup
 * - Validates postMessage origin against daemon port
 */
export function useGoogleAuth({
  apiPort,
  onSuccess,
}: UseGoogleAuthOptions = {}): UseGoogleAuthReturn {
  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [fallbackAuthUrl, setFallbackAuthUrl] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupRef = useRef<Window | null>(null);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });

  // Cleanup all timers and popup
  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Full cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  // Listen for postMessage from OAuth callback popup
  useEffect(() => {
    const daemonOrigin = `http://localhost:${apiPort ?? 8321}`;
    const handler = (event: MessageEvent) => {
      if (event.origin !== daemonOrigin) return;
      if (event.data?.type === "google-auth-success") {
        cleanup();
        setAuthorizing(false);
        setFallbackAuthUrl(null);
        onSuccessRef.current?.();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [apiPort, cleanup]);

  const handleAuthorize = useCallback(async () => {
    setAuthorizing(true);
    setAuthError(null);
    setFallbackAuthUrl(null);

    try {
      const res = await api.post<{ authUrl: string }>(
        "/config/google-auth/start",
      );

      const popup = window.open(
        res.authUrl,
        "google-auth",
        "width=600,height=700",
      );

      if (!popup) {
        setAuthError(
          "Popup blocked by browser. Click the link below to authorize directly.",
        );
        setAuthorizing(false);
        setFallbackAuthUrl(res.authUrl);
        // Auto-expire the fallback URL after the server state token TTL (10 min)
        setTimeout(() => setFallbackAuthUrl(null), 10 * 60 * 1000);
        return;
      }

      popupRef.current = popup;

      // Poll for popup close
      pollRef.current = setInterval(() => {
        if (popup.closed) {
          cleanup();
          setAuthorizing(false);
          // Popup closed — might have succeeded; caller should re-fetch config
          onSuccessRef.current?.();
        }
      }, 1000);

      // Timeout safety net: close popup and stop polling
      timeoutRef.current = setTimeout(() => {
        cleanup();
        try {
          popup.close();
        } catch {
          // Cross-origin popup — can't close, ignore
        }
        popupRef.current = null;
        setAuthorizing(false);
        setAuthError("Authorization timed out. Please try again.");
      }, OAUTH_POPUP_TIMEOUT_MS);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : "Failed to start authorization",
      );
      setAuthorizing(false);
    }
  }, [cleanup]);

  return { authorizing, authError, fallbackAuthUrl, handleAuthorize };
}
