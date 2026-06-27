"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { BACKEND_BADGE_VARIANTS } from "@/lib/backend-ui";
import type { BackendId } from "@aitne/shared";
import type { ChatCurrentBindingResponse } from "@/lib/api-types";
import type { SessionInfo } from "@/lib/hooks/use-chat";

interface SessionInfoBarProps {
  sessionInfo: SessionInfo | null;
  binding: ChatCurrentBindingResponse | null;
  sessionSourceLabel?: string | null;
  readOnly?: boolean;
  messageCount: number;
  onEndSession: () => void;
  showEndSession?: boolean;
}

export function SessionInfoBar({
  sessionInfo,
  binding,
  sessionSourceLabel,
  readOnly = false,
  messageCount,
  onEndSession,
  showEndSession = true,
}: SessionInfoBarProps) {
  // Prefer sessionInfo over binding as a SINGLE source — never mix fields
  // across them. sessionInfo carries either the dispatcher-resolved route
  // from the last turn or a synthesized override/past-session preview set
  // by the page; binding only reflects the process config default and
  // ignores picker overrides and per-session history. Field-by-field
  // fallback would let a past-session model label pair with the current
  // binding's backend, producing a label like `gemini / claude-opus-4-8`.
  const source =
    sessionInfo?.model || sessionInfo?.modelLabel
      ? {
          backend: sessionInfo.backend,
          label: sessionInfo.modelLabel ?? sessionInfo.model ?? null,
        }
      : binding
        ? {
            backend: binding.activeBackend,
            label: binding.activeModelLabel ?? binding.activeModel,
          }
        : null;
  const activeLabel = source?.label
    ? source.backend
      ? `${source.backend} / ${source.label}`
      : source.label
    : null;

  return (
    <div className="border-b border-border bg-background px-4 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {activeLabel && (
            <Badge
              variant={
                source?.backend
                  ? BACKEND_BADGE_VARIANTS[source.backend as BackendId]
                  : "gray"
              }
            >
              {activeLabel}
            </Badge>
          )}
          {binding?.fallbackActive && (
            <Badge variant="amber">
              Fallback: {binding.fallbackBackend} / {binding.fallbackModel}
            </Badge>
          )}
          {sessionSourceLabel && (
            <Badge variant="gray">
              {sessionSourceLabel}
            </Badge>
          )}
          {readOnly && (
            <Badge variant="gray">
              Read-only
            </Badge>
          )}
          {typeof sessionInfo?.costUsd === "number" && (
            <span className="text-xs text-muted-foreground">
              {formatCurrency(sessionInfo.costUsd)}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {messageCount} messages
          </span>
        </div>
        {showEndSession && (
          <Button
            variant="outline"
            size="sm"
            className="border-success/40 text-success hover:bg-success/10 hover:text-success"
            onClick={onEndSession}
          >
            New Chat
          </Button>
        )}
      </div>
    </div>
  );
}
