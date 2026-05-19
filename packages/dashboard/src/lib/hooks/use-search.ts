"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { SearchResponse } from "@/lib/api-types";

export function useSearch(query: string) {
  return useQuery({
    queryKey: ["search", query],
    queryFn: () => api.get<SearchResponse>("/search", { q: query }),
    enabled: query.length >= 2,
  });
}
