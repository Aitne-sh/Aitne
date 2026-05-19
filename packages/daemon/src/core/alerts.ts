import type { Alert, AlertSeverity } from "@aitne/shared";

/**
 * Notifications Center — pure alert aggregator.
 *
 * See docs/design/20-notifications-center.md.
 *
 * The /api/health route extracts the signals listed in `AlertInputs`
 * from the daemon's existing observation surface (db tables, in-memory
 * health, integration probes) and passes them here. This file performs
 * no I/O — every detector is pure and unit-testable.
 *
 * Severity policy:
 *  - error   → broken right now, agent cannot fully function
 *  - warning → reduced functionality or near-limit
 *  - info    → discoverability nudge
 *
 * Adding a new alert type:
 *  1. Add the input field(s) to `AlertInputs`.
 *  2. Add a detector function below following the existing pattern.
 *  3. Append it to `aggregateAlerts` and add a unit test.
 *
 * `href` policy: each alert points to where the user can actually act
 * on the underlying issue. The dashboard route `/health` is a
 * body-health skeleton (steps / sleep / habits), not system
 * diagnostics — system signals route to `/settings*` instead. The
 * notifications panel renders the link label by inspecting the href
 * prefix (see `getActionLabel` in `notifications-panel.tsx`), so a
 * mismatch between cause and target shows up as a wrong-verb button.
 */

export type MailAccountAuthStatus = "healthy" | "requires_consent" | "degraded";

export interface MailAccountSignal {
  id: string;
  kind: "gmail" | "outlook" | "yahoo" | "icloud";
  email: string;
  authStatus: MailAccountAuthStatus;
  active: boolean;
}

export interface BackendAuthSignal {
  id: string;
  enabled: boolean;
  authStatus: string;
  lastError: string | null;
  cliInstalled: boolean;
}

export interface AlertInputs {
  now: Date;

  // System
  degradedMode: { reason: string; path: string | null; since: string } | null;
  missingContextFiles: string[];

  // Mail
  mailAccounts: MailAccountSignal[];
  /**
   * When Gmail is delegated to the backend connector, the daemon is not
   * polling Gmail accounts directly so per-account `requires_consent` /
   * `degraded` signals on Gmail rows refer to accounts that are out of
   * the observation loop. Filter them out at the alert layer to mirror
   * MailAttentionAlert's existing behavior.
   */
  gmailDelegated: boolean;

  // Config / commands / templates
  templatesPending: Array<{ path: string; from: number; to: number }>;
  docsAssetConflicts: string[];
  skillConflicts: string[];
  builtInCommandNames: string[];
  userCommands: Array<{ id: number; name: string; command: string }>;

  // Auth (backends)
  backends: BackendAuthSignal[];

  // Cost
  todayCostUsd: number;
  monthCostUsd: number;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;

  // Setup
  googleConfigured: boolean;
  googleConnected: boolean;
  /** Any Google-family integration in direct mode (delegation upgrade nudge). */
  delegationUpgradeAvailable: boolean;
}

const COST_WARN_THRESHOLD = 0.8;

function iso(now: Date): string {
  return now.toISOString();
}

function detectDegradedMode(inputs: AlertInputs): Alert[] {
  const d = inputs.degradedMode;
  if (!d) return [];
  return [
    {
      id: "system.degraded",
      severity: "error",
      title: "Daemon is in degraded mode",
      description: `Reason: ${d.reason}${d.path ? ` (${d.path})` : ""}. Some writes are paused until the underlying issue is resolved.`,
      // Vault path is fixed via ManagementModeSection on /settings.
      href: "/settings",
      source: "system",
      dismissable: false,
      detectedAt: d.since,
      fingerprint: `${d.reason}:${d.path ?? ""}`,
    },
  ];
}

function detectContextFilesMissing(inputs: AlertInputs): Alert[] {
  if (inputs.missingContextFiles.length === 0) return [];
  const sorted = [...inputs.missingContextFiles].sort();
  return [
    {
      id: "system.context.missing",
      severity: "error",
      title: `${sorted.length} context file${sorted.length === 1 ? "" : "s"} missing`,
      description: `Missing: ${sorted.slice(0, 3).join(", ")}${sorted.length > 3 ? `, and ${sorted.length - 3} more` : ""}. The agent cannot read or write these until they are recreated.`,
      // Recovery: "Reinstall context" on /settings/advanced (tarball
      // backup + re-seed from templates on next restart).
      href: "/settings/advanced",
      source: "system",
      dismissable: false,
      detectedAt: iso(inputs.now),
      fingerprint: sorted.join("|"),
    },
  ];
}

const MAIL_KIND_LABEL: Record<MailAccountSignal["kind"], string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  yahoo: "Yahoo",
  icloud: "iCloud",
};

