"use client";

import type { ReactNode } from "react";
import { DirtyFieldsProvider } from "@/lib/hooks/use-dirty-fields";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { SettingsContent } from "@/components/settings/settings-content";

/**
 * Top-level client wrapper for the settings layout.
 * Provides DirtyFieldsProvider to both the sidebar (SettingsNavigation)
 * and the content area (SettingsContent + SaveBar).
 *
 * The Cmd+K palette is mounted globally by `<LayoutShell>` so the
 * "Ask docs…" action (DOCS_QA_DASHBOARD_DESIGN.md §9) is reachable
 * from every page, not just the settings tree.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  return (
    <DirtyFieldsProvider>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 md:flex-row md:items-start md:gap-8">
        <aside className="md:sticky md:top-6">
          <SettingsNavigation />
        </aside>
        <SettingsContent>{children}</SettingsContent>
      </div>
    </DirtyFieldsProvider>
  );
}
