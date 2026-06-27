"use client";

import { useState } from "react";
import { CheckCircle2, FolderTree, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useAcknowledgeVaultRestructure,
  useVaultRestructureStatus,
} from "@/lib/hooks/use-vault-restructure";

/**
 * CONTEXT_VAULT_REDESIGN_PLAN.md §11.3.4 / V16 — Obsidian-mode consent
 * surface.
 *
 * Sits inside `<LayoutShell>` and renders only when the daemon reports
 * a pending consent row. Hidden during the initial-setup wizard so a
 * brand-new install isn't presented with a "we're about to reorganise
 * your Obsidian sidebar" dialog before the user has even pointed the
 * daemon at a vault.
 *
 * Two states:
 *   1. **Pending** — the daemon deferred the migration on this boot.
 *      Modal explains what will happen, the user confirms, and we POST
 *      the ack. Daemon will run the restructure on next boot.
 *   2. **Restart prompt** — after the POST returns
 *      `restartRequired: true`, swap the modal body to a restart hint.
 *      The modal stays open until the user dismisses it (or the daemon
 *      restarts and the pending-consent row vanishes).
 *
 * Failure modes:
 *   - Network/API error → inline message; user can retry. We never
 *     auto-close on error.
 *   - `alreadyAcknowledged: true` (race vs CLI / env) → close the modal.
 */
export function VaultRestructureModal({ enabled }: { enabled: boolean }) {
  const status = useVaultRestructureStatus();
  const ack = useAcknowledgeVaultRestructure();
  const [dismissed, setDismissed] = useState(false);
  const [showRestart, setShowRestart] = useState(false);

  // Suppressed during initial-setup wizard.
  if (!enabled) return null;
  // No data yet, or no pending row — render nothing.
  if (!status.data) return null;
  const pending = status.data.pendingConsent;
  if (!pending) return null;
  // User dismissed the modal this session; respect that until the
  // daemon clears the row (next interval) or until they reopen via
  // page reload.
  if (dismissed) return null;

  const handleAck = async () => {
    try {
      const result = await ack.mutateAsync();
      if (result.restartRequired) {
        setShowRestart(true);
      } else if (result.alreadyAcknowledged) {
        setDismissed(true);
      }
    } catch {
      // ack.error is rendered inline below; no further action.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setDismissed(true);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="h-5 w-5 text-primary" />
            {showRestart
              ? "Consent recorded — restart the daemon"
              : "Aitne vault layout update"}
          </DialogTitle>
          <DialogDescription>
            {showRestart
              ? "The vault restructure will run on the next daemon boot."
              : "This release reorganises Aitne's context vault. Because you're on Obsidian mode, this changes folders you see in your Obsidian sidebar."}
          </DialogDescription>
        </DialogHeader>

        {!showRestart && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Aitne is migrating to a six-class layout:
            </p>
            <ul className="ml-1 list-inside space-y-1 text-xs text-muted-foreground">
              <li>
                <code className="rounded bg-muted px-1">identity/</code> — who
                you are (was <code>user/</code>)
              </li>
              <li>
                <code className="rounded bg-muted px-1">state/</code> — today,
                inbox, scratch (was top-level + <code>inbox/</code> +{" "}
                <code>agent/scratch/</code>)
              </li>
              <li>
                <code className="rounded bg-muted px-1">plans/</code> —
                roadmap and projects (was <code>projects/</code>)
              </li>
              <li>
                <code className="rounded bg-muted px-1">journal/</code> —
                daily, weekly, monthly, agent journal (was{" "}
                <code>daily/</code> / <code>weekly/</code> / ...)
              </li>
              <li>
                <code className="rounded bg-muted px-1">knowledge/</code> —
                wiki, repos, dossiers, entities (was <code>wiki/</code> +{" "}
                <code>dossiers/</code> + <code>git/</code>)
              </li>
              <li>
                <code className="rounded bg-muted px-1">policies/</code> —
                rules, routines, integrations, skills (was{" "}
                <code>rules/</code> + <code>routines/</code> +{" "}
                <code>integrations.md</code>)
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">
              A full backup of your vault is written to{" "}
              <code className="rounded bg-muted px-1">
                {pending.contextDir.replace(/\/context\/?$/, "")}/migration-backups/
              </code>{" "}
              before any move runs. The migration is idempotent and
              forward-only.
            </p>
            <p className="text-xs text-muted-foreground">
              File contents are preserved exactly — only locations change.
              Existing Obsidian wiki-links and aliases continue to resolve
              for one release through an in-process compatibility layer.
            </p>
          </div>
        )}

        {showRestart && (
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs">
                Your consent is saved. Run{" "}
                <code className="rounded bg-success/15 px-1">
                  aitne restart
                </code>{" "}
                in your terminal (or stop and start the daemon) to apply the
                restructure. Your vault is unchanged until the next boot.
              </p>
            </div>
          </div>
        )}

        {ack.error && !showRestart && (
          <p className="text-xs text-destructive">
            Failed to record consent:{" "}
            {(ack.error as Error | undefined)?.message ?? "unknown error"}
          </p>
        )}

        <DialogFooter>
          {showRestart ? (
            <Button
              type="button"
              onClick={() => setDismissed(true)}
              size="sm"
            >
              Got it
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDismissed(true)}
                size="sm"
                disabled={ack.isPending}
              >
                Not now
              </Button>
              <Button
                type="button"
                onClick={handleAck}
                size="sm"
                disabled={ack.isPending}
              >
                {ack.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                Confirm and continue
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
