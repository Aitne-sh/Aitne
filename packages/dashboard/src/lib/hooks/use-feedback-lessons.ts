"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { FeedbackLessonsResponse } from "@/lib/api-types";

/**
 * Read-only overview of the feedback-learning lesson stores
 * (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5). Drives the Lessons settings
 * page's store list + cap-utilisation bars. The file bodies themselves are
 * loaded/edited via `useContextFile` / `useUpdateContextFile` against the
 * `path` each store reports.
 */
export function useFeedbackLessons() {
  return useQuery({
    queryKey: ["feedback-lessons"],
    queryFn: () => api.get<FeedbackLessonsResponse>("/feedback/lessons"),
    staleTime: 30_000,
  });
}
