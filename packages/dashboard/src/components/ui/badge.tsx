import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        blue: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
        purple: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
        green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
        red: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
        amber: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
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
