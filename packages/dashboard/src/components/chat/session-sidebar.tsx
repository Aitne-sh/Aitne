"use client";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatShortDateTime, formatAbsoluteTime, formatRelativeTime, formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { BACKEND_BADGE_VARIANTS } from "@/lib/backend-ui";
import {
  formatSessionSourcePlatform,
  type ChatHistorySession,
} from "@/lib/chat-history-sessions";
import { isBackendId } from "@aitne/shared";
import { MessageSquare, Plus, Square, Trash2, X } from "lucide-react";
import type { SessionInfo } from "@/lib/hooks/use-chat";

export interface PastSessionSelection {
  id: number;
}

interface SessionSidebarProps {
  pastSessions: ChatHistorySession[];
  /** The SSE "current" session info (always the live session) */
  currentSessionInfo: SessionInfo | null;
  currentMessageCount: number;
  /** Which past session is currently active (null = live session) */
  activePastId: number | null;
  onSelectPast: (session: PastSessionSelection) => void;
  onContinuePast: (session: PastSessionSelection) => void;
  onSelectCurrent: () => void;
  onEndSession: () => void;
  onDeletePast: (session: PastSessionSelection) => void;
  onCleanAll: () => void;
  /** True while a delete request is in flight — disables delete buttons. */
  deleteInFlight: boolean;
  /** Non-null when the most recent delete failed; shown as an inline banner. */
  deleteError: string | null;
  onDismissDeleteError: () => void;
}

/** Badge color based on backend type */
function badgeVariant(backend?: string): "orange" | "pink" | "blue" | "gray" {
  return backend && isBackendId(backend) ? BACKEND_BADGE_VARIANTS[backend] : "gray";
}

export function SessionSidebar({
  pastSessions,
  currentSessionInfo,
  currentMessageCount,
  activePastId,
  onSelectPast,
  onContinuePast,
  onSelectCurrent,
  onEndSession,
  onDeletePast,
  onCleanAll,
  deleteInFlight,
  deleteError,
  onDismissDeleteError,
}: SessionSidebarProps) {
  const isCurrentSelected = activePastId === null;
  // Row click dispatches by the session's capability:
  //   - continuable dashboard session → Resume into the live chat.
  //   - anything else (messaging-platform DMs, archived dashboard
  //     sessions whose workdir was reclaimed) → read-only view.
  // The row's own indicators ("Read-only" badge, timestamp, message
  // count) convey which branch the click will take, so a separate pair
  // of View/Continue buttons would only duplicate the row itself.
  // The delete button stops propagation so it never triggers the
  // activation path.
  const handleActivatePastSession = (session: ChatHistorySession) => {
    if (!session.readOnlyFromDashboard && session.continueAvailable) {
      onContinuePast({ id: session.id });
      return;
    }
    onSelectPast({ id: session.id });
  };

  const describeActivation = (session: ChatHistorySession): string => {
    if (session.readOnlyFromDashboard) return "View this session";
    if (session.continueAvailable) return "Resume this browser session";
    return "View this archived session";
  };

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex h-12 items-center justify-between px-3">
        <h2 className="text-sm font-semibold text-foreground">Sessions</h2>
        {activePastId !== null && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onSelectCurrent}
            title="Back to current session"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <Separator />

      {/* Current session card */}
      <div className="p-2">
        <button
          onClick={onSelectCurrent}
          className={cn(
            "flex w-full flex-col gap-1.5 rounded-lg p-2.5 text-left transition-colors",
            isCurrentSelected
              ? "bg-primary/10 ring-1 ring-primary/20"
              : "hover:bg-accent",
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              currentSessionInfo ? "bg-success animate-pulse" : "bg-gray-400",
            )} />
            <span className="text-sm font-medium text-foreground">Current Session</span>
          </div>
          {currentSessionInfo ? (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {(currentSessionInfo.modelLabel || currentSessionInfo.model) && (
                <Badge variant={badgeVariant(currentSessionInfo.backend)} className="h-4 text-[10px] px-1.5 py-0">
                  {currentSessionInfo.modelLabel ?? currentSessionInfo.model}
                </Badge>
              )}
              <span>{formatCurrency(currentSessionInfo.costUsd ?? 0)}</span>
              <span>{currentMessageCount} msgs</span>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground">Connecting...</span>
          )}
        </button>

        {currentSessionInfo && isCurrentSelected && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1.5 w-full text-xs border-success/40 text-success hover:bg-success/10 hover:text-success"
            onClick={onEndSession}
          >
            <Square className="mr-1.5 h-3 w-3" />
            New Chat
          </Button>
        )}
      </div>

      <Separator />

      {deleteError && (
        <div className="px-2 pt-2">
          <Alert variant="error" className="items-center">
            <span className="flex-1">{deleteError}</span>
            <button
              type="button"
              onClick={onDismissDeleteError}
              className="ml-2 rounded p-0.5 text-destructive hover:bg-destructive/10"
              aria-label="Dismiss error"
            >
              <X className="h-3 w-3" />
            </button>
          </Alert>
        </div>
      )}

      {/* Past sessions */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          History
        </span>
        {pastSessions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onCleanAll}
            disabled={deleteInFlight}
            title="Delete all past sessions"
          >
            <Trash2 className="mr-1 h-3 w-3" />
            Clean all
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 px-2 pb-2">
          {pastSessions.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">Chat with the agent to see session history here</p>
          )}
          {pastSessions.map((s) => {
            const isSelected = activePastId === s.id;
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-1 rounded-lg p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  isSelected
                    ? "bg-primary/10 ring-1 ring-primary/20"
                    : "hover:bg-accent",
                )}
                onClick={() => handleActivatePastSession(s)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  handleActivatePastSession(s);
                }}
                title={describeActivation(s)}
              >
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm text-foreground truncate">
                    Session #{s.id}
                  </span>
                  {s.readOnlyFromDashboard && (
                    <Badge variant="gray" className="px-1.5 py-0 text-[10px]">
                      Read-only
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {s.sourcePlatforms.map((platform) => (
                    <Badge
                      key={`${s.id}-${platform}`}
                      variant={platform === "dashboard" ? "blue" : "purple"}
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {formatSessionSourcePlatform(platform)}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{s.message_count} msgs</span>
                  <span>·</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono tabular-nums">{formatShortDateTime(s.last_message_at)}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {formatAbsoluteTime(s.last_message_at)} ({formatRelativeTime(s.last_message_at)})
                    </TooltipContent>
                  </Tooltip>
                </div>
                {s.summary && (
                  <p className="line-clamp-1 text-[11px] text-muted-foreground/70">
                    {s.summary}
                  </p>
                )}
                <div className="mt-1 flex items-center justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={deleteInFlight}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeletePast({ id: s.id });
                    }}
                    title="Delete this session"
                    aria-label={`Delete session ${s.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
