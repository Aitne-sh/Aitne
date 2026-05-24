"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArchiveRestore,
  ArrowRight,
  ChevronDown,
  Database,
  FolderOpen,
  History,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { ApiError, api } from "@/lib/api-client";
import type { WikiWorkspace, WikiWorkspacesResponse } from "@/lib/api-types";
import { BackendSettingsSection } from "@/components/settings/backend-settings";
import { CopyButton } from "@/components/copy-button";
import { SettingsToast } from "@/components/settings/settings-navigation";
import { WikiVaultPathPicker } from "@/components/settings/wiki-vault-path-picker";
import type { ProbeSummary } from "@/components/settings/vault-path-picker.logic";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { PageHeader as BasePageHeader } from "@/components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { formatCurrency } from "@/lib/utils";

const WIKI_PROCESS_KEYS = [
  "wiki.ingest_url",
  "wiki.compile",
  "wiki.ask",
  "wiki.lint",
  "wiki.trace",
  "wiki.connect",
] as const;

const WIKI_LANGUAGE_OPTIONS: Array<{ tag: string; label: string }> = [
  { tag: "en", label: "English" },
  { tag: "ja", label: "Japanese" },
  { tag: "zh", label: "Chinese" },
  { tag: "es", label: "Español (Spanish)" },
  { tag: "fr", label: "Français (French)" },
  { tag: "de", label: "Deutsch (German)" },
  { tag: "pt", label: "Português (Portuguese)" },
  { tag: "ko", label: "한국어 (Korean)" },
  { tag: "__custom__", label: "Other (BCP-47 tag…)" },
];

const WIKI_LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

interface WikiDraft {
  language: string;
  dispatchMode: "parallel" | "serial";
  concurrencyCap: number;
  dmAgentWriteEnabled: boolean;
  bridgeEnabled: boolean;
  bridgeMeasurementOnly: boolean;
  bridgeMinConfidence: number;
  fullCompileApprovalThresholdUsd: number;
  writeStrategy: "fs" | "cli" | "auto";
  gitPreCompileEnabled: boolean;
}

interface EstimateResponse {
  workspace: string;
  estimate: {
    rawCount: number;
    estimatedInputTokens: number;
    unitCostUsdPerKToken: number;
    optimisticUsd: number;
    expectedUsd: number;
    pessimisticUsd: number;
    thresholdUsd: number;
    exceedsThreshold: boolean;
    method?: "flat-heuristic" | "per-file-chars";
    perFile?: Array<{ path: string; charCount: number; estimatedTokens: number }>;
  };
}

function toDraft(workspace: WikiWorkspace): WikiDraft {
  return {
    language: workspace.language,
    dispatchMode: workspace.dispatchMode,
    concurrencyCap: workspace.concurrencyCap,
    dmAgentWriteEnabled: workspace.dmAgentWriteEnabled,
    bridgeEnabled: workspace.bridgeEnabled,
    bridgeMeasurementOnly: workspace.bridgeMeasurementOnly,
    bridgeMinConfidence: workspace.bridgeMinConfidence,
    fullCompileApprovalThresholdUsd: workspace.fullCompileApprovalThresholdUsd,
    writeStrategy: workspace.writeStrategy,
    gitPreCompileEnabled: workspace.gitPreCompileEnabled,
  };
}

function draftsEqual(a: WikiDraft, b: WikiDraft): boolean {
  return (
    a.language === b.language
    && a.dispatchMode === b.dispatchMode
    && a.concurrencyCap === b.concurrencyCap
    && a.dmAgentWriteEnabled === b.dmAgentWriteEnabled
    && a.bridgeEnabled === b.bridgeEnabled
    && a.bridgeMeasurementOnly === b.bridgeMeasurementOnly
    && a.bridgeMinConfidence === b.bridgeMinConfidence
    && a.fullCompileApprovalThresholdUsd === b.fullCompileApprovalThresholdUsd
    && a.writeStrategy === b.writeStrategy
    && a.gitPreCompileEnabled === b.gitPreCompileEnabled
  );
}

