"use client";

import { useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  ConnectionCard,
  type ConnectionStatus,
} from "@/components/connections/connection-card";
import {
  useDeleteMcpServer,
  useEnableMcpServer,
  usePatchMcpServer,
  useProbeMcpServer,
  type McpServer,
} from "@/lib/hooks/use-mcp";
import { McpSecretRow } from "./mcp-secret-row";
import { McpActivityPanel } from "./mcp-activity-panel";
import {
  deriveToolState,
  toggleToolAllowlist,
} from "./mcp-tool-allowlist";

/** Map MCP state → the existing ConnectionCard status palette. */
function deriveMcpStatus(server: McpServer): ConnectionStatus {
  if (!server.enabled) return "disabled";
  if (server.lastProbeStatus && !server.lastProbeStatus.ok) return "error";
  if (server.lastProbeStatus?.ok) return "connected";
  return "configured";
}

function humanTransport(t: McpServer["transport"]): string {
  if (t === "stdio") return "Local (stdio)";
  if (t === "http") return "HTTP (remote)";
  return "SSE (remote, legacy)";
}

function formatAgo(ts: number | null): string {
  if (!ts) return "never";
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export interface McpServerCardProps {
  server: McpServer;
  onEdit: (server: McpServer) => void;
}

export function McpServerCard({ server, onEdit }: McpServerCardProps) {
  const enableMutation = useEnableMcpServer();
  const probeMutation = useProbeMcpServer();
  const deleteMutation = useDeleteMcpServer();
  const patchMutation = usePatchMcpServer();

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probeTools = server.lastProbeStatus?.ok
    ? server.lastProbeStatus.tools.map((t) => t.name)
    : [];

  const handleToggleTool = async (toolName: string) => {
    setError(null);
    try {
      const next = toggleToolAllowlist(
        server.toolAllowlist,
        toolName,
        probeTools,
      );
      await patchMutation.mutateAsync({
        id: server.id,
        patch: { toolAllowlist: next },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update allowlist");
    }
  };

  const secretKeys = [...server.envKeys, ...server.headerKeys];
  const missingSecrets = secretKeys.filter(
    (k) => server.secretsPresent[k] !== true,
  );

  const handleToggleEnable = async () => {
    setError(null);
    try {
      await enableMutation.mutateAsync({ id: server.id, enabled: !server.enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle");
    }
  };

  const handleProbe = async () => {
    setError(null);
    try {
      await probeMutation.mutateAsync(server.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Probe failed");
    }
  };

  const handleDelete = async () => {
    setError(null);
    try {
      await deleteMutation.mutateAsync(server.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleteConfirm(false);
    }
  };

  return (
    <ConnectionCard
      name={server.name}
      icon={<Activity className="h-4 w-4" />}
      status={deriveMcpStatus(server)}
      metadata={[
        { label: "ID", value: server.id },
        { label: "Transport", value: humanTransport(server.transport) },
        { label: "Backends", value: server.backends.join(", ") },
        { label: "Last probe", value: formatAgo(server.lastProbeAt) },
      ]}
    >
      {/* Per-tool enable toggles from the probe snapshot.
          A `null` toolAllowlist means every tool is implicitly allowed; an
          explicit list narrows that set. Toggling a tool here writes through
          PATCH /api/mcp/servers/:id with the new array (or null when the
          user re-checks everything). */}
      {server.lastProbeStatus?.ok && server.lastProbeStatus.tools.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2">
            {server.lastProbeStatus.tools.length} tools{" "}
            {server.toolAllowlist !== null && (
              <span className="text-warning">
                ({server.toolAllowlist.length} allowed)
              </span>
            )}
            <ChevronDown className="h-3 w-3" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-1 rounded bg-muted/50 p-2 text-xs">
              {server.lastProbeStatus.tools.map((t) => {
                const allowed =
                  deriveToolState(server.toolAllowlist, t.name) === "allowed";
                return (
                  <li key={t.name} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={allowed}
                      disabled={patchMutation.isPending}
                      onChange={() => void handleToggleTool(t.name)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-foreground"
                      aria-label={`${allowed ? "Disable" : "Enable"} tool ${t.name}`}
                    />
                    <div className="flex min-w-0 flex-col">
                      <code
                        className={
                          allowed
                            ? "text-foreground"
                            : "text-muted-foreground line-through"
                        }
                      >
                        {t.name}
                      </code>
                      {t.description && (
                        <span className="text-muted-foreground">{t.description}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {server.lastProbeStatus && !server.lastProbeStatus.ok && (
        <Alert variant="error" className="mt-2 text-xs">
          <XCircle className="h-3.5 w-3.5 mr-1 inline" />
          {server.lastProbeStatus.error ?? "Probe failed"}
        </Alert>
      )}

      {/* Per-server recent activity view. */}
      <McpActivityPanel serverId={server.id} />

      {/* Secret slots */}
      {secretKeys.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Secrets</p>
          {secretKeys.map((keyName) => (
            <McpSecretRow
              key={keyName}
              serverId={server.id}
              keyName={keyName}
              present={server.secretsPresent[keyName] ?? false}
            />
          ))}
          {missingSecrets.length > 0 && server.enabled && (
            <Alert variant="warning" className="text-xs">
              Server is enabled but missing values for:{" "}
              <code>{missingSecrets.join(", ")}</code>
            </Alert>
          )}
        </div>
      )}

      {/* Action row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={handleProbe}
          disabled={probeMutation.isPending}
        >
          {probeMutation.isPending ? (
            "Probing…"
          ) : (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Probe
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={handleToggleEnable}
          disabled={enableMutation.isPending}
        >
          {server.enabled ? (
            <>
              <PowerOff className="h-3.5 w-3.5 mr-1" /> Disable
            </>
          ) : (
            <>
              <Power className="h-3.5 w-3.5 mr-1" /> Enable
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onEdit(server)}
        >
          <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
        </Button>
        <div className="ml-auto">
          {deleteConfirm ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setDeleteConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                Confirm delete
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setDeleteConfirm(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="gray">risk: {server.riskTier}</Badge>
        {server.toolAllowlist && (
          <Badge variant="gray">
            allowlist: {server.toolAllowlist.length} tools
          </Badge>
        )}
      </div>

      {error && (
        <Alert variant="error" className="mt-2 text-xs">
          {error}
        </Alert>
      )}
    </ConnectionCard>
  );
}
