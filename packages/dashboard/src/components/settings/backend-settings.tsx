"use client";

import type {
  BackendId,
  BackendModel,
} from "@aitne/shared";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Pencil,
  Save,
  XCircle,
} from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type {
  BackendWarning,
  ProcessBackendConfigRow,
} from "@/lib/api-types";
import {
  formatModelName,
  getBackendLabel,
  getProcessGroup,
  getProcessLabel,
  isUiPreviewOnlyBackend,
  UI_PREVIEW_ONLY_BADGE_SUFFIX,
} from "@/lib/backend-ui";
import { formatCurrency } from "@/lib/utils";
import { OpencodeModelPicker } from "@/components/settings/opencode-model-picker";

type ToastType = "success" | "error" | "warning";

/**
 * This component owns only the Process Routing table; the former
 * `defaults` and `backends` sections moved into `BackendsAndPlansSection`
 * (see SETUP-UI-CONSOLIDATION-DESIGN.md), and the `sections` prop
 * narrowed to its single remaining value. The prop is retained so future
 * consumers can re-introduce other sections without a call-site rewrite
 * — today only `"processes"` is accepted.
 */
interface BackendSettingsSectionProps {
  onToast: (type: ToastType, message: string) => void;
  sections?: Array<"processes">;
  processKeys?: readonly string[];
  title?: string;
  description?: string;
}

interface ProcessDraft {
  processKey: string;
  defaultTier: "lite" | "medium" | "high";
  mainBackend: BackendId;
  mainModel: string;
  fallbackBackend: BackendId | null;
  fallbackModel: string | null;
  maxTurns: number;
  maxBudgetUsd: number;
}

function getModelsForTier(
  models: BackendModel[],
  tier: "lite" | "medium" | "high",
): BackendModel[] {
  const tierModels = models.filter((model) => model.tier === tier);
  return tierModels.length > 0 ? tierModels : models;
}

/**
 * Haiku detection by model-id substring — same predicate shape as
 * `HaikuAdvisorWarning.isAdvisorCompatibleBase()`, inverted. We match on
 * substring (not a hardcoded model id) so new Haiku releases get caught
 * without editing this file.
 */
function isHaikuModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return modelId.toLowerCase().includes("haiku");
}

/**
 * Per-process guidance shown above the row's controls. Persistent (not
 * tied to the model picker) so users can read the trade-off before
 * editing. Backend-specific because the advice references models that
 * only exist on a particular backend (Opus → Claude).
 *
 * The heavy-tier model label is resolved from the backend's registry
 * (`BackendModel.label`) instead of hardcoded — a future Opus rename
 * picks up automatically.
 */
function getProcessGuidance(
  processKey: string,
  mainBackend: BackendId | undefined,
  mainBackendModels: BackendModel[],
): string | null {
  if (processKey === "routine.morning_routine" && mainBackend === "claude") {
    const heavyModel = mainBackendModels.find(
      (model) =>
        model.tier === "high" && model.available && !model.deprecated,
    );
    if (!heavyModel) return null;
    return `Defaults to Sonnet to preserve Claude quota — ${heavyModel.label} depletes the 5h window much faster. If you want better instruction-following or more thorough day-plan output, switch Main Model to ${heavyModel.label}.`;
  }
  return null;
}

/**
 * Process keys where pinning to Haiku typically degrades output quality.
 * Warning is non-blocking — the save button still works.
 */
const HAIKU_WARNING_BY_PROCESS: Record<string, string> = {
  "message.dm": "DM response quality may degrade. Sonnet is recommended for important conversations.",
  "message.mention": "Mention response quality may degrade. Sonnet is recommended.",
  "dashboard.chat": "Dashboard chat response quality may degrade. Sonnet is recommended.",
  "routine.morning_routine": "Long-form generation may produce shorter/rougher output with Haiku. Sonnet is recommended.",
  "routine.evening_review": "Long-form generation may produce shorter/rougher output with Haiku. Sonnet is recommended.",
  "routine.weekly_review": "Weekly reviews require reasoning depth. Haiku may produce less coherent output.",
  "routine.monthly_review": "Monthly reviews require reasoning depth. Haiku may produce less coherent output.",
  "agent.task": "Sonnet is recommended for complex task execution. Haiku may make rougher tool-use decisions.",
};

