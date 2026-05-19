"use client";

import { Sparkles } from "lucide-react";
import { useDoc } from "@/lib/hooks/use-docs";
import { agentDaySeed, seededSample } from "@/lib/docs/seeded-sample";
import type { DocDetailResponse } from "@/lib/api-types";

interface DocsQASuggestedProps {
  /** The slug currently rendered in the content pane (or slide-over). */
  currentSlug: string | null;
  /** Click → insert the question into the composer (no auto-send). */
  onSelect(question: string): void;
}

/**
 * Suggested-question card stack.
 *
 * Source priority (DOCS_QA_DASHBOARD_DESIGN.md §7.5):
 *   - With an open doc → 2 of its `ask_examples` plus 1 from a `related`
 *     doc when one of the related docs has examples.
 *   - Empty state (no slug) → seeded random sample of 3 from the cached
 *     `allAskExamples`. The tree-payload enrichment (D-3) that would
 *     populate `allAskExamples` has not landed; until it does, the
 *     empty-state stack is hidden rather than synthesised, since
 *     fabricating questions is worse UX than no questions.
 *
 * Cards click → `onSelect(question)`; the panel inserts the text into
 * the composer and focuses it (does not auto-send).
 */
export function DocsQASuggested({ currentSlug, onSelect }: DocsQASuggestedProps) {
  const { data: currentDoc } = useDoc(currentSlug);
  // Pick the first related slug; if none, pass null so the related
  // fetch is disabled (no N+1 fan-out).
  const relatedSlug = currentDoc?.frontmatter.related?.[0] ?? null;
  const { data: relatedDoc } = useDoc(relatedSlug);

  const cards = pickCards({ currentDoc, relatedDoc });
  if (cards.length === 0) return null;

  return (
    <section aria-label="Suggested questions" className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Sparkles className="h-3 w-3 opacity-70" aria-hidden="true" />
        Suggested questions
      </p>
      <ul className="space-y-1.5">
        {cards.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => onSelect(card.question)}
              className="block w-full rounded-md border border-border bg-card px-3 py-2 text-left text-xs text-foreground/80 transition hover:border-primary/40 hover:bg-accent hover:text-foreground"
            >
              <span className="block">{card.question}</span>
              {card.source && (
                <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {card.source}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SuggestedCard {
  id: string;
  question: string;
  /** Optional attribution (e.g. "via Agent Day"). */
  source: string | null;
}

interface PickCardsInput {
  currentDoc: DocDetailResponse | undefined;
  relatedDoc: DocDetailResponse | undefined;
}

/**
 * Pure card-selection logic. Exported for unit testing — the component
 * itself is just the rendering.
 */
export function pickCards(input: PickCardsInput): SuggestedCard[] {
  const cards: SuggestedCard[] = [];
  if (input.currentDoc) {
    const own = input.currentDoc.frontmatter.ask_examples.slice(0, 2);
    own.forEach((q, i) => {
      cards.push({ id: `own-${i}`, question: q, source: null });
    });
    if (input.relatedDoc) {
      const fromRelated = input.relatedDoc.frontmatter.ask_examples[0];
      if (fromRelated) {
        cards.push({
          id: "related-0",
          question: fromRelated,
          source: `via ${input.relatedDoc.frontmatter.title}`,
        });
      }
    }
    return cards.slice(0, 3);
  }
  // Empty-state path — `tree.allAskExamples` enrichment is the design's
  // intended source. Until D-3 lands the pool is empty; `seededSample`
  // returns []. Kept here so the future wiring is structural.
  const pool: string[] = [];
  return seededSample(pool, 3, agentDaySeed()).map((q, i) => ({
    id: `empty-${i}`,
    question: q,
    source: null,
  }));
}
