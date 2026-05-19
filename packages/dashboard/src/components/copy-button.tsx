"use client";

import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  className?: string;
  /** Icon size class (default: "h-3.5 w-3.5") */
  iconSize?: string;
  /**
   * Optional inline label. When set, the button switches to a labelled
   * "Copy / Copied" style (used inside settings panels). When omitted, the
   * button is icon-only (used inline next to copyable text).
   */
  label?: string;
  /** Override the "Copied" feedback string. Only takes effect when `label` is set. */
  copiedLabel?: string;
}

export function CopyButton({
  text,
  className,
  iconSize = "h-3.5 w-3.5",
  label,
  copiedLabel = "Copied",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).catch(() => {
      // Clipboard API unavailable — silent fallback
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  if (label) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        title="Copy"
      >
        {copied ? (
          <Check className={cn(iconSize, "text-emerald-500")} />
        ) : (
          <Copy className={iconSize} />
        )}
        {copied ? copiedLabel : label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center text-muted-foreground hover:text-foreground transition-colors",
        className,
      )}
      title="Copy"
    >
      {copied ? (
        <Check className={cn(iconSize, "text-emerald-500")} />
      ) : (
        <Copy className={iconSize} />
      )}
    </button>
  );
}
