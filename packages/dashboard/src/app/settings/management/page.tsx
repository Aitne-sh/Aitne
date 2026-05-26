"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { SotBindingsCard } from "@/components/settings/sot-bindings-card";
import { ManagedTasksCard } from "@/components/settings/managed-tasks-card";
import { ManagementHistoryCard } from "@/components/settings/management-history-card";

/**
 * Settings → Management (docs/design/21-management-registry-and-
 * entities.md §14.1).
 *
 * The page surfaces the three concerns rendered into
 * `policies/management.md`: A (SoT bindings), B (managed tasks), and the
 * audit history that backs both.
 *
 * History lives behind its own tab so the default surface stays focused
 * on actionable state — the bindings + tasks the agent currently uses.
 *
 * Tab state is URL-anchored (`?tab=…`) for parity with the Knowledge
 * page so refresh / deep-link / back-button all preserve the user's
 * place. `useSearchParams` requires a Suspense boundary in Next.js 16
 * (the wrapper would otherwise be dead code).
 */

const TAB_KEYS = ["tasks", "bindings", "history"] as const;
type TabKey = (typeof TAB_KEYS)[number];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value);
}

function ManagementPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const raw = searchParams.get("tab");
  const tab: TabKey = isTabKey(raw) ? raw : "tasks";

  const handleTabChange = (next: string) => {
    if (!isTabKey(next)) return;
    router.replace(`/settings/management?tab=${next}`, { scroll: false });
  };

  return (
    <>
      <PageHeader
        title="Management"
        description={
          <>
            Source-of-Truth bindings (Section A) and Managed Tasks (Section B) —
            the structured rows the daemon renders into{" "}
            <code>policies/management.md</code> and injects into every agent
            session. Edits here re-render the file atomically; the agent picks
            up the new state on its next session.
          </>
        }
      />

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="tasks">Managed Tasks</TabsTrigger>
          <TabsTrigger value="bindings">SoT Bindings</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="pt-3">
          <ManagedTasksCard />
        </TabsContent>
        <TabsContent value="bindings" className="pt-3">
          <SotBindingsCard />
        </TabsContent>
        <TabsContent value="history" className="pt-3">
          <ManagementHistoryCard />
        </TabsContent>
      </Tabs>
    </>
  );
}

export default function ManagementPage() {
  return (
    <Suspense>
      <ManagementPageInner />
    </Suspense>
  );
}
