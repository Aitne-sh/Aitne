"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FolderSymlink, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DirectoryPickerField } from "@/components/directory-picker-field";
import { api, ApiError } from "@/lib/api-client";
import type {
  ContextMigrationProgressEvent,
  MigrationConflictPolicy,
  MigrationErrorBody,
  MigrationOkResponse,
  ValidateVaultPathResponse,
} from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { useSSE } from "@/providers/sse-provider";
import {
  autoSelectPolicyFor,
  canSubmitMigration,
  classifyClientPathError,
  getPrimaryActionLabel,
  type ClientPathIssue,
} from "./management-mode-dialog.logic";

type ToastFn = (
  type: "success" | "error" | "warning" | "info",
  message: string,
) => void;

interface ManagementModeDialogProps {
  currentVaultMode: "plain" | "obsidian";
  currentPrimaryVaultPath: string;
  onToast: ToastFn;
  trigger: ReactNode;
}

type TargetMode = "plain" | "obsidian";
type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid"; response: ValidateVaultPathResponse }
  | { status: "invalid"; message: string };

const VALIDATION_DEBOUNCE_MS = 250;

/**
 * The dialog that drives the Management Mode migration.
 *
 * Flow:
 *  1. User picks mode (plain / obsidian) and, for obsidian, a path.
 *  2. Confirm POSTs to `/api/setup/migrate-context`.
 *  3. Response is handled case-by-case:
 *     - `status: "migrated"` → toast, refresh config, close.
 *     - `status: "noop"` → toast (already in target state), close.
 *     - `409 sessions_active | executions_active` → show blocker list,
 *       "Wait Then Retry" re-submits.
 *     - `409 migration_in_progress` → show message, "Retry" button.
 *     - Live validation reveals target conflicts before submit and
 *       narrows the conflict-policy radio to the allowed options.
 *     - `500` with `backupPath` → show backup path prominently so the
 *       user can manually recover via the linked instructions.
 */
