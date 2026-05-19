"use client";

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";
import { forwardRef } from "react";

export const ScrollArea = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
    <ScrollAreaPrimitive.Viewport ref={ref} className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation="vertical"
      className="flex h-full w-2.5 touch-none select-none border-l border-l-transparent p-[1px] transition-colors"
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation="horizontal"
      className="flex h-2.5 w-full flex-col touch-none select-none border-t border-t-transparent p-[1px] transition-colors"
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = "ScrollArea";
