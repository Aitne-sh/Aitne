"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown, Upload, CheckCircle2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { EditableField } from "@/components/settings/editors";
import type { FileUploadResponse, GoogleIntegrationStatus } from "@/lib/api-types";
import { ConnectionCard, deriveIntegrationStatus } from "./connection-card";

// ── File Upload Button (local helper) ──

function truncateMiddle(name: string, max = 36): string {
  if (name.length <= max) return name;
  const keepEnd = Math.floor((max - 1) / 2);
  const keepStart = max - 1 - keepEnd;
  return `${name.slice(0, keepStart)}…${name.slice(-keepEnd)}`;
}

function FileUploadButton({
  label,
  accept,
  onUpload,
  configured,
}: {
  label: string;
  accept: string;
  onUpload: (file: File) => Promise<void>;
  configured: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<
    | { type: "success"; fileName: string }
    | { type: "error"; message: string }
    | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setResult(null);
    try {
      await onUpload(file);
      setResult({ type: "success", fileName: file.name });
    } catch (e) {
      setResult({ type: "error", message: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setUploading(false);
    }
  }, [onUpload]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant={configured ? "outline" : "default"}
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="text-xs"
        >
          <Upload className="h-3.5 w-3.5 mr-1" />
          {uploading ? "Uploading..." : label}
        </Button>
        {configured && <CheckCircle2 className="h-4 w-4 text-success" />}
      </div>
      {result && (
        <Alert variant={result.type === "success" ? "success" : "error"}>
          {result.type === "success" ? (
            <span className="block break-all" title={result.fileName}>
              {truncateMiddle(result.fileName)} uploaded
            </span>
          ) : (
            <span className="block break-all">{result.message}</span>
          )}
        </Alert>
      )}
    </div>
  );
}

// ── Google Calendar icon (inline SVG for the multicolor G) ──

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84Z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" fill="#EA4335" />
    </svg>
  );
}