function detectMailAttention(inputs: AlertInputs): Alert[] {
  const visible = inputs.mailAccounts
    .filter((a) => a.active)
    .filter((a) => !(inputs.gmailDelegated && a.kind === "gmail"))
    .filter((a) => a.authStatus !== "healthy");
  if (visible.length === 0) return [];

  const out: Alert[] = [];
  for (const a of visible) {
    const reconsent = a.authStatus === "requires_consent";
    out.push({
      id: `mail.${a.authStatus}.${a.id}`,
      severity: reconsent ? "error" : "warning",
      title: reconsent
        ? `${MAIL_KIND_LABEL[a.kind]} (${a.email}) needs re-authentication`
        : `${MAIL_KIND_LABEL[a.kind]} (${a.email}) is degraded`,
      description: reconsent
        ? "Re-authorize the account to resume mail polling."
        : "The provider is returning persistent errors. Mail polling may be partial until the issue clears.",
      href: `/connections/mail#${a.id}`,
      source: "mail",
      dismissable: !reconsent,
      detectedAt: iso(inputs.now),
      fingerprint: `${a.authStatus}:${a.id}`,
    });
  }
  return out;
}

function detectTemplateUpgrades(inputs: AlertInputs): Alert[] {
  if (inputs.templatesPending.length === 0) return [];
  const fingerprint = inputs.templatesPending
    .map((t) => `${t.path}:${t.from}->${t.to}`)
    .sort()
    .join("|");
  const count = inputs.templatesPending.length;
  return [
    {
      id: "config.templates.pending",
      severity: "warning",
      title: `${count} template upgrade${count === 1 ? "" : "s"} pending`,
      description: "Newer template versions ship with this release. Review and merge to pick up format changes.",
      // Acceptance path: "Reinstall context" on /settings/advanced.
      href: "/settings/advanced",
      source: "config",
      dismissable: true,
      detectedAt: iso(inputs.now),
      fingerprint,
    },
  ];
}

function detectDocsAssetConflicts(inputs: AlertInputs): Alert[] {
  if (inputs.docsAssetConflicts.length === 0) return [];
  const sorted = [...inputs.docsAssetConflicts].sort();
  const count = sorted.length;
  return [
    {
      id: "config.docs.conflicts",
      severity: "warning",
      title: `${count} doc${count === 1 ? "" : "s"} need update review`,
      description: `User-edited docs were preserved during release sync: ${sorted.slice(0, 3).join(", ")}${count > 3 ? `, and ${count - 3} more` : ""}.`,
      href: "/docs",
      source: "config",
      dismissable: true,
      detectedAt: iso(inputs.now),
      fingerprint: sorted.join("|"),
    },
  ];
}

function detectSkillConflicts(inputs: AlertInputs): Alert[] {
  if (inputs.skillConflicts.length === 0) return [];
  const sorted = [...inputs.skillConflicts].sort();
  const count = sorted.length;
  return [
    {
      id: "config.skills.conflicts",
      severity: "warning",
      title: `${count} user skill${count === 1 ? "" : "s"} conflict with built-ins`,
      description: `${sorted.slice(0, 3).join(", ")}${count > 3 ? `, and ${count - 3} more` : ""}. Built-in skills take precedence in session workdirs; rename the user skill to restore custom behavior.`,
      href: "/knowledge?tab=skills",
      source: "config",
      dismissable: true,
      detectedAt: iso(inputs.now),
      fingerprint: sorted.join("|"),
    },
  ];
}

function detectCommandConflicts(inputs: AlertInputs): Alert[] {
  const reserved = new Set(inputs.builtInCommandNames);
  const conflicting = inputs.userCommands.filter((c) => reserved.has(c.command));
  if (conflicting.length === 0) return [];
  const fingerprint = conflicting
    .map((c) => `${c.id}:${c.command}`)
    .sort()
    .join("|");
  const count = conflicting.length;
  const sample = conflicting.slice(0, 3).map((c) => c.command).join(", ");
  return [
    {
      id: "config.command.conflicts",
      severity: "warning",
      title: `${count} custom command${count === 1 ? "" : "s"} conflict with built-ins`,
      description: `${sample}${count > 3 ? `, and ${count - 3} more` : ""}. Built-in commands take precedence at dispatch — rename to restore your custom behavior.`,
      href: "/settings/commands",
      source: "config",
      dismissable: true,
      detectedAt: iso(inputs.now),
      fingerprint,
    },
  ];
}

