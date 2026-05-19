"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  MailAccount,
  MailAccountHealth,
  MailProviderKind,
  MailProvidersResponse,
} from "./types";

export function useMailProviders() {
  return useQuery({
    queryKey: ["mail-providers"],
    queryFn: () => api.get<MailProvidersResponse>("/mail/providers"),
    refetchInterval: 30_000,
  });
}

export function useMailAccounts() {
  return useQuery({
    queryKey: ["mail-accounts"],
    queryFn: () => api.get<{ accounts: MailAccount[] }>("/mail/accounts"),
    refetchInterval: 10_000,
  });
}

export function useMailAccountHealth(accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["mail-health", accountId],
    queryFn: () =>
      api.get<MailAccountHealth>(
        `/mail/${encodeURIComponent(accountId)}/health`,
      ),
    refetchInterval: 10_000,
    enabled,
  });
}

export function useInvalidateMail() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["mail-providers"] });
    qc.invalidateQueries({ queryKey: ["mail-accounts"] });
    qc.invalidateQueries({ queryKey: ["mail-health"] });
  };
}

/**
 * Toggle a single provider kind in `enabledMailProviders`. Returns the new
 * list so the caller can optimistically update its checkbox.
 */
export async function toggleProviderEnabled(
  current: MailProviderKind[],
  kind: MailProviderKind,
  enable: boolean,
): Promise<MailProviderKind[]> {
  const set = new Set(current);
  if (enable) set.add(kind);
  else set.delete(kind);
  const ordered: MailProviderKind[] = ["gmail", "outlook", "yahoo", "icloud"];
  const next = ordered.filter((k) => set.has(k));
  await api.patch("/mail/providers", { enabledKinds: next });
  return next;
}