/**
 * True if the draft cannot be saved as-is: empty main model, or fallback
 * backend selected without a fallback model. Mirrors the daemon's
 * `mainModel: z.string().min(1)` + `fallback_incomplete` validation so the
 * Save button reflects the same gate the API will apply, instead of
 * letting the user click into a 400.
 */
function isDraftIncomplete(draft: ProcessDraft | null): boolean {
  if (!draft) return true;
  if (!draft.mainModel.trim()) return true;
  if (draft.fallbackBackend && !draft.fallbackModel?.trim()) return true;
  return false;
}

function pickModelForTier(
  models: BackendModel[],
  tier: "lite" | "medium" | "high",
  preferredModelId?: string | null,
): string {
  const tierModels = getModelsForTier(models, tier);
  if (
    preferredModelId &&
    tierModels.some((model) => model.modelId === preferredModelId)
  ) {
    return preferredModelId;
  }
  return tierModels[0]?.modelId ?? models[0]?.modelId ?? "";
}

function modelLabel(models: BackendModel[], modelId: string | null): string {
  if (!modelId) return "Disabled";
  return (
    models.find((model) => model.modelId === modelId)?.label ??
    formatModelName(modelId)
  );
}

function formatBackendApiError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Request failed";
  }

  const body = error.body as Record<string, unknown> | null;
  const code = typeof body?.error === "string" ? body.error : null;
  const processKeys = Array.isArray(body?.processKeys)
    ? body.processKeys.filter((value): value is string => typeof value === "string")
    : [];

  switch (code) {
    case "backend_in_use":
      return `This backend is still used by: ${processKeys.join(", ")}. Reassign those processes first.`;
    case "default_backend":
      return "Reassign the default backend before disabling it.";
    case "main_backend_disabled":
      return "The selected main backend is disabled. Enable it first.";
    case "fallback_backend_disabled":
      return "The selected fallback backend is disabled. Enable it first.";
    case "fallback_same_as_main":
      return "Fallback backend must differ from the main backend.";
    case "fallback_incomplete":
      return "Fallback backend and fallback model must either both be set or both be disabled.";
    case "invalid_main_model":
      return "The selected main model does not belong to the chosen backend.";
    case "invalid_fallback_model":
      return "The selected fallback model does not belong to the chosen fallback backend.";
    case "multi_backend_unavailable":
      return "Multi-backend tables are not available yet. Run migrations first.";
    default:
      return error.message;
  }
}

