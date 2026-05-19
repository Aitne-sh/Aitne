export type MailProviderKind = "gmail" | "outlook" | "yahoo" | "icloud";
export type AuthStatus = "healthy" | "requires_consent" | "degraded";

export interface MailAccount {
  id: string;
  kind: MailProviderKind;
  email: string;
  label?: string;
  authStatus: AuthStatus;
  idleEnabled: boolean;
  active: boolean;
  createdAt: string;
}

export interface MailAccountHealth {
  accountId: string;
  lastPollAtUtc: string | null;
  lastError: string | null;
  lastErrorAtUtc: string | null;
  consecutiveErrorCount: number;
  idleFallbackUntilUtc: string | null;
}

export interface MailProvidersResponse {
  enabledKinds: MailProviderKind[];
  available: {
    kind: MailProviderKind;
    label: string;
    accountsConfigured: number;
    accountsHealthy: number;
  }[];
}

export type CardStatus =
  | "not-connected"
  | "needs-setup"
  | "disabled"
  | "enabled"
  | "attention";

export const STATUS_BADGE: Record<
  CardStatus,
  { variant: "gray" | "amber" | "green" | "red"; label: string }
> = {
  "not-connected": { variant: "gray", label: "Not connected" },
  "needs-setup": { variant: "gray", label: "Needs setup" },
  disabled: { variant: "amber", label: "Ready to enable" },
  enabled: { variant: "green", label: "Enabled" },
  attention: { variant: "red", label: "Needs attention" },
};

/**
 * Combine per-card inputs into a single status. Order matters:
 * `attention` wins whenever any account is unhealthy, even if the kind is
 * disabled — the user should still be able to see and act on it.
 */
export function deriveCardStatus(input: {
  accounts: MailAccount[];
  enabled: boolean;
  /** True when the provider needs out-of-band config (e.g. Outlook BYOA). */
  awaitingProviderSetup?: boolean;
}): CardStatus {
  if (input.accounts.some((a) => a.authStatus !== "healthy")) {
    return "attention";
  }
  if (input.accounts.length === 0) {
    return input.awaitingProviderSetup ? "needs-setup" : "not-connected";
  }
  return input.enabled ? "enabled" : "disabled";
}