export function ManagementModeDialog({
  currentVaultMode,
  currentPrimaryVaultPath,
  onToast,
  trigger,
}: ManagementModeDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<TargetMode>(currentVaultMode);
  const [path, setPath] = useState<string>(currentPrimaryVaultPath);
  const [policy, setPolicy] = useState<MigrationConflictPolicy>("abort");
  const [submitting, setSubmitting] = useState(false);
  const [errorBody, setErrorBody] = useState<MigrationErrorBody | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const [progress, setProgress] = useState<ContextMigrationProgressEvent | null>(null);
  const queryClient = useQueryClient();
  const { subscribeNamedEvent } = useSSE();
  const validationSeqRef = useRef(0);

  // Reset local draft whenever the dialog opens so a stale error from a
  // previous attempt doesn't linger. Deps are scoped to `open` only —
  // reading `currentVaultMode` / `currentPrimaryVaultPath` from props
  // inside the effect uses the latest render without inviting a
  // mid-edit reset when SSE invalidates the `["config"]` cache while
  // the user is typing. (React will complain about exhaustive deps in
  // lint; the narrower-deps behavior is the intentional one.)
  useEffect(() => {
    if (open) {
      setMode(currentVaultMode);
      setPath(currentPrimaryVaultPath);
      setPolicy("abort");
      setErrorBody(null);
      setErrorStatus(null);
      setValidation({ status: "idle" });
      setProgress(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return subscribeNamedEvent("context_migration_progress", (data) => {
      setProgress(data as ContextMigrationProgressEvent);
    });
  }, [open, subscribeNamedEvent]);

  // Clear stale server-side errors when the user changes the target.
  useEffect(() => {
    if (!open) return;
    setErrorBody(null);
    setErrorStatus(null);
    setProgress(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, path]);

  useEffect(() => {
    const next = autoSelectPolicyFor(
      validation.status === "valid"
        ? validation.response.conflict?.kind
        : errorBody?.error,
    );
    if (next) setPolicy(next);
  }, [errorBody?.error, validation]);

  const pathIssue: ClientPathIssue | null = useMemo(() => {
    if (mode !== "obsidian") return null;
    return classifyClientPathError(path);
  }, [mode, path]);

  useEffect(() => {
    if (!open || mode !== "obsidian") {
      setValidation({ status: "idle" });
      return;
    }
    const trimmedPath = path.trim();
    if (trimmedPath.length === 0) {
      setValidation({ status: "idle" });
      return;
    }
    if (pathIssue) {
      setValidation({ status: "invalid", message: pathIssue.message });
      return;
    }

    const seq = ++validationSeqRef.current;
    setValidation({ status: "validating" });
    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await api.post<ValidateVaultPathResponse>(
          "/setup/validate-vault-path",
          {
            targetVaultMode: "obsidian",
            targetVaultPath: trimmedPath,
          },
        );
        if (validationSeqRef.current !== seq) return;
        setValidation({ status: "valid", response });
      } catch (err) {
        if (validationSeqRef.current !== seq) return;
        if (err instanceof ApiError) {
          const body = err.body as { message?: string } | null;
          setValidation({
            status: "invalid",
            message: body?.message ?? err.message,
          });
        } else {
          setValidation({
            status: "invalid",
            message: err instanceof Error ? err.message : "Path validation failed.",
          });
        }
      }
    }, VALIDATION_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [mode, open, path, pathIssue]);

  const liveConflict =
    validation.status === "valid" ? validation.response.conflict : null;
  const fallbackConflict =
    errorBody?.error === "target_has_agent_file_conflicts"
      ? {
          kind: "target_has_agent_file_conflicts" as const,
          entries: errorBody.entries ?? [],
          allowedPolicies: ["overwrite_agent_files"] as MigrationConflictPolicy[],
        }
      : errorBody?.error === "target_has_unrelated_files"
        ? {
            kind: "target_has_unrelated_files" as const,
            entries: errorBody.entries ?? [],
            allowedPolicies: ["merge", "overwrite_agent_files"] as MigrationConflictPolicy[],
          }
        : null;

  const showPolicyPicker =
    liveConflict !== null || fallbackConflict !== null;

  const allowedPolicies: MigrationConflictPolicy[] =
    liveConflict?.allowedPolicies
    ?? fallbackConflict?.allowedPolicies
    ?? ["abort", "merge", "overwrite_agent_files"];
  const conflictEntries = liveConflict?.entries ?? fallbackConflict?.entries ?? [];
  const normalizedTargetPath =
    validation.status === "valid" ? validation.response.targetDir : path.trim();

  const samePath =
    mode === currentVaultMode
    && (mode === "plain"
      || normalizedTargetPath === currentPrimaryVaultPath.trim());

  const canSubmit = canSubmitMigration({
    submitting,
    samePath,
    mode,
    path,
    pathIssue,
    validationStatus: validation.status,
    policy,
    allowedPolicies,
  });

  async function handleSubmit() {
    setSubmitting(true);
    setErrorBody(null);
    setErrorStatus(null);
    try {
      const payload: {
        targetVaultMode: TargetMode;
        targetVaultPath?: string;
        conflictPolicy: MigrationConflictPolicy;
      } = {
        targetVaultMode: mode,
        conflictPolicy: policy,
      };
      if (mode === "obsidian") {
        payload.targetVaultPath = path.trim();
      }
      setProgress(null);
      const res = await api.post<MigrationOkResponse>(
        "/setup/migrate-context",
        payload,
      );
      if (res.status === "noop") {
        onToast("info", "No change needed — already in the target state.");
      } else {
        const { filesMoved, bytes, durationMs, manualActionRequired } = res;
        const kb = (bytes / 1024).toFixed(1);
        const summary = `Moved ${filesMoved} file${filesMoved === 1 ? "" : "s"} (${kb} KiB) in ${durationMs} ms.`;
        if (manualActionRequired) {
          onToast(
            "warning",
            `${summary} Observers failed to resume — restart the daemon.`,
          );
        } else {
          onToast("success", summary);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = (err.body ?? {}) as MigrationErrorBody;
        setErrorBody(body);
        setErrorStatus(err.status);
      } else {
        setErrorBody({
          error: "internal_error",
          message:
            err instanceof Error ? err.message : "Unexpected error.",
        });
        setErrorStatus(500);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Change Management Mode</SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {/* Mode toggle */}
          <section>
            <p className="text-sm font-medium text-foreground">
              Where should the agent store its personal data?
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2">
              {(["plain", "obsidian"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    mode === m
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50",
                  )}
                >
                  <span className="block font-medium">
                    {m === "plain"
                      ? "This app manages it"
                      : "Obsidian-style local directory"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {m === "plain"
                      ? "Data lives in ~/.personal-agent/context. Only this app reads and writes."
                      : "Data lives in a folder you pick (iCloud, Dropbox, Google Drive, or a plain local path)."}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* Path input (obsidian only) */}
          {mode === "obsidian" && (
            <section data-testid="path-input-section">
              <label
                htmlFor="mm-path-input"
                className="text-sm font-medium text-foreground"
              >
                Directory path
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                Use the folder picker to select a local directory. Cloud-sync
                folders (iCloud Drive, Dropbox, OneDrive, Google Drive) are
                supported. You can paste an absolute path if your desktop
                blocks native dialogs.
              </p>
              <DirectoryPickerField
                id="mm-path-input"
                value={path}
                onChange={setPath}
                title="Choose primary vault directory"
                placeholder="Choose a folder for the primary vault"
                defaultPath={currentPrimaryVaultPath || undefined}
                className="mt-2"
                disabled={submitting}
              />
              {pathIssue && path.length > 0 && (
                <p className="mt-1 text-xs text-destructive">
                  {pathIssue.message}
                </p>
              )}
              {mode === "obsidian" && !pathIssue && validation.status === "validating" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Checking the path and target directory contents…
                </p>
              )}
              {mode === "obsidian" && !pathIssue && validation.status === "invalid" && (
                <p className="mt-1 text-xs text-destructive">
                  {validation.message}
                </p>
              )}
              {mode === "obsidian"
                && validation.status === "valid"
                && validation.response.fsInfo?.isCloudSync && (
                  <Alert variant="info" className="mt-2">
                    <p>
                      Cloud sync detected:
                      {" "}
                      <strong>{validation.response.fsInfo.isCloudSync}</strong>
                      . Migration is supported, but performance can be slower
                      than a local SSD.
                    </p>
                  </Alert>
                )}
            </section>
          )}

          {/* Conflict policy — enabled as soon as live inspection finds a conflict */}
          {showPolicyPicker && (
            <section data-testid="policy-picker">
              <p className="text-sm font-medium text-foreground">
                Target directory already has content — pick a conflict policy:
              </p>
              <div className="mt-2 space-y-2">
                {allowedPolicies.map((p) => (
                  <label
                    key={p}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm hover:bg-muted/40"
                  >
                    <input
                      type="radio"
                      name="conflict-policy"
                      value={p}
                      checked={policy === p}
                      onChange={() => setPolicy(p)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block font-medium">
                        {policyLabel(p)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {policyDescription(p)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {conflictEntries.length > 0 && (
                <div className="mt-2 rounded border border-border bg-muted/30 p-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Conflicting entries ({conflictEntries.length}):
                  </p>
                  <ul className="mt-1 max-h-32 overflow-y-auto text-xs text-muted-foreground">
                    {conflictEntries.slice(0, 50).map((entry) => (
                      <li key={entry} className="font-mono">
                        {entry}
                      </li>
                    ))}
                    {conflictEntries.length > 50 && (
                      <li className="italic">
                        …and {conflictEntries.length - 50} more
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Backup notice */}
          <Alert variant="info">
            <div>
              <p className="font-medium">Backup made before the move</p>
              <p className="mt-0.5">
                We&apos;ll back up your current data under <code>~/.personal-agent/migration-backups/</code> for 7 days before moving. If the migration fails, all files are restored automatically.
              </p>
            </div>
          </Alert>

          {progress && (
            <Alert
              variant={
                progress.status === "failed"
                  ? "error"
                  : progress.status === "completed"
                    ? "success"
                    : "info"
              }
            >
              <div>
                <p className="font-medium">
                  Migration progress: {progress.progress}%
                </p>
                <p className="mt-0.5">{progress.message}</p>
              </div>
            </Alert>
          )}

          {/* Error display */}
          {errorBody && (
            <ErrorPanel
              status={errorStatus}
              body={errorBody}
              onDismiss={() => {
                setErrorBody(null);
                setErrorStatus(null);
              }}
            />
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="mm-confirm"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Migrating…
                </>
              ) : getPrimaryActionLabel(errorBody?.error, false) === "Wait Then Retry" ? (
                <>
                  <FolderSymlink className="h-4 w-4" />
                  Wait Then Retry
                </>
              ) : getPrimaryActionLabel(errorBody?.error, false) === "Retry" ? (
                <>
                  <FolderSymlink className="h-4 w-4" />
                  Retry
                </>
              ) : (
                <>
                  <FolderSymlink className="h-4 w-4" />
                  Confirm &amp; Migrate
                </>
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function policyLabel(p: MigrationConflictPolicy): string {
  switch (p) {
    case "abort":
      return "Abort on any conflict";
    case "merge":
      return "Merge (preserve existing target files)";
    case "overwrite_agent_files":
      return "Overwrite agent files at target";
  }
}

function policyDescription(p: MigrationConflictPolicy): string {
  switch (p) {
    case "abort":
      return "Stop if the target has any unrelated content.";
    case "merge":
      return "Move source files alongside existing target content. Unrelated target files are left in place.";
    case "overwrite_agent_files":
      return "If target has files with the same names as the agent's, the target copies are archived into the backup and the source versions take their place.";
  }
}

export function ErrorPanel({
  status,
  body,
  onDismiss,
}: {
  status: number | null;
  body: MigrationErrorBody;
  onDismiss: () => void;
}) {
  const severity: "error" | "warning" =
    status === 409 ? "warning" : "error";
  return (
    <Alert variant={severity}>
      <div className="space-y-1.5">
        <p className="font-medium">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {headlineFor(body)}
        </p>
        <p>{body.message}</p>

        {body.error === "sessions_active" && body.sessions && body.sessions.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs">
            {body.sessions.map((s) => (
              <li key={s.id}>
                Session #{s.id} — {s.scope} / {s.scope_key}
              </li>
            ))}
          </ul>
        )}
        {body.error === "executions_active"
          && body.executions
          && body.executions.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {body.executions.map((e, i) => (
                <li key={i}>{JSON.stringify(e)}</li>
              ))}
            </ul>
          )}

        {body.backupPath && (
          <div className="mt-2 rounded bg-muted/40 p-2 text-xs">
            <p className="font-medium">Backup preserved at:</p>
            <code className="break-all">{body.backupPath}</code>
            <p className="mt-1 text-muted-foreground">
              Manual recovery: copy files back from this directory if the automatic rollback did not complete.
            </p>
            <a
              href="#mm-recovery-instructions"
              className="mt-2 inline-block underline underline-offset-2"
            >
              Recovery instructions
            </a>
          </div>
        )}

        {body.rollbackStatus === "manual_required" && (
          <p className="mt-1 text-xs font-medium">
            Automatic rollback did not complete. Please restore from the backup above, then restart the daemon.
          </p>
        )}

        {body.backupPath && (
          <ol
            id="mm-recovery-instructions"
            className="list-decimal pl-4 text-xs text-muted-foreground"
          >
            <li>Stop the daemon before touching the vault contents.</li>
            <li>Copy the backup contents back to the original location if the automatic rollback did not finish.</li>
            <li>Re-open Settings → Management Mode and retry the migration once the files are back in place.</li>
          </ol>
        )}

        <div className="pt-2">
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Alert>
  );
}

function headlineFor(body: MigrationErrorBody): string {
  switch (body.error) {
    case "sessions_active":
      return "Active sessions block migration";
    case "executions_active":
      return "In-flight executions block migration";
    case "migration_in_progress":
      return "Another migration is already running";
    case "target_has_unrelated_files":
      return "Target has unrelated files";
    case "target_has_agent_file_conflicts":
      return "Target has conflicting files";
    case "target_invalid":
      return "Target path is invalid";
    case "backup_failed":
      return "Backup creation failed";
    case "move_failed":
    case "cross_fs_partial_failure":
    case "icloud_file_evicted":
      return "File move failed";
    case "move_verification_failed":
      return "Move verification failed";
    case "db_rewrite_failed":
      return "Database rewrite failed";
    case "settings_update_failed":
      return "Settings update failed";
    case "invalid_request":
      return "Request was rejected";
    case "internal_error":
      return "Unexpected error";
  }
}
