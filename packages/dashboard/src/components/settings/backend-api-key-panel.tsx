"use client";

import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import type { ApiKeyProvider, BackendId } from "@aitne/shared";
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
import { ApiError } from "@/lib/api-client";
import { BACKEND_PROVIDER_LABELS } from "@/lib/backend-ui";
import {
  useBackendApiKey,
  useClearBackendApiKey,
  useSaveBackendApiKey,
  type SaveBackendApiKeyInput,
} from "@/lib/hooks/use-backend-api-key";
import {
  apiKeyEnvVarNames,
  apiKeyFormatHint,
  apiKeyStatusLabel,
  draftToConfig,
  emptyBedrockDraft,
  emptyDraft,
  emptyGeminiVertexDraft,
  isClearVisible,
  isConfigSaveEnabled,
  isDirectApiKeyProvider,
  isPlausibleApiKey,
  isSaveEnabled,
  PROVIDER_DESCRIPTIONS,
  PROVIDER_LABELS,
  type BedrockAuthMode,
  type GeminiVertexAuthMode,
  type ProviderDraft,
} from "./backend-api-key-panel.logic";

export interface BackendApiKeyPanelProps {
  backendId: BackendId;
  onToast?: (
    type: "success" | "error",
    message: string,
  ) => void;
}

interface InlineFeedback {
  kind: "success" | "error";
  message: string;
}

/**
 * Per-backend provider auth panel.
 *
 * Direct API key (Anthropic / OpenAI / Google) is the long-standing path.
 * Claude additionally supports Bedrock / Vertex / Foundry; Gemini
 * additionally supports Vertex AI. A provider dropdown switches forms;
 * each provider exposes its own field set. The daemon mirrors the
 * active provider's env vars (`CLAUDE_CODE_USE_*`, `GOOGLE_GENAI_USE_VERTEXAI`,
 * AWS / GCP / Azure credentials) into `process.env` so the SDK / CLI
 * subprocess picks them up via inherited env.
 *
 * Codex Azure OpenAI is not exposed here — it requires a
 * `~/.codex/config.toml` file in addition to env vars, which the
 * env-mirroring chokepoint cannot configure. Codex stays direct-key only.
 *
 * The panel intentionally never displays a saved value — only a status
 * label ("Saved (bedrock)") and a one-shot input for new values.
 */
