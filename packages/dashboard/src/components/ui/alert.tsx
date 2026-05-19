import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from "lucide-react";
import type { HTMLAttributes } from "react";

const alertVariants = cva(
  "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
  {
    variants: {
      variant: {
        success:
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
        error:
          "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
        warning:
          "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
        info:
          "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

const ICON_BY_VARIANT: Record<
  NonNullable<VariantProps<typeof alertVariants>["variant"]>,
  LucideIcon
> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

export interface AlertProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  icon?: boolean;
}

export function Alert({
  className,
  variant,
  icon = true,
  role,
  "aria-live": ariaLive,
  children,
  ...props
}: AlertProps) {
  const resolvedVariant = variant ?? "info";
  const Icon = ICON_BY_VARIANT[resolvedVariant];
  const defaultRole = resolvedVariant === "error" ? "alert" : "status";
  const defaultAriaLive = resolvedVariant === "error" ? "assertive" : "polite";
  return (
    <div
      role={role ?? defaultRole}
      aria-live={ariaLive ?? defaultAriaLive}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon && <Icon className="h-3.5 w-3.5 shrink-0 mt-[1px]" />}
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
