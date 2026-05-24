"use client";

import { useState } from "react";
import { AlertTriangle, Plus, Server, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";
import { McpServerCard } from "@/components/connections/mcp/mcp-server-card";
import { McpServerForm } from "@/components/connections/mcp/mcp-server-form";
import { McpRulesEditor } from "@/components/connections/mcp/mcp-rules-editor";
import { GeminiDelegationSetupCard } from "@/components/connections/mcp/gemini-delegation-setup-card";
import {
  useDisableAllMcpServers,
  useMcpServers,
  type McpServer,
} from "@/lib/hooks/use-mcp";

export default function McpConnectionsPage() {
  const { data, isLoading, error } = useMcpServers();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);

  const servers = data?.servers ?? [];
  const enabledCount = servers.filter((s) => s.enabled).length;

  const showForm = adding || editing !== null;
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  return (
    <>
      <ConnectionsSectionHeader
        title="MCP Servers"
        description="Register MCP (Model Context Protocol) servers once and every routine and DM session loads their tools automatically. Use this for capabilities you want available across the agent — not for a single skill."
        healthy={enabledCount}
        total={servers.length}
      />

      {enabledCount > 0 && <KillSwitchPanel enabledCount={enabledCount} />}

      {error && (
        <Alert variant="error">
          Failed to load MCP servers: {error.message}
        </Alert>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {servers.length === 0 && !showForm && (
            <div className="rounded-xl border border-dashed border-border p-6">
              <div className="flex items-start gap-3">
                <Server className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-foreground">No MCP servers yet.</p>
                  <p className="text-muted-foreground">
                    Add one to make its tools available to every backend you listed.
                    Start by probing it; once the tool list returns, enable it to
                    wire it into session workdirs.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {servers.map((server) => (
              <McpServerCard
                key={server.id}
                server={server}
                onEdit={(s) => {
                  setAdding(false);
                  setEditing(s);
                }}
              />
            ))}
          </div>

          {showForm ? (
            <McpServerForm
              key={editing ? `edit-${editing.id}` : "add"}
              editing={editing}
              onCancel={closeForm}
              onSaved={closeForm}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add MCP server
            </Button>
          )}

          {/* Gemini delegation setup — one-button install for the
              MCP servers required by the delegated Gmail / Calendar /
              Notion connectors when delegatedBackend === "gemini".
              See `packages/shared/src/integrations.ts`. */}
          <div className="pt-4">
            <GeminiDelegationSetupCard />
          </div>

          {/* rules/mcp.md editor — injected into every task-flow prompt
              while at least one MCP server is enabled. */}
          <div className="pt-4">
            <McpRulesEditor />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Global MCP kill switch.
 *
 * Two-step confirm by design: clicking the button reveals an inline warning
 * panel with an explicit "Disable all" action, matching the destructive-action
 * pattern used by the rules-editor conflict card. This avoids the native
 * `window.confirm` (which the sidebar-pattern codebase uses elsewhere) because
 * the blast radius — instantly unplugging every MCP from every future session
 * until manually re-enabled — warrants a visible summary of what's about to
 * change (server count) rather than a modal dialog the user may dismiss
 * reflexively.
 */
function KillSwitchPanel({ enabledCount }: { enabledCount: number }) {
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const disableAll = useDisableAllMcpServers();

  const handleConfirm = async () => {
    setError(null);
    try {
      const res = await disableAll.mutateAsync();
      setArming(false);
      setToast(
        res.disabled === 1
          ? "Disabled 1 MCP server."
          : `Disabled ${res.disabled} MCP servers.`,
      );
      window.setTimeout(() => setToast(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable MCP servers.");
    }
  };

  if (!arming) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ShieldOff className="h-3.5 w-3.5" />
          <span>
            {enabledCount === 1
              ? "1 MCP server enabled across all sessions."
              : `${enabledCount} MCP servers enabled across all sessions.`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {toast && <span className="text-muted-foreground">{toast}</span>}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setError(null);
              setArming(true);
            }}
          >
            Disable all…
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />
        Disable every MCP server?
      </div>
      <p className="mb-3 text-amber-900/90 dark:text-amber-100/90">
        This flips {enabledCount === 1 ? "1 server" : `${enabledCount} servers`}{" "}
        to disabled. Every future routine and DM session will run without MCP
        tools until you re-enable them individually. Existing runs finish with
        their current config.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setArming(false)}
          disabled={disableAll.isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="h-7 text-xs"
          onClick={handleConfirm}
          disabled={disableAll.isPending}
        >
          {disableAll.isPending
            ? "Disabling…"
            : `Disable ${enabledCount === 1 ? "1 server" : `all ${enabledCount} servers`}`}
        </Button>
        {error && <span className="text-destructive">{error}</span>}
      </div>
    </div>
  );
}
