"use client";

import { useState } from "react";
import { Plus, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import {
  useCreateMcpServer,
  usePatchMcpServer,
  type CreateMcpServerInput,
  type McpServer,
  type McpTransport,
} from "@/lib/hooks/use-mcp";
import { BACKEND_IDS, type BackendId } from "@aitne/shared";

const ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

// B-003 Phase 2 scope: the form only covers the fields needed to get a
// server probing and enabled. `toolAllowlist` and `riskTier` live in the
// data model + API but land in the UI in Phase 4 (observability + per-tool
// toggles). Users who need them today can PATCH via `/api/mcp/servers/:id`.

interface BaseFormState {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  envKeysText: string;
  headerKeysText: string;
  backends: BackendId[];
}

function emptyState(): BaseFormState {
  return {
    id: "",
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    envKeysText: "",
    headerKeysText: "",
    backends: ["claude"],
  };
}

function serverToState(server: McpServer): BaseFormState {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join(" "),
    url: server.url ?? "",
    envKeysText: server.envKeys.join(", "),
    headerKeysText: server.headerKeys.join(", "),
    backends: server.backends,
  };
}

function parseList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface McpServerFormProps {
  editing: McpServer | null;
  onCancel: () => void;
  onSaved: () => void;
}

export function McpServerForm({ editing, onCancel, onSaved }: McpServerFormProps) {
  const [state, setState] = useState<BaseFormState>(
    editing ? serverToState(editing) : emptyState(),
  );
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateMcpServer();
  const patchMutation = usePatchMcpServer();

  const isEdit = editing !== null;
  const isPending = createMutation.isPending || patchMutation.isPending;

  const toggleBackend = (id: BackendId) => {
    setState((prev) => {
      if (prev.backends.includes(id)) {
        const next = prev.backends.filter((b) => b !== id);
        return { ...prev, backends: next.length === 0 ? prev.backends : next };
      }
      return { ...prev, backends: [...prev.backends, id] };
    });
  };

  const handleSubmit = async () => {
    setError(null);
    const idTrim = state.id.trim();
    if (!isEdit && !ID_REGEX.test(idTrim)) {
      setError(
        "ID must be lowercase alphanumeric + dash, starting with a letter or digit.",
      );
      return;
    }
    if (!state.name.trim()) {
      setError("Name is required.");
      return;
    }
    if (state.transport === "stdio" && !state.command.trim()) {
      setError("stdio transport requires a command.");
      return;
    }
    if (state.transport !== "stdio" && !state.url.trim()) {
      setError(`${state.transport} transport requires a URL.`);
      return;
    }
    if (state.backends.length === 0) {
      setError("Pick at least one backend.");
      return;
    }

    const envKeys = parseList(state.envKeysText);
    const headerKeys = parseList(state.headerKeysText);
    const args =
      state.transport === "stdio" && state.argsText.trim().length > 0
        ? parseList(state.argsText)
        : null;

    try {
      if (isEdit && editing) {
        await patchMutation.mutateAsync({
          id: editing.id,
          patch: {
            name: state.name.trim(),
            transport: state.transport,
            command:
              state.transport === "stdio" ? state.command.trim() : null,
            args,
            url: state.transport === "stdio" ? null : state.url.trim(),
            envKeys: state.transport === "stdio" ? envKeys : [],
            headerKeys: state.transport === "stdio" ? [] : headerKeys,
            backends: state.backends,
          },
        });
      } else {
        const input: CreateMcpServerInput = {
          id: idTrim,
          name: state.name.trim(),
          transport: state.transport,
          command: state.transport === "stdio" ? state.command.trim() : null,
          args,
          url: state.transport === "stdio" ? null : state.url.trim(),
          envKeys: state.transport === "stdio" ? envKeys : [],
          headerKeys: state.transport === "stdio" ? [] : headerKeys,
          backends: state.backends,
        };
        await createMutation.mutateAsync(input);
      }
      onSaved();
      if (!isEdit) setState(emptyState());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {isEdit ? `Edit ${editing?.name}` : "Add MCP server"}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground">ID</label>
          <Input
            className="h-7 text-xs font-mono"
            value={state.id}
            disabled={isEdit}
            onChange={(e) => setState({ ...state, id: e.target.value.toLowerCase() })}
            placeholder="monday"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input
            className="h-7 text-xs"
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value })}
            placeholder="Monday"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Transport</label>
        <div className="flex gap-2 mt-1">
          {(["stdio", "http", "sse"] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={state.transport === t ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => setState({ ...state, transport: t })}
            >
              {t}
            </Button>
          ))}
        </div>
      </div>

      {state.transport === "stdio" ? (
        <>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Command</label>
            <Input
              className="h-7 text-xs font-mono"
              value={state.command}
              onChange={(e) => setState({ ...state, command: e.target.value })}
              placeholder="npx"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Args (space-separated)
            </label>
            <Input
              className="h-7 text-xs font-mono"
              value={state.argsText}
              onChange={(e) => setState({ ...state, argsText: e.target.value })}
              placeholder="-y ha-mcp-server"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Env keys (comma-separated; values managed below after save)
            </label>
            <Input
              className="h-7 text-xs font-mono"
              value={state.envKeysText}
              onChange={(e) => setState({ ...state, envKeysText: e.target.value })}
              placeholder="HA_URL, HA_TOKEN"
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="text-xs font-medium text-muted-foreground">URL</label>
            <Input
              className="h-7 text-xs font-mono"
              value={state.url}
              onChange={(e) => setState({ ...state, url: e.target.value })}
              placeholder="https://mcp.monday.com/mcp"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Header keys (comma-separated; values managed below after save)
            </label>
            <Input
              className="h-7 text-xs font-mono"
              value={state.headerKeysText}
              onChange={(e) =>
                setState({ ...state, headerKeysText: e.target.value })
              }
              placeholder="Authorization"
            />
          </div>
        </>
      )}

      <div>
        <label className="text-xs font-medium text-muted-foreground">Backends</label>
        <div className="flex gap-2 mt-1">
          {BACKEND_IDS.map((id) => (
            <Button
              key={id}
              size="sm"
              variant={state.backends.includes(id) ? "default" : "outline"}
              className="h-7 text-xs capitalize"
              onClick={() => toggleBackend(id)}
            >
              {id}
            </Button>
          ))}
        </div>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={handleSubmit}
          disabled={isPending}
        >
          {isEdit ? (
            <>
              <Save className="h-3.5 w-3.5 mr-1" /> Save
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5 mr-1" /> Create
            </>
          )}
        </Button>
      </div>
    </Card>
  );
}
