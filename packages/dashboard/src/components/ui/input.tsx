"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "flex h-8 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm ring-offset-background",
          "placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
