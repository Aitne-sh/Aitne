"use client";

import type { ReactNode } from "react";
import { HaikuAdvisorWarning } from "@/components/settings/haiku-advisor-warning";
import { SettingsSaveBar } from "@/components/settings/save-bar";

/**
 * Inner content area for the settings layout.
 * Renders HaikuAdvisorWarning, page content, and the sticky save bar.
 * Must be rendered inside DirtyFieldsProvider (mounted in SettingsShell).
 */
export function SettingsContent({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 space-y-6">
      <HaikuAdvisorWarning />
      {children}
      <SettingsSaveBar />
    </div>
  );
}
