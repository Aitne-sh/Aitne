"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Pencil, Save, XCircle } from "lucide-react";
import type { BackendId, BackendModel } from "@aitne/shared";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, api } from "@/lib/api-client";
import { useBackends } from "@/lib/hooks/use-backends";
import { useProcessConfig } from "@/lib/hooks/use-process-config";
import {
  BACKEND_BADGE_VARIANTS,
  formatModelName,
  getBackendLabel,
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";

interface ProcessModelCardProps {
  processKey: string;
  title?: string;
  description?: string;
}

function getModelsForTier(models: BackendModel[], tier: "lite" | "medium" | "high"): BackendModel[] {
  const tierModels = models.filter((m) => m.tier === tier);
  return tierModels.length > 0 ? tierModels : models;
}

export function ProcessModelCard({
  processKey,
  title = "AI Model",
  description,
}: ProcessModelCardProps) {
  const queryClient = useQueryClient();
  const { data: backendsData } = useBackends();
  const { data: processConfigData } = useProcessConfig();

  const [editing, setEditing] = useState(false);
  const [draftBackend, setDraftBackend] = useState<BackendId | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const configOrUndef = processConfigData?.configs.find((c) => c.processKey === processKey);
  const backendMap = new Map((backendsData?.backends ?? []).map((b) => [b.id, b]));
  const enabledBackends = (backendsData?.backends ?? []).filter((b) => b.enabled);

  if (!backendsData || !processConfigData || !configOrUndef) {
    return null;
  }

  // Narrowed reference — TS tracks this as non-undefined after the guard above.
  const config = configOrUndef;

  const currentBackend = backendMap.get(config.mainBackend);
  const currentModelLabel =
    currentBackend?.models.find((m) => m.modelId === config.mainModel)?.label ??
    formatModelName(config.mainModel);

  const draftBackendData = draftBackend ? backendMap.get(draftBackend) : null;
  const availableModels = draftBackendData?.models ?? [];

  function beginEdit() {
    setDraftBackend(config.mainBackend);
    setDraftModel(config.mainModel);
    setFeedback(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraftBackend(null);
    setDraftModel(null);
  }

  function handleBackendChange(nextId: BackendId) {
    const backend = backendMap.get(nextId);
    if (!backend) return;
    setDraftBackend(nextId);
    const tierModels = getModelsForTier(backend.models, config.defaultTier);
    setDraftModel(tierModels[0]?.modelId ?? backend.models[0]?.modelId ?? "");
  }

  async function save() {
    if (!draftBackend || !draftModel) return;
    setSaving(true);
    setFeedback(null);
    try {
      await api.put(`/process-config/${processKey}`, {
        mainBackend: draftBackend,
        mainModel: draftModel,
        fallbackBackend: config.fallbackBackend,
        fallbackModel: config.fallbackModel,
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
      });
      await queryClient.invalidateQueries({ queryKey: ["process-config"] });
      setFeedback({ type: "success", message: "Saved" });
      setEditing(false);
    } catch (err) {
      const body =
        err instanceof ApiError ? (err.body as Record<string, unknown> | null) : null;
      const message =
        typeof body?.error === "string"
          ? body.error
          : err instanceof Error
            ? err.message
            : "Save failed";
      setFeedback({ type: "error", message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">{title}</CardTitle>
          {config.updatedBy === "user" && (
            <Badge variant="blue" className="text-xs">
              Custom
            </Badge>
          )}
        </div>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={beginEdit} className="h-8">
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </CardHeader>

      {!editing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={BACKEND_BADGE_VARIANTS[config.mainBackend]}>
              {getBackendLabel(config.mainBackend)}
            </Badge>
            <span className="text-muted-foreground">{currentModelLabel}</span>
            <Badge
              variant={
                config.defaultTier === "high"
                  ? "purple"
                  : config.defaultTier === "medium"
                    ? "blue"
                    : "default"
              }
              className="text-xs"
            >
              {config.defaultTier}
            </Badge>
          </div>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-1 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Backend</p>
              <Select
                value={draftBackend ?? ""}
                onValueChange={(v) => handleBackendChange(v as BackendId)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {enabledBackends.map((b) => {
                    const previewOnly = isUiPreviewOnlyBackend(b.id);
                    return (
                      <SelectItem
                        key={b.id}
                        value={b.id}
                        disabled={previewOnly}
                      >
                        {getBackendLabel(b.id)}
                        {previewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Model</p>
              <Select
                value={draftModel ?? ""}
                onValueChange={(v) => setDraftModel(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((m) => (
                    <SelectItem key={m.modelId} value={m.modelId}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={cancelEdit}
              disabled={saving}
            >
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => { void save(); }}
              disabled={saving || !draftModel}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
      )}

      {feedback && (
        <Alert
          variant={feedback.type === "success" ? "success" : "error"}
          className="mt-3"
        >
          {feedback.message}
        </Alert>
      )}
    </Card>
  );
}
