"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Domain, EntityType } from "@aitne/shared";
import { api } from "@/lib/api-client";

export interface EntityRecord {
  path: string;
  domain: Domain;
  type: EntityType;
  slug: string;
  title: string;
  status: string | null;
  date: string | null;
  lastSyncedAt: string | null;
  sources: Record<string, unknown>;
}

interface EntitiesByDomainTypeDateResponse {
  tier: 2;
  q: string | null;
  items: EntityRecord[];
}

interface EntitiesBySourceResponse {
  tier: 1;
  mode: "by_source_key" | "exact";
  items: EntityRecord[];
}

interface EntityByPathResponse {
  item: EntityRecord;
}

/**
 * Bias query (§7.6): list entities tagged with `source` so the entity
 * browser can group by app. Cheaper than scanning every domain.
 */
export function useEntitiesBySource(source: string | null, limit = 100) {
  return useQuery({
    queryKey: ["entities-by-source", source, limit],
    queryFn: () =>
      api.get<EntitiesBySourceResponse>("/entities", { source: source!, limit }),
    enabled: !!source,
    staleTime: 30_000,
    // Keep the previous source's entities on screen while a newly selected
    // source loads, so the results pane doesn't flash a skeleton and reset
    // its scroll on each source switch.
    placeholderData: keepPreviousData,
  });
}

export function useEntitiesByDomainTypeDate(args: {
  domain: Domain | null;
  type: EntityType | null;
  date: string | null;
  q?: string;
  limit?: number;
}) {
  const { domain, type, date, q, limit } = args;
  const enabled = !!domain && !!type && !!date;
  return useQuery({
    queryKey: ["entities-by-domain-type-date", domain, type, date, q, limit],
    queryFn: () =>
      api.get<EntitiesByDomainTypeDateResponse>("/entities", {
        domain: domain!,
        type: type!,
        date: date!,
        ...(q ? { q } : {}),
        ...(limit ? { limit } : {}),
      }),
    enabled,
    staleTime: 30_000,
    // Keep the current results on screen while a new domain/type/date/query
    // loads, so the results pane doesn't flash a skeleton and reset its
    // scroll on each filter change.
    placeholderData: keepPreviousData,
  });
}

export function useEntityByPath(path: string | null) {
  return useQuery({
    queryKey: ["entity-by-path", path],
    queryFn: () =>
      api.get<EntityByPathResponse>("/entities/by-path", { path: path! }),
    enabled: !!path,
    staleTime: 30_000,
  });
}
