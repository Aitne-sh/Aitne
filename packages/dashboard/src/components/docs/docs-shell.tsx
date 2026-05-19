"use client";

import { useSyncExternalStore } from "react";
import { PanelRightOpen } from "lucide-react";
import { DocsTree } from "./docs-tree";
import { DocsContent } from "./docs-content";
import { DocsQAPanel } from "./docs-qa-panel";
import { cn } from "@/lib/utils";

interface DocsShellProps {
  selectedSlug: string | null;
}

const QA_PANEL_OPEN_KEY = "pa.docs.qa-panel.open";

const listeners: Set<() => void> = new Set();

function readQAPanelOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(QA_PANEL_OPEN_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeQAPanelOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QA_PANEL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // localStorage blocked (private mode, quota). Listeners still fire so
    // the toggle takes effect this session; reload restores the default.
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (e.key === QA_PANEL_OPEN_KEY || e.key === null) cb();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", storageHandler);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", storageHandler);
    }
  };
}

// SSR + first paint default to expanded — matches the historical behavior
// so the panel doesn't flash hidden for users who've never toggled it.
function getServerSnapshot(): boolean {
  return true;
}

function useQAPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, readQAPanelOpen, getServerSnapshot);
}

/**
 * The `/docs` page shell — a 3-pane CSS grid (tree | content | QA panel).
 * Below 1280px viewports the QA pane is hidden (responsive collapse is a
 * follow-up tab-switcher; see DOCS_QA_DASHBOARD_DESIGN.md §5.1). At xl+
 * the QA pane can be collapsed via a header button; preference persists
 * in localStorage so it stays collapsed across reloads.
 */
export function DocsShell({ selectedSlug }: DocsShellProps) {
  const qaOpen = useQAPanelOpen();
  return (
    <div
      className={cn(
        "grid h-full min-h-0 gap-0",
        qaOpen
          ? "grid-cols-[220px_1fr] xl:grid-cols-[220px_1fr_360px]"
          : "grid-cols-[220px_1fr] xl:grid-cols-[220px_1fr_36px]",
      )}
    >
      <aside className="overflow-y-auto border-r border-border bg-muted/30">
        <DocsTree activeSlug={selectedSlug} />
      </aside>
      <main className="min-w-0 overflow-y-auto">
        <DocsContent slug={selectedSlug} />
      </main>
      {qaOpen ? (
        <aside className="hidden overflow-y-auto border-l border-border bg-muted/20 xl:block">
          <DocsQAPanel
            scope="all"
            contextHint={{ slug: selectedSlug }}
            onCollapse={() => writeQAPanelOpen(false)}
          />
        </aside>
      ) : (
        <aside className="hidden flex-col items-center border-l border-border bg-muted/20 pt-3 xl:flex">
          <button
            type="button"
            onClick={() => writeQAPanelOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="Open Ask the Agent panel"
            title="Open Ask the Agent"
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
          </button>
        </aside>
      )}
    </div>
  );
}
