"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * CONTEXT_VAULT_REDESIGN_PLAN.md §11.3.4 / V16 — dashboard hooks for
 * the Obsidian-mode vault-restructure consent flow.
 *
 * On the cutover release the bootstrap layer (`bootstrap/db.ts:
 * resolveVaultRestructureConsent`) defers migration
 * `0004-context-vault-restructure` when:
 *   - `runtimeSettings.vaultMode === "obsidian"`
 *   - no prior ack is recorded in `runtime_state`
 *   - the migration would actually have moves (legacy dirs / wrong marker)
 *
 * The daemon then writes a `pending_consent` row that this hook polls.
 * When present, the dashboard modal lets the user record their consent
 * (the migration runs on the NEXT daemon boot — the response carries
 * `restartRequired: true` so we prompt the user to restart).
 *
 * Headless installs use the `PA_VAULT_RESTRUCTURE_ACK=1` env path; that
 * codepath also writes the ack with `source: "env"` so this hook will
 * report `acknowledgement != null` and the modal stays closed.
 */

export interface VaultRestructurePendingConsent {
  since: string;
  reason: "obsidian_consent_required";
  contextDir: string;
}

export interface VaultRestructureAck {
  at: string;
  source: "env" | "dashboard" | "cli";
}

export interface VaultRestructureStatusResponse {
  pendingConsent: VaultRestructurePendingConsent | null;
  acknowledgement: VaultRestructureAck | null;
}

export interface VaultRestructureAckResponse {
  ok: boolean;
  alreadyAcknowledged: boolean;
  restartRequired: boolean;
  acknowledgement?: VaultRestructureAck;
  message: string;
}

const STATUS_KEY = ["vault-restructure-status"] as const;

export function useVaultRestructureStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () =>
      api.get<VaultRestructureStatusResponse>(
        "/setup/vault-restructure-status",
      ),
    // 30 s — the row only changes during boot, so we don't need to be
    // aggressive. Manual invalidation handles the consent-recorded case.
    refetchInterval: 30_000,
    // Static across a session unless something happens; no need to retry
    // hard on transient errors (the banner just stays hidden until the
    // next interval succeeds).
    retry: 1,
  });
}

export function useAcknowledgeVaultRestructure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<VaultRestructureAckResponse>("/setup/vault-restructure-ack"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
