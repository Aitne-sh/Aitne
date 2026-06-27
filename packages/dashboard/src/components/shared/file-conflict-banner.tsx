import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Conflict banner shown when an editor (journal, mcp rules, context-files)
 * detects that the underlying MD file was overwritten between load and save.
 *
 * The same UI used to be inlined in three places verbatim — same icon, copy,
 * button layout — diverging only in the "Reload" button label and the
 * concrete handlers. Centralizing it keeps the optimistic-concurrency UX
 * consistent across editors.
 *
 * `role="alert"` + `aria-live="assertive"` so screen readers announce the
 * conflict immediately when it appears (the banner only renders in response
 * to a 409 the user just triggered with Save). The original inline copies
 * had no a11y attributes — adding them here is a net improvement.
 */
export interface FileConflictBannerProps {
  onReload: () => void;
  onOverwrite: () => void;
  isPending?: boolean;
  /** Override for the reload button label. Defaults to "Reload latest". */
  reloadLabel?: string;
  className?: string;
}

export function FileConflictBanner({
  onReload,
  onOverwrite,
  isPending = false,
  reloadLabel = "Reload latest",
  className,
}: FileConflictBannerProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "rounded-md border border-warning/50 bg-warning/10 p-3 text-xs",
        className,
      )}
    >
      <div className="mb-2 flex items-center gap-2 font-semibold text-warning">
        <AlertTriangle className="h-3.5 w-3.5" />
        File was modified by another process
      </div>
      <p className="mb-3 text-warning/90">
        The agent or another tab wrote to this file after you started editing.
        Your unsaved draft is preserved — choose how to proceed.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onReload}
          disabled={isPending}
          className="h-7"
        >
          {reloadLabel}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={onOverwrite}
          disabled={isPending}
          className="h-7"
        >
          {isPending ? "Overwriting…" : "Overwrite with my edits"}
        </Button>
      </div>
    </div>
  );
}
