"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchConversationHistory } from "@/lib/conversation-history";

export function useConversationHistory(
  id: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["conversation-history", id],
    queryFn: ({ signal }) => fetchConversationHistory(id, { signal }),
    enabled: (options?.enabled ?? true) && id > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
