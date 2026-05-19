"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, HardDrive, Loader2, Mic, RotateCcw, Trash2, Zap } from "lucide-react";
import { useQueryClient, useQuery, type QueryClient } from "@tanstack/react-query";
import { VOICE_LANGUAGE_FULL, VOICE_LANGUAGE_TOP } from "@aitne/shared";
import { api, ApiError } from "@/lib/api-client";
import type { ReinstallContextPlanResponse } from "@/lib/api-types";
import { useConfig } from "@/lib/hooks/use-config";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { EditableArrayField } from "@/components/settings/editors";
import { SettingsToast } from "@/components/settings/settings-navigation";

export default function AdvancedSettingsPage() {
  const { data: config } = useConfig();
  // toast + showToast for non-config actions (reset safety)
  const { toast, showToast } = useSaveConfig();
  // deferSave / dv for the standard fields
  const { deferSaveFor, dv, dirtyFields, clearDirtyKeys } = useDirtyFields();
  const queryClient = useQueryClient();
  const confirmDialog = useConfirm();
  const [resetting, setResetting] = useState(false);

  const handleResetSafety = async () => {
    const ok = await confirmDialog({
      title: "Reset disallowed tools to defaults?",
      description:
        "This will restore the default safety tool list, replacing any customizations.",
      confirmLabel: "Reset",
      variant: "destructive",
    });
    if (!ok) return;
    setResetting(true);
    try {
      await api.post("/config/reset-safety");
      queryClient.invalidateQueries({ queryKey: ["config"] });
      // Clear any dirty entries for the reset keys so they don't overwrite
      // the fresh defaults when the user clicks Save in the save bar.
      clearDirtyKeys(["disallowedTools", "allowedToolsOverride"]);
      showToast("success", "Safety tools reset to defaults");
    } finally {
      setResetting(false);
    }
  };

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  return (
    <>
      <PageHeader
        title="Advanced"
        description="Power-user knobs and safety settings. Most of these are low-level — read each description carefully before saving."
      />

      {/* Toast for immediate-save actions (reset safety) */}
      <SettingsToast toast={toast} />

      <Card>
        <CardHeader>
          <CardTitle>Safety — Tool Policy</CardTitle>
        </CardHeader>
        <div className="space-y-3 [&>p]:max-w-prose">
          <p className="text-xs text-muted-foreground">
            Guardrails applied to every backend&rsquo;s tool calls, enforced
            before each call runs. Entries are either a plain tool name
            (<code>Write</code>, <code>WebFetch</code>) or a tool name with an
            argument pattern in parentheses (<code>Bash(rm -rf *)</code>) to
            match only specific invocations.{" "}
            <strong>Disallowed wins over allowed</strong> — any match in the
            disallowed list blocks the call even if the allowed override would
            otherwise permit it. The per-backend Safe / Allow toggle lives in{" "}
            <strong>Models &amp; Cost → Execution Mode</strong>.
          </p>
          <EditableArrayField
            label="Disallowed Tools"
            values={dv("disallowedTools", config.disallowedTools)}
            configKey="disallowedTools"
            variant="red"
            placeholder="e.g. Bash(rm -rf *)"
            modified={dirtyFields.has("disallowedTools")}
            onSave={deferSave}
          />
          <p className="text-xs text-muted-foreground -mt-1">
            Tools the agent is forbidden from calling. The defaults block
            destructive shell commands and dangerous file operations. Use Reset
            to Defaults below to restore them after experimenting.
          </p>

          <Separator />

          <EditableArrayField
            label="Allowed Tools Override"
            values={dv("allowedToolsOverride", config.allowedTools)}
            configKey="allowedToolsOverride"
            variant="green"
            placeholder="e.g. Bash(git push)"
            modified={dirtyFields.has("allowedToolsOverride")}
            onSave={deferSave}
          />
          <p className="text-xs text-muted-foreground -mt-1">
            Narrow exceptions to the disallowed list. Use this to permit a
            specific safe invocation of an otherwise-blocked tool — for
            example, allow <code>Bash(git push)</code> while keeping arbitrary{" "}
            <code>Bash</code> blocked.
          </p>

          <Separator />
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetSafety}
            disabled={resetting}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            {resetting ? "Resetting..." : "Reset to Defaults"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Restores the built-in disallowed-tool list and{" "}
            <strong>clears the allowed override list</strong>, replacing any
            customizations in both. Use this when your safety config has
            drifted and you want a clean slate.
          </p>
        </div>
      </Card>

      <VoiceModeSection />

      <DangerZone />
    </>
  );
}

