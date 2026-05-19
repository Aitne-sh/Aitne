"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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

export function usePatchBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: number;
      status?: string;
      rating?: number;
      notes?: string;
    }) => api.patch(`/books/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.invalidateQueries({ queryKey: ["books-summary"] });
    },
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
