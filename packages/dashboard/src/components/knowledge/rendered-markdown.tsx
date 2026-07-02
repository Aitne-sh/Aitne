"use client";

import { memo, useMemo } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { extractFrontmatter } from "@/lib/frontmatter";
import { FrontmatterProperties } from "@/components/knowledge/frontmatter-properties";
import {
  bareSlugCandidates,
  knowledgeUrlTransform,
  parsePaWikiHref,
  remarkWikilinks,
  resolveBareSlug,
  wikiTargetHref,
} from "@/lib/knowledge/remark-wikilinks";
import { api } from "@/lib/api-client";

const REMARK_PLUGINS = [remarkGfm, remarkWikilinks];

// Lazy-loaded preview renderer. Splitting react-markdown + remark-gfm
// out of the Knowledge page bundle lets the route commit faster; the
// preview shows a tiny skeleton while the chunk loads on first use.
function RenderedMarkdownImpl({ content }: { content: string }) {
  const parsed = useMemo(() => extractFrontmatter(content), [content]);
  const body = useMemo(() => {
    const raw = parsed ? parsed.body : content;
    // react-markdown v9 (no rehype-raw) renders raw HTML — including
    // comments — as escaped literal text. Strip HTML comments so guardrail
    // notes the agent needs to see don't surface in the preview.
    return raw.replace(/<!--[\s\S]*?-->\s*/g, "");
  }, [parsed, content]);

  const router = useRouter();
  const components = useMemo<
    React.ComponentProps<typeof ReactMarkdown>["components"]
  >(
    () => ({
      a: ({ href, children, ...props }) => {
        const wiki = href ? parsePaWikiHref(href) : null;
        if (!wiki) {
          return (
            <a {...props} href={href}>
              {children}
            </a>
          );
        }
        // Path-qualified targets navigate directly; bare slugs (Obsidian
        // basename links like `Project: [[acme-launch]]`) probe their
        // conventional homes on click. The static href keeps middle/cmd-
        // click plausible by pointing at the most likely candidate.
        const qualified = wiki.target.includes("/");
        const staticTarget = qualified
          ? wiki.target
          : bareSlugCandidates(wiki.target)[0];
        return (
          <a
            {...props}
            href={wikiTargetHref(staticTarget)}
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
              if (qualified) {
                router.push(wikiTargetHref(wiki.target));
                return;
              }
              void resolveBareSlug(wiki.target, (p) =>
                api.get(`/context/${p}`),
              ).then((path) => {
                if (path) router.push(wikiTargetHref(path));
              });
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [router],
  );

  return (
    <div className="max-w-3xl">
      {parsed && <FrontmatterProperties fields={parsed.fields} />}
      <div className="markdown-body text-[15px] text-foreground">
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          urlTransform={knowledgeUrlTransform}
          components={components}
        >
          {body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// memo skips re-render when the parent re-renders for unrelated work
// (selection changes, list refreshes) but `content` is unchanged.
export const RenderedMarkdown = memo(RenderedMarkdownImpl);
