import type { QueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api-client";
import type { ConfigResponse, ConfigUpdateResponse } from "./api-types";

type NotionDatabaseIds = Record<string, string>;

export interface NotionDatabaseIdsApi {
  get<T>(path: string): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

export interface SaveNotionDatabaseIdsOptions {
  build: (current: NotionDatabaseIds) => NotionDatabaseIds;
  queryClient: Pick<QueryClient, "invalidateQueries">;
  apiClient?: NotionDatabaseIdsApi;
}

export async function saveNotionDatabaseIds(
  { build, queryClient, apiClient = api }: SaveNotionDatabaseIdsOptions,
): Promise<ConfigUpdateResponse> {
  const latestConfig = await apiClient.get<ConfigResponse>("/config");
  const base = latestConfig.notionDatabaseIds ?? {};
  const updated = build(base);

  try {
    const response = await apiClient.patch<ConfigUpdateResponse>("/config", {
      notionDatabaseIdsBase: base,
      notionDatabaseIds: updated,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["config"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] }),
    ]);
    return response;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
      ]);
    }
    throw error;
  }
}
