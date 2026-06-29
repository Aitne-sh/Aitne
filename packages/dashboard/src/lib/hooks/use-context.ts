"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { ContextFileResponse, ContextListResponse } from "@/lib/api-types";

/**
 * Read a context file. While the user is actively editing we set
 * `enabled=false` to suppress background refetches that would otherwise
 * race the editor's draft baseline (window-focus refetches, polling, etc.)
 * and silently corrupt the optimistic-concurrency check.
 */
export function useContextFile(path: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["context", path],
    queryFn: () => api.get<ContextFileResponse>(`/context/${path}`),
    enabled: !!path && options?.enabled !== false,
    refetchOnWindowFocus: options?.enabled !== false,
  });
}

export function useContextList(dir: string) {
  return useQuery({
    queryKey: ["context-list", dir],
    queryFn: () => api.get<ContextListResponse>(`/context/list/${dir}`),
  });
}

interface ContextPutResponse {
  status: "updated";
  snapshotId: number;
  lastModified: string;
}

export interface ContextConflict {
  currentMtime: string;
  currentContent: string;
}

/**
 * Thrown when a PUT to /context/* returns 409 with `error: "conflict"`.
 * Carries the current on-disk state so the UI can render a conflict
 * resolution dialog without re-fetching.
 */
export class ContextConflictError extends Error {
  constructor(public readonly conflict: ContextConflict) {
    super("context_conflict");
    this.name = "ContextConflictError";
  }
}

/**
 * Full-replace write with optimistic concurrency control.
 *
 * The client always sends `expectedMtime` (captured at edit-start) so the
 * daemon can detect when another writer (the agent itself, another tab,
 * etc.) has modified the file in the meantime. On mismatch the server
 * returns 409 + the current state, which we surface as a typed
 * `ContextConflictError` for the page to handle.
 *
 * The backend records a snapshot of the previous content before
 * overwriting, so even a forced overwrite is recoverable from the
 * Snapshots panel.
 */
export function useUpdateContextFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      path,
      content,
      expectedMtime,
    }: {
      path: string;
      content: string;
      expectedMtime?: string;
    }) => {
      try {
        return await api.put<ContextPutResponse>(`/context/${path}`, {
          content,
          ...(expectedMtime !== undefined ? { expectedMtime } : {}),
        });
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          (err.body as Record<string, unknown> | null)?.error === "conflict"
        ) {
          const body = err.body as {
            currentMtime?: string;
            currentContent?: string;
          };
          throw new ContextConflictError({
            currentMtime: body.currentMtime ?? "",
            currentContent: body.currentContent ?? "",
          });
        }
        throw err;
      }
    },
    onSuccess: (data, { path, content }) => {
      // Seed the cache directly instead of invalidating-and-refetching.
      // If we only invalidated, an immediate re-edit could read the old
      // cached content during the refetch window. Writing the new content
      // synchronously eliminates that race entirely.
      qc.setQueryData<ContextFileResponse>(["context", path], (prev) =>
        prev
          ? { ...prev, content, lastModified: data.lastModified }
          : { content, lastModified: data.lastModified, editable: true },
      );
      qc.invalidateQueries({ queryKey: ["snapshots", path] });
      // A directory listing's lastModified timestamps may shift after a write
      const dir = path.includes("/") ? path.split("/")[0] : null;
      if (dir) qc.invalidateQueries({ queryKey: ["context-list", dir] });
    },
  });
}
