"use client";

/**
 * Phase B-4 dashboard — experimental purchase confirmations.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.8 / §13 step 55.
 * BROWSER_TASK_REDESIGN_PLAN.md §9a.6 — post-rename: the legacy
 * workflow registry is gone; the audit-join column
 * `browser_automation_purchase_tokens.workflow_invocation_id` is kept
 * by name (Option b) for forward-compat and now covers EITHER a
 * legacy workflow invocation id OR a `browser_task.id`. The dashboard
 * never renders that value as a user-visible label — see the
 * `workflowInvocationId` field note below — so the post-rename
 * semantic stretch stays invisible to the user.
 *
 * Surfaces:
 *   - Global enable toggle with experimental-danger confirmation modal.
 *   - Per-site B-4 config (enabled flag + currency + daily token/spend
 *     caps + optional per-transaction cap override).
 *   - Primary channel selection (only primary channels receive the
 *     confirmation DM; at least one is required to enable B-4).
 *   - Pending purchase-token panel — PURCHASE tokens ONLY. Lite-final-
 *     confirm tokens minted by browser tasks (BROWSER_TASK_REDESIGN_PLAN.md
 *     §5 "Final-confirm tokens are NOT B-4 purchase tokens") share the
 *     `!~xxxxxxxx` UX but live in their own DB table; they surface on
 *     `/browser-tasks/<id>` instead and the panel description points
 *     users there. §12 Open Q#8 (v0.2) tracks unifying the two panels.
 *   - Recent purchases + cancellations (audit trail).
 *
 * Explicitly NOT surfaced:
 *   - The raw `!~xxxxxxxx` token. Only the server-side `jti` and the
 *     delivery state are returned by `GET /purchase-tokens`. An
 *     attacker who briefly compromises dashboard credentials cannot
 *     extract live tokens via this page.
 *   - A "mint a token" form. Tokens are minted by the daemon during a
 *     B-4 purchase invocation (originally a workflow run, now also a
 *     `browser_task`-triggered checkout); the dashboard's role is
 *     configuration + audit, never issuance.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";

const ENABLED_KEY = ["browser-automation-b4-enabled"] as const;
const SITE_CONFIGS_KEY = ["browser-automation-b4-site-configs"] as const;
const PRIMARY_CHANNELS_KEY = [
  "browser-automation-b4-primary-channels",
] as const;
const PENDING_TOKENS_KEY = ["browser-automation-purchase-tokens"] as const;

// ── Types from the daemon's wire shapes ─────────────────────────────────

interface B4EnabledResponse {
  enabled: boolean;
  primaryChannelCount: number;
}

interface B4SiteConfigRow {
  siteKey: string;
  enabled: boolean;
  currency: string;
  dailyTokenCap: number;
  dailySpendCapMinor: number;
  perTxCapMinorOverride: number | null;
  updatedAt: number;
}

interface PrimaryChannelRow {
  platform: string;
  channelId: string;
  setAt: number;
}

interface PurchaseTokenWire {
  jti: string;
  /**
   * §9a.6 (Option b) — post-rename this is the legacy workflow
   * invocation id OR a `browser_task.id`. The wire-field name is
   * preserved for forward-compat with the daemon's row shape; the
   * dashboard never renders it as a user-visible label.
   */
  workflowInvocationId: string;
  siteKey: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  maxAmountMinor: number;
  currency: string;
  notesForUser: string | null;
  preScreenshotPath: string;
  postScreenshotPath: string | null;
  deliveredChannels: readonly string[];
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedViaChannel: string | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  confirmedAmountMinor: number | null;
  orderId: string | null;
}

interface PurchaseTokenListResponse {
  pending: PurchaseTokenWire[];
  recent: PurchaseTokenWire[];
  now: number;
}

// ── Currency formatting (mirrors the daemon's ZERO_DECIMAL_CURRENCIES) ──

const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "RWF", "UGX",
  "BIF", "DJF", "GNF", "KMF", "MGA", "XAF", "XOF", "XPF",
]);

