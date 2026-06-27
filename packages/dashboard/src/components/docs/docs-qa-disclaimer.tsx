"use client";

import { AlertTriangle, Info } from "lucide-react";
import { APP_NAME } from "@aitne/shared";
import { useDocsQABinding } from "@/lib/hooks/use-docs";
import { cn } from "@/lib/utils";

interface DocsQADisclaimerProps {
  /** Collapse to a single line — true once the operator has sent a message. */
  collapsed: boolean;
  /** Operator clicked the collapsed line: re-expand. */
  onExpand(): void;
  /** Currently-selected model id from the picker. The picker is the
   *  source of truth for which model the next QA turn will use; the
   *  `useDocsQABinding()` model field describes the dispatcher's
   *  fallback only and would mislead once the picker overrides it. */
  selectedModelId?: string;
}

/**
 * The "How this works" block above the QA composer.
 *
 * Three render branches:
 *   1. binding fetch succeeded → render the per-backend long-form copy
 *      (Claude/Codex flat-rate vs Gemini token-billed — DOCS_QA_DESIGN.md §9.3).
 *   2. binding fetch failed (the endpoint isn't shipped yet, so this is
 *      the day-1 path) → render the fallback copy from §7.1.
 *   3. collapsed (post-first-message) → render a single line; click to
 *      re-expand.
 */
export function DocsQADisclaimer({
  collapsed,
  onExpand,
  selectedModelId,
}: DocsQADisclaimerProps) {
  const { data, isLoading, error } = useDocsQABinding();
  // The picker is the source of truth — pull its label from the
  // binding's availableModels list; fall back to the binding's
  // model-display string when the picker hasn't picked yet (initial
  // render before localStorage hydration).
  const pickedModelLabel =
    (selectedModelId
      && data?.availableModels.find((m) => m.modelId === selectedModelId)?.label)
    || data?.modelDisplay
    || "";

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60"
        aria-label="Show QA disclaimer"
      >
        <Info className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="truncate">
          ⓘ Powered by {data?.backendDisplay ?? "your DM messaging app"}
          {pickedModelLabel ? ` (${pickedModelLabel})` : ""}
        </span>
      </button>
    );
  }

  if (isLoading) {
    return (
      <div
        aria-hidden="true"
        className="rounded-md border border-border bg-muted/30 px-3 py-3"
      >
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  return (
    <section
      role="region"
      aria-label="How this works"
      className={cn(
        "space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs leading-relaxed",
      )}
    >
      {error ? (
        <FallbackCopy />
      ) : data ? (
        <LongFormCopy data={data} pickedModelLabel={pickedModelLabel} />
      ) : null}
      <p className="flex gap-1.5 text-warning">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Answers can be inaccurate. The agent searches all {APP_NAME} docs
          and cites its sources — always click through to verify before acting
          on a suggestion.
        </span>
      </p>
    </section>
  );
}

function FallbackCopy() {
  return (
    <p className="text-muted-foreground">
      Powered by your DM messaging app&rsquo;s light-tier model. Token usage
      is billed against the provider API key configured for that backend
      (or the CLI&rsquo;s subscription auth, when no API key is set).
    </p>
  );
}

function LongFormCopy({
  data,
  pickedModelLabel,
}: {
  data: NonNullable<ReturnType<typeof useDocsQABinding>["data"]>;
  pickedModelLabel: string;
}) {
  // Gemini is the only branch that publishes a fully metered free-tier
  // path. Detection mirrors the dashboard's existing convention: backend
  // display string starts with "Gemini" (Gemini CLI / Gemini API). For
  // Claude / Codex we fall back to the API-key-vs-subscription explainer.
  const isGemini = /^gemini/i.test(data.backendDisplay);
  return (
    <>
      <p className="text-foreground/90">
        Powered by <strong>{data.backendDisplay}</strong> running{" "}
        <strong>{pickedModelLabel || data.modelDisplay}</strong> — pick a
        different light-tier model from the dropdown above if you want.{" "}
        {isGemini ? (
          <>
            Token usage is billed against your Google Gemini API quota (or
            counts toward the free-tier per-day cap). Heavy QA traffic can
            exhaust the daily Flash budget — keep an eye on{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[10px]">/analytics</code>{" "}
            if you ask a lot of questions in one day.
          </>
        ) : (
          <>
            Token usage is billed against the provider API key configured
            for <strong>{data.backendDisplay}</strong> (or, if no key is
            set, against the CLI&rsquo;s subscription auth as a fallback).
          </>
        )}
      </p>
    </>
  );
}
