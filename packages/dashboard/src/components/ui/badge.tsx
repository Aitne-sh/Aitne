import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        // Status hues derive from the theme tokens (theme-aware, so no
        // dark: twins). Variant names stay color-flavored for call-site
        // stability; only the definitions are token-based.
        blue: "bg-primary/10 text-primary",
        teal: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
        purple: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
        green: "bg-success/10 text-success",
        red: "bg-destructive/10 text-destructive",
        amber: "bg-warning/10 text-warning",
        orange: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
        pink: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
        gray: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
