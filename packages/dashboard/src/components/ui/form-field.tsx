import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FormFieldProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  /**
   * When set, renders as `<div>` and associates a child `<input>` / `<select>` /
   * `<textarea>` via its own `id` matching this value. When omitted, renders
   * as a `<label>` so any inner control is implicitly associated.
   */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

const LABEL_CLS = "text-xs font-medium text-muted-foreground";
const HELPER_CLS = "text-xs text-muted-foreground";
const ERROR_CLS = "text-xs text-destructive";

export function FormField({
  label,
  description,
  error,
  htmlFor,
  className,
  children,
}: FormFieldProps) {
  if (htmlFor) {
    return (
      <div className={cn("flex flex-col gap-1 text-sm", className)}>
        {label && (
          <label htmlFor={htmlFor} className={LABEL_CLS}>
            {label}
          </label>
        )}
        {children}
        {description && !error && <p className={HELPER_CLS}>{description}</p>}
        {error && <p className={ERROR_CLS}>{error}</p>}
      </div>
    );
  }
  return (
    <label className={cn("flex flex-col gap-1 text-sm", className)}>
      {label && <span className={LABEL_CLS}>{label}</span>}
      {children}
      {description && !error && <span className={HELPER_CLS}>{description}</span>}
      {error && <span className={ERROR_CLS}>{error}</span>}
    </label>
  );
}