function formatAmount(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(code);
  const major = zeroDecimal
    ? minor.toLocaleString("en-US")
    : (minor / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return code === "JPY" ? `¥${major}` : `${code} ${major}`;
}

function formatCountdown(deadlineMs: number, nowMs: number): string {
  const ms = Math.max(0, deadlineMs - nowMs);
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

// ── Queries ─────────────────────────────────────────────────────────────

function useB4Enabled() {
  return useQuery({
    queryKey: ENABLED_KEY,
    queryFn: () =>
      api.get<B4EnabledResponse>("/browser-automation/b4/enabled"),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

function useSiteConfigs() {
  return useQuery({
    queryKey: SITE_CONFIGS_KEY,
    queryFn: () =>
      api.get<{ rows: B4SiteConfigRow[] }>(
        "/browser-automation/b4/site-configs",
      ),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

function usePrimaryChannels() {
  return useQuery({
    queryKey: PRIMARY_CHANNELS_KEY,
    queryFn: () =>
      api.get<{ rows: PrimaryChannelRow[] }>(
        "/browser-automation/b4/primary-channels",
      ),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

function usePurchaseTokens(enabled: boolean) {
  return useQuery({
    queryKey: PENDING_TOKENS_KEY,
    queryFn: () =>
      api.get<PurchaseTokenListResponse>("/browser-automation/purchase-tokens"),
    refetchInterval: enabled ? 3_000 : 30_000,
    staleTime: 1_000,
    enabled: true,
  });
}

// ── Page ────────────────────────────────────────────────────────────────

export default function B4Page(): React.ReactElement {
  const enabled = useB4Enabled();
  const sites = useSiteConfigs();
  const primary = usePrimaryChannels();
  const tokens = usePurchaseTokens(Boolean(enabled.data?.enabled));
  const [modalOpen, setModalOpen] = useState(false);

  const hasAnyPending = (tokens.data?.pending.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <Link
        href="/settings/integrations/browser-history-managed"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Browser Automation
      </Link>

      <PageHeader
        title="Experimental purchase (B-4)"
        description="DM-token-gated checkout confirmations. Aitne can be tricked. The DM-token guard is experimental and bypassable if the daemon or messaging platform is compromised. Money lost via approved purchases cannot be recovered."
      />

      <Alert variant="warning" className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5" aria-hidden />
        <div className="space-y-1 text-sm">
          <div className="font-semibold">
            Experimental — confirm with full understanding
          </div>
          <p>
            Every purchase requires a fresh single-use confirmation token the
            daemon mints AFTER the pre-confirm screenshot. The user types
            the exact token back in DM. Hard-deny categories from parent
            plan §23 (banking, brokerages, government, healthcare, identity
            / legal, generic payment processors not bound to a registered
            commerce workflow) remain absolutely denied — no token
            override possible.
          </p>
          <p>
            You are solely responsible for every approval you type. Aitne
            cannot reverse a confirmed purchase.
          </p>
        </div>
      </Alert>

      {/* ── Global enable toggle ──────────────────────────────────────── */}
      <EnableCard
        enabled={enabled.data?.enabled ?? false}
        primaryChannelCount={enabled.data?.primaryChannelCount ?? 0}
        loading={enabled.isLoading}
        onRequestToggle={(next) => {
          if (next) setModalOpen(true);
          else {
            void api
              .post<B4EnabledResponse>(
                "/browser-automation/b4/enabled",
                { enabled: false },
              )
              .finally(() => enabled.refetch());
          }
        }}
      />

      <ExperimentalEnableModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onConfirm={async () => {
          await api.post<B4EnabledResponse>(
            "/browser-automation/b4/enabled",
            { enabled: true, acknowledge: true },
          );
          await enabled.refetch();
          setModalOpen(false);
        }}
        primaryChannelCount={enabled.data?.primaryChannelCount ?? 0}
      />

      <Separator />

      {/* ── Per-site config ──────────────────────────────────────────── */}
      <SiteConfigsCard
        rows={sites.data?.rows ?? []}
        loading={sites.isLoading}
      />

      <Separator />

      {/* ── Primary channels ─────────────────────────────────────────── */}
      <PrimaryChannelsCard
        rows={primary.data?.rows ?? []}
        loading={primary.isLoading}
      />

      <Separator />

      {/* ── Pending tokens ───────────────────────────────────────────── */}
      <PendingTokensCard
        tokens={tokens.data?.pending ?? []}
        // Fall back to the server-reported `now` so the initial render
        // stays pure; the live countdown ticks via the per-row setInterval.
        nowMs={tokens.data?.now ?? 0}
        loading={tokens.isLoading}
        hasAnyPending={hasAnyPending}
      />

      <Separator />

      {/* ── Recent purchases / audit ─────────────────────────────────── */}
      <RecentPurchasesCard
        tokens={tokens.data?.recent ?? []}
        loading={tokens.isLoading}
      />
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────

function EnableCard(props: {
  enabled: boolean;
  primaryChannelCount: number;
  loading: boolean;
  onRequestToggle: (next: boolean) => void;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {props.enabled ? (
              <>
                <ShieldCheck className="h-4 w-4 text-green-600" aria-hidden />
                Master toggle: ENABLED
              </>
            ) : (
              <>
                <ShieldAlert
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden
                />
                Master toggle: DISABLED
              </>
            )}
          </div>
          <div className="text-sm text-muted-foreground">
            {props.primaryChannelCount} primary channel
            {props.primaryChannelCount === 1 ? "" : "s"} configured.
            {props.primaryChannelCount === 0
              ? " Add a primary channel before enabling."
              : ""}
          </div>
        </div>
        <Button
          variant={props.enabled ? "outline" : "default"}
          disabled={
            props.loading ||
            (!props.enabled && props.primaryChannelCount === 0)
          }
          onClick={() => props.onRequestToggle(!props.enabled)}
        >
          {props.enabled ? "Disable" : "Enable"}
        </Button>
      </CardHeader>
    </Card>
  );
}

function ExperimentalEnableModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  primaryChannelCount: number;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={(v) => !v && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" aria-hidden />
            Enable experimental purchase confirmations?
          </DialogTitle>
          <DialogDescription className="space-y-3 pt-2 text-sm">
            <p>
              Enabling B-4 lets Aitne complete checkouts on your behalf when
              you approve via DM. Aitne can be tricked. The DM-token guard
              is experimental and bypassable if the daemon or messaging
              platform is compromised.
            </p>
            <p>
              Money lost via approved purchases cannot be recovered by
              Aitne. You are solely responsible for every approval you type.
            </p>
            <p>
              {props.primaryChannelCount} primary channel
              {props.primaryChannelCount === 1 ? "" : "s"} will receive
              every confirmation DM.
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy || props.primaryChannelCount === 0}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "I understand — Enable"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SiteConfigsCard(props: {
  rows: B4SiteConfigRow[];
  loading: boolean;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Per-site configuration</h2>
            <p className="text-sm text-muted-foreground">
              Currency, daily token + spend caps per site_key. Caps are
              enforced atomically at token-issuance time.
            </p>
          </div>
          {props.loading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="mt-3 space-y-3">
          {props.rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No sites configured yet. After signing in to a site via the
              B-2.5 connect flow, return here to opt that site into B-4.
            </div>
          ) : (
            props.rows.map((row) => (
              <SiteConfigEditor key={row.siteKey} initial={row} />
            ))
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function SiteConfigEditor(props: {
  initial: B4SiteConfigRow;
}): React.ReactElement {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(props.initial.enabled);
  const [currency, setCurrency] = useState(props.initial.currency);
  const [dailyTokenCap, setDailyTokenCap] = useState(
    props.initial.dailyTokenCap,
  );
  const [dailySpendCapMinor, setDailySpendCapMinor] = useState(
    props.initial.dailySpendCapMinor,
  );
  const [perTxCap, setPerTxCap] = useState<number | "">(
    props.initial.perTxCapMinorOverride ?? "",
  );

  const mutation = useMutation({
    mutationFn: async () =>
      api.patch<{ row: B4SiteConfigRow }>(
        `/browser-automation/sites/${props.initial.siteKey}/b4-config`,
        {
          enabled,
          currency: currency.toUpperCase(),
          dailyTokenCap,
          dailySpendCapMinor,
          perTxCapMinorOverride: perTxCap === "" ? null : perTxCap,
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SITE_CONFIGS_KEY });
    },
  });

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="gray">{props.initial.siteKey}</Badge>
          {enabled ? (
            <Badge>enabled</Badge>
          ) : (
            <Badge variant="gray">disabled</Badge>
          )}
        </div>
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Enabled</span>
          <select
            value={enabled ? "1" : "0"}
            onChange={(e) => setEnabled(e.currentTarget.value === "1")}
            className="rounded-md border bg-background px-2 py-1"
          >
            <option value="1">enabled</option>
            <option value="0">disabled</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Currency (ISO-4217)
          </span>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
            maxLength={3}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Daily token cap
          </span>
          <Input
            type="number"
            min={1}
            max={100}
            value={dailyTokenCap}
            onChange={(e) =>
              setDailyTokenCap(Number(e.currentTarget.value) || 1)
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Daily spend cap (minor)
          </span>
          <Input
            type="number"
            min={0}
            value={dailySpendCapMinor}
            onChange={(e) =>
              setDailySpendCapMinor(Number(e.currentTarget.value) || 0)
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Per-tx cap override
          </span>
          <Input
            type="number"
            min={0}
            value={perTxCap}
            placeholder="(unset)"
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v === "") setPerTxCap("");
              else setPerTxCap(Number(v));
            }}
          />
        </label>
      </div>
      {mutation.isError && (
        <div className="mt-2 text-xs text-destructive">
          Save failed. Check the daemon log for details.
        </div>
      )}
    </div>
  );
}

function PrimaryChannelsCard(props: {
  rows: PrimaryChannelRow[];
  loading: boolean;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Primary channels</h2>
            <p className="text-sm text-muted-foreground">
              Only these DM channels receive a B-4 confirmation request.
              At least one is required to enable the master toggle.
            </p>
          </div>
          {props.loading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="mt-3 space-y-2">
          {props.rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No primary channels configured. Mark a channel primary from
              the messaging settings page or via the API.
            </div>
          ) : (
            props.rows.map((row) => (
              <PrimaryChannelRowView
                key={`${row.platform}:${row.channelId}`}
                row={row}
              />
            ))
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function PrimaryChannelRowView(props: {
  row: PrimaryChannelRow;
}): React.ReactElement {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: async () =>
      api.patch<unknown>(
        `/browser-automation/channels/${props.row.platform}/${encodeURIComponent(props.row.channelId)}/primary`,
        { primary: false },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PRIMARY_CHANNELS_KEY });
      void qc.invalidateQueries({ queryKey: ENABLED_KEY });
    },
  });
  return (
    <div className="flex items-center justify-between rounded-md border p-2 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="gray">{props.row.platform}</Badge>
        <span className="font-mono text-xs">{props.row.channelId}</span>
        <span className="text-xs text-muted-foreground">
          set {new Date(props.row.setAt).toLocaleString()}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
      >
        {remove.isPending ? "…" : "Clear primary"}
      </Button>
    </div>
  );
}

function PendingTokensCard(props: {
  tokens: PurchaseTokenWire[];
  nowMs: number;
  loading: boolean;
  hasAnyPending: boolean;
}): React.ReactElement {
  // Tick locally so the countdown ticks down between server polls. The
  // tick state itself carries the wall-clock epoch ms — kept inside the
  // setInterval callback so the effect body does not call setState
  // synchronously (react-hooks/set-state-in-effect lint rule).
  const [tickMs, setTickMs] = useState<number>(props.nowMs);
  useEffect(() => {
    if (!props.hasAnyPending) return;
    const t = setInterval(() => setTickMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [props.hasAnyPending]);

  // The row uses `Math.max(tickMs, props.nowMs)` indirectly via this
  // memoized snapshot — when no pending tokens are live the ticker is
  // off and we fall back to the server's `now` value.
  const effectiveNow = Math.max(tickMs, props.nowMs);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Pending purchase tokens</h2>
            <p className="text-sm text-muted-foreground">
              In-flight purchase-confirmation requests waiting on the
              user&apos;s DM reply. Raw token strings are NEVER shown here.
            </p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="lite-final-confirm-pointer"
            >
              Browser-task confirmations (non-purchase) share the same{" "}
              <code>!~</code> token shape but live on their per-task detail
              page —{" "}
              <Link
                href="/browser-tasks"
                className="underline underline-offset-2 hover:text-foreground"
              >
                open Browser Tasks
              </Link>{" "}
              to find them.
            </p>
          </div>
          {props.loading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="mt-3 space-y-2">
          {props.tokens.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No pending purchase tokens.
            </div>
          ) : (
            props.tokens.map((tok) => (
              <PendingTokenRow
                key={tok.jti}
                token={tok}
                nowMs={effectiveNow}
              />
            ))
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function PendingTokenRow(props: {
  token: PurchaseTokenWire;
  nowMs: number;
}): React.ReactElement {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: async () =>
      api.delete<unknown>(
        `/browser-automation/purchase-tokens/${props.token.jti}`,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PENDING_TOKENS_KEY });
    },
  });

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="gray">{props.token.siteKey}</Badge>
            <Badge variant="gray">{props.token.status}</Badge>
            <span className="font-mono text-xs text-muted-foreground">
              jti={props.token.jti.slice(0, 8)}…
            </span>
          </div>
          <div>
            Total{" "}
            <strong>
              {formatAmount(props.token.maxAmountMinor, props.token.currency)}
            </strong>
          </div>
          {props.token.notesForUser && (
            <div className="text-xs text-muted-foreground">
              Agent: {props.token.notesForUser}
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Delivered to {props.token.deliveredChannels.length} channel
            {props.token.deliveredChannels.length === 1 ? "" : "s"} ·{" "}
            expires in{" "}
            <strong>
              {formatCountdown(props.token.expiresAt, props.nowMs)}
            </strong>
          </div>
        </div>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
        >
          {cancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

function RecentPurchasesCard(props: {
  tokens: PurchaseTokenWire[];
  loading: boolean;
}): React.ReactElement {
  const summary = useMemo(() => summariseSpend(props.tokens), [props.tokens]);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Recent purchases</h2>
            <p className="text-sm text-muted-foreground">
              Confirmed + cancelled tokens. Today / week aggregates per
              site_key.
            </p>
          </div>
          {props.loading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        {summary.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            {summary.map((row) => (
              <div
                key={`${row.siteKey}:${row.currency}`}
                className="rounded-md border p-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="gray">{row.siteKey}</Badge>
                  <Badge>{row.currency}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Today: <strong>{formatAmount(row.spentToday, row.currency)}</strong>{" "}
                  · Week: <strong>{formatAmount(row.spentWeek, row.currency)}</strong>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-2">
          {props.tokens.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No recent purchases.
            </div>
          ) : (
            props.tokens.slice(0, 32).map((tok) => (
              <RecentPurchaseRow key={tok.jti} token={tok} />
            ))
          )}
        </div>
      </CardHeader>
    </Card>
  );
}

function RecentPurchaseRow(props: {
  token: PurchaseTokenWire;
}): React.ReactElement {
  const t = props.token;
  return (
    <div className="rounded-md border p-2 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {t.status === "confirmed" ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
          ) : (
            <XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          <Badge variant="gray">{t.siteKey}</Badge>
          <Badge variant="gray">{t.status}</Badge>
          {t.cancelReason && (
            <span className="text-xs text-muted-foreground">
              ({t.cancelReason})
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date(t.consumedAt ?? t.cancelledAt ?? t.issuedAt).toLocaleString()}
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t.confirmedAmountMinor !== null
          ? formatAmount(t.confirmedAmountMinor, t.currency)
          : formatAmount(t.maxAmountMinor, t.currency)}{" "}
        · jti={t.jti.slice(0, 12)}…{" "}
        {t.orderId && (
          <span>
            · order=<strong>{t.orderId}</strong>
          </span>
        )}
      </div>
    </div>
  );
}

interface SpendSummary {
  siteKey: string;
  currency: string;
  spentToday: number;
  spentWeek: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function summariseSpend(rows: PurchaseTokenWire[]): SpendSummary[] {
  const now = Date.now();
  const byKey = new Map<string, SpendSummary>();
  for (const r of rows) {
    if (r.status !== "confirmed" || r.confirmedAmountMinor === null) continue;
    const k = `${r.siteKey}:${r.currency}`;
    let bucket = byKey.get(k);
    if (!bucket) {
      bucket = {
        siteKey: r.siteKey,
        currency: r.currency,
        spentToday: 0,
        spentWeek: 0,
      };
      byKey.set(k, bucket);
    }
    const ts = r.consumedAt ?? r.issuedAt;
    if (now - ts <= DAY_MS) bucket.spentToday += r.confirmedAmountMinor;
    if (now - ts <= 7 * DAY_MS) bucket.spentWeek += r.confirmedAmountMinor;
  }
  return Array.from(byKey.values()).sort(
    (a, b) => b.spentWeek - a.spentWeek,
  );
}

// Suppress unused warning — AlertTriangle is referenced by the experimental
// modal indirectly through the alert variant. Keep the import so a future
// inline icon swap does not require re-adding it.
void AlertTriangle;
