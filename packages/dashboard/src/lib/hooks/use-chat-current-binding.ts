"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ChatCurrentBindingResponse } from "@/lib/api-types";

export function useChatCurrentBinding() {
  return useQuery({
    queryKey: ["chat-current-binding"],
    queryFn: () => api.get<ChatCurrentBindingResponse>("/chat/current-binding"),
    refetchInterval: 15_000,
  });
}