export function GoogleCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const { toast, saveField } = useSaveConfig();
  const queryClient = useQueryClient();

  const gStatus: GoogleIntegrationStatus | undefined = health?.integrations?.google;

  const [authorizing, setAuthorizing] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const credDone = config?.googleCalendarCredentialsConfigured ?? false;
  const tokenDone = config?.googleCalendarTokenConfigured ?? false;
  const isServiceAccount = config?.googleCredentialType === "service_account";

  const handleUploadCredentials = async (file: File) => {
    await api.upload<FileUploadResponse>("/config/upload/google-credentials", file);
    queryClient.invalidateQueries({ queryKey: ["config"] });
    queryClient.invalidateQueries({ queryKey: ["health"] });
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!event.origin.startsWith("http://localhost")) return;
      if (event.data?.type === "google-auth-success") {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setAuthorizing(false);
        queryClient.invalidateQueries({ queryKey: ["config"] });
        queryClient.invalidateQueries({ queryKey: ["health"] });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [queryClient]);

  const handleAuthorize = async () => {
    setAuthorizing(true);
    setAuthError(null);
    try {
      const res = await api.post<{ authUrl: string }>("/config/google-auth/start");
      const popup = window.open(res.authUrl, "google-auth", "width=600,height=700");
      if (!popup) {
        setAuthError("Popup blocked. Allow popups for this site and try again.");
        setAuthorizing(false);
        return;
      }
      pollRef.current = setInterval(() => {
        if (popup.closed) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setAuthorizing(false);
          queryClient.invalidateQueries({ queryKey: ["config"] });
          queryClient.invalidateQueries({ queryKey: ["health"] });
        }
      }, 1000);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Failed to start authorization");
      setAuthorizing(false);
    }
  };

  if (!config || !health) return null;

  const calendarStatus = gStatus?.services?.calendar;
  const gmailStatus = gStatus?.services?.gmail;

  // While the user is actively completing the OAuth browser flow, display
  // the card as "connecting" rather than falling through to whatever the
  // health endpoint reports — the daemon can briefly look unconfigured /
  // errored during this window, and it's not a failure the user needs to see.
  const displayStatus = authorizing ? "connecting" : deriveIntegrationStatus(gStatus);

  return (
    <ConnectionCard
      name="Google"
      icon={<GoogleIcon />}
      status={displayStatus}
      error={gStatus?.error}
    >
      {/* Service statuses */}
      {gStatus?.configured && (
        <div className="flex gap-4 mb-3">
          <div className="flex items-center gap-1.5 text-xs">
            <span className={cn(
              "inline-block h-2 w-2 rounded-full",
              calendarStatus?.connected ? "bg-success" : "bg-gray-300 dark:bg-gray-600",
            )} />
            <span className="text-muted-foreground">Calendar</span>
            <span className={calendarStatus?.connected ? "text-success" : "text-muted-foreground"}>
              {calendarStatus?.connected ? "Active" : "Inactive"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className={cn(
              "inline-block h-2 w-2 rounded-full",
              gmailStatus?.connected ? "bg-success" : "bg-gray-300 dark:bg-gray-600",
            )} />
            <span className="text-muted-foreground">Gmail</span>
            <span className={gmailStatus?.connected ? "text-success" : "text-muted-foreground"}>
              {gmailStatus?.connected ? "Active" : "Not yet implemented"}
            </span>
          </div>
        </div>
      )}

      {/* OAuth Setup Flow */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">1. Upload credentials</p>
          <FileUploadButton
            label="Credentials JSON"
            accept=".json,application/json"
            onUpload={handleUploadCredentials}
            configured={credDone}
          />
        </div>

        {!isServiceAccount && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">2. Authorize</p>
            <Button
              size="sm"
              variant={tokenDone ? "outline" : "default"}
              onClick={handleAuthorize}
              disabled={!credDone || authorizing}
              className="text-xs"
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              {authorizing ? "Waiting..." : tokenDone ? "Re-authorize" : "Authorize with Google"}
            </Button>
            {tokenDone && <CheckCircle2 className="inline-block ml-2 h-4 w-4 text-success" />}
            {authError && (
              <Alert variant="error" className="mt-1">{authError}</Alert>
            )}
            {!credDone && (
              <p className="text-xs text-muted-foreground mt-1">Upload credentials first</p>
            )}
          </div>
        )}
      </div>

      {!gStatus?.connected && credDone && (isServiceAccount || tokenDone) && (
        <Alert variant="warning" className="mt-3">
          {isServiceAccount ? "Service account configured." : "Authorized."} Restart the daemon to connect.
        </Alert>
      )}

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-3">
          Advanced setup notes <ChevronDown className="h-3 w-3" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded bg-muted/50 p-2 space-y-1 text-xs">
            <p className="font-medium text-muted-foreground">Secrets are stored in the macOS Keychain.</p>
            <p className="text-muted-foreground">
              Use the upload button above for credentials JSON, then complete OAuth in the browser.
            </p>
            <p className="text-muted-foreground mt-1">
              Same credentials are used for Calendar and Gmail (scopes: calendar, gmail.modify, gmail.send).
            </p>
            <p className="text-muted-foreground">
              Calendar ID defaults to &quot;primary&quot; and can be changed below.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Calendar ID selector — which calendar within the authed account */}
      {gStatus?.configured && (
        <div className="mt-3 pt-3 border-t border-border">
          {toast && <Alert variant={toast.type} className="mb-2">{toast.message}</Alert>}
          <EditableField
            label="Calendar ID"
            value={config.googleCalendarId}
            configKey="googleCalendarId"
            description='Use "primary" for your main calendar, or paste a full calendar ID (e.g. abc123@group.calendar.google.com) for a secondary or shared calendar.'
            onSave={saveField}
          />
        </div>
      )}
    </ConnectionCard>
  );
}
