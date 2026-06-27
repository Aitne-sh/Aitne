import { Badge } from "@/components/ui/badge";
import { statusBadgeVariant } from "@/lib/status-badge";

interface StatusBadgeProps {
  status: string;
  /** Display text; defaults to the raw status value. */
  label?: string;
  /** Render the pulsing live dot. Defaults to `status === "running"`. */
  live?: boolean;
  className?: string;
}

/**
 * Status pill colored via the shared `STATUS_BADGE_VARIANTS`
 * vocabulary (see `lib/status-badge.ts`). Running rows get the
 * pulsing dot that the schedule page and browser-task badge used to
 * duplicate independently.
 */
export function StatusBadge({ status, label, live, className }: StatusBadgeProps) {
  const isLive = live ?? status === "running";
  const text = label ?? status;
  return (
    <Badge variant={statusBadgeVariant(status)} className={className}>
      {isLive ? (
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning"
          />
          {text}
        </span>
      ) : (
        text
      )}
    </Badge>
  );
}
