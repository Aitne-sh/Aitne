"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, RotateCcw, Trash2, Zap } from "lucide-react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { ReinstallContextPlanResponse } from "@/lib/api-types";
import { formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { useConfirm } from "@/components/shared/confirm-dialog";

/**
 * Danger Zone — destructive maintenance actions, split out of the former
 * monolithic /settings/advanced page (DASHBOARD_UI_REFRESH_DESIGN.md
 * follow-up #1). On the old combined page the section sat behind a
 * Collapsible as friction against accidental discovery; as a dedicated page
 * the navigation itself is the opt-in, so the card renders open — the
 * per-action confirm dialogs (double-confirm + requireText for the
 * irreversible ones) remain the real guard.
 */
export default function DangerZoneSettingsPage() {
  return (
    <>
      <PageHeader
        title="Danger Zone"
        description="Destructive maintenance actions. Every action asks for confirmation; factory reset and context reinstall additionally require a typed phrase."
      />
      <DangerZone />
    </>
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
        "Wipes everything on this device: conversation history, action logs, runtime settings, context files (including policies/management.md), keychain secrets, encrypted blobs, uploaded attachments, session and skill-optimizer workdirs, all backups, caches, user skills, the managed Codex Azure config, the Whisper model cache, and every user-data table (backends, mail accounts, recurring schedules, receipts, books, travel bookings, runtime state, auth telemetry). The SQLite DB is compacted afterward; restart the daemon to re-bootstrap observers and adapters.",
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
    <Card className="border-destructive/40">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
        </div>
      </CardHeader>
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
          description="Writes a tarball backup first, then wipes context/ (including policies/management.md) and md_file_snapshots. Conversation history, settings, and credentials are preserved. Restart the daemon to re-seed the vault from templates."
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
    </Card>
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
