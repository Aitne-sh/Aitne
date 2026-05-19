import { api } from "@/lib/api-client";
import type { DirectoryPickerResponse } from "@/lib/api-types";

export async function pickDirectoryFromDesktop({
  title,
  defaultPath,
}: {
  title: string;
  defaultPath?: string;
}): Promise<string | null> {
  const response = await api.post<DirectoryPickerResponse>(
    "/system/pick-directory",
    {
      title,
      ...(defaultPath ? { defaultPath } : {}),
    },
  );

  if (response.status === "selected" && response.path) {
    return response.path;
  }
  if (response.status === "cancelled") {
    return null;
  }
  throw new Error(response.message ?? "Folder picker is unavailable.");
}
