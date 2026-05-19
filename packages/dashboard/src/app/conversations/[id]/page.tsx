"use client";

import { use } from "react";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useConversationMessages } from "@/lib/hooks/use-conversation-messages";
import { useConfig } from "@/lib/hooks/use-config";
import { MessageBubble } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { parseUtcDate } from "@/lib/utils";

export default function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const conversationId = Number(id);
  const { data: config } = useConfig();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useConversationMessages(conversationId);
  const assistantLabel = config?.agentDisplayName ?? DEFAULT_AGENT_DISPLAY_NAME;

  const messages = data?.pages.flatMap((p) => p.messages) ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link href="/activity?tab=conversations">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-lg font-semibold text-foreground">
          Conversation #{conversationId}
        </h1>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? "Loading..." : "Load older messages"}
              </Button>
            </div>
          )}

          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={{
                id: String(m.id),
                role: m.role as "user" | "assistant",
                content: m.content,
                timestamp: parseUtcDate(m.timestamp),
              }}
              assistantLabel={assistantLabel}
            />
          ))}

          {messages.length === 0 && (
            <p className="text-center text-muted-foreground">No messages</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
