"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardCopy,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api-client";
import type {
  BackendInstallInfo,
  CliInstallResult,
  InstallMethodsResponse,
} from "@/lib/api-types";
import type { BackendId } from "@aitne/shared";
import { BACKEND_LABELS } from "@/lib/backend-ui";

interface CliInstallPanelProps {
  backendId: BackendId;
  /** Whether the CLI is currently installed (from useBackends). */
  cliInstalled: boolean;
  /** Compact mode for inline use in settings cards. */
  compact?: boolean;
  /** Called after a successful install so the parent can re-fetch data. */
  onInstalled?: () => void;
}

/**
 * Shows CLI installation status for a backend and lets the user
 * install via their preferred package manager (npm, brew, etc.).
 *
 * Handles two types of install methods:
 * - Auto-runnable: daemon executes the install command directly
 * - Manual-only: command is shown for the user to copy & run in their
 *   own terminal (for methods requiring elevation or interactive input)
 */
export function CliInstallPanel({
  backendId,
  cliInstalled,
  compact = false,
  onInstalled,
}: CliInstallPanelProps) {
  const queryClient = useQueryClient();
  const [installInfo, setInstallInfo] = useState<BackendInstallInfo | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<CliInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchMethods = useCallback(async () => {
    if (cliInstalled) return;
    setLoading(true);
    try {
      const data = await api.get<InstallMethodsResponse>(
        "/backends/install-methods",
      );
      const info = data.backends[backendId];
      setInstallInfo(info);
      // Auto-select the first available method (ordered by recommendation)
      const firstAvailable = info.methods.find((m) => m.available);
      if (firstAvailable) {
        setSelectedMethod(firstAvailable.id);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch install methods",
      );
    } finally {
      setLoading(false);
    }
  }, [backendId, cliInstalled]);

  useEffect(() => {
    if (!cliInstalled) {
      fetchMethods();
    }
  }, [cliInstalled, fetchMethods]);

  const handleInstall = async () => {
    if (!selectedMethod) return;
    setInstalling(true);
    setResult(null);
    setError(null);
    try {
      const res = await api.post<CliInstallResult>(
        `/backends/${backendId}/install`,
        { method: selectedMethod },
      );
      setResult(res);
      if (res.ok && res.cliInstalled) {
        await queryClient.invalidateQueries({ queryKey: ["backends"] });
        onInstalled?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setInstalling(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback — select the text for manual copy
    }
  };

  const handleRetryDetection = () => {
    setResult(null);
    setError(null);
    fetchMethods();
    queryClient.invalidateQueries({ queryKey: ["backends"] });
  };

  const docsUrl = installInfo?.docsUrl;
  const backendLabel = BACKEND_LABELS[backendId];

  // ── Already installed (or field unavailable from old daemon) ──
  // cliInstalled is `true` when installed, `false` when not, or
  // `undefined` if the daemon predates this field. For `undefined`,
  // hide the panel rather than falsely showing "not installed."
  if (cliInstalled !== false && !result?.ok) {
    if (compact) return null;
    if (cliInstalled === true) {
      return (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          <span>{backendLabel} CLI is installed and ready</span>
        </div>
      );
    }
    return null;
  }

  // ── Loading methods ──
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Detecting available install methods...</span>
      </div>
    );
  }

  const allMethods = installInfo?.methods ?? [];
  const availableMethods = allMethods.filter((m) => m.available);
  const selectedDef = allMethods.find((m) => m.id === selectedMethod);
  const isManualOnly = selectedDef?.manualOnly ?? false;
  const otherAvailable = availableMethods.filter(
    (m) => m.id !== selectedMethod,
  );

  // ── Install success ──
  if (result?.ok) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          <span>{backendLabel} CLI installed successfully</span>
        </div>
        {!compact && (
          <p className="text-xs text-muted-foreground">
            Proceed to verify authentication below to confirm your credentials
            are working.
          </p>
        )}
      </div>
    );
  }

  // ── Install form ──
  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {/* Status heading */}
      <div className="flex items-center gap-2 text-sm text-warning">
        <Download className="h-4 w-4 shrink-0" />
        <span>{backendLabel} CLI is not installed</span>
      </div>

      {/* Description — only in non-compact mode */}
      {!compact && (
        <p className="text-xs text-muted-foreground">
          The {backendLabel} CLI must be installed on this machine for the agent
          to use it as a backend. Choose an install method below, or install
          manually in your terminal.
        </p>
      )}

      {availableMethods.length > 0 ? (
        <>
          <div className={compact ? "flex items-center gap-2" : "space-y-2"}>
            {/* Method selector */}
            <Select value={selectedMethod} onValueChange={setSelectedMethod}>
              <SelectTrigger className={compact ? "w-[200px]" : "w-full"}>
                <SelectValue placeholder="Choose install method" />
              </SelectTrigger>
              <SelectContent>
                {allMethods.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={!m.available}>
                    {m.label}
                    {!m.available && " (not available)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Action button — Install or Copy depending on method type */}
            {isManualOnly ? (
              <Button
                size={compact ? "sm" : "default"}
                variant="outline"
                onClick={() => selectedDef && handleCopy(selectedDef.command)}
                disabled={!selectedMethod}
                className="gap-2 shrink-0"
              >
                {copied ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : (
                  <ClipboardCopy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied!" : "Copy Command"}
              </Button>
            ) : (
              <Button
                size={compact ? "sm" : "default"}
                variant="outline"
                onClick={handleInstall}
                disabled={
                  installing || !selectedMethod || !selectedDef?.available
                }
                className="gap-2 shrink-0"
              >
                {installing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Terminal className="h-3.5 w-3.5" />
                )}
                {installing ? "Installing..." : "Install"}
              </Button>
            )}
          </div>

          {/* Command preview — non-compact only */}
          {selectedDef && !compact && (
            <div className="rounded-md bg-muted/50 px-3 py-2">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {isManualOnly
                  ? "Run this command in your terminal"
                  : "Command to run"}
              </p>
              <code className="text-xs text-muted-foreground">
                $ {selectedDef.command}
              </code>
            </div>
          )}

          {/* Manual-only hint */}
          {isManualOnly && !compact && (
            <p className="text-xs text-muted-foreground">
              This method requires you to run the command in your own terminal
              (it may need elevated permissions). After installing, click{" "}
              <strong>Retry Detection</strong> to verify.
            </p>
          )}

          {/* Retry detection — always visible for manual-only methods */}
          {isManualOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetryDetection}
              className="gap-1.5"
            >
              <RefreshCw className="h-3 w-3" />
              Retry Detection
            </Button>
          )}
        </>
      ) : (
        /* No package manager available — manual install guidance */
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <p className="text-xs font-medium text-warning">
            No supported package manager was detected on this system.
          </p>
          <p className="text-xs text-warning">
            Please install the CLI manually in your terminal:
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded bg-muted px-2.5 py-1.5">
              <code className="text-xs">
                npm install -g{" "}
                {backendId === "claude"
                  ? "@anthropic-ai/claude-code"
                  : backendId === "codex"
                    ? "@openai/codex"
                    : "@google/gemini-cli"}
              </code>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                handleCopy(
                  `npm install -g ${
                    backendId === "claude"
                      ? "@anthropic-ai/claude-code"
                      : backendId === "codex"
                        ? "@openai/codex"
                        : "@google/gemini-cli"
                  }`,
                )
              }
              className="shrink-0"
            >
              {copied ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              ) : (
                <ClipboardCopy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetryDetection}
              className="gap-1.5"
            >
              <RefreshCw className="h-3 w-3" />
              Retry Detection
            </Button>
            {docsUrl && (
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-warning underline"
              >
                <ExternalLink className="h-3 w-3" />
                Official installation guide
              </a>
            )}
          </div>
        </div>
      )}

      {/* ── Install failure ── */}
      {result && !result.ok && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <XCircle className="h-4 w-4 shrink-0" />
            <span>
              {result.timedOut
                ? "Installation timed out (5 min limit)"
                : `Installation failed (exit code ${result.exitCode})`}
            </span>
          </div>

          {/* stderr output */}
          {result.stderr && (
            <pre className="max-h-32 overflow-auto rounded bg-destructive/10 p-2 text-xs text-destructive">
              {result.stderr.slice(-1500)}
            </pre>
          )}

          {/* Recovery suggestions */}
          <div className="space-y-1 text-xs text-destructive">
            {otherAvailable.length > 0 && (
              <p>
                Try a different method: select{" "}
                {otherAvailable.map((m) => `"${m.label}"`).join(" or ")} from
                the dropdown above.
              </p>
            )}
            <p>
              You can also install manually in your terminal and then click{" "}
              <strong>Retry Detection</strong> below.
            </p>
          </div>

          {/* Retry detection + docs link */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetryDetection}
              className="gap-1.5"
            >
              <RefreshCw className="h-3 w-3" />
              Retry Detection
            </Button>
            {docsUrl && (
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-destructive underline"
              >
                <ExternalLink className="h-3 w-3" />
                Official install guide
              </a>
            )}
          </div>
        </div>
      )}

      {/* API-level error (not install failure) */}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
