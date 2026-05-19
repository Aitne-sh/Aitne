import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import type { HTMLAttributes } from "react";

const cardVariants = cva(
  "rounded-xl border p-5 shadow-[0_1px_3px_rgb(0_0_0/0.04)]",
  {
    variants: {
      tone: {
        default: "border-border bg-card",
        warning:
          "border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/30",
        success:
          "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30",
        error:
          "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/30",
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
      className={cn("text-lg font-semibold text-foreground", className)}
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
      className={cn("text-sm font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardValue({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-3xl font-bold text-foreground", className)} {...props} />;
}
