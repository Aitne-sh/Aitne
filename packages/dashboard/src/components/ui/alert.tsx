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
        // Theme-token tints (light/dark handled by the token definitions
        // in globals.css — no dark: twins needed).
        success: "border-success/40 bg-success/10 text-success",
        error: "border-destructive/40 bg-destructive/10 text-destructive",
        warning: "border-warning/40 bg-warning/10 text-warning",
        info: "border-primary/40 bg-primary/10 text-primary",
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
