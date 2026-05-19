"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, PanelRightClose, Sparkles } from "lucide-react";
import { APP_NAME } from "@aitne/shared";
import {
  patchDocsQAState,
  useDocsQAState,
  type DocsQAScope,
} from "@/lib/docs/qa-cache";
import {
  loadPreferredQAModel,
  savePreferredQAModel,
} from "@/lib/docs/qa-model-pref";
import { useDocsQA } from "@/lib/hooks/use-docs-qa";
import { useDocsQABinding } from "@/lib/hooks/use-docs";
import { parsePaDocHref, remarkCitations } from "@/lib/docs/remark-citations";
import { CitationPill } from "./citation-pill";
import { DocsQADisclaimer } from "./docs-qa-disclaimer";
import { DocsQASuggested } from "./docs-qa-suggested";
import { cn } from "@/lib/utils";

export type { DocsQAScope } from "@/lib/docs/qa-cache";

export interface DocsQAContextHint {
  /** Slug rendered in the content pane (or shown in the slide-over). */
  slug: string | null;
  /** Dashboard pathname the slide-over was opened from, when applicable. */
  dashboardPath?: string | null;
}

interface DocsQAPanelProps {
  scope?: DocsQAScope;
  contextHint: DocsQAContextHint;
  /** When provided, renders a collapse button in the header. */
  onCollapse?: () => void;
}

const SCOPE_LABEL: Record<DocsQAScope, string> = {
  all: "All docs",
  current: "Current page only",
  category: "This category",
};

/**
 * The right-pane QA surface (DOCS_QA_DASHBOARD_DESIGN.md §5.4 +
 * DOCS_QA_B7_DESIGN.md §S10). Wires the SSE pipeline:
 * `useDocsQA()` opens `GET /api/docs/qa/stream`, captures the
 * minted channelId, and POSTs to `/api/docs/qa/messages` on submit.
 * The button transitions idle → busy on send and back to idle when
 * the dispatcher emits `stream_end` (or `chat_error`).
 */