interface VoiceInstallProgress {
  phase: "initializing" | "downloading" | "loading" | "ready";
  currentFile: string | null;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  filesDownloaded: number;
}

interface VoiceStatusResponse {
  enabled: boolean;
  installing: boolean;
  installed: boolean;
  /**
   * `true` when the configured Whisper model is materialized on disk. Goes
   * `false` after a package upgrade switches the default model — used to
   * surface the "Upgrade voice model" CTA without forcing a manual toggle.
   */
  modelOnDisk: boolean;
  /** Aggregate byte size of every file under the model's on-disk dir. */
  modelSizeBytes: number;
  /** Absolute path to the daemon-owned model cache root. */
  modelDir: string;
  status: "idle" | "running" | "ready" | "error";
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  model: string;
  progress: VoiceInstallProgress | null;
  primaryLanguage: string | null;
  suggestedPrimaryLanguage: string;
  // Whisper's full language registry is imported directly from
  // @aitne/shared — see VOICE_LANGUAGE_TOP / VOICE_LANGUAGE_FULL — so
  // the status payload does not duplicate it on every 1.5s poll.
}

/**
 * Voice Mode card. Toggling on triggers `POST /api/voice/install`, which
 * downloads the Whisper model and then auto-restarts the daemon so the
 * `voiceTranscriptionEnabled` flag is observed at boot. Polls
 * `/api/voice/status` every 2s while installing or while waiting for the
 * daemon to come back up.
 *
 * See docs/design/appendices/voice-transcription.md for the workflow + model.
 */
