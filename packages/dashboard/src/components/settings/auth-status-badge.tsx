"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatRelativeTime, parseUtcDate } from "@/lib/utils";
import { Loader2 } from "lucide-react";

type AuthStatus = "ok" | "expiring_soon" | "expired" | "missing" | "recovering" | "unknown";

interface AuthStatusBadgeProps {
  status: string;
  detail: string | null;
  firstExpiredAt: string | null;
  lastSuccessAt: string | null;
  notificationCount: number;
}

const STATUS_CONFIG: Record<AuthStatus, {
  variant: "green" | "amber" | "red" | "gray" | "blue";
  label: string;
  icon: string;
}> = {
  ok: { variant: "green", label: "OK", icon: "\u2705" },
  expiring_soon: { variant: "amber", label: "Expiring Soon", icon: "\uD83D\uDFE1" },
  expired: { variant: "red", label: "Expired", icon: "\uD83D\uDD34" },
  missing: { variant: "gray", label: "Missing", icon: "\u26AB" },
  recovering: { variant: "blue", label: "Recovering", icon: "\uD83D\uDD04" },
  unknown: { variant: "gray", label: "Unknown", icon: "\u2753" },
};

function normalizeStatus(raw: string): AuthStatus {
  if (raw in STATUS_CONFIG) return raw as AuthStatus;
  if (raw === "error") return "expired";
  return "unknown";
}

function formatElapsed(isoDate: string): string {
  const diffMs = Date.now() - parseUtcDate(isoDate).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Auth status badge with 5-state color coding, elapsed-time display for
 * failures, and a tooltip showing the detailed auth status information.
 *
 * Phase 8 §7.1.
 */
export function AuthStatusBadge({
  status: rawStatus,
  detail,
  firstExpiredAt,
  lastSuccessAt,
  notificationCount,
}: AuthStatusBadgeProps) {
  const status = normalizeStatus(rawStatus);
  const config = STATUS_CONFIG[status];

  const isRecovering = status === "recovering";
  const isFailure = status === "expired" || status === "missing";

  const elapsedText =
    isFailure && firstExpiredAt ? ` (${formatElapsed(firstExpiredAt)})` : "";

  const tooltipLines: string[] = [];
  tooltipLines.push(`Status: ${config.label}`);
  if (detail) tooltipLines.push(`Detail: ${detail}`);
  if (firstExpiredAt && isFailure) {
    tooltipLines.push(`Failed since: ${formatRelativeTime(firstExpiredAt)}`);
  }
  if (lastSuccessAt) {
    tooltipLines.push(`Last success: ${formatRelativeTime(lastSuccessAt)}`);
  }
  if (notificationCount > 0) {
    tooltipLines.push(`Notifications sent: ${notificationCount}`);
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant={config.variant} className="gap-1">
            {isRecovering ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            Auth: {config.label}
            {elapsedText}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-0.5 text-xs">
          {tooltipLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