export function BackendApiKeyPanel({
  backendId,
  onToast,
}: BackendApiKeyPanelProps) {
  const { data, isLoading, error } = useBackendApiKey(backendId);
  const save = useSaveBackendApiKey(backendId);
  const clear = useClearBackendApiKey(backendId);

  const availableProviders: readonly ApiKeyProvider[] = useMemo(
    () => data?.availableProviders ?? defaultAvailableProviders(backendId),
    [data?.availableProviders, backendId],
  );
  const hasProviderChoice = availableProviders.length > 1;

  const [pickedProvider, setPickedProvider] = useState<ApiKeyProvider | null>(
    null,
  );
  const selectedProvider: ApiKeyProvider =
    pickedProvider ?? data?.provider ?? availableProviders[0];

  const [draft, setDraft] = useState<ProviderDraft>(() =>
    emptyDraft(selectedProvider),
  );
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);

  const source = data?.source ?? "none";
  const configured = data?.configured ?? false;
  const savedProvider = data?.provider ?? null;
  const envVarNames = data?.envVarNames ?? apiKeyEnvVarNames(backendId);

  const saving = save.isPending;
  const clearing = clear.isPending;
  const showClear = isClearVisible(source);

  const handleProviderChange = (next: string) => {
    if (next === selectedProvider) return;
    if (!availableProviders.includes(next as ApiKeyProvider)) return;
    setPickedProvider(next as ApiKeyProvider);
    setDraft(emptyDraft(next as ApiKeyProvider));
    setFeedback(null);
  };

  const handleSave = async () => {
    setFeedback(null);

    let payload: SaveBackendApiKeyInput;
    if (isDirectApiKeyProvider(selectedProvider)) {
      const trimmed = "apiKey" in draft ? draft.apiKey.trim() : "";
      if (!isPlausibleApiKey(backendId, trimmed)) {
        setFeedback({ kind: "error", message: apiKeyFormatHint(backendId) });
        return;
      }
      payload = { apiKey: trimmed };
    } else {
      const config = draftToConfig(draft);
      if (!config) {
        setFeedback({
          kind: "error",
          message: "Fill in all required fields for this provider.",
        });
        return;
      }
      payload = { config };
    }

    try {
      const result = await save.mutateAsync(payload);
      setDraft(emptyDraft(selectedProvider));
      const detail = result.auth?.detail ?? null;
      const providerLabel = result.provider
        ? PROVIDER_LABELS[result.provider]
        : BACKEND_PROVIDER_LABELS[backendId];
      if (result.auth?.ok) {
        const message = detail
          ? `Saved (${providerLabel}) — ${detail}`
          : `Saved (${providerLabel}).`;
        setFeedback({ kind: "success", message });
        onToast?.("success", `${providerLabel} configured.`);
      } else {
        const message = detail
          ? `Saved (${providerLabel}), but the provider rejected it — ${detail}`
          : `Saved (${providerLabel}), but the provider probe did not succeed.`;
        setFeedback({ kind: "error", message });
        onToast?.("error", message);
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to save provider config";
      setFeedback({ kind: "error", message });
      onToast?.("error", message);
    }
  };

  const handleClear = async () => {
    setFeedback(null);
    try {
      const result = await clear.mutateAsync();
      const message =
        result.source === "shell"
          ? "Cleared from keychain — falling back to the shell-set env var."
          : "Cleared from keychain — backend will use CLI / OAuth auth.";
      setFeedback({ kind: "success", message });
      onToast?.(
        "success",
        `${BACKEND_PROVIDER_LABELS[backendId]} provider config cleared.`,
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to clear provider config";
      setFeedback({ kind: "error", message });
      onToast?.("error", message);
    }
  };

  const saveEnabled = isDirectApiKeyProvider(selectedProvider)
    ? isSaveEnabled({
        backendId,
        draftValue: "apiKey" in draft ? draft.apiKey : "",
        saving,
      })
    : isConfigSaveEnabled({ backendId, draft, saving });

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">
            Provider auth
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              (optional)
            </span>
          </h3>
          {configured && (
            <Badge variant={source === "keychain" ? "green" : "gray"}>
              {source === "keychain"
                ? `Saved${savedProvider ? ` (${PROVIDER_LABELS[savedProvider]})` : ""}`
                : "From shell"}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {isLoading
            ? "Loading…"
            : error
              ? "Could not read provider config from the daemon."
              : apiKeyStatusLabel(source)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Stored in the OS keychain. Leave blank to skip — the daemon falls back
          to local CLI / OAuth auth or your shell-set env vars.
        </p>
      </div>

      {hasProviderChoice && (
        <div className="space-y-1">
          <label
            htmlFor={`${backendId}-provider`}
            className="text-xs font-medium text-foreground"
          >
            Provider
          </label>
          <Select
            value={selectedProvider}
            onValueChange={handleProviderChange}
          >
            <SelectTrigger id={`${backendId}-provider`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {PROVIDER_DESCRIPTIONS[selectedProvider]}
          </p>
        </div>
      )}

      <ProviderForm
        backendId={backendId}
        draft={draft}
        onChange={setDraft}
        disabled={saving || clearing}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            void handleSave();
          }}
          disabled={!saveEnabled}
          className="gap-2"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {configured && source === "keychain"
            ? "Update provider"
            : "Save provider"}
        </Button>
        {showClear && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void handleClear();
            }}
            disabled={saving || clearing}
            className="gap-2"
          >
            {clearing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Clear
          </Button>
        )}
        {!hasProviderChoice && (
          <span className="text-[11px] text-muted-foreground">
            Sets <code className="rounded bg-muted px-1">{envVarNames.join(" / ")}</code>
          </span>
        )}
      </div>

      {feedback && (
        <div
          role="status"
          className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
            feedback.kind === "success"
              ? "border-success/30 bg-success/5 text-success"
              : "border-destructive/30 bg-destructive/5 text-destructive"
          }`}
        >
          {feedback.kind === "success" ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Per-provider form fragment. Switches the visible inputs based on the
 * draft's `provider` discriminator. Inline because the field set is
 * tightly coupled to the provider type.
 */
function ProviderForm({
  backendId,
  draft,
  onChange,
  disabled,
}: {
  backendId: BackendId;
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  disabled: boolean;
}) {
  switch (draft.provider) {
    case "anthropic":
    case "openai":
    case "google":
      return (
        <div className="space-y-1">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={apiKeyFormatHint(backendId)}
            value={draft.apiKey}
            onChange={(e) =>
              onChange({ ...draft, apiKey: e.target.value })
            }
            disabled={disabled}
            aria-label={`${PROVIDER_LABELS[draft.provider]} API key`}
          />
          <p className="text-[11px] text-muted-foreground">
            {apiKeyFormatHint(backendId)}
          </p>
        </div>
      );

    case "bedrock":
      return (
        <BedrockForm draft={draft} onChange={onChange} disabled={disabled} />
      );

    case "opencode-server":
      return (
        <div className="space-y-2">
          <LabeledField label="Server URL">
            <Input
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:4096"
              value={draft.baseUrl}
              onChange={(e) =>
                onChange({ ...draft, baseUrl: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledField label="Username">
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="opencode"
                value={draft.username}
                onChange={(e) =>
                  onChange({ ...draft, username: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
            <LabeledField label="Password (optional)">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.password}
                onChange={(e) =>
                  onChange({ ...draft, password: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
          </div>
        </div>
      );

    case "vertex":
      return (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledField label="GCP project id">
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="my-gcp-project"
                value={draft.projectId}
                onChange={(e) =>
                  onChange({ ...draft, projectId: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
            <LabeledField
              label="Vertex region"
              hint="`global`, a multi-region (`us`, `eu`), or a region (e.g. `us-east5`)."
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="us-east5"
                value={draft.region}
                onChange={(e) =>
                  onChange({ ...draft, region: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
          </div>
          <LabeledField
            label="Service account key file path (optional)"
            hint="Absolute path to a service-account JSON file. Leave blank to use Application Default Credentials (`gcloud auth application-default login`)."
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              placeholder="/Users/me/keys/sa.json"
              value={draft.credentialsFile}
              onChange={(e) =>
                onChange({ ...draft, credentialsFile: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
          <LabeledField
            label="Vertex base URL (optional)"
            hint="Override for custom endpoints / gateways."
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              placeholder="https://aiplatform.googleapis.com"
              value={draft.vertexBaseUrl}
              onChange={(e) =>
                onChange({ ...draft, vertexBaseUrl: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
          <PinnedModelsFields
            draft={draft}
            onChange={onChange}
            disabled={disabled}
          />
        </div>
      );

    case "foundry":
      return (
        <div className="space-y-2">
          <div className="space-y-1">
            <span className="text-xs font-medium text-foreground">Endpoint</span>
            <div className="flex gap-2">
              <Select
                value={draft.endpointKind}
                onValueChange={(v) =>
                  onChange({
                    ...draft,
                    endpointKind: v as "resource" | "base_url",
                  })
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="resource">Resource name</SelectItem>
                  <SelectItem value="base_url">Full base URL</SelectItem>
                </SelectContent>
              </Select>
              {draft.endpointKind === "resource" ? (
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="my-foundry-resource"
                  value={draft.resource}
                  onChange={(e) =>
                    onChange({ ...draft, resource: e.target.value })
                  }
                  disabled={disabled}
                />
              ) : (
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://my-foundry-resource.services.ai.azure.com/anthropic"
                  value={draft.baseUrl}
                  onChange={(e) =>
                    onChange({ ...draft, baseUrl: e.target.value })
                  }
                  disabled={disabled}
                />
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Resource name is the simpler form; base URL is for custom
              gateways. Set exactly one.
            </p>
          </div>
          <LabeledField
            label="Foundry API key (optional)"
            hint="Leave blank to use Azure DefaultAzureCredential (`az login`, managed identity, etc.)."
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.apiKey}
              onChange={(e) =>
                onChange({ ...draft, apiKey: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
          <PinnedModelsFields
            draft={draft}
            onChange={onChange}
            disabled={disabled}
          />
        </div>
      );

    case "azure-openai":
      return (
        <div className="space-y-2">
          <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning">
            <strong>Deployment-name alignment required.</strong> The daemon
            spawns codex with <code>--model &lt;id&gt;</code> from the
            process-routing registry, which Codex treats as the Azure
            deployment name. Name your Azure deployments to match the
            model IDs configured on the <code>/settings/models</code>{" "}
            page (e.g. <code>gpt-5-codex</code>). Renaming the deployment
            in Azure is the supported fix.
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <LabeledField
              label="Azure resource name"
              hint="The Foundry/Azure-OpenAI resource name (subdomain of `*.openai.azure.com`)."
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="my-azure-resource"
                value={draft.resource}
                onChange={(e) =>
                  onChange({ ...draft, resource: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
            <LabeledField label="Azure OpenAI API key">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft.apiKey}
                onChange={(e) =>
                  onChange({ ...draft, apiKey: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
            <LabeledField
              label="API version"
              hint="Azure OpenAI API version (Codex uses the `responses` wire API)."
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                value={draft.apiVersion}
                onChange={(e) =>
                  onChange({ ...draft, apiVersion: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
            <LabeledField
              label="Default deployment name (optional)"
              hint="Falls back when the daemon does not pass --model. Most invocations override this via --model from the routing registry — see warning above."
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                placeholder="gpt-5-codex"
                value={draft.deploymentName}
                onChange={(e) =>
                  onChange({ ...draft, deploymentName: e.target.value })
                }
                disabled={disabled}
              />
            </LabeledField>
          </div>
        </div>
      );

    case "gemini-vertex":
      return (
        <GeminiVertexForm
          draft={draft}
          onChange={onChange}
          disabled={disabled}
        />
      );
  }
}

function BedrockForm({
  draft,
  onChange,
  disabled,
}: {
  draft: Extract<ProviderDraft, { provider: "bedrock" }>;
  onChange: (draft: ProviderDraft) => void;
  disabled: boolean;
}) {
  const setMode = (mode: string) => {
    if (mode === draft.authMode) return;
    onChange(emptyBedrockDraft(mode as BedrockAuthMode));
  };
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <span className="text-xs font-medium text-foreground">
          AWS authentication
        </span>
        <Select value={draft.authMode} onValueChange={setMode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="access_key">
              Access key id + secret
            </SelectItem>
            <SelectItem value="bearer_token">
              Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`)
            </SelectItem>
            <SelectItem value="profile">
              AWS profile (`~/.aws/config`)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {draft.authMode === "access_key" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <LabeledField
            label="AWS access key id"
            hint="`AKIA…` for IAM users; `ASIA…` for STS / Identity Center."
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              placeholder="AKIAIOSFODNN7EXAMPLE"
              value={draft.awsAccessKeyId}
              onChange={(e) =>
                onChange({ ...draft, awsAccessKeyId: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
          <LabeledField label="AWS secret access key">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.awsSecretAccessKey}
              onChange={(e) =>
                onChange({ ...draft, awsSecretAccessKey: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
          <LabeledField
            label="AWS session token (optional)"
            hint="Required for STS / Identity Center temporary credentials."
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.awsSessionToken}
              onChange={(e) =>
                onChange({ ...draft, awsSessionToken: e.target.value })
              }
              disabled={disabled}
            />
          </LabeledField>
        </div>
      )}

      {draft.authMode === "bearer_token" && (
        <LabeledField
          label="Bedrock API key"
          hint="See AWS docs: 'Bedrock API keys' for how to issue one."
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.awsBearerTokenBedrock}
            onChange={(e) =>
              onChange({
                ...draft,
                awsBearerTokenBedrock: e.target.value,
              })
            }
            disabled={disabled}
          />
        </LabeledField>
      )}

      {draft.authMode === "profile" && (
        <LabeledField
          label="AWS profile name"
          hint="Resolves credentials from `~/.aws/config` and `~/.aws/credentials`."
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="default"
            value={draft.awsProfile}
            onChange={(e) =>
              onChange({ ...draft, awsProfile: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledField
          label="AWS region"
          hint="Required by Claude Code regardless of auth mode."
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="us-east-1"
            value={draft.awsRegion}
            onChange={(e) =>
              onChange({ ...draft, awsRegion: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
        <LabeledField
          label="Bedrock base URL (optional)"
          hint="Override for VPC endpoints / gateways."
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="https://bedrock-runtime.us-east-1.amazonaws.com"
            value={draft.bedrockBaseUrl}
            onChange={(e) =>
              onChange({ ...draft, bedrockBaseUrl: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
      </div>

      <details className="rounded-md border border-border p-2 text-xs">
        <summary className="cursor-pointer font-medium text-foreground">
          Mantle endpoint (advanced)
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Mantle is an alternate Bedrock endpoint that uses the native
            Anthropic API shape. Setting this alongside the standard
            Invoke API lets Claude Code route per model. Most operators
            should leave this off.
          </p>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={draft.useMantle}
              onChange={(e) =>
                onChange({ ...draft, useMantle: e.target.checked })
              }
              disabled={disabled}
            />
            Enable Mantle endpoint (`CLAUDE_CODE_USE_MANTLE=1`)
          </label>
          <LabeledField
            label="Mantle base URL (optional)"
            hint="Override the default Mantle endpoint URL."
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              value={draft.mantleBaseUrl}
              onChange={(e) =>
                onChange({ ...draft, mantleBaseUrl: e.target.value })
              }
              disabled={disabled || !draft.useMantle}
            />
          </LabeledField>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={draft.skipMantleAuth}
              onChange={(e) =>
                onChange({ ...draft, skipMantleAuth: e.target.checked })
              }
              disabled={disabled || !draft.useMantle}
            />
            Skip client-side auth (gateway injects credentials)
          </label>
        </div>
      </details>

      <PinnedModelsFields
        draft={draft}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Shared pinned-model fields for all three Anthropic-cloud forms.
 * Pre-filled with the recommended defaults from the Anthropic docs;
 * editing them mirrors to `ANTHROPIC_DEFAULT_*_MODEL` env vars.
 *
 * Pinning is *strongly recommended* by Anthropic for production rollouts:
 * without it, `sonnet`/`opus`/`haiku` aliases resolve to the latest model
 * version, which may not be enabled in the customer's cloud account →
 * Claude Code falls back at startup or 404s on Foundry. Hide behind a
 * `<details>` because the defaults are usually right.
 */
type PinnedDraft = Extract<
  ProviderDraft,
  { defaultOpusModel: string }
>;

function PinnedModelsFields({
  draft,
  onChange,
  disabled,
}: {
  draft: PinnedDraft;
  onChange: (draft: ProviderDraft) => void;
  disabled: boolean;
}) {
  // Each branch of the discriminated draft union has a different
  // property set, so spreading `draft` and adding one field at a time
  // would produce a union too wide for TS to assign back to ProviderDraft.
  // The runtime spread is sound; we narrow once via a local helper.
  const updatePinned = (patch: Partial<PinnedDraft>) => {
    onChange({ ...draft, ...patch } as ProviderDraft);
  };
  return (
    <details className="rounded-md border border-border p-2 text-xs">
      <summary className="cursor-pointer font-medium text-foreground">
        Pinned model IDs (recommended)
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[11px] text-muted-foreground">
          Pinning prevents the `sonnet`/`opus`/`haiku` aliases from
          resolving to a model not yet enabled in your cloud account.
          Pre-filled with Anthropic&apos;s recommended defaults — edit only
          if your account is on a different model tier.
        </p>
        <LabeledField label="Opus model ID (`ANTHROPIC_DEFAULT_OPUS_MODEL`)">
          <Input
            autoComplete="off"
            spellCheck={false}
            value={draft.defaultOpusModel}
            onChange={(e) =>
              updatePinned({ defaultOpusModel: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
        <LabeledField label="Sonnet model ID (`ANTHROPIC_DEFAULT_SONNET_MODEL`)">
          <Input
            autoComplete="off"
            spellCheck={false}
            value={draft.defaultSonnetModel}
            onChange={(e) =>
              updatePinned({ defaultSonnetModel: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
        <LabeledField label="Haiku model ID (`ANTHROPIC_DEFAULT_HAIKU_MODEL`)">
          <Input
            autoComplete="off"
            spellCheck={false}
            value={draft.defaultHaikuModel}
            onChange={(e) =>
              updatePinned({ defaultHaikuModel: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
      </div>
    </details>
  );
}

function GeminiVertexForm({
  draft,
  onChange,
  disabled,
}: {
  draft: Extract<ProviderDraft, { provider: "gemini-vertex" }>;
  onChange: (draft: ProviderDraft) => void;
  disabled: boolean;
}) {
  const setMode = (mode: string) => {
    if (mode === draft.authMode) return;
    onChange(emptyGeminiVertexDraft(mode as GeminiVertexAuthMode));
  };
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledField label="GCP project id">
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="my-gcp-project"
            value={draft.projectId}
            onChange={(e) =>
              onChange({ ...draft, projectId: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
        <LabeledField label="GCP location" hint="e.g. `us-central1`">
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="us-central1"
            value={draft.location}
            onChange={(e) =>
              onChange({ ...draft, location: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
      </div>

      <div className="space-y-1">
        <span className="text-xs font-medium text-foreground">
          Authentication
        </span>
        <Select value={draft.authMode} onValueChange={setMode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="adc">
              Application Default Credentials (`gcloud auth`)
            </SelectItem>
            <SelectItem value="service_account">
              Service-account JSON file path
            </SelectItem>
            <SelectItem value="api_key">Vertex API key</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {draft.authMode === "service_account" && (
        <LabeledField label="Service account key file path">
          <Input
            autoComplete="off"
            spellCheck={false}
            placeholder="/Users/me/keys/sa.json"
            value={draft.credentialsFile}
            onChange={(e) =>
              onChange({ ...draft, credentialsFile: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
      )}

      {draft.authMode === "api_key" && (
        <LabeledField
          label="Vertex API key"
          hint="`AIza…`. Distinct from a direct Gemini API key — it goes to GOOGLE_API_KEY only and routes through Vertex."
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft.apiKey}
            onChange={(e) =>
              onChange({ ...draft, apiKey: e.target.value })
            }
            disabled={disabled}
          />
        </LabeledField>
      )}
    </div>
  );
}

function LabeledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function defaultAvailableProviders(
  backendId: BackendId,
): readonly ApiKeyProvider[] {
  switch (backendId) {
    case "claude":
      return ["anthropic", "bedrock", "vertex", "foundry"];
    case "codex":
      return ["openai", "azure-openai"];
    case "gemini":
      return ["google", "gemini-vertex"];
    case "opencode":
      return ["opencode-server"];
  }
}
