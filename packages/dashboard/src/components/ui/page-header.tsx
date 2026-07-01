import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  badge?: ReactNode;
  /** Small label row rendered above the title (e.g. a category + status eyebrow). */
  eyebrow?: ReactNode;
  /** Metadata row rendered below the description (e.g. a schedule · model · last-run strip). */
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  icon: Icon,
  badge,
  eyebrow,
  meta,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-1.5", className)}>
      {eyebrow}
      <div className="flex items-baseline justify-between gap-3">
        {/* min-w-0 lets a long title wrap/clamp within its own column instead of
            pushing the actions off to the side (or off-screen). */}
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />}
          <h1 className="min-w-0 font-display text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
            {title}
          </h1>
          {badge}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {meta}
      {children}
    </header>
  );
}
