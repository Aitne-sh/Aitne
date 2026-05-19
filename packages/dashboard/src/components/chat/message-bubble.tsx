"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import type { ChatMessage } from "@/lib/hooks/use-chat";
import { MessageAttachments } from "./message-attachments";

interface MessageBubbleProps {
  message: ChatMessage;
  assistantLabel?: string;
}

const remarkPlugins = [remarkGfm];

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  a: ({ children, href, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};

export const MessageBubble = memo(function MessageBubble({
  message,
  assistantLabel = "Assistant",
}: MessageBubbleProps) {
  if (message.role === "error") {
    return (
      <Alert variant="error" className="mx-auto max-w-md rounded-lg px-4 py-2 text-sm">
        {message.content}
      </Alert>
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className="max-w-[80%] space-y-1">
        {!isUser && (
          <p className="px-1 text-[11px] font-medium text-muted-foreground">
            {assistantLabel}
          </p>
        )}
        {message.content && (
          <div
            className={cn(
              "rounded-2xl px-4 py-2.5 text-sm",
              isUser
                ? "whitespace-pre-wrap rounded-br-md bg-primary text-primary-foreground [overflow-wrap:anywhere]"
                : "markdown-body markdown-bubble rounded-bl-md border border-border bg-card text-foreground",
            )}
          >
            {isUser ? (
              message.content
            ) : (
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                components={markdownComponents}
              >
                {message.content}
              </ReactMarkdown>
            )}
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="px-1">
            <MessageAttachments
              attachments={message.attachments}
              isOwn={isUser}
            />
          </div>
        )}
        {!isUser && message.meta && (
          <p className="px-1 text-[10px] text-muted-foreground/60">
            {[
              message.meta.backend && message.meta.model
                ? `${message.meta.backend} · ${message.meta.model}`
                : message.meta.backend || message.meta.model,
              message.meta.durationMs != null
                ? `${(message.meta.durationMs / 1000).toFixed(1)}s`
                : null,
              message.meta.costUsd != null
                ? `$${message.meta.costUsd.toFixed(4)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
});
