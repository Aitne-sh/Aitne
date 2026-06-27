"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Mail, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { formatAbsoluteTime, formatRelativeTime, parseUtcDate } from "@/lib/utils";
import type { MailAccount } from "./types";
import { useInvalidateMail, useMailAccountHealth } from "./use-mail-data";

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

function isStale(lastPollAtUtc: string): boolean {
  return Date.now() - parseUtcDate(lastPollAtUtc).getTime() > STALE_THRESHOLD_MS;
}

const STATUS_BADGE = {
  healthy: { variant: "green" as const, label: "Healthy" },
  requires_consent: { variant: "amber" as const, label: "Re-authenticate" },
  degraded: { variant: "red" as const, label: "Degraded" },
};

interface AccountRowProps {
  account: MailAccount;
  /** True for the row that the re-consent DM deep-linked to. */
  highlight?: boolean;
  /** Hide the active toggle (the shared-OAuth Gmail row has no per-account control). */
  hideActive?: boolean;
  /**
   * Hide health detail. Kept for the Gmail card's summary view where the
   * per-account `/health` endpoint would duplicate the card-level status.
   */
  hideHealth?: boolean;
  /** Optional re-authenticate handler shown when account is `requires_consent`. */
  onReauthenticate?: () => void | Promise<void>;
  /**
   * If true, deleting this row will remove the last account of its kind.
   * The confirm dialog warns the user, and `onAfterRemove` may auto-disable
   * the kind in `enabledMailProviders` to keep the auth-then-enable contract.
   */
  isLastOfKind?: boolean;
  /**
   * Fires after a successful DELETE. Parents use this to auto-disable the
   * kind when the last account is removed.
   */
  onAfterRemove?: () => void | Promise<void>;
}

export function AccountRow({
  account,
  highlight = false,
  hideActive = false,
  hideHealth = false,
  onReauthenticate,
  isLastOfKind = false,
  onAfterRemove,
}: AccountRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const confirm = useConfirm();
  const invalidate = useInvalidateMail();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (highlight && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlight]);

  const healthQuery = useMailAccountHealth(account.id, !hideHealth);
  const health = healthQuery.data ?? null;

  const isImap = account.kind === "yahoo" || account.kind === "icloud";
  const [refreshFormOpen, setRefreshFormOpen] = useState(false);

  const toggleActive = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/mail/accounts/${encodeURIComponent(account.id)}`, {
        active: !account.active,
      });
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const lastOfKindNote = isLastOfKind
      ? " This is the last account of its kind, so the provider will also be disabled — re-authenticate and toggle Enable to bring it back."
      : "";
    const ok = await confirm({
      title: `Remove ${account.email}?`,
      description:
        "Local credentials are revoked and the account is removed from this app. The mailbox itself is untouched at the provider." +
        lastOfKindNote,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    setError(null);
    setBusy(true);
    try {
      await api.delete(`/mail/accounts/${encodeURIComponent(account.id)}`);
      if (onAfterRemove) await onAfterRemove();
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  };

  const status = STATUS_BADGE[account.authStatus];
  const idleIndicator = (() => {
    if (hideHealth) return null;
    if (!account.idleEnabled) return null; // OAuth-based providers don't IDLE
    if (health?.idleFallbackUntilUtc) {
      return { label: "polling (IDLE down)", variant: "amber" as const };
    }
    return { label: "IDLE", variant: "green" as const };
  })();

  return (
    <div
      ref={ref}
      id={`account-${account.id}`}
      className={
        "rounded-md border p-3 transition-colors " +
        (highlight
          ? "border-warning ring-1 ring-warning/40"
          : "border-border")
      }
    >
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">
              {account.email}
            </span>
            {account.label && (
              <span className="text-xs text-muted-foreground">
                ({account.label})
              </span>
            )}
            <Badge variant={status.variant}>{status.label}</Badge>
            {idleIndicator && (
              <Badge variant={idleIndicator.variant}>
                {idleIndicator.label}
              </Badge>
            )}
          </div>
          {!hideHealth && <HealthSummary health={health} />}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!hideActive && (
            <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={account.active}
                disabled={busy}
                onChange={() => void toggleActive()}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Active
            </label>
          )}
          {account.authStatus === "requires_consent" &&
            (isImap ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRefreshFormOpen((v) => !v)}
                className="h-7 text-xs px-2"
              >
                {refreshFormOpen ? "Cancel" : "Re-authenticate"}
              </Button>
            ) : (
              onReauthenticate && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onReauthenticate()}
                  className="h-7 text-xs px-2"
                >
                  Re-authenticate
                </Button>
              )
            ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void remove()}
            disabled={busy}
            className="h-7 px-2"
            title="Remove account"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="error" className="mt-2">
          {error}
        </Alert>
      )}
      {isImap && refreshFormOpen && (
        <ImapRefreshForm
          accountId={account.id}
          onSuccess={() => {
            setRefreshFormOpen(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function ImapRefreshForm({
  accountId,
  onSuccess,
}: {
  accountId: string;
  onSuccess: () => void;
}) {
  const [appPassword, setAppPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/config/mail/app-password/${encodeURIComponent(accountId)}/refresh`,
        { appPassword: appPassword.trim() },
      );
      setAppPassword("");
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3 space-y-2">
      <p className="text-xs text-foreground">
        Generate a new app password at the provider, paste it here, and the
        daemon will swap it in place — the polling cursor and account ID stay
        intact.
      </p>
      <Input
        type="password"
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
        placeholder="paste new app password"
        className="h-8 text-xs"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={busy || appPassword.trim().length === 0}
          className="h-7 text-xs px-3"
        >
          {busy ? "Verifying…" : "Update password"}
        </Button>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

function HealthSummary({ health }: { health: ReturnType<typeof useMailAccountHealth>["data"] | null }) {
  if (!health) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        Waiting for first poll…
      </p>
    );
  }
  const lastPoll = health.lastPollAtUtc;
  const stale = lastPoll != null && isStale(lastPoll);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>
        last poll:{" "}
        {lastPoll ? (
          <span
            title={formatAbsoluteTime(lastPoll)}
            className={
              stale ? "text-warning" : undefined
            }
          >
            {formatRelativeTime(lastPoll)}
            {stale ? " · stale" : ""}
          </span>
        ) : (
          <span>never</span>
        )}
      </span>
      {health.consecutiveErrorCount > 0 && (
        <span className="text-warning">
          {health.consecutiveErrorCount} consecutive errors
        </span>
      )}
      {health.lastError && (
        <span
          className="flex items-center gap-1 text-destructive max-w-full truncate"
          title={health.lastError}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {health.lastError}
        </span>
      )}
    </div>
  );
}
