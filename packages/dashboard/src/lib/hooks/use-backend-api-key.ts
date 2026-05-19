"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiKeyProvider,
  BackendApiKeyConfig,
  BackendId,
} from "@aitne/shared";
import { api } from "@/lib/api-client";

export type ApiKeySource = "keychain" | "shell" | "none";

export interface BackendApiKeyState {
  backendId: BackendId;
  configured: boolean;
  source: ApiKeySource;
  /** Active provider when source==='keychain'. Null otherwise. */
  provider: ApiKeyProvider | null;
  envVarNames: readonly string[];
  /** Providers the operator can pick for this backend. */
  availableProviders: readonly ApiKeyProvider[];
}

export interface BackendApiKeyMutationResult {
  status: "saved" | "cleared";
  backendId: BackendId;
  source: ApiKeySource;
  provider: ApiKeyProvider | null;
  auth: {
    ok: boolean;
    status: string | null;
    detail: string | null;
    method: string | null;
  } | null;
}

/**
 * Save body. Two accepted shapes — direct API key (legacy single-field
 * form) or a typed cloud-provider config. Mirrors the union the daemon
 * accepts at PUT /backends/:id/api-key.
 */
export type SaveBackendApiKeyInput =
  | { apiKey: string }
  | { config: BackendApiKeyConfig };

const apiKeyQueryKey = (backendId: BackendId) =>
  ["backend-api-key", backendId] as const;

export function useBackendApiKey(backendId: BackendId) {
  return useQuery({
    queryKey: apiKeyQueryKey(backendId),
    queryFn: () =>
      api.get<BackendApiKeyState>(`/backends/${backendId}/api-key`),
    staleTime: 30_000,
  });
}

/** Save a new API key or cloud-provider config. Triggers a server-side
 *  `checkAuthDetailed()` so the backend's auth status reflects the new
 *  config without a separate click. */
export function useSaveBackendApiKey(backendId: BackendId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveBackendApiKeyInput) =>
      api.put<BackendApiKeyMutationResult>(
        `/backends/${backendId}/api-key`,
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: apiKeyQueryKey(backendId),
      });
      // The save triggered a checkAuthDetailed() server-side, so the
      // /backends list now has a fresher auth status row.
      void queryClient.invalidateQueries({ queryKey: ["backends"] });
    },
  });
}

/** Clear the keychain entry. Falls back to the captured shell value if any. */
export function useClearBackendApiKey(backendId: BackendId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete<BackendApiKeyMutationResult>(
        `/backends/${backendId}/api-key`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: apiKeyQueryKey(backendId),
      });
      void queryClient.invalidateQueries({ queryKey: ["backends"] });
    },
  });
}
