import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import { saveNotionDatabaseIds } from "./notion-database-ids";

describe("saveNotionDatabaseIds", () => {
  it("patches notion mappings with a conflict-detection base snapshot", async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue({
        notionDatabaseIds: { tasks: "db-1" },
      }),
      patch: vi.fn().mockResolvedValue({
        status: "updated",
        updated: ["notionDatabaseIds"],
        requiresRestart: ["notionDatabaseIds"],
        errors: {},
      }),
    };
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    };

    const response = await saveNotionDatabaseIds({
      apiClient,
      queryClient,
      build: (current) => ({ ...current, projects: "db-2" }),
    });

    expect(apiClient.get).toHaveBeenCalledWith("/config");
    expect(apiClient.patch).toHaveBeenCalledWith("/config", {
      notionDatabaseIdsBase: { tasks: "db-1" },
      notionDatabaseIds: { tasks: "db-1", projects: "db-2" },
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(response.requiresRestart).toEqual(["notionDatabaseIds"]);
  });

  it("refreshes stale data before surfacing a conflict", async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue({
        notionDatabaseIds: { tasks: "db-1" },
      }),
      patch: vi.fn().mockRejectedValue(
        new ApiError(409, {
          error: "conflict",
          message: "Notion database mappings changed on another tab. Reload and try again.",
        }),
      ),
    };
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    };

    await expect(saveNotionDatabaseIds({
      apiClient,
      queryClient,
      build: (current) => ({ ...current, projects: "db-2" }),
    })).rejects.toThrow("Notion database mappings changed on another tab. Reload and try again.");

    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });
});
