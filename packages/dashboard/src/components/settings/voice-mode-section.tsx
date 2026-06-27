"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, HardDrive, Loader2, Mic, Trash2 } from "lucide-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { VOICE_LANGUAGE_FULL, VOICE_LANGUAGE_TOP } from "@aitne/shared";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { cn, formatBytes } from "@/lib/utils";

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
export function VoiceModeSection() {
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
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
            <p className="font-medium text-warning">
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
      container: "border-warning/40 bg-warning/5",
      pill: "bg-warning/15 text-warning",
      iconBg: "text-warning",
    },
    installed: {
      container: "border-success/40 bg-success/5",
      pill: "bg-success/15 text-success",
      iconBg: "text-success",
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
