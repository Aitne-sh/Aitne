import { cn } from "@/lib/utils";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * Dashed-border container for the per-platform pairing/setup steps used in
 * Connections (Slack/Telegram/Discord) and the legacy messaging panel.
 *
 * The visual shell — `rounded-lg border border-dashed border-input bg-background/50 p-3`
 * — was duplicated ~19 times across four files; collapsing it here keeps the
 * step bodies (which are intentionally bespoke per platform) close to their
 * handlers while the framing stays consistent.
 *
 * `heading` (not `title`) intentionally — keeping `title` free lets the native
 * HTML `title` attribute (tooltip text) pass through via `...rest`.
 */
export interface StepCardProps extends HTMLAttributes<HTMLDivElement> {
  heading?: ReactNode;
  /** Vertical rhythm between children. Mirrors the `space-y-2` / `space-y-3`
   *  variants the call sites used; pass `"none"` (default) for the original
   *  no-`space-y-*` form, where bespoke per-child margins (`mt-1`/`mt-2`/…)
   *  carry the spacing. */
  spacing?: "none" | "sm" | "md";
}

const SPACING_CLASS = {
  none: "",
  sm: "space-y-2",
  md: "space-y-3",
} as const;

export function StepCard({
  className,
  heading,
  spacing = "none",
  children,
  ...rest
}: StepCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-input bg-background/50 p-3",
        SPACING_CLASS[spacing],
        className,
      )}
      {...rest}
    >
      {heading != null && <p className="text-xs font-medium">{heading}</p>}
      {children}
    </div>
  );
}