function formatApiError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Request failed";
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function WikiLanguageField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const isKnown = WIKI_LANGUAGE_OPTIONS.some(
    (opt) => opt.tag === value && opt.tag !== "__custom__",
  );
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  const mode = modeOverride ?? (isKnown ? value : "__custom__");
  const customInvalid =
    mode === "__custom__"
    && value.trim().length > 0
    && !WIKI_LANGUAGE_TAG_RE.test(value.trim());

  const handleModeChange = (next: string) => {
    if (next === "__custom__") {
      setModeOverride("__custom__");
      return;
    }
    setModeOverride(null);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <Select value={mode} onValueChange={handleModeChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WIKI_LANGUAGE_OPTIONS.map((lang) => (
            <SelectItem key={lang.tag} value={lang.tag}>
              {lang.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === "__custom__" && (
        <div className="space-y-1">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="e.g. zh-Hans or pt-BR"
          />
          {customInvalid && (
            <p className="text-xs text-red-500">
              Use a BCP-47 tag like <code>en-US</code> or <code>zh-Hans</code>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PageHeader() {
  return (
    <BasePageHeader
      title="Wiki"
      description={
        <>
          Long-form personal knowledge base. <code>!ingest</code> captures
          sources, <code>!compile</code> turns them into wiki pages, and{" "}
          <code>!ask</code> / <code>!trace</code> / <code>!connect</code> produce
          answers and timelines.
        </>
      }
    />
  );
}

export default function WikiSettingsPage() {
  const queryClient = useQueryClient();
  const { toast, showToast } = useSaveConfig();
  const { data, isLoading, error } = useQuery({
    queryKey: ["wiki-workspaces"],
    queryFn: () => api.get<WikiWorkspacesResponse>("/wiki/workspaces"),
  });
  const activeWorkspace = data?.workspaces.find((item) => item.active) ?? null;
  const archivedWorkspace = !activeWorkspace
    ? (data?.workspaces.find((item) => !item.active) ?? null)
    : null;
  const workspace = activeWorkspace ?? archivedWorkspace;

  const [draft, setDraft] = useState<WikiDraft | null>(null);
  const [externalPath, setExternalPath] = useState("");
  const [externalProbeSummary, setExternalProbeSummary] = useState<
    ProbeSummary | null
  >(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (workspace) setDraft(toDraft(workspace));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const baseline = useMemo(() => (workspace ? toDraft(workspace) : null), [workspace]);
  const isDirty = !!(draft && baseline && !draftsEqual(draft, baseline));

  const estimate = useQuery({
    queryKey: ["wiki-estimate", activeWorkspace?.name],
    enabled: !!activeWorkspace,
    queryFn: () =>
      api.get<EstimateResponse>(`/wiki/${activeWorkspace!.name}/estimate`, {
        headers: { "x-process-key": "wiki.compile" },
      }),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!workspace || !draft) return null;
      return api.patch<{ workspace: WikiWorkspace }>(
        `/wiki/workspaces/${workspace.name}`,
        draft,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["wiki-workspaces"] });
      showToast("success", "Wiki settings saved");
    },
    onError: (err) => showToast("error", formatApiError(err)),
  });

  const enableInternalMutation = useMutation({
    mutationFn: () =>
      api.post<{ workspace: WikiWorkspace }>("/wiki/workspaces", {
        kind: "internal",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["wiki-workspaces"] });
      showToast("success", "Internal wiki enabled");
    },
    onError: (err) => showToast("error", formatApiError(err)),
  });

  const enableExternalMutation = useMutation({
    mutationFn: async () => {
      const probed = await api.post<{
        ok: boolean;
        error?: string;
        message?: string;
        validation: { resolvedPath?: string };
        probe: { kind: "empty" | "partial" | "wiki" };
      }>("/wiki/workspaces/probe", { rootPath: externalPath });
      if (!probed.ok) {
        throw new ApiError(400, {
          message: probed.message ?? "External path failed validation.",
        });
      }
      return api.post<{ workspace: WikiWorkspace }>("/wiki/workspaces", {
        kind: "external",
        rootPath: probed.validation.resolvedPath ?? externalPath,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["wiki-workspaces"] });
      showToast("success", "External wiki created");
    },
    onError: (err) => showToast("error", formatApiError(err)),
  });

  const reactivateMutation = useMutation({
    mutationFn: () => {
      if (!workspace) throw new Error("No workspace to re-activate");
      return api.patch<{ workspace: WikiWorkspace }>(
        `/wiki/workspaces/${workspace.name}`,
        { active: true },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["wiki-workspaces"] });
      showToast("success", "Wiki re-activated");
    },
    onError: (err) => showToast("error", formatApiError(err)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/wiki/workspaces/${workspace?.name}/archive`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["wiki-workspaces"] });
      showToast("success", "Wiki archived");
    },
    onError: (err) => showToast("error", formatApiError(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<{ ok: true; rootPathPreserved: string }>(
      `/wiki/workspaces/${workspace?.name}`,
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["wiki-workspaces"] });
      showToast("success", "Wiki workspace removed (files preserved on disk)");
    },
    onError: (err) => showToast("error", formatApiError(err)),
  });

  if (isLoading) {
    return (
      <>
        <PageHeader />
        <Card>
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner /> Loading wiki…
          </div>
        </Card>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader />
        <Alert variant="error">
          {error instanceof Error ? error.message : "Failed to load wiki settings."}
        </Alert>
      </>
    );
  }

  // ---- EMPTY STATE: no workspace at all -------------------------------------
  if (!workspace) {
    return (
      <>
        <PageHeader />
        <SettingsToast toast={toast} />
        <EmptyState
          defaultInternalRoot={data?.defaultInternalRoot}
          externalPath={externalPath}
          setExternalPath={setExternalPath}
          probeSummary={externalProbeSummary}
          onProbeChange={(_path, summary) => setExternalProbeSummary(summary)}
          enableInternalPending={enableInternalMutation.isPending}
          enableExternalPending={enableExternalMutation.isPending}
          onEnableInternal={() => enableInternalMutation.mutate()}
          onEnableExternal={() => enableExternalMutation.mutate()}
        />
      </>
    );
  }

  // ---- ARCHIVED STATE: workspace exists but inactive ------------------------
  if (!workspace.active) {
    return (
      <>
        <PageHeader />
        <SettingsToast toast={toast} />
        <ArchivedState
          workspace={workspace}
          reactivatePending={reactivateMutation.isPending}
          deletePending={deleteMutation.isPending}
          onReactivate={() => reactivateMutation.mutate()}
          onDelete={() => {
            if (
              window.confirm(
                "Delete this wiki workspace registration?\n\nThe folder on disk is preserved — only the daemon's record is removed.",
              )
            ) {
              deleteMutation.mutate();
            }
          }}
        />
      </>
    );
  }

  // ---- ACTIVE STATE ----------------------------------------------------------
  if (!draft) return null;

  const isExternal = workspace.kind === "external";
  const showGitToggle = isExternal && workspace.isGitRepo === true;
  const totalSevenDayCost = workspace.recentCosts.reduce(
    (sum, row) => sum + Number(row.totalCostUsd ?? 0),
    0,
  );

  return (
    <>
      <PageHeader />
      <SettingsToast toast={toast} />

      <WorkspaceOverviewCard
        workspace={workspace}
        sevenDayCost={totalSevenDayCost}
      />

      {estimate.data?.estimate && estimate.data.estimate.rawCount > 0 && (
        <EstimateBanner data={estimate.data.estimate} />
      )}

      <GeneralSettingsCard draft={draft} setDraft={setDraft} />

      <BridgeSettingsCard
        draft={draft}
        setDraft={setDraft}
        bridgeStats={workspace.bridgeStats}
      />

      <CompilationSettingsCard
        draft={draft}
        setDraft={setDraft}
        isExternal={isExternal}
        showGitToggle={showGitToggle}
      />

      <BackendSettingsSection
        onToast={showToast}
        sections={["processes"]}
        processKeys={WIKI_PROCESS_KEYS}
        title="Commands & models"
        description="Pick the backend, model, turn limit, and per-run budget for each wiki command."
      />

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <Card>
          <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
            <div>
              <CardTitle>Advanced</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                External URL fetch policy, backend-specific notes.
              </p>
            </div>
            <ChevronDown
              className={`h-5 w-5 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4">
            <ExternalFetchPolicy />
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <DangerZone
        workspaceName={workspace.name}
        archivePending={archiveMutation.isPending}
        deletePending={deleteMutation.isPending}
        onArchive={() => {
          if (
            window.confirm(
              "Archive this wiki workspace?\n\nWiki commands will stop working until you re-activate it. Files on disk are kept.",
            )
          ) {
            archiveMutation.mutate();
          }
        }}
        onDelete={() => {
          if (
            window.confirm(
              "Permanently remove this workspace registration?\n\nThe folder on disk is preserved — only the daemon's record is deleted.",
            )
          ) {
            deleteMutation.mutate();
          }
        }}
      />

      {isDirty && (
        <SaveBar
          saving={saveMutation.isPending}
          onSave={() => saveMutation.mutate()}
          onDiscard={() => setDraft(baseline)}
        />
      )}
    </>
  );
}

// ============================================================================
// Empty state — no workspace at all
// ============================================================================

function EmptyState({
  defaultInternalRoot,
  externalPath,
  setExternalPath,
  probeSummary,
  onProbeChange,
  enableInternalPending,
  enableExternalPending,
  onEnableInternal,
  onEnableExternal,
}: {
  defaultInternalRoot: string | undefined;
  externalPath: string;
  setExternalPath: (v: string) => void;
  probeSummary: ProbeSummary | null;
  onProbeChange: (path: string, summary: ProbeSummary) => void;
  enableInternalPending: boolean;
  enableExternalPending: boolean;
  onEnableInternal: () => void;
  onEnableExternal: () => void;
}) {
  return (
    <>
      <Card>
        <CardHeader className="items-start">
          <div>
            <CardTitle>Set up your wiki</CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Pick where the wiki lives. You can switch later by archiving
              this workspace and setting up a new one.
            </p>
          </div>
        </CardHeader>

        <div className="grid gap-3 md:grid-cols-2">
          {/* Internal option */}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-foreground" />
              <h3 className="text-base font-semibold">Internal</h3>
              <Badge variant="blue">Recommended</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Managed by Aitne in its data directory. Nothing to set up.
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>• Path: <code className="break-all">{defaultInternalRoot ?? "~/.personal-agent/wiki"}</code></li>
              <li>• Schema is seeded automatically</li>
              <li>• Best for: starting fresh, no Obsidian vault yet</li>
            </ul>
            <Button
              className="mt-auto"
              onClick={onEnableInternal}
              disabled={enableInternalPending}
            >
              {enableInternalPending ? <Spinner /> : <ArrowRight className="h-4 w-4" />}
              Enable internal wiki
            </Button>
          </div>

          {/* External option */}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-foreground" />
              <h3 className="text-base font-semibold">Existing Obsidian vault</h3>
              <Badge variant="purple">External</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Point Aitne at a folder you already own. The wiki layout is
              detected and migrated on demand.
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>• Path must exist and be writable</li>
              <li>• Cannot overlap your primary vault or Aitne&rsquo;s data dir</li>
              <li>• Best for: continuing an existing Obsidian knowledge base</li>
            </ul>
            <WikiVaultPathPicker
              value={externalPath}
              onChange={setExternalPath}
              onValidatedChange={onProbeChange}
              defaultPath={defaultInternalRoot}
            />
            <Button
              className="mt-auto"
              variant="secondary"
              onClick={onEnableExternal}
              disabled={
                !externalPath
                || enableExternalPending
                || probeSummary?.canConfirm === false
              }
            >
              {enableExternalPending ? <Spinner /> : <ArrowRight className="h-4 w-4" />}
              Use this folder
            </Button>
          </div>
        </div>
      </Card>

      <Collapsible>
        <Card>
          <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
            <div>
              <CardTitle className="text-base">What changes when wiki is on?</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                A small per-turn permission widening so <code>!ingest</code> can
                reach the internet.
              </p>
            </div>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <ExternalFetchPolicy />
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </>
  );
}

// ============================================================================
// Archived state — workspace exists but inactive.
// ============================================================================

function ArchivedState({
  workspace,
  reactivatePending,
  deletePending,
  onReactivate,
  onDelete,
}: {
  workspace: WikiWorkspace;
  reactivatePending: boolean;
  deletePending: boolean;
  onReactivate: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-100 p-2 dark:bg-amber-950/60">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500" />
          </div>
          <div>
            <CardTitle>This wiki is archived</CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              The workspace <code>{workspace.name}</code> still exists on disk
              but wiki commands (<code>!ingest</code>, <code>!compile</code>,{" "}
              <code>!ask</code>) won&rsquo;t run until you re-activate it.
            </p>
          </div>
        </div>
      </CardHeader>

      <dl className="grid gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Mode
          </dt>
          <dd className="text-foreground">
            <Badge variant={workspace.kind === "external" ? "purple" : "blue"}>
              {workspace.kind === "external" ? "External" : "Internal"}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Root path
          </dt>
          <dd className="break-all font-mono text-xs text-foreground">
            {workspace.rootPath}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Wiki pages
          </dt>
          <dd className="text-foreground">{workspace.stats.wikiCount}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Last activity
          </dt>
          <dd className="text-foreground">
            {formatTimestamp(workspace.lastCompileAt ?? workspace.lastIngestAt)}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onReactivate} disabled={reactivatePending}>
          {reactivatePending ? (
            <Spinner />
          ) : (
            <ArchiveRestore className="h-4 w-4" />
          )}
          Re-activate wiki
        </Button>
        <Button
          variant="outline"
          onClick={onDelete}
          disabled={deletePending}
          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
        >
          <Trash2 className="h-4 w-4" />
          Remove registration
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Removing the registration is non-destructive — the folder on disk is
        preserved.
      </p>
    </Card>
  );
}

// ============================================================================
// Active state — workspace overview header
// ============================================================================

function WorkspaceOverviewCard({
  workspace,
  sevenDayCost,
}: {
  workspace: WikiWorkspace;
  sevenDayCost: number;
}) {
  const isExternal = workspace.kind === "external";
  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{workspace.name}</CardTitle>
              <Badge variant={isExternal ? "purple" : "blue"}>
                {isExternal ? "External" : "Internal"}
              </Badge>
              <Badge variant="gray">{workspace.language}</Badge>
            </div>
            <div className="flex items-center gap-1.5">
              <code className="break-all text-xs text-muted-foreground">
                {workspace.rootPath}
              </code>
              <CopyButton text={workspace.rootPath} label="Copy" iconSize="h-3 w-3" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/wiki">Browse wiki</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/wiki/timeline">
                <History className="h-4 w-4" /> Timeline &amp; health
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>

      <dl className="grid gap-3 border-t border-border pt-3 text-sm sm:grid-cols-4">
        <Stat label="Raw notes" value={workspace.stats.rawCount} />
        <Stat label="Wiki pages" value={workspace.stats.wikiCount} />
        <Stat label="Outputs" value={workspace.stats.outputCount} />
        <Stat label="7-day cost" value={formatCurrency(sevenDayCost)} />
      </dl>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-base font-semibold text-foreground">{value}</dd>
    </div>
  );
}

// ============================================================================
// Estimate banner
// ============================================================================

function EstimateBanner({ data }: { data: EstimateResponse["estimate"] }) {
  return (
    <Alert variant={data.exceedsThreshold ? "error" : "info"}>
      <p className="text-sm">
        <strong><code>!compile full</code> cost estimate:</strong>{" "}
        ${data.optimisticUsd.toFixed(2)}–${data.pessimisticUsd.toFixed(2)}{" "}
        (expected ${data.expectedUsd.toFixed(2)}) from {data.rawCount}{" "}
        raw note{data.rawCount === 1 ? "" : "s"}.{" "}
        {data.exceedsThreshold
          ? <>Above the ${data.thresholdUsd.toFixed(2)} threshold — will require dashboard approval.</>
          : <>Under the per-workspace threshold; will run autonomously.</>}
      </p>
      {data.method === "per-file-chars" && data.perFile && data.perFile.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Top {data.perFile.length} raw notes by estimated cost
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {data.perFile.map((file) => (
              <li key={file.path}>
                {file.path} — {file.estimatedTokens.toLocaleString()} tokens
                {" "}({file.charCount.toLocaleString()} chars)
              </li>
            ))}
          </ul>
        </details>
      )}
    </Alert>
  );
}

// ============================================================================
// Settings: General
// ============================================================================

function GeneralSettingsCard({
  draft,
  setDraft,
}: {
  draft: WikiDraft;
  setDraft: (next: WikiDraft) => void;
}) {
  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>General</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Language new pages are written in, and how multi-URL ingests are dispatched.
          </p>
        </div>
      </CardHeader>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Writing language"
          hint="Independent of your profile language. Existing pages are not rewritten."
        >
          <WikiLanguageField
            value={draft.language}
            onChange={(next) => setDraft({ ...draft, language: next })}
          />
        </Field>
        <Field
          label="Dispatch mode"
          hint="Parallel ingests multiple URLs concurrently. Serial runs one at a time."
        >
          <Select
            value={draft.dispatchMode}
            onValueChange={(value) =>
              setDraft({ ...draft, dispatchMode: value as WikiDraft["dispatchMode"] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="parallel">Parallel</SelectItem>
              <SelectItem value="serial">Serial</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={
            <span className="flex items-center gap-2">
              Concurrency cap
              <span className="inline-flex min-w-[2rem] justify-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                {draft.concurrencyCap}
              </span>
            </span>
          }
          hint={
            draft.dispatchMode === "serial"
              ? "Disabled — set Dispatch mode to Parallel to use this."
              : "Maximum simultaneous !ingest sessions."
          }
        >
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={draft.concurrencyCap}
            onChange={(event) =>
              setDraft({
                ...draft,
                concurrencyCap: Math.max(1, Math.min(10, Number(event.target.value) || 1)),
              })
            }
            aria-label="Per-URL concurrency cap"
            className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={draft.dispatchMode === "serial"}
          />
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>1</span>
            <span>5</span>
            <span>10</span>
          </div>
        </Field>
      </div>
    </Card>
  );
}

// ============================================================================
// Settings: Bridge (DM → wiki capture)
// ============================================================================

function BridgeSettingsCard({
  draft,
  setDraft,
  bridgeStats,
}: {
  draft: WikiDraft;
  setDraft: (next: WikiDraft) => void;
  bridgeStats: WikiWorkspace["bridgeStats"];
}) {
  const bridgeActive = draft.bridgeEnabled && draft.dmAgentWriteEnabled;
  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex w-full items-start justify-between gap-2">
          <div>
            <CardTitle>Capture insights from chat</CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              When you and Aitne land on something worth keeping in a DM, the
              agent can drop a draft into <code>10_raw/bridge-*.md</code> for
              you to refine later. Both switches below must be on before any
              file is written.
            </p>
          </div>
          <Badge variant={bridgeActive && !draft.bridgeMeasurementOnly ? "blue" : "gray"}>
            {!draft.bridgeEnabled || !draft.dmAgentWriteEnabled
              ? "Off"
              : draft.bridgeMeasurementOnly
                ? "Observing"
                : "Writing"}
          </Badge>
        </div>
      </CardHeader>

      <div className="space-y-3">
        <Toggle
          checked={draft.bridgeEnabled}
          onChange={(v) => setDraft({ ...draft, bridgeEnabled: v })}
          label="Detect bridge candidates"
          hint="The agent watches DM turns for ideas that look wiki-worthy."
        />
        <Toggle
          checked={draft.dmAgentWriteEnabled}
          onChange={(v) => setDraft({ ...draft, dmAgentWriteEnabled: v })}
          label="Let the agent write drafts"
          hint="Required before any file is written. Without this, candidates are only logged."
          disabled={!draft.bridgeEnabled}
        />
        <Toggle
          checked={draft.bridgeMeasurementOnly}
          onChange={(v) => setDraft({ ...draft, bridgeMeasurementOnly: v })}
          label="Observation mode (don't write yet)"
          hint="Recommended for the first 1-2 weeks: log candidates only so you can review precision before opening the write gate."
          disabled={!draft.bridgeEnabled}
        />
        <Field
          label="Minimum confidence"
          hint="The agent's own confidence threshold (0–1). Lower = more drafts, more noise. Higher = fewer drafts, higher signal."
        >
          <Input
            type="number"
            min={0}
            max={1}
            step="0.05"
            value={draft.bridgeMinConfidence}
            onChange={(event) =>
              setDraft({
                ...draft,
                bridgeMinConfidence: Math.min(1, Math.max(0, Number(event.target.value) || 0)),
              })
            }
            className="max-w-[8rem]"
            disabled={!draft.bridgeEnabled}
          />
        </Field>

        {bridgeStats && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <div className="grid gap-2 sm:grid-cols-3">
              <span>{bridgeStats.written} files written</span>
              <span>{bridgeStats.candidates} candidates logged</span>
              <span>{bridgeStats.deduplicated} dedup hits</span>
            </div>
            {bridgeStats.lastDetectedAt && (
              <p className="mt-1.5">Last activity: {formatTimestamp(bridgeStats.lastDetectedAt)}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ============================================================================
// Settings: Compilation
// ============================================================================

function CompilationSettingsCard({
  draft,
  setDraft,
  isExternal,
  showGitToggle,
}: {
  draft: WikiDraft;
  setDraft: (next: WikiDraft) => void;
  isExternal: boolean;
  showGitToggle: boolean;
}) {
  return (
    <Card>
      <CardHeader className="items-start">
        <div>
          <CardTitle>Compilation &amp; writes</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            How <code>!compile</code> handles large jobs and writes back to disk.
          </p>
        </div>
      </CardHeader>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Approval threshold for !compile full"
          hint="If the estimated cost exceeds this, !compile full asks for dashboard approval instead of running autonomously."
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={draft.fullCompileApprovalThresholdUsd}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  fullCompileApprovalThresholdUsd: Number(event.target.value) || 0,
                })
              }
            />
          </div>
        </Field>

        {isExternal && (
          <Field
            label="Write strategy"
            hint="Vaults that Obsidian is actively syncing (iCloud, Obsidian Sync, etc.) need the Obsidian CLI for writes to propagate. Auto probes on the first write."
          >
            <Select
              value={draft.writeStrategy}
              onValueChange={(value) =>
                setDraft({ ...draft, writeStrategy: value as WikiDraft["writeStrategy"] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (probe on first write)</SelectItem>
                <SelectItem value="fs">Direct filesystem</SelectItem>
                <SelectItem value="cli">Obsidian CLI (for iCloud vaults)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}

        {showGitToggle && (
          <div className="md:col-span-2">
            <Toggle
              checked={draft.gitPreCompileEnabled}
              onChange={(v) => setDraft({ ...draft, gitPreCompileEnabled: v })}
              label="Auto-commit before !compile full"
              hint="Stages and commits any pending changes so a full compile starts from a clean tree. Skipped if the tree is dirty in unexpected ways."
            />
          </div>
        )}
      </div>
    </Card>
  );
}

// ============================================================================
// External fetch policy — rewritten in plain language
// ============================================================================

function ExternalFetchPolicy() {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Only <code>wiki.ingest_url</code> sessions (one per URL passed to{" "}
        <code>!ingest</code>) are allowed to reach the internet.{" "}
        <code>wiki.compile</code> and <code>wiki.ask</code> read locally
        through the daemon and never touch external hosts.
      </p>
      <details className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-foreground">
          Per-backend details
        </summary>
        <ul className="mt-2 ml-4 list-disc space-y-1.5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Claude</strong> — adds{" "}
            <code>WebFetch</code> to the per-turn allowed tools. The deny
            list and dontAsk permission mode still apply. If you customised{" "}
            <code>allowedToolsOverride</code>, include <code>WebFetch</code>{" "}
            yourself.
          </li>
          <li>
            <strong className="text-foreground">Codex</strong> — no change
            needed. The workspace-write sandbox already reaches the network.
          </li>
          <li>
            <strong className="text-foreground">Gemini</strong> — the strict
            admin policy flips just <code>web_fetch</code> to allow for this
            turn. Container sandbox + context-dir chokepoint stay intact.
          </li>
          <li>
            If a backend is globally in <code>allow</code> execution mode,
            the widening is a no-op.
          </li>
        </ul>
      </details>
    </div>
  );
}

// ============================================================================
// Danger zone
// ============================================================================

function DangerZone({
  workspaceName,
  archivePending,
  deletePending,
  onArchive,
  onDelete,
}: {
  workspaceName: string;
  archivePending: boolean;
  deletePending: boolean;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="border-red-200 dark:border-red-900/50">
      <CardHeader className="items-start">
        <div>
          <CardTitle className="text-red-700 dark:text-red-400">Danger zone</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Stop or remove the <code>{workspaceName}</code> wiki. Files on
            disk are kept in both cases.
          </p>
        </div>
      </CardHeader>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border p-3">
          <h4 className="text-sm font-semibold text-foreground">Archive</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Pauses wiki commands. You can re-activate later from this page.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onArchive}
            disabled={archivePending}
          >
            {archivePending ? <Spinner /> : null}
            Archive workspace
          </Button>
        </div>
        <div className="rounded-lg border border-red-200 p-3 dark:border-red-900/50">
          <h4 className="text-sm font-semibold text-red-700 dark:text-red-400">Remove registration</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Deletes the daemon&rsquo;s record only. The folder on disk is
            preserved — re-add it later if you change your mind.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40"
            onClick={onDelete}
            disabled={deletePending}
          >
            {deletePending ? <Spinner /> : <Trash2 className="h-4 w-4" />}
            Remove
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ============================================================================
// Save bar — sticky bottom, visible only when draft is dirty
// ============================================================================

function SaveBar({
  saving,
  onSave,
  onDiscard,
}: {
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
      <p className="text-sm text-foreground">You have unsaved changes.</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={saving}>
          <RotateCcw className="h-4 w-4" />
          Discard
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Spinner /> : <Save className="h-4 w-4" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Small primitives
// ============================================================================

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border border-border p-3 text-sm ${
        disabled ? "opacity-50" : "cursor-pointer hover:bg-muted/40"
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <div className="space-y-0.5">
        <p className="font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </label>
  );
}
