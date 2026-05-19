import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
  children?: React.ReactNode;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-muted-foreground",
        className,
      )}
    >
      <Icon className="mb-3 h-10 w-10 opacity-40" />
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-prose text-xs text-muted-foreground/70">{description}</p>
      )}
      {children}
    </div>
  );
}
