"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { extractFrontmatter } from "@/lib/frontmatter";
import { FrontmatterProperties } from "@/components/knowledge/frontmatter-properties";

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
  return (
    <div className="max-w-3xl">
      {parsed && <FrontmatterProperties fields={parsed.fields} />}
      <div className="markdown-body text-[15px] text-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
    </div>
  );
}

// memo skips re-render when the parent re-renders for unrelated work
// (selection changes, list refreshes) but `content` is unchanged.
export const RenderedMarkdown = memo(RenderedMarkdownImpl);
