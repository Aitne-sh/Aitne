"use client";

import type { BackendId } from "@aitne/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, KeyRound, Loader2, Send, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api-client";
import type { RecoveryStatusResponse } from "@/lib/api-types";
import { getBackendShortLabel } from "@/lib/backend-ui";
import { parseUtcDate } from "@/lib/utils";

type ToastFn = (type: "success" | "error" | "warning", message: string) => void;

interface AuthRecoveryDialogProps {
  backendId: BackendId;
  authStatus: string;
  onToast: ToastFn;
  onRefresh: () => Promise<void>;
}

// ── Claude sub-view (browser OAuth — Phase 9) ──

interface ClaudeRecoveryViewProps {
  backendId: BackendId;
  onToast: ToastFn;
  onRefresh: () => Promise<void>;
}

function ClaudeRecoveryView({ backendId, onToast, onRefresh }: ClaudeRecoveryViewProps) {
  const [loading, setLoading] = useState(false);
  const [recoveryData, setRecoveryData] = useState<{
    authUrl: string;
    expiresMinutes: number;
    startedAt: string;
  } | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  useEffect(() => {
    // Check for existing recovery session on mount
    api
      .get<RecoveryStatusResponse>(`/backends/${backendId}/recovery/status`)
      .then((res) => {
        if (res.status === "recovering" && res.authUrl) {
          setRecoveryData({
            authUrl: res.authUrl,
            expiresMinutes: res.expiresMinutes ?? 10,
            startedAt: res.startedAt ?? new Date().toISOString(),
          });
        }
      })
      .catch(() => {
        // Ignore — no active session
      });
  }, [backendId]);

  // Start countdown and polling when recovery data appears
  useEffect(() => {
    if (!recoveryData) return;
    cleanup();

    const expiresAt =
      parseUtcDate(recoveryData.startedAt).getTime() +
      recoveryData.expiresMinutes * 60_000;

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        cleanup();
        setRecoveryData(null);
        onToast("warning", "Recovery session timed out. Start a new one.");
      }
    };
    updateCountdown();
    countdownRef.current = setInterval(updateCountdown, 1000);

    // Poll for completion
    pollRef.current = setInterval(async () => {
      try {
        const status = await api.get<RecoveryStatusResponse>(
          `/backends/${backendId}/recovery/status`,
        );
        if (status.status === "idle") {
          cleanup();
          setRecoveryData(null);
          onToast("success", "Claude authentication restored");
          await onRefresh();
          await queryClient.invalidateQueries({ queryKey: ["backends"] });
        }
      } catch {
        // Keep polling
      }
    }, 3000);

    return cleanup;
  }, [recoveryData, backendId, onToast, onRefresh, cleanup, queryClient]);

  async function startRecovery() {
    setLoading(true);
    try {
      const res = await api.post<{
        status: string;
        authUrl?: string;
        expiresMinutes?: number;
        startedAt?: string;
      }>(`/backends/${backendId}/recovery/start`);

      if (res.authUrl) {
        setRecoveryData({
          authUrl: res.authUrl,
          expiresMinutes: res.expiresMinutes ?? 10,
          startedAt: res.startedAt ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const status = await api.get<RecoveryStatusResponse>(
            `/backends/${backendId}/recovery/status`,
          );
          if (status.status === "recovering" && status.authUrl) {
            setRecoveryData({
              authUrl: status.authUrl,
              expiresMinutes: status.expiresMinutes ?? 10,
              startedAt: status.startedAt ?? new Date().toISOString(),
            });
          }
        } catch {
          onToast("error", "Recovery session in progress but details unavailable");
        }
      } else {
        onToast(
          "error",
          error instanceof Error ? error.message : "Failed to start recovery",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function cancelRecovery() {
    try {
      await api.post(`/backends/${backendId}/recovery/cancel`);
      cleanup();
      setRecoveryData(null);
      onToast("success", "Recovery cancelled");
    } catch (error) {
      onToast(
        "error",
        error instanceof Error ? error.message : "Failed to cancel recovery",
      );
    }
  }

  if (!recoveryData) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Click below to start a recovery session — you&rsquo;ll receive a link to
          sign in through your browser.
        </p>
        <Button onClick={startRecovery} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          Start Browser Login
        </Button>
      </div>
    );
  }

  const minutes = timeLeft != null ? Math.floor(timeLeft / 60) : 0;
  const seconds = timeLeft != null ? timeLeft % 60 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="blue">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Awaiting browser login
        </Badge>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {minutes}:{seconds.toString().padStart(2, "0")}
        </span>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Open this URL in your browser and sign in:</p>
          <a
            href={recoveryData.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400 break-all"
          >
            Sign in to Anthropic
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The daemon is waiting for the browser login to complete. This dialog will
        close automatically when authentication succeeds.
      </p>

      <Button size="sm" variant="outline" onClick={cancelRecovery}>
        <X className="h-3.5 w-3.5" />
        Cancel
      </Button>
    </div>
  );
}

// ── Codex sub-view (device code flow) ──

interface CodexRecoveryViewProps {
  backendId: BackendId;
  onToast: ToastFn;
  onRefresh: () => Promise<void>;
}

function CodexRecoveryView({ backendId, onToast, onRefresh }: CodexRecoveryViewProps) {
  const [loading, setLoading] = useState(false);
  const [recoveryData, setRecoveryData] = useState<{
    authUrl: string;
    userCode: string;
    expiresMinutes: number;
    startedAt: string;
  } | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  useEffect(() => {
    // Check for existing recovery session on mount
    api
      .get<RecoveryStatusResponse>(`/backends/${backendId}/recovery/status`)
      .then((res) => {
        if (res.status === "recovering" && res.authUrl && res.userCode) {
          setRecoveryData({
            authUrl: res.authUrl,
            userCode: res.userCode,
            expiresMinutes: res.expiresMinutes ?? 15,
            startedAt: res.startedAt ?? new Date().toISOString(),
          });
        }
      })
      .catch(() => {
        // Ignore — no active session
      });
  }, [backendId]);

  // Start countdown and polling when recovery data appears
  useEffect(() => {
    if (!recoveryData) return;
    cleanup();

    const expiresAt =
      parseUtcDate(recoveryData.startedAt).getTime() +
      recoveryData.expiresMinutes * 60_000;

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        cleanup();
        setRecoveryData(null);
        onToast("warning", "Device code expired. Start a new recovery session.");
      }
    };
    updateCountdown();
    countdownRef.current = setInterval(updateCountdown, 1000);

    // Poll for completion
    pollRef.current = setInterval(async () => {
      try {
        const status = await api.get<RecoveryStatusResponse>(
          `/backends/${backendId}/recovery/status`,
        );
        if (status.status === "idle") {
          cleanup();
          setRecoveryData(null);
          onToast("success", `${getBackendShortLabel(backendId)} authentication restored`);
          await onRefresh();
          await queryClient.invalidateQueries({ queryKey: ["backends"] });
        }
      } catch {
        // Keep polling
      }
    }, 3000);

    return cleanup;
  }, [recoveryData, backendId, onToast, onRefresh, cleanup, queryClient]);

  async function startRecovery() {
    setLoading(true);
    try {
      const res = await api.post<{
        status: string;
        authUrl?: string;
        userCode?: string;
        expiresMinutes?: number;
        startedAt?: string;
      }>(`/backends/${backendId}/recovery/start`);

      if (res.authUrl && res.userCode) {
        setRecoveryData({
          authUrl: res.authUrl,
          userCode: res.userCode,
          expiresMinutes: res.expiresMinutes ?? 15,
          startedAt: res.startedAt ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Already active — try fetching status
        try {
          const status = await api.get<RecoveryStatusResponse>(
            `/backends/${backendId}/recovery/status`,
          );
          if (status.status === "recovering" && status.authUrl && status.userCode) {
            setRecoveryData({
              authUrl: status.authUrl,
              userCode: status.userCode,
              expiresMinutes: status.expiresMinutes ?? 15,
              startedAt: status.startedAt ?? new Date().toISOString(),
            });
          }
        } catch {
          onToast("error", "Recovery session in progress but details unavailable");
        }
      } else {
        onToast(
          "error",
          error instanceof Error ? error.message : "Failed to start recovery",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function cancelRecovery() {
    try {
      await api.post(`/backends/${backendId}/recovery/cancel`);
      cleanup();
      setRecoveryData(null);
      onToast("success", "Recovery cancelled");
    } catch (error) {
      onToast(
        "error",
        error instanceof Error ? error.message : "Failed to cancel recovery",
      );
    }
  }

  if (!recoveryData) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Codex uses OpenAI&rsquo;s device code flow. Click below to start a recovery
          session — you&rsquo;ll receive a URL and a code to enter in your browser.
        </p>
        <Button onClick={startRecovery} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          Start Device Auth
        </Button>
      </div>
    );
  }

  const minutes = timeLeft != null ? Math.floor(timeLeft / 60) : 0;
  const seconds = timeLeft != null ? timeLeft % 60 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="blue">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Awaiting confirmation
        </Badge>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {minutes}:{seconds.toString().padStart(2, "0")}
        </span>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">1. Open this URL in your browser:</p>
          <a
            href={recoveryData.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {recoveryData.authUrl}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">2. Enter this code:</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="rounded bg-background px-3 py-1.5 text-lg font-bold tracking-widest">
              {recoveryData.userCode}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(recoveryData.userCode);
                onToast("success", "Code copied to clipboard");
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The daemon is polling for completion. This dialog will close automatically
        when authentication succeeds.
      </p>

      <Button size="sm" variant="outline" onClick={cancelRecovery}>
        <X className="h-3.5 w-3.5" />
        Cancel
      </Button>
    </div>
  );
}

// ── Gemini sub-view (OAuth URL + code input) ──

interface GeminiRecoveryViewProps {
  backendId: BackendId;
  onToast: ToastFn;
  onRefresh: () => Promise<void>;
}

function GeminiRecoveryView({ backendId, onToast, onRefresh }: GeminiRecoveryViewProps) {
  const [loading, setLoading] = useState(false);
  const [recoveryData, setRecoveryData] = useState<{
    authUrl: string;
    expiresMinutes: number;
    startedAt: string;
  } | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  const cleanup = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  // Check for existing recovery session on mount
  useEffect(() => {
    api
      .get<RecoveryStatusResponse>(`/backends/${backendId}/recovery/status`)
      .then((res) => {
        if (res.status === "recovering" && res.authUrl) {
          setRecoveryData({
            authUrl: res.authUrl,
            expiresMinutes: res.expiresMinutes ?? 5,
            startedAt: res.startedAt ?? new Date().toISOString(),
          });
        }
      })
      .catch(() => {});
  }, [backendId]);

  // Countdown timer
  useEffect(() => {
    if (!recoveryData) return;
    cleanup();

    const expiresAt =
      parseUtcDate(recoveryData.startedAt).getTime() +
      recoveryData.expiresMinutes * 60_000;

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        cleanup();
        setRecoveryData(null);
        onToast("warning", "Session expired. Start a new recovery.");
      }
    };
    updateCountdown();
    countdownRef.current = setInterval(updateCountdown, 1000);

    return cleanup;
  }, [recoveryData, onToast, cleanup]);

  async function startRecovery() {
    setLoading(true);
    try {
      const res = await api.post<{
        status: string;
        authUrl?: string;
        expiresMinutes?: number;
        startedAt?: string;
      }>(`/backends/${backendId}/recovery/start`);

      if (res.authUrl) {
        setRecoveryData({
          authUrl: res.authUrl,
          expiresMinutes: res.expiresMinutes ?? 5,
          startedAt: res.startedAt ?? new Date().toISOString(),
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const status = await api.get<RecoveryStatusResponse>(
            `/backends/${backendId}/recovery/status`,
          );
          if (status.status === "recovering" && status.authUrl) {
            setRecoveryData({
              authUrl: status.authUrl,
              expiresMinutes: status.expiresMinutes ?? 5,
              startedAt: status.startedAt ?? new Date().toISOString(),
            });
          }
        } catch {
          onToast("error", "Recovery session in progress but details unavailable");
        }
      } else {
        onToast(
          "error",
          error instanceof Error ? error.message : "Failed to start recovery",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function submitAuthCode() {
    if (!authCode.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ status: string; detail: string }>(
        `/backends/${backendId}/recovery/code`,
        { code: authCode.trim() },
      );
      if (res.status === "ok") {
        onToast("success", `${getBackendShortLabel(backendId)} authentication restored`);
        cleanup();
        setRecoveryData(null);
        setAuthCode("");
        await onRefresh();
        await queryClient.invalidateQueries({ queryKey: ["backends"] });
      } else {
        onToast("error", res.detail || "Authentication failed");
      }
    } catch (error) {
      onToast(
        "error",
        error instanceof Error ? error.message : "Failed to submit auth code",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRecovery() {
    try {
      await api.post(`/backends/${backendId}/recovery/cancel`);
      cleanup();
      setRecoveryData(null);
      setAuthCode("");
      onToast("success", "Recovery cancelled");
    } catch (error) {
      onToast(
        "error",
        error instanceof Error ? error.message : "Failed to cancel recovery",
      );
    }
  }

  if (!recoveryData) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Gemini uses Google OAuth. Click below to generate an authorization URL
          — open it in your browser, sign in, and paste the resulting code back here.
        </p>
        <Button onClick={startRecovery} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          Start OAuth Flow
        </Button>
      </div>
    );
  }

  const minutes = timeLeft != null ? Math.floor(timeLeft / 60) : 0;
  const seconds = timeLeft != null ? timeLeft % 60 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="blue">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Awaiting code
        </Badge>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {minutes}:{seconds.toString().padStart(2, "0")}
        </span>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            1. Open this URL and sign in with Google:
          </p>
          <a
            href={recoveryData.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 break-all text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Open Google Sign-In
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            2. Copy the authorization code and paste it here:
          </p>
          <div className="mt-1 flex gap-2">
            <Input
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="4/0Axx..."
              className="font-mono text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAuthCode();
              }}
            />
            <Button onClick={submitAuthCode} disabled={submitting || !authCode.trim()}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Submit
            </Button>
          </div>
        </div>
      </div>

      <Button size="sm" variant="outline" onClick={cancelRecovery}>
        <X className="h-3.5 w-3.5" />
        Cancel
      </Button>
    </div>
  );
}

// ── Main dialog component ──

export function AuthRecoveryDialog({
  backendId,
  authStatus,
  onToast,
  onRefresh,
}: AuthRecoveryDialogProps) {
  const label = getBackendShortLabel(backendId);
  const isRecovering = authStatus === "recovering";

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant={isRecovering ? "default" : "outline"}>
          {isRecovering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <KeyRound className="h-3.5 w-3.5" />
          )}
          {isRecovering ? "Recovery..." : "Fix Auth"}
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>
            {label} Authentication Recovery
          </SheetTitle>
        </SheetHeader>
        <div className="mt-6">
          {backendId === "claude" && (
            <ClaudeRecoveryView
              backendId={backendId}
              onToast={onToast}
              onRefresh={onRefresh}
            />
          )}
          {backendId === "codex" && (
            <CodexRecoveryView
              backendId={backendId}
              onToast={onToast}
              onRefresh={onRefresh}
            />
          )}
          {backendId === "gemini" && (
            <GeminiRecoveryView
              backendId={backendId}
              onToast={onToast}
              onRefresh={onRefresh}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
