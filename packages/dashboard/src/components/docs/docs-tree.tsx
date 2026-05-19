"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, FileText, Search, X } from "lucide-react";
import { useDocsTree, useDocsSearch } from "@/lib/hooks/use-docs";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CATEGORY_ORDER, SECTION_ORDER, orderIndex } from "@/lib/docs/doc-order";
import type { DocsTreeItem } from "@/lib/api-types";

interface DocsTreeProps {
  activeSlug: string | null;
}

interface CategoryGroup {
  category: string;
  sections: Map<string | null, DocsTreeItem[]>;
}

function groupTree(docs: DocsTreeItem[]): CategoryGroup[] {
  const byCategory = new Map<string, Map<string | null, DocsTreeItem[]>>();
  for (const doc of docs) {
    const sectionMap = byCategory.get(doc.category) ?? new Map();
    const sectionKey = doc.section ?? null;
    const list = sectionMap.get(sectionKey) ?? [];
    list.push(doc);
    sectionMap.set(sectionKey, list);
    byCategory.set(doc.category, sectionMap);
  }

  const sortedCategories = Array.from(byCategory.entries()).sort(
    ([a], [b]) => orderIndex(CATEGORY_ORDER, a) - orderIndex(CATEGORY_ORDER, b),
  );

  return sortedCategories.map(([category, sections]) => {
    const order = SECTION_ORDER[category] ?? [];
    const sortedSections = new Map(
      Array.from(sections.entries()).sort(([a], [b]) => {
        // Untyped (null) sections sort first within a category — they hold
        // top-level docs that the category landing should surface above
        // sub-grouped content (e.g., `concepts/agent-day` above future
        // `concepts/<sub>/...`).
        if (a === null && b !== null) return -1;
        if (b === null && a !== null) return 1;
        if (a === null && b === null) return 0;
        return orderIndex(order, a as string) - orderIndex(order, b as string);
      }),
    );
    return { category, sections: sortedSections };
  });
}

const CATEGORY_LABEL: Record<string, string> = {
  "getting-started": "Get Started",
  concepts: "Concepts",
  features: "Features",
  guides: "Guides",
  troubleshooting: "Troubleshooting",
  reference: "Reference",
  glossary: "Glossary",
};

function categoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? key;
}

function sectionLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
}

export function DocsTree({ activeSlug }: DocsTreeProps) {
  const tree = useDocsTree();
  const [filter, setFilter] = useState("");
  // `enterPressed` lets the operator force FTS at any non-empty length;
  // otherwise FTS auto-engages once the query is long enough to be
  // meaningful (4+ chars). Cleared whenever the input is emptied so a
  // subsequent short filter falls back to the substring tree mode.
  const [enterPressed, setEnterPressed] = useState(false);
  const ftsActive = filter.length > 0 && (filter.length >= 4 || enterPressed);
  const search = useDocsSearch(ftsActive ? filter : "");

  const filteredDocs = useMemo(() => {
    if (!tree.data) return [];
    if (!filter) return tree.data.docs;
    const needle = filter.toLowerCase();
    return tree.data.docs.filter((d) => d.title.toLowerCase().includes(needle));
  }, [tree.data, filter]);

  const grouped = useMemo(() => groupTree(filteredDocs), [filteredDocs]);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search docs"
          placeholder="Filter docs (Enter to search)…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            if (e.target.value.length === 0) setEnterPressed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filter.length > 0) {
              e.preventDefault();
              setEnterPressed(true);
            } else if (e.key === "Escape") {
              setFilter("");
              setEnterPressed(false);
            }
          }}
          className="pl-7 pr-7"
        />
        {filter && (
          <button
            aria-label="Clear search"
            onClick={() => {
              setFilter("");
              setEnterPressed(false);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {tree.isLoading && <SkeletonRows />}
      {tree.error && (
        <p className="px-2 text-xs text-destructive">Failed to load docs.</p>
      )}

      {ftsActive ? (
        <FtsResults
          query={filter}
          loading={search.isLoading}
          activeSlug={activeSlug}
          results={search.data?.results.map((r) => ({
            slug: r.slug,
            title: r.title,
            category: r.category,
            section: r.section || null,
            status: null,
            summary: r.summary,
          })) ?? []}
        />
      ) : (
        <nav aria-label="Docs tree" className="flex-1 space-y-3 overflow-y-auto text-sm">
          {grouped.map((group) => (
            <CategoryBlock
              key={group.category}
              category={group.category}
              sections={group.sections}
              activeSlug={activeSlug}
              forceOpen={!!filter}
            />
          ))}
          {!tree.isLoading && grouped.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">
              {filter ? "No matching docs." : "No docs indexed yet."}
            </p>
          )}
        </nav>
      )}
    </div>
  );
}

function CategoryBlock({
  category,
  sections,
  activeSlug,
  forceOpen,
}: {
  category: string;
  sections: Map<string | null, DocsTreeItem[]>;
  activeSlug: string | null;
  forceOpen: boolean;
}) {
  const containsActive = activeSlug?.startsWith(category + "/") ?? false;
  const [open, setOpen] = useState(
    forceOpen || containsActive || category === "getting-started",
  );
  const isOpen = forceOpen || open;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <span>{categoryLabel(category)}</span>
      </button>
      {isOpen && (
        <div className="mt-1 space-y-1 pl-3">
          {Array.from(sections.entries()).map(([sectionKey, docs]) => (
            <SectionBlock
              key={sectionKey ?? "_root"}
              section={sectionKey}
              docs={docs}
              activeSlug={activeSlug}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionBlock({
  section,
  docs,
  activeSlug,
}: {
  section: string | null;
  docs: DocsTreeItem[];
  activeSlug: string | null;
}) {
  return (
    <div>
      {section && (
        <p className="px-1 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {sectionLabel(section)}
        </p>
      )}
      <ul className="space-y-0.5">
        {docs.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/docs/${doc.slug}`}
              className={cn(
                "flex items-center gap-1.5 rounded px-1.5 py-1 text-sm",
                doc.slug === activeSlug
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              <FileText className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{doc.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FtsResults({
  query,
  loading,
  results,
  activeSlug,
}: {
  query: string;
  loading: boolean;
  results: DocsTreeItem[];
  activeSlug: string | null;
}) {
  return (
    <nav aria-label="Search results" className="flex-1 overflow-y-auto text-sm">
      <p className="px-1 pb-2 text-xs text-muted-foreground">
        {loading ? "Searching…" : `${results.length} matches for “${query}”`}
      </p>
      <ul className="space-y-1">
        {results.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/docs/${doc.slug}`}
              className={cn(
                "block rounded px-2 py-1.5",
                doc.slug === activeSlug
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="block truncate text-sm">{doc.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {doc.category}
                {doc.section ? ` · ${doc.section}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2 p-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-muted"
          style={{ width: `${60 + ((i * 13) % 30)}%` }}
        />
      ))}
    </div>
  );
}
