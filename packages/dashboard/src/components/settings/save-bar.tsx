"use client";

import { useEffect, useState } from "react";
import { Save, Undo2 } from "lucide-react";
import { RESTART_REQUIRED_KEY_TUPLE } from "@aitne/shared";
import type { EditableConfigKey } from "@aitne/shared";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import { useSaveConfig, type ConfigValue } from "@/lib/hooks/use-save-config";

const RESTART_SET = new Set<string>(RESTART_REQUIRED_KEY_TUPLE);

function isRestartRequired(key: EditableConfigKey): boolean {
  return RESTART_SET.has(key);
}

/**
 * Warns the user when they try to close the tab or navigate away externally
 * with unsaved settings changes.
 */
function useBeforeUnloadGuard(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);
}

/**
 * Intercepts clicks on `<a>` elements that navigate away from /settings/*
 * (e.g. the main sidebar links to /chat, /activity). Shows a native confirm
 * dialog; if cancelled, prevents the navigation.
 *
 * Uses capture phase so it fires before Next.js's Link click handler.
 */
function useClientNavigationGuard(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: MouseEvent) => {
      // Walk up from click target to find the nearest <a>
      const anchor = (e.target as HTMLElement).closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Only guard navigations AWAY from settings
      if (href.startsWith("/settings")) return;
      // External links are handled by beforeunload
      if (href.startsWith("http")) return;
      // This is an in-app navigation leaving settings — confirm
      const ok = window.confirm(
        "You have unsaved settings changes. Leave without saving?",
      );
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", handler, true); // capture phase
    return () => document.removeEventListener("click", handler, true);
  }, [isDirty]);
}

/**
 * Sticky bar rendered at the bottom of the settings content area.
 * Visible only when at least one field has been modified but not yet saved.
 */
export function SettingsSaveBar() {
  const { dirtyFields, dirtyCount, isDirty, discardAll, clearDirtyKeys } = useDirtyFields();
  const { patchConfig } = useSaveConfig();
  const confirmDialog = useConfirm();
  useBeforeUnloadGuard(isDirty);
  useClientNavigationGuard(isDirty);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "warning";
    message: string;
  } | null>(null);

  if (!isDirty && !feedback) return null;

  const restartKeys = [...dirtyFields.keys()].filter(isRestartRequired);

  const handleSave = async () => {
    if (restartKeys.length > 0) {
      const ok = await confirmDialog({
        title: "Daemon restart required",
        description: `This change requires a daemon restart to take effect. The agent will be unavailable for ~5 seconds.\n\nAffected: ${restartKeys.join(", ")}`,
        confirmLabel: "Save & restart",
        variant: "destructive",
      });
      if (!ok) return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const updates = Object.fromEntries(dirtyFields) as Partial<
        Record<EditableConfigKey, ConfigValue>
      >;
      const res = await patchConfig(updates);

      const errors = Object.values(res.errors ?? {});
      if (errors.length > 0) {
        // Partial success: clear the keys that did succeed, keep the failed ones dirty.
        const updatedKeys = (res.updated ?? []) as EditableConfigKey[];
        if (updatedKeys.length > 0) {
          clearDirtyKeys(updatedKeys);
        }
        setFeedback({ type: "error", message: errors.join(" ") });
      } else if (res.requiresRestart?.length > 0) {
        setFeedback({
          type: "warning",
          message: `Saved. Restart daemon for: ${res.requiresRestart.join(", ")}`,
        });
        discardAll();
      } else {
        setFeedback({ type: "success", message: "All settings saved" });
        discardAll();
        setTimeout(() => setFeedback(null), 3000);
      }
    } catch (e) {
      setFeedback({
        type: "error",
        message: `Save failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    discardAll();
    setFeedback(null);
  };

  return (
    <div className="sticky bottom-0 z-30 -mx-6 mt-6 border-t border-border bg-background/95 backdrop-blur-sm px-6 py-3">
      {feedback && (
        <Alert variant={feedback.type} className="mb-3">
          {feedback.message}
        </Alert>
      )}
      {isDirty && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {dirtyCount} unsaved change{dirtyCount !== 1 ? "s" : ""}
            {restartKeys.length > 0 && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                (restart required)
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDiscard}
              disabled={saving}
            >
              <Undo2 className="h-3.5 w-3.5 mr-1" />
              Discard
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <Save className="h-3.5 w-3.5 mr-1" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
