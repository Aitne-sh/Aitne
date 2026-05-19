"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ConfigUpdateResponse } from "@/lib/api-types";
import type { SettingsToastState } from "@/components/settings/settings-navigation";
import type { EditableConfigKey } from "@aitne/shared";

export type ConfigValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, unknown>[]
  | null;

export type SaveFieldFn = (
  key: EditableConfigKey,
  value: ConfigValue,
) => Promise<void>;

export function useSaveConfig() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<SettingsToastState | null>(null);

  const showToast = useCallback(
    (type: SettingsToastState["type"], message: string) => {
      setToast({ type, message });
      setTimeout(() => setToast(null), 4000);
    },
    [],
  );

  const interpret = useCallback(
    (res: ConfigUpdateResponse, successMessage: string) => {
      const warnings = Object.values(res.errors ?? {});
      if (warnings.length > 0) {
        showToast("warning", warnings.join(" "));
      } else if (res.requiresRestart?.length > 0) {
        showToast(
          "warning",
          `Updated. Restart daemon for: ${res.requiresRestart.join(", ")}`,
        );
      } else {
        showToast("success", successMessage);
      }
    },
    [showToast],
  );

  const saveField = useCallback(
    async (key: EditableConfigKey, value: ConfigValue) => {
      try {
        const res = await api.patch<ConfigUpdateResponse>("/config", {
          [key]: value,
        });
        queryClient.invalidateQueries({ queryKey: ["config"] });
        interpret(res, "Setting updated");
      } catch (e) {
        showToast(
          "error",
          `Failed to save: ${e instanceof Error ? e.message : "Unknown error"}`,
        );
        throw e;
      }
    },
    [queryClient, interpret, showToast],
  );

  const saveMultipleFields = useCallback(
    async (updates: Partial<Record<EditableConfigKey, ConfigValue>>) => {
      try {
        const res = await api.patch<ConfigUpdateResponse>("/config", updates);
        queryClient.invalidateQueries({ queryKey: ["config"] });
        interpret(res, "Settings updated");
      } catch (e) {
        showToast(
          "error",
          `Failed to save: ${e instanceof Error ? e.message : "Unknown error"}`,
        );
        throw e;
      }
    },
    [queryClient, interpret, showToast],
  );

  /**
   * Lower-level PATCH /config — makes the API call and invalidates queries
   * but does NOT show a toast. Used by SettingsSaveBar which handles its
   * own feedback.
   */
  const patchConfig = useCallback(
    async (updates: Partial<Record<EditableConfigKey, ConfigValue>>) => {
      const res = await api.patch<ConfigUpdateResponse>("/config", updates);
      queryClient.invalidateQueries({ queryKey: ["config"] });
      return res;
    },
    [queryClient],
  );

  return { toast, showToast, saveField, saveMultipleFields, patchConfig };
}
