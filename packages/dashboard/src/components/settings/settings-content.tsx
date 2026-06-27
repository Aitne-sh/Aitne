"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HaikuAdvisorWarning } from "@/components/settings/haiku-advisor-warning";
import { SettingsSaveBar } from "@/components/settings/save-bar";

/**
 * Inner content area for the settings layout.
 * Renders HaikuAdvisorWarning, page content, and the sticky save bar.
 * Must be rendered inside DirtyFieldsProvider (mounted in SettingsShell).
 *
 * On md+ this is its own scroll region (SETTINGS_REDESIGN_PLAN.md §2):
 * the pane resets to the top whenever the settings route changes, so
 * navigating between settings pages never moves the nav or the app
 * chrome. Nav links pass `scroll={false}` so Next.js's default
 * scroll-to-top doesn't fight the pane. In-pane anchors keep working —
 * `#execution-mode` and the cmdk `scrollIntoView` both resolve against
 * the nearest scrollable ancestor, which is now this pane.
 */
export function SettingsContent({ children }: { children: ReactNode }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    // Skip the reset when the URL carries a hash — the browser (or cmdk)
    // is about to scroll the target into view and a reset would race it.
    if (window.location.hash) return;
    paneRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div
      ref={paneRef}
      className="min-w-0 flex-1 space-y-6 md:h-full md:overflow-y-auto md:pb-6"
    >
      <HaikuAdvisorWarning />
      {children}
      <SettingsSaveBar />
    </div>
  );
}
