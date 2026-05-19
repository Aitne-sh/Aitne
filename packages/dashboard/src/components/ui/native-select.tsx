"use client";

import { ChevronDown } from "lucide-react";
import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A styled native `<select>` that matches the visual rhythm of `<Input>`.
 * Use this for simple option lists. For searchable / grouped / portal-
 * rendered selects, reach for `@/components/ui/select` (Radix) instead.
 */
export const NativeSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "flex h-9 w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background",
          "focus:outline-none focus:ring-2 focus:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
    </div>
  );
});
NativeSelect.displayName = "NativeSelect";
