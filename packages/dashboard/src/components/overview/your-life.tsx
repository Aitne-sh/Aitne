"use client";

import Link from "next/link";
import {
  Brain,
  BookOpen,
  GitBranch,
  Plane,
  Wallet,
  Heart,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type LensStatus =
  | { kind: "ready" }
  | { kind: "soon"; label: string }
  | { kind: "skeleton"; label: string };

type Lens = {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  status: LensStatus;
  hidden?: boolean;
};

const LENSES: Lens[] = [
  {
    label: "Knowledge",
    href: "/knowledge",
    icon: Brain,
    description: "All MD — projects, today, weekly, user notes.",
    status: { kind: "ready" },
  },
  {
    label: "Reading",
    href: "/reading",
    icon: BookOpen,
    description: "Books, highlights, and reading progress.",
    status: { kind: "ready" },
  },
  {
    label: "Git",
    href: "/git",
    icon: GitBranch,
    description: "Repos and event-driven Triggers.",
    status: { kind: "soon", label: "Preview" },
  },
  // Trip / Finance / Health are placeholder lenses with no backing
  // implementation yet — hidden from the Overview until shipped.
  // Definitions are kept so re-enabling is a one-line `hidden` flip.
  {
    label: "Trip",
    href: "/trip",
    icon: Plane,
    description: "Trips, itineraries, and post-trip notes.",
    status: { kind: "soon", label: "Soon" },
    hidden: true,
  },
  {
    label: "Finance",
    href: "/finance",
    icon: Wallet,
    description: "Receipts, budgets, and trends.",
    status: { kind: "soon", label: "Soon" },
    hidden: true,
  },
  {
    label: "Health",
    href: "/health",
    icon: Heart,
    description: "Activity, sleep, habits, and journaling.",
    status: { kind: "skeleton", label: "Skeleton" },
    hidden: true,
  },
];

export function YourLife() {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Your Life
        </h2>
        <span className="text-[11px] text-muted-foreground/70">Domain lenses over Knowledge</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {LENSES.filter((lens) => !lens.hidden).map((lens) => (
          <LensCard key={lens.href} lens={lens} />
        ))}
      </div>
    </section>
  );
}

function LensCard({ lens }: { lens: Lens }) {
  const Icon = lens.icon;
  const isPlaceholder = lens.status.kind !== "ready";
  return (
    <Link
      href={lens.href}
      title={lens.description}
      className={cn(
        "group flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.03)] transition-all duration-150",
        "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_4px_12px_-6px_rgb(0_0_0/0.10)]",
        isPlaceholder && "border-dashed",
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      <span className="truncate text-sm font-medium text-foreground">{lens.label}</span>
      {lens.status.kind !== "ready" && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {lens.status.label}
        </span>
      )}
      <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
    </Link>
  );
}