function VoiceModeSection() {
  const queryClient = useQueryClient();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState(false);
  const [waitingForRestart, setWaitingForRestart] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Local picker state — initialized from the server's locale suggestion or
  // the previously persisted setting once /voice/status loads.
  const [pickerLanguage, setPickerLanguage] = useState<string | null>(null);

  const { data: status } = useQuery<VoiceStatusResponse>({
    queryKey: ["voice-status"],
    queryFn: async () => {
      try {
        return await api.get<VoiceStatusResponse>("/voice/status");
      } catch (err) {
        // While the daemon is restarting, /api/voice/status will fail. Surface
        // a synthetic "installing" snapshot so the UI keeps polling.
        if (waitingForRestart) {
          return {
            enabled: false,
            installing: true,
            installed: true,
            modelOnDisk: false,
            modelSizeBytes: 0,
            modelDir: "",
            status: "running",
            error: null,
            startedAt: null,
            finishedAt: null,
            model: "onnx-community/whisper-large-v3-turbo",
            progress: null,
            primaryLanguage: null,
            suggestedPrimaryLanguage: "en",
          };
        }
        throw err;
      }
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (waitingForRestart) return 1500;
      if (data?.installing || data?.status === "running") return 1500;
      return false;
    },
    refetchOnWindowFocus: false,
  });

  // Seed the picker from server-side suggestion / existing setting. Runs
  // each time those upstream values change so a re-fetch after install
  // round-trips the persisted value back into the dropdown.
  useEffect(() => {
    if (!status) return;
    const initial = status.primaryLanguage ?? status.suggestedPrimaryLanguage;
    setPickerLanguage((prev) => prev ?? initial);
  }, [status?.primaryLanguage, status?.suggestedPrimaryLanguage, status]);

  // When the daemon comes back from a restart and reports enabled=true, drop
  // the waiting flag so the UI settles.
  useEffect(() => {
    if (waitingForRestart && status?.enabled) {
      setWaitingForRestart(false);
      queryClient.invalidateQueries({ queryKey: ["config"] });
    }
  }, [waitingForRestart, status?.enabled, queryClient]);

  // After install succeeds the route returns status="ready" and triggers a
  // restart ~250ms later. Flip into "waiting for restart" mode so the polling
  // tolerates the brief window where /api/voice/status returns 5xx.
  useEffect(() => {
    if (status?.status === "ready" && !status.enabled) {
      setWaitingForRestart(true);
    }
  }, [status?.status, status?.enabled]);

  const handleEnable = async () => {
    setActionError(null);
    setBusy(true);
    try {
      await api.post("/voice/install", {
        primaryLanguage: pickerLanguage,
      });
      // The route is fire-and-forget. Force an immediate refetch so the
      // query latches onto status="running" — without this, refetchInterval
      // is evaluated against the stale `installing=false` snapshot from the
      // initial load and stays disabled, leaving the UI frozen with no
      // visible signal that the download is happening.
      await queryClient.invalidateQueries({ queryKey: ["voice-status"] });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Install failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteModel = async () => {
    // Two-stage destructive UX: explicit confirm with a description that
    // mentions the rough disk reclaim. The dialog is the only protection
    // against accidental clicks — there is no requireText gate because the
    // operation is reversible (clicking "Upgrade & install" re-downloads
    // the same weights from HuggingFace).
    const ok = await confirmDialog({
      title: "Delete the local Whisper model?",
      description:
        "Removes the on-disk Whisper weights (~800 MB). Voice mode stays enabled — click \"Upgrade & install\" afterwards to download the model again. Use this when an install attempt failed and the dashboard is stuck on an error banner.",
      confirmLabel: "Delete model",
      variant: "destructive",
    });
    if (!ok) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.delete("/voice/model");
      await queryClient.invalidateQueries({ queryKey: ["voice-status"] });
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Deleting voice model failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSavePrimaryLanguage = async (next: string) => {
    setActionError(null);
    setBusy(true);
    try {
      // Direct config PATCH — same hot-reloadable knob the transcriber
      // reads via getter, so this takes effect on the next inbound voice
      // attachment without a daemon restart.
      await api.patch("/config", { voiceTranscriptionPrimaryLanguage: next });
      setPickerLanguage(next);
      await queryClient.invalidateQueries({ queryKey: ["voice-status"] });
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Saving primary language failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const installing = busy || (status?.installing ?? false) || waitingForRestart;
  const progress = status?.progress ?? null;
  const errorMessage = actionError ?? status?.error ?? null;
  const upgradeAvailable =
    enabled && status?.modelOnDisk === false && !installing;

  // Render order in the picker: top languages first, then "More languages"
  // group with the rest, sorted by English name. Both arrays are static
  // (imported from @aitne/shared) — `useMemo` runs once per mount.
  const languageGroups = useMemo(() => {
    const topCodes = new Set(VOICE_LANGUAGE_TOP.map((l) => l.code));
    const more = VOICE_LANGUAGE_FULL
      .filter((l) => !topCodes.has(l.code))
      .slice()
      .sort((a, b) => a.englishName.localeCompare(b.englishName));
    return { top: VOICE_LANGUAGE_TOP, more };
  }, []);

  // The picker is shown in two places, so factor the JSX. The select is
  // disabled while installing/restarting so the operator cannot mutate
  // the value mid-flight.
  const renderLanguagePicker = (id: string) => (
    <Select
      value={pickerLanguage ?? undefined}
      onValueChange={(v) => setPickerLanguage(v)}
      disabled={installing}
    >
      <SelectTrigger id={id} className="w-full max-w-sm">
        <SelectValue placeholder="Select language…" />
      </SelectTrigger>
      <SelectContent>
        {languageGroups.top.length > 0 && (
          <SelectGroup>
            <SelectLabel>Common</SelectLabel>
            {languageGroups.top.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.nativeName}
                {l.nativeName !== l.englishName && (
                  <span className="text-muted-foreground"> · {l.englishName}</span>
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {languageGroups.more.length > 0 && (
          <SelectGroup>
            <SelectLabel>More languages</SelectLabel>
            {languageGroups.more.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.nativeName}
                {l.nativeName !== l.englishName && (
                  <span className="text-muted-foreground"> · {l.englishName}</span>
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="h-4 w-4" />
          Voice Mode
        </CardTitle>
      </CardHeader>
      <div className="space-y-3 [&>p]:max-w-prose">
        <p className="text-xs text-muted-foreground">
          Transcribe inbound voice messages (Telegram voice / WhatsApp PTT /
          Discord audio / Slack audio file) locally with Whisper before they
          reach the agent. Audio bytes never leave the host. See{" "}
          <code>docs/design/appendices/voice-transcription.md</code> for
          implementation details.
        </p>

        {/* Installed-model status panel. Surfaces, at a glance:
            (a) whether the configured Whisper weights are actually on disk,
            (b) which model id is configured (operators can override via
                PA_VOICE_TRANSCRIPTION_MODEL),
            (c) the on-disk size, so a half-downloaded directory is visible,
            (d) a "Delete model" action co-located with the artifact it
                operates on (previously docked far from the model info, on
                the Status row, which made the association non-obvious).
            The four visual states map 1:1 to the install lifecycle so the
            user never has to consult the file system to know what's there. */}
        <ModelStatusPanel
          status={status}
          modelOnDisk={status?.modelOnDisk ?? false}
          upgradeAvailable={upgradeAvailable}
          installing={installing}
          waitingForRestart={waitingForRestart}
          onDelete={handleDeleteModel}
          deleteDisabled={busy}
        />

        {errorMessage && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </p>
        )}

        {upgradeAvailable && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            <p className="font-medium text-amber-700 dark:text-amber-400">
              Upgrade voice model
            </p>
            <p className="text-muted-foreground mt-0.5">
              The configured model{" "}
              <code>{status?.model}</code> is not yet downloaded — likely
              because a package update changed the default. Click{" "}
              <strong>Upgrade & install</strong> below to fetch it.
              Inbound voice will keep using the previous model until then.
            </p>
          </div>
        )}

        {!enabled && !installing && (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
            <div>
              <label
                htmlFor="voice-primary-language"
                className="text-sm font-medium"
              >
                Your primary spoken language
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Used as the fallback when Whisper&apos;s automatic language
                detection fails on a clip. Other languages are still
                transcribed correctly when detected — this only kicks in
                when detection is uncertain.
              </p>
            </div>
            {renderLanguagePicker("voice-primary-language")}
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">
              Status:{" "}
              <span className="font-medium">
                {installing
                  ? waitingForRestart
                    ? "Restarting daemon to apply…"
                    : progress?.phase === "ready"
                      ? "Finalizing…"
                      : progress?.currentFile
                        ? `Downloading ${progress.currentFile}…`
                        : "Starting model download…"
                  : enabled
                    ? upgradeAvailable
                      ? "Enabled (upgrade available)"
                      : "Enabled"
                    : "Disabled"}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {enabled
                ? "Inbound audio is transcribed locally before it reaches the agent. You can change your primary language below at any time."
                : "Turning this on downloads the Whisper weights (~800 MB), then auto-restarts the daemon so the transcriber picks up the new flag. First download takes a minute or two, depending on your connection."}
            </p>
          </div>
          {/* Primary action only. The recovery "Delete model" button now
              lives inside ModelStatusPanel so it's adjacent to the artifact
              it operates on instead of orphaned under the runtime-state
              toggle. */}
          <Button
            size="sm"
            variant={enabled && !upgradeAvailable ? "outline" : "default"}
            onClick={handleEnable}
            disabled={
              busy
              || installing
              || (enabled && !upgradeAvailable)
              || pickerLanguage === null
            }
          >
            {installing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Working…
              </>
            ) : upgradeAvailable ? (
              "Upgrade & install"
            ) : enabled ? (
              "Enabled"
            ) : (
              "Enable & install"
            )}
          </Button>
        </div>

        {enabled && !installing && (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
            <div>
              <label
                htmlFor="voice-primary-language-live"
                className="text-sm font-medium"
              >
                Primary spoken language
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Saved changes apply to the next inbound voice attachment —
                no daemon restart needed.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {renderLanguagePicker("voice-primary-language-live")}
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy
                  || pickerLanguage === null
                  || pickerLanguage === status?.primaryLanguage
                }
                onClick={() => {
                  if (pickerLanguage) void handleSavePrimaryLanguage(pickerLanguage);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        )}

        {installing && !waitingForRestart && (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full bg-primary transition-[width] duration-200",
                  (!progress || progress.percent === 0) && "animate-pulse",
                )}
                style={{
                  width: `${Math.min(100, Math.max(progress?.percent ?? 0, progress ? 2 : 8))}%`,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>
                {progress && progress.totalBytes > 0
                  ? `${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`
                  : "Contacting Hugging Face…"}
                {progress && progress.filesDownloaded > 0 && (
                  <> · {progress.filesDownloaded} file{progress.filesDownloaded === 1 ? "" : "s"} complete</>
                )}
              </span>
              <span>
                {progress && progress.percent > 0
                  ? `${Math.round(progress.percent)}%`
                  : ""}
              </span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Compact "what's on disk" panel rendered at the top of the Voice Mode
 * card. Tells the operator without ambiguity whether the configured
 * Whisper weights are present and how much space they occupy. Three
 * visual states, picked in priority order:
 *
 *   1. `installing` — neutral border + spinning indicator
 *   2. `upgradeAvailable` (enabled but configured model not on disk) — amber
 *   3. `modelOnDisk` — green, with the actual byte size
 *   4. otherwise — muted "not installed yet" hint
 *
 * The model id is always shown so an operator who set
 * `PA_VOICE_TRANSCRIPTION_MODEL` can confirm the daemon picked it up.
 */
function ModelStatusPanel({
  status,
  modelOnDisk,
  upgradeAvailable,
  installing,
  waitingForRestart,
  onDelete,
  deleteDisabled,
}: {
  status: VoiceStatusResponse | undefined;
  modelOnDisk: boolean;
  upgradeAvailable: boolean;
  installing: boolean;
  waitingForRestart: boolean;
  /**
   * Action wired from VoiceModeSection. We render the trigger only when
   * the model is actually on disk (variant === "installed" or "upgrade")
   * and the daemon isn't mid-install — anything else and there's either
   * nothing to delete or a download we'd corrupt.
   */
  onDelete: () => void;
  deleteDisabled: boolean;
}) {
  const model =
    status?.model ?? "onnx-community/whisper-large-v3-turbo";
  const sizeBytes = status?.modelSizeBytes ?? 0;
  const modelDir = status?.modelDir ?? null;

  type Variant = "installing" | "upgrade" | "installed" | "missing";
  const variant: Variant = installing
    ? "installing"
    : upgradeAvailable
      ? "upgrade"
      : modelOnDisk
        ? "installed"
        : "missing";

  const styles: Record<Variant, { container: string; pill: string; iconBg: string }> = {
    installing: {
      container: "border-border bg-muted/30",
      pill: "bg-muted text-foreground",
      iconBg: "text-muted-foreground",
    },
    upgrade: {
      container: "border-amber-500/40 bg-amber-500/5",
      pill: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      iconBg: "text-amber-600 dark:text-amber-400",
    },
    installed: {
      container: "border-emerald-500/40 bg-emerald-500/5",
      pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      iconBg: "text-emerald-600 dark:text-emerald-400",
    },
    missing: {
      container: "border-border bg-muted/30",
      pill: "bg-muted text-muted-foreground",
      iconBg: "text-muted-foreground",
    },
  };
  const s = styles[variant];

  const icon =
    variant === "installing" ? (
      <Loader2 className={cn("h-4 w-4 animate-spin", s.iconBg)} />
    ) : variant === "installed" ? (
      <CheckCircle2 className={cn("h-4 w-4", s.iconBg)} />
    ) : variant === "upgrade" ? (
      <AlertTriangle className={cn("h-4 w-4", s.iconBg)} />
    ) : (
      <CircleDashed className={cn("h-4 w-4", s.iconBg)} />
    );

  const pillLabel =
    variant === "installing"
      ? waitingForRestart
        ? "Restarting"
        : "Installing"
      : variant === "installed"
        ? "Installed"
        : variant === "upgrade"
          ? "Upgrade available"
          : "Not installed";

  const subline =
    variant === "installed" && sizeBytes > 0 ? (
      <span className="inline-flex items-center gap-1 tabular-nums">
        <HardDrive className="h-3 w-3" />
        {formatBytes(sizeBytes)} on disk
      </span>
    ) : variant === "upgrade" ? (
      <span>Configured model is not on disk yet.</span>
    ) : variant === "installing" ? (
      <span>Downloading weights from Hugging Face…</span>
    ) : (
      <span>Click <strong>Enable &amp; install</strong> below to download (~800 MB).</span>
    );

  // Delete is meaningful only when weights are actually on disk and no
  // download is in flight (variants "installed" and "upgrade" both
  // imply something is materialized, though "upgrade" is a configured-
  // model mismatch — deleting clears either the stale or fresh copy).
  const canDelete =
    !installing && (variant === "installed" || variant === "upgrade");

  return (
    <div className={cn("rounded-md border px-3 py-2.5", s.container)}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{icon}</div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                s.pill,
              )}
            >
              {pillLabel}
            </span>
            <code className="break-all text-xs">{model}</code>
          </div>
          <div className="text-xs text-muted-foreground">{subline}</div>
          {modelDir && variant === "installed" && (
            <div className="text-[10px] text-muted-foreground/70 font-mono break-all">
              {modelDir}
            </div>
          )}
        </div>
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            disabled={deleteDisabled}
            className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

type DangerAction =
  | "reset-config"
  | "purge-history"
  | "reinstall-context"
  | "factory-reset";

async function runDangerAction(
  action: DangerAction,
): Promise<Record<string, unknown>> {
  switch (action) {
    case "reset-config":
      return api.post("/system/reset-config");
    case "purge-history":
      return api.post("/system/purge-history");
    case "reinstall-context":
      return api.post("/system/reinstall-context", { confirm: "CLEAN" });
    case "factory-reset":
      return api.post("/system/factory-reset");
  }
}

function invalidateAfter(action: DangerAction, qc: QueryClient): void {
  switch (action) {
    case "reset-config":
      qc.invalidateQueries({ queryKey: ["config"] });
      return;
    case "purge-history":
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["cost"] });
      return;
    case "reinstall-context":
      qc.invalidateQueries({ queryKey: ["context"] });
      qc.invalidateQueries({ queryKey: ["setup-status"] });
      return;
    case "factory-reset":
      qc.invalidateQueries();
      return;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function describeReinstallPlan(plan: ReinstallContextPlanResponse): string {
  const ancillary =
    plan.ancillaryDirs.length > 0
      ? `Ancillary caches to remove: ${plan.ancillaryDirs.join(", ")}.`
      : "No ancillary caches are scheduled for removal.";
  return [
    `This will remove ${plan.fileCount} file(s) (${formatBytes(plan.totalBytes)}) from ${plan.contextDir}, clear ${plan.snapshotRowCount} snapshot row(s), and then re-run setup on the next daemon start.`,
    ancillary,
    `Backup tarball path: ${plan.backupPath}`,
  ].join(" ");
}

function DangerZone() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<DangerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const runAction = async (
    action: DangerAction,
    opts: {
      title: string;
      description: string;
      confirmLabel: string;
      doubleConfirm?: {
        title: string;
        description: string;
        confirmLabel: string;
        requireText?: string;
      };
      successMessage: (result: Record<string, unknown>) => string;
    },
  ): Promise<void> => {
    const ok = await confirm({
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel,
      variant: "destructive",
    });
    if (!ok) return;
    if (opts.doubleConfirm) {
      const ok2 = await confirm({
        title: opts.doubleConfirm.title,
        description: opts.doubleConfirm.description,
        confirmLabel: opts.doubleConfirm.confirmLabel,
        variant: "destructive",
        requireText: opts.doubleConfirm.requireText,
      });
      if (!ok2) return;
    }

    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await runDangerAction(action);
      invalidateAfter(action, queryClient);
      setNotice(opts.successMessage(result));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  };

  const handleResetConfig = () =>
    runAction("reset-config", {
      title: "Reset all config to defaults?",
      description:
        "Restores every runtime setting in the database to its factory default. Bootstrap values in .env (API port, data directory, log level) and integration credentials are preserved.",
      confirmLabel: "Reset config",
      successMessage: (r) => `Cleared ${r.cleared ?? 0} runtime setting(s).`,
    });

  const handlePurgeHistory = () =>
    runAction("purge-history", {
      title: "Delete all sessions and history?",
      description:
        "Permanently removes every non-active conversation session, message, action log, observation, notification log, MD snapshot, and scheduled task. The active session is preserved.",
      confirmLabel: "Delete history",
      successMessage: (r) =>
        `Deleted ${r.deletedSessions ?? 0} session(s), ${r.deletedMessages ?? 0} message(s), ${r.deletedActions ?? 0} action(s).`,
    });

  const handleReinstallContext = () =>
    (async () => {
      setBusy("reinstall-context");
      setError(null);
      setNotice(null);
      try {
        const plan = await api.get<ReinstallContextPlanResponse>("/system/reinstall-context/plan");
        const ok = await confirm({
          title: "Clean reinstall of context/ (B-007)?",
          description: describeReinstallPlan(plan),
          confirmLabel: "Continue",
          variant: "destructive",
        });
        if (!ok) return;

        const ok2 = await confirm({
          title: "Type CLEAN to confirm",
          description:
            `Backup tarball: ${plan.backupPath}. Proceed to remove ${plan.fileCount} file(s) and clear ${plan.snapshotRowCount} snapshot row(s).`,
          confirmLabel: "Reinstall context",
          variant: "destructive",
          requireText: "CLEAN",
        });
        if (!ok2) return;

        const result = await runDangerAction("reinstall-context");
        invalidateAfter("reinstall-context", queryClient);
        setNotice(
          `Reinstalled. Removed ${result.filesDeleted ?? 0} file(s), cleared ${result.snapshotRowsDeleted ?? 0} snapshot row(s). Backup at ${result.backupPath ?? plan.backupPath}.`,
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Request failed");
      } finally {
        setBusy(null);
      }
    })();

  const handleFactoryReset = () =>
    runAction("factory-reset", {
      title: "Factory reset — really?",
      description:
        "Wipes everything on this device: conversation history, action logs, runtime settings, context files (including rules/management.md), keychain secrets, encrypted blobs, uploaded attachments, session and skill-optimizer workdirs, all backups, caches, user skills, integrations.md, the managed Codex Azure config, the Whisper model cache, and every user-data table (backends, mail accounts, recurring schedules, receipts, books, travel bookings, runtime state, auth telemetry). The SQLite DB is compacted afterward; restart the daemon to re-bootstrap observers and adapters.",
      confirmLabel: "Continue",
      doubleConfirm: {
        title: "Final confirmation",
        description:
          "There is no undo. Type the confirmation phrase below to proceed.",
        confirmLabel: "Factory reset",
        requireText: "RESET EVERYTHING",
      },
      successMessage: (r) => {
        const status = typeof r.status === "string" ? r.status : "reset";
        const errs = Array.isArray(r.errors) ? (r.errors as unknown[]).length : 0;
        const reloadErrs = Array.isArray(r.adapterReloadErrors)
          ? (r.adapterReloadErrors as unknown[]).length
          : 0;
        if (status === "reset_with_errors" || errs > 0 || reloadErrs > 0) {
          return `Factory reset finished with warnings. Restart the daemon to re-bootstrap observers and adapters. (${errs} reset step warning(s), ${reloadErrs} adapter reload warning(s).)`;
        }
        return "Factory reset complete. Restart the daemon to re-bootstrap observers and adapters.";
      },
    });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-destructive/40">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer select-none">
            <div className="flex items-center gap-2">
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-destructive transition-transform",
                  open && "rotate-90",
                )}
              />
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <CardTitle className="text-destructive">Danger Zone</CardTitle>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-4 pb-1">
            <p className="text-xs text-muted-foreground max-w-prose">
              Destructive actions that cannot be undone. Each action requires
              confirmation before executing.
            </p>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
            {notice && (
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {notice}
              </p>
            )}

            <DangerRow
              title="Reset all config to defaults"
              description="Restores every runtime setting to its factory default. Bootstrap values in .env (API port, data directory, log level) and integration credentials are preserved."
              icon={<RotateCcw className="h-3.5 w-3.5 mr-1" />}
              label="Reset config"
              busy={busy === "reset-config"}
              disabled={busy !== null}
              onClick={handleResetConfig}
            />

            <Separator />

            <DangerRow
              title="Delete all sessions and history"
              description="Permanently removes all non-active conversation sessions, messages, action logs, observations, notification logs, MD snapshots, and scheduled tasks. The active session is preserved."
              icon={<Trash2 className="h-3.5 w-3.5 mr-1" />}
              label="Delete history"
              busy={busy === "purge-history"}
              disabled={busy !== null}
              onClick={handlePurgeHistory}
            />

            <Separator />

            <DangerRow
              title="Reinstall context"
              description="Writes a tarball backup first, then wipes context/ (including rules/management.md) and md_file_snapshots. Conversation history, settings, and credentials are preserved. Restart the daemon to re-seed the vault from templates."
              icon={<RotateCcw className="h-3.5 w-3.5 mr-1" />}
              label="Reinstall context"
              busy={busy === "reinstall-context"}
              disabled={busy !== null}
              onClick={handleReinstallContext}
            />

            <Separator />

            <DangerRow
              title="Factory reset"
              description="Wipe everything: history, settings, context, credentials, encrypted blobs, attachments, session workdirs, backups, caches, user skills, integrations, backend configs, mail accounts, and recurring schedules. The SQLite DB is compacted afterward."
              icon={<Zap className="h-3.5 w-3.5 mr-1" />}
              label="Factory reset"
              busy={busy === "factory-reset"}
              disabled={busy !== null}
              onClick={handleFactoryReset}
            />
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function DangerRow({
  title,
  description,
  icon,
  label,
  busy,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        onClick={onClick}
        disabled={disabled}
        className="shrink-0"
      >
        {icon}
        {busy ? "Working..." : label}
      </Button>
    </div>
  );
}
