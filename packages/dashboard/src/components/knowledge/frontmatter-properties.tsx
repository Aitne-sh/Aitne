"use client";

import {
  Calendar,
  CheckSquare,
  Hash,
  List,
  Tag,
  Text,
  Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  inferKind,
  type FieldKind,
  type FrontmatterValue,
  type ParsedFrontmatter,
} from "@/lib/frontmatter";

export interface FrontmatterPropertiesProps {
  fields: ParsedFrontmatter["fields"];
  className?: string;
}

const TAG_FIELDS = new Set(["tags", "labels", "categories"]);

export function FrontmatterProperties({ fields, className }: FrontmatterPropertiesProps) {
  return (
    <div
      className={cn(
        "mb-6 max-w-3xl rounded-md border border-border bg-muted/20 px-3 py-2 text-sm",
        className,
      )}
    >
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">
        Properties
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {fields.map((field) => (
          <FieldRow key={field.key} field={field} />
        ))}
      </dl>
    </div>
  );
}

function FieldRow({ field }: { field: ParsedFrontmatter["fields"][number] }) {
  const kind = pickKindForField(field.key, field.value);
  return (
    <>
      <dt className="flex items-start gap-1.5 py-1 pt-1.5 text-muted-foreground">
        <KindIcon kind={kind} />
        <span className="font-mono text-xs leading-5">{field.key}</span>
      </dt>
      <dd className="flex min-w-0 items-start py-1 text-foreground">
        <ValueRenderer field={field.key} value={field.value} />
      </dd>
    </>
  );
}

function KindIcon({ kind }: { kind: FieldKind }) {
  const className = "h-3.5 w-3.5";
  switch (kind) {
    case "date":
      return <Calendar className={className} />;
    case "datetime":
      return <Clock className={className} />;
    case "boolean":
      return <CheckSquare className={className} />;
    case "number":
      return <Hash className={className} />;
    case "list":
      return <List className={className} />;
    case "empty":
    case "text":
      return <Text className={className} />;
    default:
      return <Tag className={className} />;
  }
}

function ValueRenderer({
  field,
  value,
}: {
  field: string;
  value: FrontmatterValue;
}) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <EmptyValue />;
    }
    const variant = TAG_FIELDS.has(field) ? "purple" : "gray";
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          <Badge
            key={`${String(item)}-${i}`}
            variant={variant}
            className="font-normal"
          >
            {renderScalar(item)}
          </Badge>
        ))}
      </div>
    );
  }
  if (value === null) return <EmptyValue />;
  if (typeof value === "boolean") {
    return (
      <span
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded border",
          value
            ? "border-violet-500 bg-violet-500 text-white"
            : "border-border bg-transparent",
        )}
        aria-label={value ? "true" : "false"}
      >
        {value && <CheckSquare className="h-3 w-3" strokeWidth={3} />}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="font-mono tabular-nums">{value}</span>;
  }
  if (typeof value === "string") {
    if (value.length === 0) return <EmptyValue />;
    return <span className="break-words leading-5">{value}</span>;
  }
  return null;
}

function renderScalar(value: FrontmatterValue): string {
  if (value === null) return "—";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function EmptyValue() {
  return <span className="text-muted-foreground/60">Empty</span>;
}

function pickKindForField(key: string, value: FrontmatterValue): FieldKind {
  const base = inferKind(value);
  if (base !== "text") return base;
  // Heuristic: treat tag-like fields as list even when empty-string.
  if (TAG_FIELDS.has(key) && typeof value === "string" && value.length === 0) {
    return "list";
  }
  return base;
}

