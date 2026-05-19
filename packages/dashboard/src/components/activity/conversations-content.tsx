"use client";

import { useState } from "react";
import Link from "next/link";
import { useConversations } from "@/lib/hooks/use-conversations";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult } from "@/components/shared/query-result";
import { DocsLearnMore } from "@/components/docs/docs-learn-more";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatShortDateTime, formatAbsoluteTime, formatRelativeTime } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { formatShortModelName, modelBadgeVariant } from "@/lib/backend-ui";
import { Hash, MessageSquare, MessagesSquare, Send, Smartphone, LayoutDashboard } from "lucide-react";

const PLATFORMS = ["all", "slack", "discord", "telegram", "whatsapp", "dashboard"];
const STATUSES = ["all", "active", "expired", "closed"];
const PLATFORM_ICON: Record<string, React.ElementType> = {
  slack: Hash,
  discord: MessagesSquare,
  telegram: Send,
  whatsapp: Smartphone,
  dashboard: LayoutDashboard,
};

const STATUS_BADGE_VARIANT: Record<string, "green" | "red" | "gray"> = {
  active: "green",
  closed: "red",
  expired: "gray",
};

const PLATFORM_BORDER_COLOR: Record<string, string> = {
  slack: "border-l-purple-500",
  discord: "border-l-indigo-500",
  telegram: "border-l-sky-500",
  whatsapp: "border-l-emerald-500",
  dashboard: "border-l-gray-400",
};

export function ConversationsContent({ enabled = true }: { enabled?: boolean }) {
  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState("all");

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } = useConversations(
    {
      platform: platform === "all" ? undefined : platform,
      status: status === "all" ? undefined : status,
    },
    { enabled },
  );

  const conversations = data?.pages.flatMap((p) => p.conversations) ?? [];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3" role="toolbar" aria-label="Conversation filters">
        <div className="flex gap-1">
          {PLATFORMS.map((p) => (
            <Button
              key={p}
              variant={platform === p ? "default" : "outline"}
              size="sm"
              onClick={() => setPlatform(p)}
              aria-pressed={platform === p}
            >
              {p === "all" ? "All" : p}
            </Button>
          ))}
        </div>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex gap-1">
          {STATUSES.map((s) => (
            <Button
              key={s}
              variant={status === s ? "default" : "outline"}
              size="sm"
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
            >
              {s === "all" ? "All" : s}
            </Button>
          ))}
        </div>
      </div>

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
      >
        {/* Conversation cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {conversations.map((conv) => {
            const Icon = PLATFORM_ICON[conv.platform] ?? MessageSquare;

            return (
              <Link key={conv.id} href={`/conversations/${conv.id}`}>
                <Card className={`cursor-pointer border-l-4 min-h-[120px] ${PLATFORM_BORDER_COLOR[conv.platform] ?? "border-l-gray-300"}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground capitalize">{conv.platform}</span>
                    </div>
                    <Badge variant={STATUS_BADGE_VARIANT[conv.status] ?? "gray"}>
                      {conv.status}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-1">
                    <p className="text-sm text-muted-foreground">
                      <Badge variant={modelBadgeVariant(conv.model)} className="mr-1.5">
                        {formatShortModelName(conv.model)}
                      </Badge>
                      {conv.message_count} messages
                    </p>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="text-xs font-mono tabular-nums text-muted-foreground">
                          {formatShortDateTime(conv.last_message_at)}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent>
                        {formatAbsoluteTime(conv.last_message_at)} ({formatRelativeTime(conv.last_message_at)})
                      </TooltipContent>
                    </Tooltip>
                    {conv.summary && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{conv.summary}</p>
                    )}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>

        {conversations.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No conversations found"
            description="Conversations will appear here when the agent interacts via messaging platforms"
          >
            <div className="mt-4">
              <DocsLearnMore docId="features/operations/activity-and-conversations" />
            </div>
          </EmptyState>
        ) : null}

        {hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}
      </QueryResult>
    </div>
  );
}
