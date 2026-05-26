"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AppSidebar } from "./app-sidebar";
import { DegradedBanner } from "./degraded-banner";
import { VaultRestructureModal } from "./vault-restructure-modal";
import { CmdkPalette } from "@/components/settings/cmdk-palette";
import { DocsHelpButton } from "@/components/docs/docs-help-button";
import { DocsHelpKeybinding } from "@/components/docs/docs-help-keybinding";
import { DocsHelpSlideover } from "@/components/docs/docs-help-slideover";
import { docIdForPath } from "@/lib/docs/page-doc-map";

function LayoutShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Hide sidebar during initial setup (fullscreen wizard)
  // Keep sidebar during update mode (user navigated from overview)
  const isInitialSetup =
    pathname === "/setup" && searchParams.get("mode") !== "update";

  // The page → docId map drives the help button; `null` hides the
  // button (e.g. on /docs itself). docIdForPath copies search params
  // so the predicate sees a plain URLSearchParams.
  const search = new URLSearchParams(Array.from(searchParams.entries()));
  const docId = docIdForPath(pathname, search);

  // The DegradedBanner sits above the sidebar+main flex row so that a
  // critical "writes are blocked" signal stays visible even while the
  // main content scrolls. It renders null when the daemon is healthy.
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {!isInitialSetup && <DegradedBanner />}
      <div className="flex min-h-0 flex-1">
        {!isInitialSetup && <AppSidebar />}
        <main className="flex flex-1 flex-col overflow-hidden">
          {!isInitialSetup && (
            // Thin top action strip — DOCS_QA_DASHBOARD_DESIGN.md §6.3.
            // Stays mounted on every authenticated page so the strip's
            // height is uniform; the button hides itself when docId is
            // null (e.g. /docs). During initial setup the wizard renders
            // its own help affordance (DOCS_QA_DESIGN.md §8.4 row E5),
            // so we suppress this strip to keep the wizard fullscreen.
            <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-b border-border bg-background/80 px-3 backdrop-blur">
              <DocsHelpButton docId={docId} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </main>
      </div>
      {/* Slide-over and `?`-keypress mount globally — including during
          initial setup — so the wizard's help affordance has a target
          to open. CmdkPalette stays gated because the palette is
          settings-focused and not relevant to a fresh-install wizard. */}
      <DocsHelpSlideover />
      <DocsHelpKeybinding />
      {!isInitialSetup && <CmdkPalette />}
      {/* CONTEXT_VAULT_REDESIGN_PLAN.md §11.3.4 / V16 — Obsidian-mode
          consent modal. Suppressed during the initial-setup wizard
          since a brand-new install has no legacy vault to migrate. */}
      <VaultRestructureModal enabled={!isInitialSetup} />
    </div>
  );
}

export function LayoutShell({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <LayoutShellInner>{children}</LayoutShellInner>
    </Suspense>
  );
}
