"use client";

import { Suspense, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import {
  ContextFilesContent,
  type ContextFilesHandle,
} from "@/components/knowledge/context-files-content";
import { SkillsContent } from "@/components/knowledge/skills-content";
import { KnowledgeUploadContent } from "@/components/knowledge/upload-content";
import { ActivityContent } from "@/components/knowledge/activity-content";
import { EntitiesContent } from "@/components/knowledge/entities-content";

// One concise line per tab. The full breakdown of all five surfaces used to
// live permanently in the page header, which wrapped to ~6 lines and pushed
// the two-pane file browser into the lower half of the viewport. Showing only
// the active tab's description keeps the header to a single line so the
// folder tree + file viewer get the vertical space.
const TAB_DESCRIPTIONS: Record<string, React.ReactNode> = {
  "context-files":
    "Markdown notes the agent loads on each run — its long-term memory.",
  skills:
    "Per-event-type behavioral guides materialized into the session workdir.",
  activity: "Per-source aggregates written by the management registry.",
  entities:
    "Structured records (people, organizations, projects) filterable by source, domain, type, or date.",
  upload:
    "Ingest a Markdown or text file; facts are folded into the right Context Files by topic.",
};

function KnowledgePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") ?? "context-files";
  const contextFilesRef = useRef<ContextFilesHandle>(null);

  const handleTabChange = async (newTab: string) => {
    if (tab === "context-files" && newTab !== "context-files") {
      const ok = await contextFilesRef.current?.confirmDiscard();
      if (!ok) return;
    }
    router.replace(`/knowledge?tab=${newTab}`, { scroll: false });
  };

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        className="mb-3"
        title="Knowledge"
        description={TAB_DESCRIPTIONS[tab]}
      />

      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-fit">
          <TabsTrigger value="context-files">Context Files</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="entities">Entities</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
        </TabsList>

        <TabsContent value="context-files" className="mt-4 min-h-0 flex-1">
          <ContextFilesContent ref={contextFilesRef} />
        </TabsContent>

        <TabsContent value="skills" className="mt-4 min-h-0 flex-1">
          <SkillsContent />
        </TabsContent>

        <TabsContent value="activity" className="mt-4 min-h-0 flex-1">
          <ActivityContent />
        </TabsContent>

        <TabsContent value="entities" className="mt-4 min-h-0 flex-1">
          <EntitiesContent />
        </TabsContent>

        <TabsContent value="upload" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <KnowledgeUploadContent />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense>
      <KnowledgePageInner />
    </Suspense>
  );
}
