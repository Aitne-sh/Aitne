import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  badge?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  icon: Icon,
  badge,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
          <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
          {badge}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      )}
      {children}
    </header>
  );
}
