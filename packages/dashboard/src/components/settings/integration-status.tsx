"use client";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useHealth } from "@/lib/hooks/use-health";
import { useConfig } from "@/lib/hooks/use-config";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { saveNotionDatabaseIds } from "@/lib/notion-database-ids";
import { Input } from "@/components/ui/input";
import type {
  IntegrationStatus,
  GoogleIntegrationStatus,
  FileUploadResponse,
} from "@/lib/api-types";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown, Upload, CheckCircle2, ExternalLink, Plus, Trash2, Eye, EyeOff } from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";

// ── Status Badge ──

function StatusBadge({ status }: { status: IntegrationStatus | undefined }) {
  if (!status || !status.configured) {
    return <Badge variant="gray">Not Configured</Badge>;
  }
  if (status.connected) {
    return <Badge variant="green">Connected</Badge>;
  }
  return <Badge variant="red">Error</Badge>;
}

// ── File Upload Button ──

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
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setResult(null);
    try {
      await onUpload(file);
      setResult({ type: "success", message: `${file.name} uploaded` });
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
          {result.message}
        </Alert>
      )}
    </div>
  );
}

// ── Google Integration Card (Calendar + Gmail unified) ──

function GoogleCard({ status }: { status: GoogleIntegrationStatus | undefined }) {
  const { data: config } = useConfig();
  const queryClient = useQueryClient();
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

  // Clean up popup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Listen for postMessage from the OAuth callback window
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
        // Popup was blocked by the browser
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

  const calendarStatus = status?.services?.calendar;
  const gmailStatus = status?.services?.gmail;

  return (
    <div
      className={cn(
        "rounded-lg border p-4 sm:col-span-2",
        status?.connected
          ? "border-success/40 bg-success/5"
          : "border-border",
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">Google</h3>
        <StatusBadge status={status} />
      </div>

      {status?.error && (
        <Alert variant="error" className="mb-3">
          {status.error}
        </Alert>
      )}

      {/* Service statuses */}
      {status?.configured && (
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
        {/* Step 1 */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">1. Upload credentials</p>
          <FileUploadButton
            label="Credentials JSON"
            accept=".json,application/json"
            onUpload={handleUploadCredentials}
            configured={credDone}
          />
        </div>

        {/* Step 2 (OAuth2 only — service accounts skip this) */}
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
              <Alert variant="error" className="mt-1">
                {authError}
              </Alert>
            )}
            {!credDone && (
              <p className="text-xs text-muted-foreground mt-1">Upload credentials first</p>
            )}
          </div>
        )}
      </div>

      {!status?.connected && credDone && (isServiceAccount || tokenDone) && (
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
              Calendar ID defaults to &quot;primary&quot; and can be changed in Settings.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Generic Integration Card ──

function IntegrationCard({
  label,
  status,
  docsHint,
}: {
  label: string;
  status: IntegrationStatus | undefined;
  docsHint?: string;
}) {
  const isConfigured = status?.configured ?? false;
  const isConnected = status?.connected ?? false;

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        isConnected
          ? "border-success/40 bg-success/5"
          : "border-border",
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        <StatusBadge status={status} />
      </div>

      {status?.error && (
        <Alert variant="error" className="mb-2">
          {status.error}
        </Alert>
      )}

      {!isConfigured && docsHint && (
        <p className="text-xs text-muted-foreground">{docsHint}</p>
      )}
    </div>
  );
}

// ── Notion Integration Card ──

interface SecretUpdateResponse {
  status: string;
  configured: boolean;
  requiresRestart: boolean;
  validationErrors?: Record<string, string>;
}

function NotionCard({ status }: { status: IntegrationStatus | undefined }) {
  const { data: config } = useConfig();
  const queryClient = useQueryClient();

  // API key state
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Database mappings state
  const [newLabel, setNewLabel] = useState("");
  const [newId, setNewId] = useState("");
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isKeyConfigured = !!config?.notionConfigured;
  const databaseIds: Record<string, string> = config?.notionDatabaseIds ?? {};

  const handleSaveKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await api.put<SecretUpdateResponse>("/secrets/notion", { apiKey: key });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["health"] });
      setKeySaved(true);
      setApiKey("");
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingKey(false);
    }
  };

  const saveDatabaseIds = async (
    build: (current: Record<string, string>) => Record<string, string>,
  ) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await saveNotionDatabaseIds({ build, queryClient });
      if (res.requiresRestart?.length > 0) {
        setNotice("Restart daemon to apply changes.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    const label = newLabel.trim();
    const id = newId.trim();
    if (!label || !id) return;
    await saveDatabaseIds((current) => ({ ...current, [label]: id }));
    setNewLabel("");
    setNewId("");
  };

  const handleRemove = async (label: string) => {
    await saveDatabaseIds((current) => {
      const { [label]: _, ...rest } = current;
      return rest;
    });
  };

  const startEdit = (label: string) => {
    setEditingLabel(label);
    setEditingValue(databaseIds[label] ?? "");
  };

  const commitEdit = async () => {
    if (editingLabel === null) return;
    const trimmed = editingValue.trim();
    if (!trimmed || trimmed === databaseIds[editingLabel]) {
      setEditingLabel(null);
      return;
    }
    await saveDatabaseIds((current) => ({ ...current, [editingLabel]: trimmed }));
    setEditingLabel(null);
  };

  const cancelEdit = () => {
    setEditingLabel(null);
  };

  const entries = Object.entries(databaseIds);

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        status?.connected
          ? "border-success/40 bg-success/5"
          : "border-border",
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground">Notion</h3>
        <StatusBadge status={status} />
      </div>

      {status?.error && (
        <Alert variant="error" className="mb-2">
          {status.error}
        </Alert>
      )}

      {/* API Key */}
      <div className="space-y-1.5 mt-3">
        <p className="text-xs font-medium text-muted-foreground">API Key</p>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setKeySaved(false); }}
              placeholder={isKeyConfigured ? "ntn_... (configured)" : "ntn_..."}
              className="h-7 text-xs pr-8"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSaveKey}
            disabled={savingKey || !apiKey.trim()}
            className="h-7 text-xs px-2 shrink-0"
          >
            {savingKey ? "..." : "Save"}
          </Button>
          {(keySaved || isKeyConfigured) && (
            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
          )}
        </div>
        {keyError && <Alert variant="error">{keyError}</Alert>}
      </div>

      {/* Database ID mappings */}
      <div className="space-y-2 mt-3">
        <p className="text-xs font-medium text-muted-foreground">Database mappings</p>

        {entries.length > 0 && (
          <div className="space-y-1.5">
            {entries.map(([label, id]) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="font-medium text-foreground min-w-[60px]">{label}</span>
                {editingLabel === label ? (
                  <Input
                    type="text"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitEdit();
                      if (e.key === "Escape") cancelEdit();
                    }}
                    autoFocus
                    className="h-6 text-xs font-mono flex-1"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(label)}
                    className="text-muted-foreground font-mono truncate flex-1 text-left hover:text-foreground transition-colors"
                    title="Click to edit"
                  >
                    {id}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(label)}
                  disabled={saving}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add new database */}
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. tasks)"
            className="h-7 text-xs flex-[1]"
          />
          <Input
            type="text"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="Database ID"
            className="h-7 text-xs flex-[2] font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={saving || !newLabel.trim() || !newId.trim()}
            className="h-7 text-xs px-2 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {notice && <Alert variant="warning">{notice}</Alert>}
        {error && <Alert variant="error">{error}</Alert>}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-3">
          Setup notes <ChevronDown className="h-3 w-3" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded bg-muted/50 p-2 space-y-1 text-xs">
            <p className="text-muted-foreground">
              Create an internal integration at{" "}
              <a
                href="https://www.notion.so/my-integrations"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                notion.so/my-integrations
              </a>
              , enter the API key above, and share each target database with the
              integration. Then add the database mappings.
            </p>
            <p className="text-muted-foreground">
              The database ID is the 32-character hex string in the Notion URL
              (e.g. <code className="text-foreground">notion.so/&lt;workspace&gt;/&lt;database-id&gt;</code>).
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Integration Status Section ──

export function IntegrationStatusSection() {
  const { data: health } = useHealth();
  const integrations = health?.integrations;

  const totalServices = 3; // google, obsidian, notion
  const connectedCount = [
    integrations?.google?.connected,
    integrations?.obsidian?.connected,
    integrations?.notion?.connected,
  ].filter(Boolean).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        {integrations && (
          <span className="text-xs text-muted-foreground">
            {connectedCount}/{totalServices} connected
          </span>
        )}
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Google — spans full width since it's larger */}
        <GoogleCard status={integrations?.google} />

        {/* External Obsidian Vault */}
        <IntegrationCard
          label="External Obsidian Vault"
          status={integrations?.obsidian}
          docsHint="Configure in the External Obsidian Vault section below."
        />

        {/* Notion */}
        <NotionCard status={integrations?.notion} />
      </div>
    </Card>
  );
}