export function DocsQAPanel({
  scope: scopeOverride,
  contextHint,
  onCollapse,
}: DocsQAPanelProps) {
  const queryClient = useQueryClient();
  const state = useDocsQAState();
  const { ready, busy, sendMessage } = useDocsQA();
  const { data: binding } = useDocsQABinding();
  // Picker preference — localStorage-backed per qa-model-pref.ts so it
  // outlives a single tab session. Lazy initializer so SSR sees the
  // default and the first client render hydrates without a flash.
  const [modelId, setModelId] = useState<string | null>(() =>
    loadPreferredQAModel(),
  );
  // If the persisted choice is no longer registered for the bound
  // backend (deprecation, backend swap), fall back to the default the
  // binding endpoint advertises so we never POST a stale id the daemon
  // would reject as `model_not_registered`.
  const availableModels = useMemo(
    () => binding?.availableModels ?? [],
    [binding?.availableModels],
  );
  const defaultModelId = binding?.defaultModelId;
  const effectiveModelId = useMemo(() => {
    if (availableModels.length === 0) return modelId ?? "";
    if (modelId && availableModels.some((m) => m.modelId === modelId)) {
      return modelId;
    }
    const fallback =
      (defaultModelId
        && availableModels.find((m) => m.modelId === defaultModelId)?.modelId)
      ?? availableModels[0]!.modelId;
    return fallback;
  }, [availableModels, modelId, defaultModelId]);
  const onModelChange = useCallback(
    (next: string) => {
      setModelId(next);
      savePreferredQAModel(next);
    },
    [],
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  // Local mirror of the controlled value. Routing every keystroke through
  // React Query lets the value prop lag, which during IME composition can
  // commit a partial keystroke before the IME absorbs it (typical CJK kana
  // input). Local state keeps the textarea in sync synchronously; the cache
  // stays authoritative for cross-mount prefill (selection-ask) and reset,
  // synced on each non-composition change and on compositionend. External
  // cache changes propagate via the adjust-state-during-render pattern
  // (React's blessed alternative to setState-in-effect for derived state).
  const [localDraft, setLocalDraft] = useState(state.composerDraft);
  const [trackedExternal, setTrackedExternal] = useState(state.composerDraft);
  if (state.composerDraft !== trackedExternal) {
    setTrackedExternal(state.composerDraft);
    setLocalDraft(state.composerDraft);
  }
  // The disclaimer auto-collapses while a transcript exists; the operator
  // can re-expand by clicking the collapsed line. Pure derivation — no
  // effect — so the disclaimer follows messages.length without a feedback
  // loop. When messages.length is 0 the disclaimer is always shown
  // (re-expand has no visible effect there); when > 0 the operator's
  // expand override wins. The override is intentionally session-sticky:
  // once expanded, it stays expanded for the rest of the tab session,
  // matching DOCS_QA_DASHBOARD_DESIGN.md §7.1 ("Re-expansion is via a
  // click on the collapsed line").
  const [userExpanded, setUserExpanded] = useState(false);
  const disclaimerCollapsed = state.messages.length > 0 && !userExpanded;

  // The QA scope lives in qa-cache so it persists across mounts (panel
  // ↔ slide-over). When the parent provides an explicit `scope` prop
  // we sink it into the cache once on mount; thereafter the dropdown
  // is the source of truth. Without this sink, the prop would be a
  // dead parameter — the panel would always read `state.scope` only.
  const sunkScopeRef = useRef(false);
  useEffect(() => {
    if (sunkScopeRef.current) return;
    sunkScopeRef.current = true;
    if (scopeOverride && scopeOverride !== state.scope) {
      patchDocsQAState(queryClient, { scope: scopeOverride });
    }
    // The cache value is the persisted last choice; on first mount
    // for a brand-new session it's "all" (the qa-cache default), so
    // the prop only takes effect when the parent wants something else.
  }, [queryClient, scopeOverride, state.scope]);

  // selection-ask writes the prefill into the cache. When the draft
  // arrives from elsewhere, focus the composer so the operator sees it.
  const previousDraftRef = useRef(state.composerDraft);
  useEffect(() => {
    if (state.composerDraft && state.composerDraft !== previousDraftRef.current) {
      composerRef.current?.focus();
      // Move the caret to the end so the operator can keep typing.
      const len = state.composerDraft.length;
      composerRef.current?.setSelectionRange(len, len);
    }
    previousDraftRef.current = state.composerDraft;
  }, [state.composerDraft]);

  const onScopeChange = (next: DocsQAScope): void => {
    patchDocsQAState(queryClient, { scope: next });
  };

  const onComposerChange = (value: string): void => {
    patchDocsQAState(queryClient, { composerDraft: value });
  };

  const onSuggestedSelect = (question: string): void => {
    patchDocsQAState(queryClient, { composerDraft: question });
    composerRef.current?.focus();
  };

  const composerEmpty = localDraft.trim().length === 0;
  // Disabled while the SSE channel hasn't minted a channelId yet
  // (the POST would 404 channel_not_connected) and while a turn is
  // already in flight. The composer-empty check is the cheapest of
  // the three so it short-circuits last to keep `disabledReason`
  // accurate for tooltip rendering.
  const sendDisabled = !ready || busy || composerEmpty;
  const disabledReason = !ready
    ? "Connecting to the docs assistant…"
    : busy
      ? "Waiting for the previous answer…"
      : null;

  const onSend = (): void => {
    if (sendDisabled) return;
    void sendMessage(
      localDraft,
      {
        ...(contextHint.slug ? { currentSlug: contextHint.slug } : {}),
        ...(contextHint.dashboardPath
          ? { dashboardPath: contextHint.dashboardPath }
          : {}),
      },
      { modelId: effectiveModelId },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 text-sm">
      <header>
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Ask the Agent
          </p>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Collapse Ask the Agent panel"
              title="Collapse"
            >
              <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/80">
          <div className="flex items-center gap-1.5">
            <span>Asking about:</span>
            <select
              aria-label="QA scope"
              value={state.scope}
              onChange={(e) => onScopeChange(e.target.value as DocsQAScope)}
              className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
            >
              {(Object.keys(SCOPE_LABEL) as DocsQAScope[]).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          {availableModels.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span>Model:</span>
              <select
                aria-label="QA model"
                value={effectiveModelId}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={busy}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs disabled:opacity-60"
              >
                {availableModels.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {contextHint.slug && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            (open: <span className="font-medium">{contextHint.slug}</span>)
          </p>
        )}
      </header>

      <DocsQADisclaimer
        collapsed={disclaimerCollapsed}
        onExpand={() => setUserExpanded(true)}
        selectedModelId={effectiveModelId}
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {state.messages.length === 0 && (
          <DocsQASuggested
            currentSlug={contextHint.slug}
            onSelect={onSuggestedSelect}
          />
        )}
        {state.messages.length > 0 && (
          <Transcript messages={state.messages} />
        )}
      </div>

      <div className="space-y-2">
        {state.error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive"
          >
            {state.error}
          </p>
        )}
        <textarea
          ref={composerRef}
          value={localDraft}
          onChange={(e) => {
            // Always update local state so React's controlled-input
            // tracker stays in sync (skipping setState here would let
            // React reset the DOM value to the stale prop, freezing
            // input). The cache write is gated on composition because
            // every cache write notifies useQuery and re-renders, which
            // mid-composition clobbers the IME's composing buffer.
            setLocalDraft(e.target.value);
            if (isComposingRef.current) return;
            onComposerChange(e.target.value);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            const v = (e.target as HTMLTextAreaElement).value;
            setLocalDraft(v);
            onComposerChange(v);
          }}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter mirrors chat composer ergonomics. Suppress
            // during IME composition so the candidate-confirmation Enter
            // (which can carry metaKey on some IMEs) doesn't fire send.
            if (isComposingRef.current || e.nativeEvent.isComposing) return;
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={`Ask anything about ${APP_NAME}…`}
          rows={3}
          disabled={busy}
          className={cn(
            "w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none",
            busy && "opacity-60",
          )}
          aria-label="Question composer"
        />
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={onSend}
            disabled={sendDisabled}
            className={cn(
              "inline-flex min-w-[180px] items-center justify-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium transition",
              sendDisabled
                ? "cursor-not-allowed bg-muted text-muted-foreground"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            aria-label="Ask the agent"
            {...(disabledReason ? { title: disabledReason } : {})}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{busy ? "Thinking…" : "Ask the agent"}</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {disabledReason && (
            <p className="text-[10px] text-muted-foreground">{disabledReason}</p>
          )}
        </div>
      </div>
    </div>
  );
}

const QA_REMARK_PLUGINS = [remarkGfm, remarkCitations];

// Internal dashboard paths the renderer should turn into client-side
// router links. The agent profile asks for explicit `[label](/path)`
// markdown links, but it routinely emits paths inside inline code spans
// instead — `\`/connections/mail\`` is the shape in the user-facing
// transcript. We linkify both, keeping the inline-code linkifier
// conservative (single-line, no language class) so fenced code blocks
// stay untouched.
const INTERNAL_PATH_RE = /^\/[a-z][a-z0-9_\-/]*$/i;

function isInternalHref(href: string | undefined): href is string {
  return !!href && href.startsWith("/") && !href.startsWith("//");
}

function Transcript({
  messages,
}: {
  messages: ReturnType<typeof useDocsQAState>["messages"];
}) {
  const router = useRouter();

  const onCitationClick = useCallback(
    (citationSlug: string, anchor: string | null) => {
      const target = anchor
        ? `/docs/${citationSlug}#${anchor}`
        : `/docs/${citationSlug}`;
      router.push(target);
    },
    [router],
  );

  const components = useMemo(
    () => buildQAMarkdownComponents(onCitationClick),
    [onCitationClick],
  );

  return (
    <ol className="space-y-2">
      {messages.map((m) => {
        const isEmptyStreaming =
          m.role === "assistant" && m.streaming && m.content.length === 0;
        return (
          <li
            key={m.id}
            className={cn(
              // `min-w-0` + `max-w-full` + `overflow-hidden` together
              // pin the bubble to the panel's column width. Without
              // them a wide markdown table or a long inline code span
              // (e.g. `/api/integrations/:key/invoke`) pushes the
              // bubble beyond the 360px QA aside, which the parent
              // `overflow-y-auto` aside resolves by exposing horizontal
              // scroll — the failure mode the operator just reported.
              // Children that legitimately need horizontal room
              // (tables, `pre`) carry their own internal scroll.
              "min-w-0 max-w-full overflow-hidden rounded-md border border-border px-3 py-2 text-xs",
              m.role === "user" ? "bg-primary/5" : "bg-muted/40",
            )}
          >
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {m.role === "user" ? "You" : "Docs assistant"}
            </p>
            {isEmptyStreaming ? (
              <p className="italic text-muted-foreground" aria-live="polite">
                Thinking…
              </p>
            ) : m.role === "user" ? (
              <p className="whitespace-pre-wrap">{m.content}</p>
            ) : (
              <div className="markdown-body markdown-bubble">
                <ReactMarkdown
                  remarkPlugins={QA_REMARK_PLUGINS}
                  urlTransform={qaUrlTransform}
                  components={components}
                >
                  {m.content}
                </ReactMarkdown>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function qaUrlTransform(url: string): string {
  if (url.startsWith("pa-doc:")) return url;
  return defaultUrlTransform(url);
}

function buildQAMarkdownComponents(
  onCitationClick: (slug: string, anchor: string | null) => void,
): React.ComponentProps<typeof ReactMarkdown>["components"] {
  return {
    a: ({ href, children, ...props }) => {
      const citation = href ? parsePaDocHref(href) : null;
      if (citation) {
        return (
          <CitationPill
            slug={citation.slug}
            anchor={citation.anchor}
            onClick={onCitationClick}
          />
        );
      }
      if (isInternalHref(href)) {
        return (
          <Link href={href} className="text-primary underline">
            {children}
          </Link>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
    // ReactMarkdown v9 calls this for both inline `code` and fenced code
    // blocks. Fenced blocks come with a `language-*` class and may
    // contain newlines — only linkify the simple inline case so quoted
    // YAML / TS examples stay untouched.
    code: ({ className, children, ...props }) => {
      const text =
        typeof children === "string"
          ? children
          : Array.isArray(children) && children.every((c) => typeof c === "string")
            ? children.join("")
            : null;
      const inline =
        !className?.startsWith("language-") &&
        text !== null &&
        !text.includes("\n");
      if (inline && text && INTERNAL_PATH_RE.test(text)) {
        return (
          <Link href={text} className="text-primary underline">
            <code className={className} {...props}>
              {children}
            </code>
          </Link>
        );
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };
}
