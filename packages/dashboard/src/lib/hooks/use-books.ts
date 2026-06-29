"use client";

import {
  keepPreviousData,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  BooksResponse,
  BookHighlightsResponse,
  BooksSummaryResponse,
} from "@/lib/api-types";

export function useBooks(filters?: {
  status?: string;
  source?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ["books", filters],
    queryFn: () =>
      api.get<BooksResponse>("/books", {
        status: filters?.status ?? "all",
        source: filters?.source ?? "all",
        limit: filters?.limit ?? 50,
        offset: filters?.offset ?? 0,
      }),
    staleTime: 30_000,
    // Keep the current table on screen while a new status filter loads —
    // otherwise the key change clears data, QueryResult collapses to a
    // skeleton, and the page scrolls to the top on every filter change.
    placeholderData: keepPreviousData,
  });
}

export function useBookHighlights(bookId: number | null, limit?: number) {
  return useQuery({
    queryKey: ["book-highlights", bookId, limit],
    queryFn: () =>
      api.get<BookHighlightsResponse>(`/books/${bookId}/highlights`, {
        limit: limit ?? 100,
      }),
    enabled: bookId !== null,
    staleTime: 30_000,
    // Keep the previous book's highlights on screen while the newly
    // selected book loads, so the panel doesn't flash a skeleton and
    // bounce the scroll on each row click.
    placeholderData: keepPreviousData,
  });
}

export function useBooksSummary(months?: number) {
  return useQuery({
    queryKey: ["books-summary", months],
    queryFn: () =>
      api.get<BooksSummaryResponse>("/books/summary", {
        months: months ?? 12,
      }),
    staleTime: 60_000,
  });
}

export function useImportClippings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ data }: { data: string }) =>
      api.post("/books/import-clippings", { data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.invalidateQueries({ queryKey: ["book-highlights"] });
      queryClient.invalidateQueries({ queryKey: ["books-summary"] });
    },
  });
}
