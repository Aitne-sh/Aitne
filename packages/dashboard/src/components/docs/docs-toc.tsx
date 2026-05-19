"use client";

import { useEffect, useState } from "react";
import { slugifyAnchor } from "@/lib/docs/anchor";
import { cn } from "@/lib/utils";

interface DocsTocProps {
  body: string;
  /**
   * Container element whose H2 headings the TOC scrolls. Pass the
   * `<article>` ref from `<DocsContent>` so `IntersectionObserver`
   * scopes to the right scroll root. May be null on first paint.
   */
  scopeRef: React.RefObject<HTMLElement | null>;
}

interface TocEntry {
  anchor: string;
  text: string;
}

const TOC_THRESHOLD = 4;

export function DocsToc({ body, scopeRef }: DocsTocProps) {
  const entries = extractH2Entries(body);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(
    entries[0]?.anchor ?? null,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (entries.length < TOC_THRESHOLD) return;
    const root = scopeRef.current;
    if (!root) return;
    const targets = entries
      .map((e) => root.querySelector<HTMLElement>(`#${cssEscape(e.anchor)}`))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (events) => {
        for (const entry of events) {
          const id = entry.target.id;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // Active = first H2 whose target is currently in the visible
        // set; fall back to the closest H2 above the viewport.
        const firstVisible = entries.find((e) => visible.has(e.anchor));
        if (firstVisible) {
          setActiveAnchor(firstVisible.anchor);
          return;
        }
        // Find the last entry whose target is *above* the viewport.
        const above = entries
          .map((e) => ({ entry: e, target: targets.find((t) => t.id === e.anchor) }))
          .filter(({ target }) => target && target.getBoundingClientRect().bottom < 0);
        const last = above[above.length - 1];
        if (last) setActiveAnchor(last.entry.anchor);
      },
      {
        // -45% on the bottom margin pulls the trigger up so a heading
        // is "active" when it crosses the upper third of the viewport,
        // matching how readers track reading position.
        rootMargin: "0px 0px -55% 0px",
        threshold: [0, 1],
      },
    );

    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [body, entries, scopeRef]);

  if (entries.length < TOC_THRESHOLD) return null;

  return (
    <aside
      aria-label="On this page"
      className="sticky top-4 hidden h-fit w-44 shrink-0 self-start text-xs lg:block"
    >
      <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-1 border-l border-border pl-2">
        {entries.map((e) => (
          <li key={e.anchor}>
            <a
              href={`#${e.anchor}`}
              className={cn(
                "block truncate rounded px-1.5 py-0.5 transition",
                e.anchor === activeAnchor
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * Pull H2 headings from raw Markdown. Code fences are stripped so a
 * `## ` line inside a fenced block is not surfaced as a TOC entry.
 * H1/H3 are intentionally excluded — a TOC of mixed depths is harder
 * to scan, and the design's threshold (>4 H2s) is the meaningful unit.
 */
export function extractH2Entries(body: string): TocEntry[] {
  const out: TocEntry[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const text = match[1]!;
    const anchor = slugifyAnchor(text);
    if (anchor.length === 0) continue;
    out.push({ anchor, text });
  }
  return out;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
