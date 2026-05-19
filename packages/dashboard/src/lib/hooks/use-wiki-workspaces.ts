"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { WikiWorkspacesResponse } from "@/lib/api-types";

/**
 * Shared accessor for the wiki workspaces list.
 *
 * Two consumers today:
 *   1. `/settings/wiki` — full configuration page (already had its own
 *      `useQuery(["wiki-workspaces"])`; this hook is now the canonical
 *      keyed entry so the cache is shared).
 *   2. `AppSidebar` — gates the "Wiki" entry in the My Life section on
 *      `workspaces.some(active)`. The sidebar mounts on every page so
 *      `staleTime` matters; the list rarely changes (operator-only
 *      action on `/settings/wiki`), so 5 minutes is plenty.
 *
 * WIKI_BUILDER_DESIGN.md §0 / §6.0 treats the absence of any active
 * row as the canonical "wiki disabled" signal. Surfacing the entry
 * conditionally keeps the My Life menu clean for users who have not
 * opted in, while still letting opted-in users reach wiki content in
 * one click from any page.
 */
export function useWikiWorkspaces() {
  return useQuery({
    queryKey: ["wiki-workspaces"],
    queryFn: () => api.get<WikiWorkspacesResponse>("/wiki/workspaces"),
    staleTime: 5 * 60 * 1000,
  });
}

export function selectActiveWikiWorkspace(
  data: WikiWorkspacesResponse | undefined,
) {
  return data?.workspaces.find((w) => w.active) ?? null;
}
