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
 * Two-pane scroll containment (SETTINGS_REDESIGN_PLAN.md §2): on md+ the
 * shell fills the LayoutShell scroll pane (`h-full overflow-hidden`) and
 * each column scrolls independently — the nav never moves when the
 * content scrolls, and SettingsContent resets its own scrollTop on route
 * change so every page opens at its top. Below md the shell stays in
 * normal document flow (the mobile chip-row nav scrolls with the page).
 * `md:pb-0` hands the bottom padding to the panes so the sticky SaveBar
 * sits flush with the viewport bottom instead of floating above the
 * shell's padding.
 *
 * The Cmd+K palette is mounted globally by `<LayoutShell>` so the
 * "Ask docs…" action (DOCS_QA_DASHBOARD_DESIGN.md §9) is reachable
 * from every page, not just the settings tree.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  return (
    <DirtyFieldsProvider>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 md:h-full md:flex-row md:gap-8 md:overflow-hidden md:pb-0">
        <aside className="md:h-full md:shrink-0 md:overflow-y-auto md:pb-6">
          <SettingsNavigation />
        </aside>
        <SettingsContent>{children}</SettingsContent>
      </div>
    </DirtyFieldsProvider>
  );
}
