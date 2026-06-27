import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import type { HTMLAttributes } from "react";

const cardVariants = cva(
  "rounded-xl border p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.10)]",
  {
    variants: {
      tone: {
        default: "border-border bg-card",
        // Theme-token tints — the /5 wash keeps tinted cards close to the
        // plain card surface; light/dark handled by the tokens themselves.
        warning: "border-warning/40 bg-warning/5",
        success: "border-success/40 bg-success/5",
        error: "border-destructive/40 bg-destructive/5",
      },
      interactive: {
        true: "transition-shadow duration-150 hover:shadow-[0_4px_6px_rgb(0_0_0/0.06)]",
        false: "",
      },
    },
    defaultVariants: { tone: "default", interactive: false },
  },
);

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export function Card({ className, tone, interactive, ...props }: CardProps) {
  return (
    <div className={cn(cardVariants({ tone, interactive }), className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3 flex items-center justify-between", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-base font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

export function CardStatLabel({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

// No `tabular-nums` here: the display face (Fraunces Variable) ships no `tnum`
// feature ("liga"/"rvrn"/"kern" only, verified via fontkit), so the utility was
// an inert no-op. Stat figures render with Fraunces' proportional digits.
export function CardValue({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "font-display text-3xl font-semibold tracking-tight text-foreground",
        className,
      )}
      {...props}
    />
  );
}
