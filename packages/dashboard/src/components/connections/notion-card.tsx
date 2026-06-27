"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { useIntegrations, usePatchIntegration } from "@/lib/hooks/use-integrations";
import { api } from "@/lib/api-client";
import { saveNotionDatabaseIds } from "@/lib/notion-database-ids";
import type {
  IntegrationFetchTargetDto,
  IntegrationPatchRequest,
  IntegrationStateDto,
} from "@/lib/api-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ChevronDown, Plus, Trash2, Eye, EyeOff, CheckCircle2, BookOpen, ExternalLink } from "lucide-react";
import { INTEGRATION_DESCRIPTORS } from "@aitne/shared";
import { ConnectionCard, deriveIntegrationStatus } from "./connection-card";

export function NotionCard() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();

  // Match the pre-split behavior: render nothing while config/health load so
  // the setup wizard does not flash an empty Notion frame on first paint.
  if (!config || !health) return null;

  const notionStatus = health.integrations?.notion;

  return (
    <ConnectionCard
      name="Notion"
      icon={<BookOpen className="h-4 w-4" />}
      status={deriveIntegrationStatus(notionStatus)}
      error={notionStatus?.error}
    >
      <NotionDirectSettingsBody />
    </ConnectionCard>
  );
}

/**
 * API key + database mappings + setup notes, without a surrounding card frame.
 * Used standalone via {@link NotionCard} (which adds a ConnectionCard wrapper for
 * the setup wizard) and as `children` of the registry-driven `IntegrationCard`
 * on the Knowledge page so the Notion mode dropdown and credential fields
 * render inside a single card instead of two stacked ones.
 */
export function NotionDirectSettingsBody() {
  const { data: config } = useConfig();
  const { data: health } = useHealth();
  const integrations = useIntegrations();
  const patchIntegration = usePatchIntegration();
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

  // Routine fetch target state
  const [newTarget, setNewTarget] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);

  if (!config || !health) return null;

  const isKeyConfigured = !!config.notionConfigured;
  const databaseIds: Record<string, string> = config.notionDatabaseIds ?? {};
  const notionIntegration = integrations.data?.integrations.find((x) => x.key === "notion");
  const fetchTargets: IntegrationFetchTargetDto[] =
    notionIntegration?.state.fetchTargets ?? [];

  const handleSaveKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await api.put("/secrets/notion", { apiKey: key });
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

  const saveFetchTargets = async (targets: IntegrationFetchTargetDto[]) => {
    if (!notionIntegration) return;
    setTargetError(null);
    try {
      await patchIntegration.mutateAsync({
        key: "notion",
        body: buildFetchTargetPatch(notionIntegration.state, targets),
      });
    } catch (e) {
      setTargetError(e instanceof Error ? e.message : "Failed to save fetch targets");
    }
  };

  const handleAddTarget = async () => {
    const value = newTarget.trim();
    if (!value || !notionIntegration) return;
    const normalized = value.toLocaleLowerCase();
    if (fetchTargets.some((target) => target.locator.toLocaleLowerCase() === normalized)) {
      setTargetError("That Notion target is already listed.");
      return;
    }
    await saveFetchTargets([
      ...fetchTargets,
      // Schema caps label at 200 chars (locator at 2000) — slice rather
      // than bounce a long URL back as an opaque validation error.
      { label: value.slice(0, 200), locator: value },
    ]);
    setNewTarget("");
  };

  const handleRemoveTarget = async (index: number) => {
    await saveFetchTargets(fetchTargets.filter((_, i) => i !== index));
  };

  const entries = Object.entries(databaseIds);

  return (
    <>
      {/* Source identity first: what the agent watches in this workspace. */}
      {isKeyConfigured && (
        <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              Notion workspace
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {entries.length} watched database{entries.length === 1 ? "" : "s"}
            {" · "}
            {fetchTargets.length} routine fetch target
            {fetchTargets.length === 1 ? "" : "s"}
          </p>
        </div>
      )}

      {/* API Key */}
      <div className="space-y-1.5 mt-3">
        <p className="text-xs font-medium text-foreground">API Key</p>
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
      <div className="space-y-2 mt-3 border-t border-border pt-3">
        <div>
          <p className="text-xs font-medium text-foreground">Watched databases</p>
          <p className="text-[11px] text-muted-foreground">
            The daemon polls these databases for changes (direct mode). Label
            them so the agent can refer to each by name.
          </p>
        </div>

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

      {/* Routine fetch target allowlist */}
      <div className="space-y-2 mt-3 border-t border-border pt-3">
        <div>
          <p className="text-xs font-medium text-foreground">
            Routine fetch targets
          </p>
          <p className="text-[11px] text-muted-foreground">
            Autonomous Notion checks are limited to these pages. Use a page URL
            or page ID when possible; titles are matched best-effort.
          </p>
        </div>

        {fetchTargets.length > 0 && (
          <div className="space-y-1.5">
            {fetchTargets.map((target, index) => (
              <div key={`${target.locator}-${index}`} className="flex items-center gap-2 text-xs">
                <span className="truncate flex-1 text-foreground" title={target.locator}>
                  {target.label}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRemoveTarget(index)}
                  disabled={patchIntegration.isPending}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={newTarget}
            onChange={(e) => setNewTarget(e.target.value)}
            placeholder="Notion page name, URL, or ID"
            maxLength={2000}
            className="h-7 text-xs flex-1"
            disabled={!notionIntegration || patchIntegration.isPending}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddTarget();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleAddTarget}
            disabled={!notionIntegration || patchIntegration.isPending || !newTarget.trim()}
            className="h-7 text-xs px-2 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {fetchTargets.length === 0 && (
          <Alert variant="warning">
            Notion routine fetches are skipped until at least one target is listed.
          </Alert>
        )}
        {fetchTargets.length > 10 && (
          <Alert variant="warning">
            Routine passes fetch at most 10 targets per window — entries beyond
            the first 10 are skipped each pass.
          </Alert>
        )}
        {targetError && <Alert variant="error">{targetError}</Alert>}
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
            {INTEGRATION_DESCRIPTORS.notion.directSetup?.helpUrl && (
              <p className="text-muted-foreground">
                See Notion&apos;s official guide:{" "}
                <a
                  href={INTEGRATION_DESCRIPTORS.notion.directSetup.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline hover:text-foreground"
                >
                  Create a Notion integration
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function buildFetchTargetPatch(
  state: IntegrationStateDto,
  fetchTargets: IntegrationFetchTargetDto[],
): IntegrationPatchRequest {
  return {
    mode: state.mode,
    ...(state.mode === "delegated" && state.delegatedBackend
      ? { delegatedBackend: state.delegatedBackend }
      : {}),
    ...(state.mode === "native" && state.nativeBackend
      ? { nativeBackend: state.nativeBackend }
      : {}),
    fetchTargets,
  };
}
