"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { BackendId } from "@aitne/shared";
import type {
  DocDetailResponse,
  DocsHealthResponse,
  DocsSearchResponse,
  DocsTreeResponse,
} from "@/lib/api-types";

export interface DocsQABindingModel {
  modelId: string;
  label: string;
}

export interface DocsQABindingResponse {
  /** Resolved backend id — drives picker scope (light models for this backend). */
  backend: BackendId;
  /** "Claude Code", "Codex", "Gemini CLI". */
  backendDisplay: string;
  /** "Sonnet 4.6", "GPT-5.4 mini", "Gemini 2.5 Flash". */
  modelDisplay: string;
  /** True when no messaging app is paired — disclaimer adds a notice. */
  isInstallDefault: boolean;
  /** Light-tier models the picker may offer for the bound backend. */
  availableModels: DocsQABindingModel[];
  /**
   * Picker's initial pick when nothing is persisted in localStorage —
   * the cheapest available light-tier model for the bound backend.
   * Registry-derived; the dashboard does not hardcode a model id.
   */
  defaultModelId: string;
}

export function useDocsTree() {
  return useQuery({
    queryKey: ["docs", "tree"],
    queryFn: () => api.get<DocsTreeResponse>("/docs"),
    staleTime: 60_000,
  });
}

export function useDoc(slug: string | null) {
  return useQuery({
    queryKey: ["docs", "detail", slug],
    queryFn: () => api.get<DocDetailResponse>(`/docs/by-slug/${slug}`),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
}

export function useDocsSearch(
  q: string,
  filters?: { category?: string; tag?: string; limit?: number },
) {
  return useQuery({
    queryKey: ["docs", "search", q, filters],
    queryFn: () =>
      api.get<DocsSearchResponse>("/docs/search", {
        q,
        category: filters?.category,
        tag: filters?.tag,
        limit: filters?.limit,
      }),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
}

export function useDocsHealth() {
  return useQuery({
    queryKey: ["docs", "health"],
    queryFn: () => api.get<DocsHealthResponse>("/docs/health"),
    staleTime: 30_000,
  });
}

/**
 * `GET /api/docs/qa/binding` — returns the backend / model strings
 * that drive the QA disclaimer.
 *
 * The endpoint is part of the deferred QA pipeline (DOCS_QA_DESIGN.md
 * §10.4); until the daemon ships it, calls 404 and the consumer renders
 * the §7.1 fallback copy. `retry: false` keeps the 404 from being
 * re-tried on every focus. `refetchOnWindowFocus` is the canonical
 * invalidation trigger; SSE-driven invalidation is deferred.
 */
export function useDocsQABinding() {
  return useQuery<DocsQABindingResponse, ApiError>({
    queryKey: ["docs", "qa-binding"],
    queryFn: () => api.get<DocsQABindingResponse>("/docs/qa/binding"),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
