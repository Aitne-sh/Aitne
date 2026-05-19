"use client";

import { memo, useEffect, useMemo } from "react";
import Link from "next/link";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CitationPill } from "./citation-pill";
import { dashboardRouteHref } from "@/lib/docs/dashboard-routes";
import { parsePaDocHref, remarkCitations } from "@/lib/docs/remark-citations";
import { resolveRelativeDocLink } from "@/lib/docs/relative-link";
import { slugifyAnchor } from "@/lib/docs/anchor";

const REMARK_PLUGINS = [remarkGfm, remarkCitations];

function docsUrlTransform(url: string): string {
  if (url.startsWith("pa-doc:")) return url;
  return defaultUrlTransform(url);
}

// Visual styling for both shared anchors and the dashboard-route chip is
// owned by globals.css under `.markdown-body.docs-prose a` (and the
// `.docs-route-chip` variant). That scope wins over the global
// `.markdown-body a { color: primary }` rule via specificity without
// needing `!important` in every utility class here.
const ROUTE_CHIP_CLASS = "docs-route-chip";

interface DocsMarkdownBodyProps {
  body: string;
  currentSlug: string | null;
  onCitationClick: (slug: string, anchor: string | null) => void;
  /**
   * Fires after the body has been rendered. The parent uses this to
   * (re-)trigger anchor scrolling, since the markdown chunk loads
   * asynchronously and the heading elements don't exist yet when the
   * page-level useEffect first runs.
   */
  onRendered?: () => void;
}

// Lazy-loaded markdown render. The parent imports this via next/dynamic
// so react-markdown + remark-gfm + remark-citations are split into a
// separate chunk and don't block the route's synchronous mount.
function DocsMarkdownBodyImpl({
  body,
  currentSlug,
  onCitationClick,
  onRendered,
}: DocsMarkdownBodyProps) {
  // Notify the parent once we've actually rendered. Fires post-commit
  // every time the body changes — that's the moment the new heading
  // anchors exist in the DOM.
  useEffect(() => {
    onRendered?.();
  }, [body, onRendered]);

  // The component map only depends on the citation handler and current
  // slug; rebuilding on every render would defeat any internal short-
  // circuiting in react-markdown's reconciliation.
  const components = useMemo<
    React.ComponentProps<typeof ReactMarkdown>["components"]
  >(() => ({
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
      const internal =
        href && currentSlug
          ? resolveRelativeDocLink(currentSlug, href)
          : null;
      if (internal) {
        const target = internal.anchor
          ? `/docs/${internal.slug}#${internal.anchor}`
          : `/docs/${internal.slug}`;
        return (
          <a
            {...props}
            href={target}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              ) {
                return;
              }
              event.preventDefault();
              onCitationClick(internal.slug, internal.anchor);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
    // Inline `` `/dashboard-route` `` becomes a real <Link>. Fenced code
    // blocks fall through to the default <code> rendering — they always
    // contain a newline; inline code by definition never does.
    code: ({ children, ...props }) => {
      const text = reactNodeToText(children);
      if (!text || text.includes("\n")) {
        return <code {...props}>{children}</code>;
      }
      const href = dashboardRouteHref(text);
      if (!href) {
        return <code {...props}>{children}</code>;
      }
      return (
        <Link href={href} className={ROUTE_CHIP_CLASS} title={`Open ${text}`}>
          {text}
        </Link>
      );
    },
    h1: ({ children, ...props }) => (
      <h2 id={anchorIdForChildren(children)} {...props}>
        {children}
      </h2>
    ),
    h2: ({ children, ...props }) => (
      <h2 id={anchorIdForChildren(children)} {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 id={anchorIdForChildren(children)} {...props}>
        {children}
      </h3>
    ),
  }), [currentSlug, onCitationClick]);

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={docsUrlTransform}
      components={components}
    >
      {body}
    </ReactMarkdown>
  );
}

// memo skips re-render when the parent re-renders for unrelated work
// (e.g. the QA panel toggle in DocsShell) but body / slug are unchanged.
export const DocsMarkdownBody = memo(DocsMarkdownBodyImpl);

function anchorIdForChildren(children: React.ReactNode): string {
  return slugifyAnchor(reactNodeToText(children));
}

function reactNodeToText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join("");
  if (typeof node === "object" && "props" in node) {
    return reactNodeToText(
      (node as { props: { children?: React.ReactNode } }).props.children,
    );
  }
  return "";
}