function detectAuthHealth(inputs: AlertInputs): Alert[] {
  const out: Alert[] = [];
  for (const b of inputs.backends) {
    if (!b.enabled) continue;
    if (!b.cliInstalled) {
      out.push({
        id: `auth.${b.id}.cli_missing`,
        severity: "error",
        title: `${b.id} CLI not found on PATH`,
        description: "Install the CLI or disable this backend so it doesn't get scheduled.",
        href: "/settings/backends",
        source: "auth",
        dismissable: false,
        detectedAt: iso(inputs.now),
        fingerprint: `cli_missing:${b.id}`,
      });
      continue;
    }
    const broken = b.authStatus === "expired"
      || b.authStatus === "missing"
      || b.authStatus === "error";
    if (!broken) continue;
    out.push({
      id: `auth.${b.id}.${b.authStatus}`,
      severity: "error",
      title: `${b.id} backend authentication ${b.authStatus}`,
      description: b.lastError
        ? `Last error: ${b.lastError}.`
        : "Re-authenticate to resume sessions on this backend.",
      href: "/settings/backends",
      source: "auth",
      dismissable: false,
      detectedAt: iso(inputs.now),
      fingerprint: `${b.authStatus}:${b.id}`,
    });
  }
  return out;
}

function detectCostCap(
  inputs: AlertInputs,
  scope: "daily" | "monthly",
): Alert[] {
  const cap = scope === "daily" ? inputs.dailyCapUsd : inputs.monthlyCapUsd;
  const spend = scope === "daily" ? inputs.todayCostUsd : inputs.monthCostUsd;
  // Loose null check covers both `null` (cap disabled) and `undefined`
  // (test config that didn't seed the field). Also guards against zero
  // and negative caps which would produce NaN/Infinity ratios.
  if (cap == null || cap <= 0) return [];
  if (typeof spend !== "number" || Number.isNaN(spend)) return [];
  const ratio = spend / cap;
  if (ratio < COST_WARN_THRESHOLD) return [];

  const exceeded = ratio >= 1;
  const severity: AlertSeverity = exceeded ? "error" : "warning";
  const pct = Math.floor(ratio * 100);
  const scopeLabel = scope === "daily" ? "today" : "this month";
  return [
    {
      id: `cost.${scope}_cap`,
      severity,
      title: exceeded
        ? `${scope === "daily" ? "Daily" : "Monthly"} cost cap reached`
        : `${pct}% of ${scope} cost cap used`,
      description: `Spent $${spend.toFixed(2)} of $${cap.toFixed(2)} ${scopeLabel}.${
        exceeded && scope === "daily"
          ? " Autonomous sessions are being skipped until the next agent day."
          : ""
      }`,
      href: "/settings/models",
      source: "cost",
      dismissable: !exceeded,
      detectedAt: iso(inputs.now),
      // Bucket by 5% so the same threshold band doesn't keep re-firing as
      // the user accrues a few more cents of usage.
      fingerprint: `${scope}:${exceeded ? "exceeded" : `band:${Math.floor(pct / 5) * 5}`}`,
    },
  ];
}

function detectGcalSetup(inputs: AlertInputs): Alert[] {
  if (!inputs.googleConfigured) return [];
  if (inputs.googleConnected) return [];
  return [
    {
      id: "setup.gcal",
      severity: "info",
      title: "Google Calendar is configured but not connected",
      description: "Re-authorize the Google account to resume calendar sync.",
      href: "/connections/calendar#google",
      source: "setup",
      dismissable: true,
      detectedAt: iso(inputs.now),
      fingerprint: "disconnected",
    },
  ];
}

function detectDelegationUpgrade(inputs: AlertInputs): Alert[] {
  if (!inputs.delegationUpgradeAvailable) return [];
  return [
    {
      id: "setup.delegation_upgrade",
      severity: "info",
      title: "You can delegate Google access to your backend connector",
      description: "Zero GCP setup, parity on most Gmail + Calendar tasks. Tokens stay in the keychain so revert is one click.",
      href: "/connections/calendar#google",
      source: "setup",
      dismissable: true,
      detectedAt: iso(inputs.now),
      fingerprint: "available",
    },
  ];
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function aggregateAlerts(inputs: AlertInputs): Alert[] {
  const all: Alert[] = [
    ...detectDegradedMode(inputs),
    ...detectContextFilesMissing(inputs),
    ...detectMailAttention(inputs),
    ...detectTemplateUpgrades(inputs),
    ...detectDocsAssetConflicts(inputs),
    ...detectSkillConflicts(inputs),
    ...detectCommandConflicts(inputs),
    ...detectAuthHealth(inputs),
    ...detectCostCap(inputs, "daily"),
    ...detectCostCap(inputs, "monthly"),
    ...detectGcalSetup(inputs),
    ...detectDelegationUpgrade(inputs),
  ];

  return all.sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return b.detectedAt.localeCompare(a.detectedAt);
  });
}
