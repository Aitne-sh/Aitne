import { type VariantProps, cva } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

const spinnerVariants = cva("animate-spin", {
  variants: {
    size: {
      xs: "h-3 w-3",
      sm: "h-3.5 w-3.5",
      md: "h-4 w-4",
      lg: "h-5 w-5",
    },
  },
  defaultVariants: { size: "md" },
});

export interface SpinnerProps
  extends Omit<ComponentPropsWithoutRef<typeof Loader2>, "size">,
    VariantProps<typeof spinnerVariants> {}

export function Spinner({ className, size, ...props }: SpinnerProps) {
  return (
    <Loader2
      aria-hidden
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}
