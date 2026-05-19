"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { EventsContent } from "@/components/logs/events-content";
import { SystemLogsContent } from "@/components/logs/system-logs-content";
import { ConversationsContent } from "@/components/activity/conversations-content";
import { NotificationsContent } from "@/components/activity/notifications-content";
import { cn } from "@/lib/utils";

function ActivityPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") ?? "events";

  const handleTabChange = (next: string) => {
    router.replace(`/activity?tab=${next}`, { scroll: false });
  };

  // System Logs uses an internal ScrollArea that needs a bounded parent
  // (h-full → flex-1 chain). All other tabs let the page grow naturally
  // so main's overflow-y-auto scrolls and p-6's bottom padding stays visible.
  const isSystemTab = tab === "system";

  return (
    <div
      className={cn(
        "flex flex-col p-6 pb-8",
        isSystemTab ? "h-full" : "min-h-full",
      )}
    >
      <PageHeader
        className="mb-4"
        title="Agent Log"
        description={
          <>
            A historical record of everything the agent has seen or done. Use <strong>Events</strong> for agent invocations (what triggered a run, which backend served it, success/failure),{" "}
            <strong>System Logs</strong> for daemon-level output (startup, errors, warnings from the Hono server),{" "}
            <strong>Conversations</strong> for completed chat threads from every messaging platform, and <strong>Notifications</strong> for outbound messages the agent sent proactively.
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className={cn("flex flex-col", isSystemTab && "min-h-0 flex-1")}
      >
        <TabsList className="w-fit">
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="system">System Logs</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="mt-4">
          <EventsContent enabled={tab === "events"} />
        </TabsContent>

        <TabsContent value="system" className="mt-4 flex min-h-0 flex-1 flex-col">
          <SystemLogsContent enabled={tab === "system"} />
        </TabsContent>

        <TabsContent value="conversations" className="mt-4">
          <ConversationsContent enabled={tab === "conversations"} />
        </TabsContent>

        <TabsContent value="notifications" className="mt-4">
          <NotificationsContent enabled={tab === "notifications"} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense>
      <ActivityPageInner />
    </Suspense>
  );
}