export function BackendSettingsSection({
  onToast,
  sections = ["processes"],
  processKeys,
  title = "Process Routing",
  description,
}: BackendSettingsSectionProps) {
  const showProcesses = sections.includes("processes");
  const queryClient = useQueryClient();
  const {
    data: backendsData,
    error: backendsError,
    isLoading: backendsLoading,
  } = useBackends({ enabled: showProcesses });
  const {
    data: processConfigData,
    error: processError,
    isLoading: processLoading,
  } = useProcessConfig({ enabled: showProcesses });
  const [editingProcessKey, setEditingProcessKey] = useState<string | null>(null);
  const [processDraft, setProcessDraft] = useState<ProcessDraft | null>(null);
  const [savingProcess, setSavingProcess] = useState(false);

  const refreshQueries = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["backends"] }),
      queryClient.invalidateQueries({ queryKey: ["process-config"] }),
      queryClient.invalidateQueries({ queryKey: ["cost"] }),
      queryClient.invalidateQueries({ queryKey: ["metrics"] }),
    ]);
  }, [queryClient]);

  const combinedError = showProcesses ? backendsError ?? processError : null;
  if (combinedError) {
    const unavailable =
      combinedError instanceof ApiError && combinedError.status === 503;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Process Routing</CardTitle>
        </CardHeader>
        <p className="max-w-prose text-sm text-muted-foreground">
          {unavailable
            ? "Multi-backend tables are not available yet. Run migrations first."
            : combinedError instanceof Error
              ? combinedError.message
              : "Failed to load process routing."}
        </p>
      </Card>
    );
  }

  if (!showProcesses) return null;

  const loading =
    backendsLoading || !backendsData || processLoading || !processConfigData;
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Process Routing</CardTitle>
        </CardHeader>
        <p className="text-sm text-muted-foreground">
          Loading process routing…
        </p>
      </Card>
    );
  }

  const backendMap = new Map(
    backendsData.backends.map((backend) => [backend.id, backend]),
  );
  const enabledBackends = backendsData.backends.filter(
    (backend) => backend.enabled,
  );
  const visibleConfigs = processKeys
    ? processConfigData.configs.filter((config) =>
        processKeys.includes(config.processKey),
      )
    : processConfigData.configs;
  const groupedConfigs = visibleConfigs.reduce<
    Array<{ group: string; configs: ProcessBackendConfigRow[] }>
  >((groups, config) => {
    const group = getProcessGroup(config.processKey);
    const existing = groups.find((entry) => entry.group === group);
    if (existing) {
      existing.configs.push(config);
    } else {
      groups.push({ group, configs: [config] });
    }
    return groups;
  }, []);

  function beginProcessEdit(config: ProcessBackendConfigRow): void {
    setEditingProcessKey(config.processKey);
    setProcessDraft({
      processKey: config.processKey,
      defaultTier: config.defaultTier,
      mainBackend: config.mainBackend,
      mainModel: config.mainModel,
      fallbackBackend: config.fallbackBackend,
      fallbackModel: config.fallbackModel,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
    });
  }

  function updateProcessMainBackend(nextBackendId: BackendId): void {
    const backend = backendMap.get(nextBackendId);
    if (!backend || !processDraft) return;

    const fallbackNeedsReset = processDraft.fallbackBackend === nextBackendId;
    // opencode's effective catalogue is the live `client.config.providers()`
    // response — the static registry only seeds the Anthropic preset. Auto-
    // picking from that registry would silently bind to a provider the
    // typical operator hasn't authed (Anthropic), producing a runtime
    // "Model not found" later. Clear instead so the live picker forces an
    // explicit choice. Other backends keep the existing tier-based pick.
    const nextMainModel = nextBackendId === "opencode"
      ? (backend.models.some((m) => m.modelId === processDraft.mainModel)
          ? processDraft.mainModel
          : "")
      : pickModelForTier(backend.models, processDraft.defaultTier, processDraft.mainModel);
    setProcessDraft({
      ...processDraft,
      mainBackend: nextBackendId,
      mainModel: nextMainModel,
      fallbackBackend: fallbackNeedsReset ? null : processDraft.fallbackBackend,
      fallbackModel: fallbackNeedsReset ? null : processDraft.fallbackModel,
    });
  }

  function updateProcessFallbackBackend(nextBackendId: BackendId | null): void {
    if (!processDraft) return;
    if (!nextBackendId) {
      setProcessDraft({
        ...processDraft,
        fallbackBackend: null,
        fallbackModel: null,
      });
      return;
    }

    const backend = backendMap.get(nextBackendId);
    if (!backend) return;
    // Same opencode handling as main — clear to force an explicit pick from
    // the live catalogue rather than auto-binding a likely-unauthorized
    // Anthropic preset.
    const nextFallbackModel = nextBackendId === "opencode"
      ? (processDraft.fallbackModel
          && backend.models.some((m) => m.modelId === processDraft.fallbackModel)
            ? processDraft.fallbackModel
            : "")
      : pickModelForTier(backend.models, processDraft.defaultTier, processDraft.fallbackModel);
    setProcessDraft({
      ...processDraft,
      fallbackBackend: nextBackendId,
      fallbackModel: nextFallbackModel,
    });
  }

  async function saveProcessConfig(): Promise<void> {
    if (!processDraft) return;

    setSavingProcess(true);
    try {
      const result = await api.put<{ warnings?: BackendWarning[] }>(
        `/process-config/${processDraft.processKey}`,
        {
          mainBackend: processDraft.mainBackend,
          mainModel: processDraft.mainModel,
          fallbackBackend: processDraft.fallbackBackend,
          fallbackModel: processDraft.fallbackModel,
          maxTurns: processDraft.maxTurns,
          maxBudgetUsd: processDraft.maxBudgetUsd,
        },
      );
      await refreshQueries();
      if (result.warnings?.length) {
        onToast(
          "warning",
          `Saved — ${result.warnings.map((w) => w.message).join("; ")}`,
        );
      } else {
        onToast(
          "success",
          `${getProcessLabel(processDraft.processKey)} updated`,
        );
      }
      setEditingProcessKey(null);
      setProcessDraft(null);
    } catch (error) {
      onToast("error", formatBackendApiError(error));
    } finally {
      setSavingProcess(false);
    }
  }

  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {description ?? (
              <>
                One row per process (event-handling pipeline). Each row shows
                the resolved main backend and model, an optional fallback, and
                the per-run limits. Click <em>Edit</em> to override any of
                them. Fallback kicks in only on <em>decisive</em> main-backend
                failures (quota exhausted, auth broken, model unavailable,
                timeout — not ordinary rate limiting).{" "}
                &ldquo;Default&rdquo; badges mean the value is inherited from
                the main backend&rsquo;s preset defaults above.
              </>
            )}
          </p>
        </div>
      </CardHeader>
      <div className="space-y-3">
        {groupedConfigs.map((group) => (
          <div key={group.group} className="space-y-3">
            {!processKeys && (
              <h3 className="px-1 text-xs font-semibold uppercase text-muted-foreground">
                {group.group}
              </h3>
            )}
            {group.configs.map((config) => {
          const mainBackend = backendMap.get(config.mainBackend);
          const fallbackBackend = config.fallbackBackend
            ? backendMap.get(config.fallbackBackend)
            : null;
          const isEditing =
            editingProcessKey === config.processKey && processDraft;
          const draftMainModels = isEditing
            ? backendMap.get(processDraft.mainBackend)?.models ?? []
            : [];
          const draftFallbackModels =
            isEditing && processDraft.fallbackBackend
              ? backendMap.get(processDraft.fallbackBackend)?.models ?? []
              : [];

          return (
            <div
              key={config.processKey}
              className="rounded-xl border border-border p-4"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-medium text-foreground">
                        {getProcessLabel(config.processKey)}
                      </p>
                      <Badge
                        variant={
                          config.defaultTier === "high"
                            ? "purple"
                            : config.defaultTier === "medium"
                              ? "blue"
                              : "default"
                        }
                      >
                        Default {config.defaultTier}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {config.processKey}
                    </p>
                    {(() => {
                      const guidance = getProcessGuidance(
                        config.processKey,
                        config.mainBackend,
                        mainBackend?.models ?? [],
                      );
                      return guidance ? (
                        <Alert variant="info" className="mt-2 text-xs">
                          {guidance}
                        </Alert>
                      ) : null;
                    })()}
                  </div>

                  <div className="grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
                    <div>
                      <p className="font-medium text-foreground">Main</p>
                      <p>
                        {mainBackend
                          ? getBackendLabel(mainBackend.id)
                          : config.mainBackend}
                      </p>
                      <p>
                        {mainBackend
                          ? modelLabel(mainBackend.models, config.mainModel)
                          : config.mainModel}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Fallback</p>
                      {fallbackBackend && config.fallbackModel ? (
                        <>
                          <p>{getBackendLabel(fallbackBackend.id)}</p>
                          <p>
                            {modelLabel(
                              fallbackBackend.models,
                              config.fallbackModel,
                            )}
                          </p>
                        </>
                      ) : (
                        <p>Disabled</p>
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Limits</p>
                      <p>{config.maxTurns} turns</p>
                      <p>{formatCurrency(config.maxBudgetUsd)} soft budget</p>
                    </div>
                  </div>
                </div>

                <Button
                  variant="outline"
                  onClick={() => beginProcessEdit(config)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
              </div>

              {isEditing && processDraft && (
                <div className="mt-4 grid gap-4 rounded-xl border border-border/80 bg-muted/30 p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Main backend
                    </p>
                    <Select
                      value={processDraft.mainBackend}
                      onValueChange={(value) =>
                        updateProcessMainBackend(value as BackendId)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select backend" />
                      </SelectTrigger>
                      <SelectContent>
                        {backendsData.backends.map((backend) => {
                          const previewOnly = isUiPreviewOnlyBackend(backend.id);
                          return (
                            <SelectItem
                              key={backend.id}
                              value={backend.id}
                              disabled={!backend.enabled || previewOnly}
                            >
                              {getBackendLabel(backend.id)}
                              {previewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Main model</p>
                    {processDraft.mainBackend === "opencode" ? (
                      <OpencodeModelPicker
                        value={processDraft.mainModel}
                        onChange={(value) =>
                          setProcessDraft((current) =>
                            current ? { ...current, mainModel: value } : current,
                          )
                        }
                        preferredTier={processDraft.defaultTier}
                      />
                    ) : (
                      <Select
                        value={processDraft.mainModel}
                        onValueChange={(value) =>
                          setProcessDraft((current) =>
                            current ? { ...current, mainModel: value } : current,
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectContent>
                          {draftMainModels.map((model) => (
                            <SelectItem key={model.modelId} value={model.modelId}>
                              {model.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {isHaikuModel(processDraft.mainModel) &&
                      HAIKU_WARNING_BY_PROCESS[processDraft.processKey] && (
                        <Alert variant="warning" className="mt-2 text-xs">
                          {HAIKU_WARNING_BY_PROCESS[processDraft.processKey]}
                        </Alert>
                      )}
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Fallback backend
                    </p>
                    <Select
                      value={processDraft.fallbackBackend ?? "__none__"}
                      onValueChange={(value) =>
                        updateProcessFallbackBackend(
                          value === "__none__" ? null : (value as BackendId),
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select backend" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Disabled</SelectItem>
                        {backendsData.backends.map((backend) => {
                          const previewOnly = isUiPreviewOnlyBackend(backend.id);
                          return (
                            <SelectItem
                              key={backend.id}
                              value={backend.id}
                              disabled={
                                !backend.enabled ||
                                backend.id === processDraft.mainBackend ||
                                previewOnly
                              }
                            >
                              {getBackendLabel(backend.id)}
                              {previewOnly ? UI_PREVIEW_ONLY_BADGE_SUFFIX : ""}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Fallback model
                    </p>
                    {processDraft.fallbackBackend === "opencode" ? (
                      <OpencodeModelPicker
                        value={processDraft.fallbackModel ?? ""}
                        onChange={(value) =>
                          setProcessDraft((current) =>
                            current ? { ...current, fallbackModel: value } : current,
                          )
                        }
                        preferredTier={processDraft.defaultTier}
                        placeholder="Select fallback model"
                      />
                    ) : (
                      <Select
                        disabled={!processDraft.fallbackBackend}
                        value={processDraft.fallbackModel ?? "__none__"}
                        onValueChange={(value) =>
                          setProcessDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  fallbackModel: value === "__none__" ? null : value,
                                }
                              : current,
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Disabled</SelectItem>
                          {draftFallbackModels.map((model) => (
                            <SelectItem key={model.modelId} value={model.modelId}>
                              {model.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Max turns</p>
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      value={processDraft.maxTurns}
                      onChange={(event) =>
                        setProcessDraft((current) =>
                          current
                            ? {
                                ...current,
                                maxTurns: Number(event.target.value) || 1,
                              }
                            : current,
                        )
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Hard cap on agent turns per run for this process. One
                      turn = one model response (possibly with tool calls).
                      When reached, the run stops mid-task — raise this if you
                      see <code>max_turns_reached</code> in the audit log.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Soft budget (USD)
                    </p>
                    <Input
                      type="number"
                      min={0}
                      max={10000}
                      step="0.01"
                      value={processDraft.maxBudgetUsd}
                      onChange={(event) =>
                        setProcessDraft((current) =>
                          current
                            ? {
                                ...current,
                                maxBudgetUsd: Number(event.target.value) || 0,
                              }
                            : current,
                        )
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Per-run spend cap in USD. &ldquo;Soft&rdquo; because the
                      check happens between turns, so a single long turn can
                      overshoot slightly. Runs that exceed the cap are aborted.
                      Set to 0 to disable and rely only on the turn cap.
                    </p>
                  </div>

                  <div className="md:col-span-2 flex items-center justify-between gap-3">
                    <p className="max-w-xl text-xs text-muted-foreground">
                      <strong>Fallback backend/model</strong> is consulted only
                      on decisive failures: quota exhaustion, auth breakage,
                      model refusal, timeout, or unrecoverable provider errors.
                      Transient 5xx and ordinary rate limits are retried on the
                      main backend first.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setEditingProcessKey(null);
                          setProcessDraft(null);
                        }}
                      >
                        <XCircle className="h-4 w-4" />
                        Cancel
                      </Button>
                      <Button
                        onClick={saveProcessConfig}
                        disabled={savingProcess || isDraftIncomplete(processDraft)}
                        title={
                          isDraftIncomplete(processDraft)
                            ? "Pick a main model first — opencode requires an explicit selection from the live catalogue."
                            : undefined
                        }
                      >
                        {savingProcess ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        Save Process
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
          </div>
        ))}
      </div>

      {enabledBackends.length < 2 && (
        <Alert variant="warning" className="mt-4 rounded-xl px-4 py-3 text-sm">
          Enable another backend if you want fallback routing to be available
          for any process.
        </Alert>
      )}
    </Card>
  );
}
