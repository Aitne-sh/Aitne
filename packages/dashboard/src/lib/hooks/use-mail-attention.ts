import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

type AuthStatus = "healthy" | "requires_consent" | "degraded";
type MailProviderKind = "gmail" | "outlook" | "yahoo" | "icloud";

interface MailAccount {
  id: string;
  kind: MailProviderKind;
  email: string;
  authStatus: AuthStatus;
  active: boolean;
}

export interface MailAttentionEntry {
  id: string;
  email: string;
  kind: MailProviderKind;
  authStatus: Exclude<AuthStatus, "healthy">;
}

export interface MailAttention {
  needsReconsent: MailAttentionEntry[];
  degraded: MailAttentionEntry[];
  total: number;
}

/**
 * Surface accounts that need owner action — used by the overview-page red
 * banner. Refresh cadence (60s) is intentionally slower than the Settings →
 * Mail page's 10s; the banner only needs eventual consistency.
 */
export function useMailAttention(): MailAttention {
  const { data } = useQuery({
    queryKey: ["mail-accounts"],
    queryFn: () => api.get<{ accounts: MailAccount[] }>("/mail/accounts"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const accounts = data?.accounts ?? [];
  const needsReconsent: MailAttentionEntry[] = [];
  const degraded: MailAttentionEntry[] = [];
  for (const a of accounts) {
    if (!a.active) continue;
    if (a.authStatus === "requires_consent") {
      needsReconsent.push({ id: a.id, email: a.email, kind: a.kind, authStatus: "requires_consent" });
    } else if (a.authStatus === "degraded") {
      degraded.push({ id: a.id, email: a.email, kind: a.kind, authStatus: "degraded" });
    }
  }
  return {
    needsReconsent,
    degraded,
    total: accounts.length,
  };
}
